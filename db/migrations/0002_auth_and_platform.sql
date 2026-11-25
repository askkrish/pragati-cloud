-- Pragati Cloud · 0002 sign-in and platform operations
--
-- Residents sign in with their mobile number and a one-time code. The application role cannot
-- read these tables; it calls the SECURITY DEFINER functions below, which do one narrow job each.
-- Codes and session tokens are stored only as HMAC/SHA-256 hashes computed by the application.

create table auth_private.users (
  id            uuid primary key default gen_random_uuid(),
  phone_e164    text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  disabled_at   timestamptz
);

create table auth_private.otp_challenges (
  id          uuid primary key,
  tenant_id   uuid not null references app.tenants (id) on delete cascade,
  phone_e164  text not null,
  code_hash   text,              -- null when the number has no access, so nothing was sent
  ip          inet,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  attempts    smallint not null default 0,
  consumed_at timestamptz
);
create index otp_challenges_phone_idx on auth_private.otp_challenges (phone_e164, created_at desc);
create index otp_challenges_ip_idx on auth_private.otp_challenges (ip, created_at desc);
create index otp_challenges_tenant_idx on auth_private.otp_challenges (tenant_id);

create table auth_private.sessions (
  id           uuid primary key default gen_random_uuid(),
  token_hash   bytea not null unique,
  user_id      uuid not null references auth_private.users (id) on delete cascade,
  tenant_id    uuid not null references app.tenants (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text
);
create index sessions_user_idx on auth_private.sessions (user_id);
create index sessions_tenant_idx on auth_private.sessions (tenant_id);

revoke all on all tables in schema auth_private from public;

-- Finds a community by the web address it is reached on: a registered domain, or
-- <slug>.<base domain>. Returns only what the sign-in page shows.
create function app.resolve_tenant(p_host text, p_base_domain text)
returns table (id uuid, slug text, brand_name text, platform_name text, primary_color text,
               logo_file_id uuid, languages text[], assistant_name text, status text)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.slug, t.brand_name, t.platform_name, t.primary_color, t.logo_file_id, t.languages,
         t.assistant_name, t.status
    from app.tenants t
   where t.id = coalesce(
           (select d.tenant_id from app.tenant_domains d where d.domain = lower(p_host)),
           (select t2.id from app.tenants t2
             where lower(p_host) = t2.slug || '.' || lower(p_base_domain)))
$$;

create function auth_api.otp_start(p_tenant uuid, p_challenge_id uuid, p_phone text, p_code_hash text,
                                   p_ttl_seconds integer, p_ip inet)
returns table (challenge_id uuid, deliver boolean, status text)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_prev   text := current_setting('app.tenant_id', true);
  v_member boolean;
begin
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    return query select null::uuid, false, 'invalid_phone'; return;
  end if;
  if (select count(*) from auth_private.otp_challenges c
       where c.phone_e164 = p_phone and c.created_at > now() - interval '15 minutes') >= 3
     or (p_ip is not null and (select count(*) from auth_private.otp_challenges c
       where c.ip = p_ip and c.created_at > now() - interval '1 hour') >= 30) then
    return query select null::uuid, false, 'rate_limited'; return;
  end if;
  if not exists (select 1 from app.tenants t where t.id = p_tenant and t.status = 'active') then
    return query select null::uuid, false, 'community_unavailable'; return;
  end if;

  perform set_config('app.tenant_id', p_tenant::text, true);
  select exists (
    select 1 from app.people p
      join app.memberships m on m.tenant_id = p.tenant_id and m.person_id = p.id and m.status = 'active'
     where p.tenant_id = p_tenant and p.phone_e164 = p_phone and p.archived_at is null)
    into v_member;
  perform set_config('app.tenant_id', coalesce(v_prev, ''), true);

  v_member := v_member and not exists (
    select 1 from auth_private.users u where u.phone_e164 = p_phone and u.disabled_at is not null);

  insert into auth_private.otp_challenges (id, tenant_id, phone_e164, code_hash, ip, expires_at)
  values (p_challenge_id, p_tenant, p_phone, case when v_member then p_code_hash end, p_ip,
          now() + make_interval(secs => greatest(60, least(p_ttl_seconds, 900))));

  return query select p_challenge_id, v_member, case when v_member then 'sent' else 'not_registered' end;
end $$;

create function auth_api.otp_verify(p_tenant uuid, p_challenge_id uuid, p_code_hash text, p_token_hash bytea,
                                    p_session_days integer, p_ip inet, p_user_agent text)
returns table (status text, user_id uuid, session_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  c         auth_private.otp_challenges;
  v_prev    text := current_setting('app.tenant_id', true);
  v_user    uuid;
  v_off     timestamptz;
  v_session uuid;
  v_expires timestamptz;
begin
  select * into c from auth_private.otp_challenges
   where id = p_challenge_id and tenant_id = p_tenant for update;
  if not found or c.code_hash is null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::timestamptz; return;
  end if;
  if c.consumed_at is not null then
    return query select 'used'::text, null::uuid, null::uuid, null::timestamptz; return;
  end if;
  if c.expires_at < now() then
    return query select 'expired'::text, null::uuid, null::uuid, null::timestamptz; return;
  end if;
  if c.attempts >= 5 then
    return query select 'locked'::text, null::uuid, null::uuid, null::timestamptz; return;
  end if;

  update auth_private.otp_challenges set attempts = attempts + 1 where id = c.id;
  if c.code_hash <> p_code_hash then
    return query select 'invalid'::text, null::uuid, null::uuid, null::timestamptz; return;
  end if;
  update auth_private.otp_challenges set consumed_at = now() where id = c.id;

  insert into auth_private.users (phone_e164, last_login_at) values (c.phone_e164, now())
  on conflict (phone_e164) do update set last_login_at = now()
  returning id, disabled_at into v_user, v_off;
  if v_off is not null then
    return query select 'disabled'::text, null::uuid, null::uuid, null::timestamptz; return;
  end if;

  perform set_config('app.tenant_id', p_tenant::text, true);
  update app.people p set user_id = v_user
   where p.tenant_id = p_tenant and p.phone_e164 = c.phone_e164 and p.archived_at is null
     and p.user_id is distinct from v_user;
  perform set_config('app.tenant_id', coalesce(v_prev, ''), true);

  insert into auth_private.sessions (token_hash, user_id, tenant_id, expires_at, ip, user_agent)
  values (p_token_hash, v_user, p_tenant, now() + make_interval(days => greatest(1, least(p_session_days, 90))),
          p_ip, left(p_user_agent, 300))
  returning id, sessions.expires_at into v_session, v_expires;

  return query select 'ok'::text, v_user, v_session, v_expires;
end $$;

-- A session works only on the community it was created for, and lapses after p_idle_days of no use.
create function auth_api.session_resolve(p_tenant uuid, p_token_hash bytea, p_idle_days integer)
returns table (session_id uuid, user_id uuid, phone_e164 text, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id   uuid;
  v_user uuid;
  v_phone text;
  v_exp  timestamptz;
  v_seen timestamptz;
begin
  select s.id, s.user_id, u.phone_e164, s.expires_at, s.last_seen_at
    into v_id, v_user, v_phone, v_exp, v_seen
    from auth_private.sessions s
    join auth_private.users u on u.id = s.user_id
   where s.token_hash = p_token_hash and s.tenant_id = p_tenant and s.revoked_at is null
     and s.expires_at > now() and u.disabled_at is null
     and s.last_seen_at > now() - make_interval(days => p_idle_days);
  if not found then return; end if;
  if v_seen < now() - interval '5 minutes' then
    update auth_private.sessions set last_seen_at = now() where id = v_id;
  end if;
  return query select v_id, v_user, v_phone, v_exp;
end $$;

create function auth_api.session_revoke(p_token_hash bytea) returns void
language sql security definer set search_path = ''
as $$ update auth_private.sessions set revoked_at = now() where token_hash = p_token_hash and revoked_at is null $$;

create function auth_api.purge_expired() returns void
language sql security definer set search_path = ''
as $$
  delete from auth_private.otp_challenges where created_at < now() - interval '2 days';
  delete from auth_private.sessions where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days';
$$;

revoke all on all functions in schema auth_api from public;
grant usage on schema auth_api to pragati_app;
grant execute on function auth_api.otp_start(uuid, uuid, text, text, integer, inet),
                          auth_api.otp_verify(uuid, uuid, text, bytea, integer, inet, text),
                          auth_api.session_resolve(uuid, bytea, integer),
                          auth_api.session_revoke(bytea),
                          auth_api.purge_expired()
  to pragati_app;
revoke all on function app.resolve_tenant(text, text) from public;
grant execute on function app.resolve_tenant(text, text) to pragati_app, pragati_platform;

-- ---------------------------------------------------------------------------------------------
-- Platform operations (our onboarding team). Granted only to pragati_platform.
-- ---------------------------------------------------------------------------------------------
create function platform.role_templates()
returns table (key text, name text, description text, permissions text[])
language sql stable set search_path = ''
as $$
  values
  ('administrator', 'Administrator', 'Full access to the community''s platform',
     array(select c.key from app.permission_catalog c order by c.key)),
  ('office_bearer', 'Office bearer', 'President, Secretary or Treasurer: committee access plus signed-letter approvals',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','approvals.override','audit.view','files.upload']),
  ('committee_member', 'Committee member', 'Sees the community''s records and raises approval requests',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload']),
  ('block_committee_member', 'Block committee member', 'Committee access limited to one block or phase',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload']),
  ('facility_manager', 'Facility manager', 'Runs day-to-day operations',
     array['property.view','units.view','people.view','approvals.view','approvals.propose','files.upload']),
  ('staff', 'Staff', 'On-site staff', array['property.view','units.view']),
  ('owner', 'Owner', 'Sees their own homes, notices and requests', array[]::text[]),
  ('resident', 'Resident', 'Tenant or family member living in a home', array[]::text[]),
  ('auditor', 'Auditor (view only)', 'Reads records and the audit trail, and can export data',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'audit.view','data.export'])
$$;

create function platform.create_tenant(
  p_slug text, p_brand_name text, p_legal_name text, p_city text,
  p_root_kind text, p_root_name text, p_admin_name text, p_admin_phone text,
  p_domains text[] default '{}', p_hosting_tier text default 'shared')
returns uuid
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_prev   text := current_setting('app.tenant_id', true);
  v_tenant uuid := gen_random_uuid();
  v_root   uuid;
  v_admin  uuid;
  v_role   uuid;
  v_comm   uuid;
  v_rule   uuid;
  d        text;
begin
  if p_root_kind not in ('community', 'federation') then
    raise exception 'The top of the property tree must be a community or a federation' using errcode = '22023';
  end if;
  insert into app.tenants (id, slug, brand_name, legal_name, city, hosting_tier)
  values (v_tenant, p_slug, p_brand_name, p_legal_name, p_city, p_hosting_tier);
  foreach d in array p_domains loop
    insert into app.tenant_domains (domain, tenant_id, is_primary) values (lower(d), v_tenant, d = p_domains[1]);
  end loop;

  perform set_config('app.tenant_id', v_tenant::text, true);

  insert into app.property_nodes (kind, name) values (p_root_kind, p_root_name) returning id into v_root;

  insert into app.unit_types (code, name, category, bedrooms, sort_order) values
    ('studio', 'Studio', 'apartment', 0, 10), ('1bhk', '1 BHK', 'apartment', 1, 20),
    ('2bhk', '2 BHK', 'apartment', 2, 30), ('2.5bhk', '2.5 BHK', 'apartment', 2.5, 35),
    ('3bhk', '3 BHK', 'apartment', 3, 40), ('3.5bhk', '3.5 BHK', 'apartment', 3.5, 45),
    ('4bhk', '4 BHK', 'apartment', 4, 50), ('5bhk', '5 BHK', 'apartment', 5, 55),
    ('duplex', 'Duplex', 'apartment', null, 60), ('penthouse', 'Penthouse', 'apartment', null, 65),
    ('villa', 'Villa', 'villa', null, 70), ('row_house', 'Row house', 'row_house', null, 75),
    ('plot', 'Plot', 'plot', null, 80), ('shop', 'Shop', 'commercial', null, 90),
    ('office', 'Office', 'commercial', null, 95);

  insert into app.roles (key, name, description, permissions, is_template)
  select r.key, r.name, r.description, r.permissions, true from platform.role_templates() r;

  insert into app.people (full_name, phone_e164) values (p_admin_name, p_admin_phone) returning id into v_admin;
  select id into v_role from app.roles where key = 'administrator';
  insert into app.memberships (person_id, role_id) values (v_admin, v_role);

  insert into app.committees (name, kind, scope_node_id)
  values (case when p_root_kind = 'federation' then 'Federation council' else 'Managing committee' end,
          case when p_root_kind = 'federation' then 'federation' else 'apex' end, v_root)
  returning id into v_comm;

  -- The JAOA policy as the starting point: every decision needs every committee member's approval.
  insert into app.approval_rules (name, subject_type, priority)
  values ('All decisions: unanimous committee approval', '*', 0) returning id into v_rule;
  insert into app.approval_rule_stages (rule_id, stage_no, label, committee_selector, mode)
  values (v_rule, 1, 'Committee', 'apex', 'unanimous');

  insert into app.audit_events (action, entity_type, entity_id, summary, data)
  values ('community.created', 'tenant', v_tenant::text, p_brand_name || ' Pragati was set up',
          jsonb_build_object('slug', p_slug, 'hosting_tier', p_hosting_tier));

  perform set_config('app.tenant_id', coalesce(v_prev, ''), true);
  return v_tenant;
end $$;

create function platform.set_tenant_status(p_tenant uuid, p_status text) returns void
language sql security definer set search_path = ''
as $$ update app.tenants set status = p_status where id = p_tenant $$;

create function platform.add_domain(p_tenant uuid, p_domain text, p_primary boolean default false) returns void
language sql security definer set search_path = ''
as $$ insert into app.tenant_domains (domain, tenant_id, is_primary) values (lower(p_domain), p_tenant, p_primary) $$;

-- Usage per community for billing and capacity planning. Counts only; no personal data.
create function platform.tenant_usage()
returns table (tenant_id uuid, platform_name text, status text, hosting_tier text, locations bigint,
               units bigint, people bigint, active_members bigint, pending_approvals bigint)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  t      record;
  v_prev text := current_setting('app.tenant_id', true);
begin
  for t in select x.id, x.platform_name, x.status, x.hosting_tier from app.tenants x order by x.created_at loop
    perform set_config('app.tenant_id', t.id::text, true);
    return query select t.id, t.platform_name, t.status, t.hosting_tier,
      (select count(*) from app.property_nodes), (select count(*) from app.units where archived_at is null),
      (select count(*) from app.people where archived_at is null),
      (select count(*) from app.memberships m where m.status = 'active'),
      (select count(*) from app.approval_requests r where r.status = 'pending');
  end loop;
  perform set_config('app.tenant_id', coalesce(v_prev, ''), true);
end $$;

revoke all on all functions in schema platform from public;
grant usage on schema platform to pragati_platform;
grant execute on function platform.create_tenant(text, text, text, text, text, text, text, text, text[], text),
                          platform.set_tenant_status(uuid, text),
                          platform.add_domain(uuid, text, boolean),
                          platform.tenant_usage(),
                          platform.role_templates()
  to pragati_platform;
