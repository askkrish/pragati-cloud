-- Pragati Cloud · 0001 foundation
--
-- Runs as the schema owner (pragati_owner). It needs CREATEROLE but not superuser, which matches
-- the administrator account on Azure Database for PostgreSQL Flexible Server.
--
-- Isolation model
--   * Every community (tenant) row carries tenant_id. Row-level security limits each statement to
--     the community named by the transaction-local setting app.tenant_id.
--   * The application connects as a member of pragati_app, which owns nothing and cannot bypass
--     row-level security. Every request runs inside one transaction that sets app.tenant_id with
--     set_config(..., true), so the setting can never leak to the next request on a pooled connection.
--   * Foreign keys include tenant_id, so a row can only point at rows of its own community even if
--     application code passes a wrong id.
--   * Sign-in tables live in auth_private, which pragati_app cannot read at all. It reaches them only
--     through the SECURITY DEFINER functions in auth_api.

-- ---------------------------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pragati_app') then
    create role pragati_app nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'pragati_platform') then
    create role pragati_platform nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;

create schema if not exists app;
create schema if not exists auth_private;
create schema if not exists auth_api;
create schema if not exists platform;

revoke all on schema public from public;
revoke all on schema app, auth_private, auth_api, platform from public;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create function app.current_tenant() returns uuid
language sql stable parallel safe
as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create function app.touch_updated_at() returns trigger
language plpgsql
as $$ begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------------------------------------
-- Communities (tenants)
-- ---------------------------------------------------------------------------------------------
create table app.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  brand_name      text not null check (length(btrim(brand_name)) between 1 and 40),
  -- Decision of 25 Nov 2026: every community names its own platform as "<their name> Pragati",
  -- the way Jains Ansruta has "JAOA Pragati".
  platform_name   text generated always as (btrim(brand_name) || ' Pragati') stored,
  legal_name      text not null,
  registration_no text,
  state           text not null default 'Tamil Nadu',
  city            text,
  timezone        text not null default 'Asia/Kolkata',
  languages       text[] not null default '{en}' check (cardinality(languages) between 1 and 6),
  primary_color   text not null default '#1f4d7a' check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  assistant_name  text not null default 'Ask Pragathi',
  logo_file_id    uuid,
  hosting_tier    text not null default 'shared' check (hosting_tier in ('shared', 'dedicated', 'customer_cloud')),
  status          text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger tenants_touch before update on app.tenants for each row execute function app.touch_updated_at();

create table app.tenant_domains (
  domain     text primary key check (domain = lower(domain)),
  tenant_id  uuid not null references app.tenants (id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index tenant_domains_tenant_idx on app.tenant_domains (tenant_id);

-- Per-community counters for human-readable references such as AP-0007.
create table app.tenant_counters (
  tenant_id uuid not null default app.current_tenant() references app.tenants (id) on delete cascade,
  name      text not null,
  value     bigint not null default 0,
  primary key (tenant_id, name)
);

create function app.next_ref(p_name text, p_prefix text) returns text
language plpgsql
as $$
declare v bigint;
begin
  insert into app.tenant_counters (tenant_id, name, value) values (app.current_tenant(), p_name, 1)
  on conflict (tenant_id, name) do update set value = app.tenant_counters.value + 1
  returning value into v;
  return p_prefix || '-' || lpad(v::text, 4, '0');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Files (logos, signed approval letters, ownership documents). Bytes live in Blob Storage.
-- ---------------------------------------------------------------------------------------------
create table app.files (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  purpose       text not null check (purpose in ('logo', 'approval_letter', 'ownership_document', 'import', 'other')),
  storage_key   text not null,
  file_name     text not null,
  content_type  text not null,
  size_bytes    bigint not null check (size_bytes > 0),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by   uuid,
  created_at    timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id)
);
create index files_tenant_idx on app.files (tenant_id, created_at desc);

alter table app.tenants
  add constraint tenants_logo_fk foreign key (id, logo_file_id) references app.files (tenant_id, id);

-- ---------------------------------------------------------------------------------------------
-- Property tree: Community / Federation → Phase / Zone → Block / Tower → Wing → Floor (any depth)
-- ---------------------------------------------------------------------------------------------
create table app.property_nodes (
  id           uuid not null default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant() references app.tenants (id),
  parent_id    uuid,
  kind         text not null check (kind in ('federation', 'community', 'phase', 'zone', 'block', 'tower',
                                             'wing', 'sub_block', 'floor', 'street', 'cluster', 'other')),
  name         text not null check (length(btrim(name)) between 1 and 80),
  code         text check (code is null or length(code) <= 20),
  sort_order   integer not null default 0,
  ancestor_ids uuid[] not null default '{}',
  depth        smallint not null default 0,
  attributes   jsonb not null default '{}' check (jsonb_typeof(attributes) = 'object'),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique nulls not distinct (tenant_id, parent_id, name),
  foreign key (tenant_id, parent_id) references app.property_nodes (tenant_id, id)
);
create unique index property_nodes_one_root on app.property_nodes (tenant_id) where parent_id is null;
create index property_nodes_parent_idx on app.property_nodes (tenant_id, parent_id, sort_order);
create index property_nodes_ancestors_idx on app.property_nodes using gin (ancestor_ids);

create function app.property_nodes_set_path() returns trigger
language plpgsql
as $$
declare p_ancestors uuid[];
begin
  if new.parent_id is null then
    new.ancestor_ids := '{}';
    new.depth := 0;
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'A location cannot be placed inside itself' using errcode = '23514';
  end if;
  select ancestor_ids into p_ancestors
    from app.property_nodes where tenant_id = new.tenant_id and id = new.parent_id;
  if not found then
    raise exception 'The parent location does not exist' using errcode = '23503';
  end if;
  if new.id = any (p_ancestors) then
    raise exception 'A location cannot be placed inside one of its own sub-locations' using errcode = '23514';
  end if;
  new.ancestor_ids := p_ancestors || new.parent_id;
  new.depth := cardinality(new.ancestor_ids);
  return new;
end $$;

create function app.property_nodes_move_subtree() returns trigger
language plpgsql
as $$
begin
  update app.property_nodes d
     set ancestor_ids = new.ancestor_ids || new.id || d.ancestor_ids[array_position(d.ancestor_ids, new.id) + 1:],
         depth = cardinality(new.ancestor_ids || new.id || d.ancestor_ids[array_position(d.ancestor_ids, new.id) + 1:])
   where d.tenant_id = new.tenant_id and new.id = any (d.ancestor_ids);
  return null;
end $$;

create trigger property_nodes_path before insert or update of parent_id on app.property_nodes
  for each row execute function app.property_nodes_set_path();
create trigger property_nodes_move after update of parent_id on app.property_nodes
  for each row when (old.parent_id is distinct from new.parent_id)
  execute function app.property_nodes_move_subtree();
create trigger property_nodes_touch before update on app.property_nodes
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Units
-- ---------------------------------------------------------------------------------------------
create table app.unit_types (
  id         uuid not null default gen_random_uuid(),
  tenant_id  uuid not null default app.current_tenant() references app.tenants (id),
  code       text not null check (code ~ '^[a-z0-9_.-]{1,24}$'),
  name       text not null,
  category   text not null check (category in ('apartment', 'villa', 'row_house', 'plot', 'commercial', 'other')),
  bedrooms   numeric(3, 1),
  sort_order integer not null default 0,
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create table app.units (
  id               uuid not null default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant() references app.tenants (id),
  node_id          uuid not null,
  unit_type_id     uuid not null,
  label            text not null check (length(btrim(label)) between 1 and 40),
  floor_no         smallint,
  carpet_sqft      numeric(10, 2) check (carpet_sqft is null or carpet_sqft > 0),
  builtup_sqft     numeric(10, 2) check (builtup_sqft is null or builtup_sqft > 0),
  super_sqft       numeric(10, 2) check (super_sqft is null or super_sqft > 0),
  plot_sqft        numeric(12, 2) check (plot_sqft is null or plot_sqft > 0),
  uds_sqft         numeric(12, 2) check (uds_sqft is null or uds_sqft > 0),
  occupancy        text not null default 'vacant'
                   check (occupancy in ('owner_occupied', 'let_out', 'vacant', 'under_construction')),
  attributes       jsonb not null default '{}' check (jsonb_typeof(attributes) = 'object'),
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, label),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, unit_type_id) references app.unit_types (tenant_id, id)
);
create index units_node_idx on app.units (tenant_id, node_id);
create index units_type_idx on app.units (tenant_id, unit_type_id);
create trigger units_touch before update on app.units for each row execute function app.touch_updated_at();

create table app.parking_slots (
  id         uuid not null default gen_random_uuid(),
  tenant_id  uuid not null default app.current_tenant() references app.tenants (id),
  node_id    uuid not null,
  label      text not null,
  kind       text not null default 'covered' check (kind in ('covered', 'open', 'stack', 'two_wheeler', 'visitor')),
  unit_id    uuid,
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, label),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, unit_id) references app.units (tenant_id, id)
);
create index parking_slots_unit_idx on app.parking_slots (tenant_id, unit_id);
create index parking_slots_node_idx on app.parking_slots (tenant_id, node_id);

create table app.meters (
  id         uuid not null default gen_random_uuid(),
  tenant_id  uuid not null default app.current_tenant() references app.tenants (id),
  unit_id    uuid not null,
  kind       text not null check (kind in ('electricity', 'water', 'gas', 'dg_backup')),
  meter_no   text not null,
  provider   text,
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, kind, meter_no),
  foreign key (tenant_id, unit_id) references app.units (tenant_id, id)
);
create index meters_unit_idx on app.meters (tenant_id, unit_id);

-- ---------------------------------------------------------------------------------------------
-- People, ownership and occupancy
-- ---------------------------------------------------------------------------------------------
create table app.people (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant() references app.tenants (id),
  full_name   text not null check (length(btrim(full_name)) between 1 and 120),
  phone_e164  text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email       text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  user_id     uuid,
  language    text not null default 'en',
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id)
);
create unique index people_phone_unique on app.people (tenant_id, phone_e164)
  where phone_e164 is not null and archived_at is null;
create index people_user_idx on app.people (tenant_id, user_id);
create index people_name_idx on app.people (tenant_id, lower(full_name));
create trigger people_touch before update on app.people for each row execute function app.touch_updated_at();

create table app.ownerships (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant() references app.tenants (id),
  unit_id     uuid not null,
  person_id   uuid not null,
  share_pct   numeric(5, 2) not null check (share_pct > 0 and share_pct <= 100),
  starts_on   date not null default current_date,
  ends_on     date check (ends_on is null or ends_on >= starts_on),
  document_id uuid,
  created_at  timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  foreign key (tenant_id, unit_id) references app.units (tenant_id, id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id),
  foreign key (tenant_id, document_id) references app.files (tenant_id, id)
);
create index ownerships_unit_idx on app.ownerships (tenant_id, unit_id) where ends_on is null;
create index ownerships_person_idx on app.ownerships (tenant_id, person_id);
create unique index ownerships_active_unique on app.ownerships (tenant_id, unit_id, person_id) where ends_on is null;

-- Shares are checked at commit, so a sale can end the old owners and add the new ones in one step.
create function app.check_ownership_shares() returns trigger
language plpgsql
as $$
declare total numeric;
begin
  select coalesce(sum(share_pct), 0) into total
    from app.ownerships where tenant_id = new.tenant_id and unit_id = new.unit_id and ends_on is null;
  if total > 100 then
    raise exception 'Ownership shares for this unit add up to % percent; they cannot exceed 100', total
      using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger ownerships_share_check after insert or update on app.ownerships
  deferrable initially deferred for each row execute function app.check_ownership_shares();

create table app.occupancies (
  id                 uuid not null default gen_random_uuid(),
  tenant_id          uuid not null default app.current_tenant() references app.tenants (id),
  unit_id            uuid not null,
  person_id          uuid not null,
  relation           text not null check (relation in ('owner', 'tenant', 'family', 'caretaker')),
  is_primary_contact boolean not null default false,
  starts_on          date not null default current_date,
  ends_on            date check (ends_on is null or ends_on >= starts_on),
  created_at         timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  foreign key (tenant_id, unit_id) references app.units (tenant_id, id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id)
);
create index occupancies_unit_idx on app.occupancies (tenant_id, unit_id) where ends_on is null;
create index occupancies_person_idx on app.occupancies (tenant_id, person_id);

-- ---------------------------------------------------------------------------------------------
-- Roles and memberships. Each community defines its own roles from a fixed list of permissions.
-- ---------------------------------------------------------------------------------------------
create table app.permission_catalog (
  key   text primary key,
  area  text not null,
  label text not null
);

insert into app.permission_catalog (key, area, label) values
  ('settings.manage',        'Settings',   'Change the platform name, branding and languages'),
  ('property.view',          'Property',   'See blocks, wings, floors and other locations'),
  ('property.manage',        'Property',   'Add, rename and move locations'),
  ('units.view',             'Units',      'See units and their details'),
  ('units.manage',           'Units',      'Add and edit units, parking and meters; import units'),
  ('people.view',            'People',     'See the people directory'),
  ('people.manage',          'People',     'Add and edit people, owners and occupants'),
  ('roles.manage',           'Access',     'Create and edit roles'),
  ('members.manage',         'Access',     'Give people access and assign roles'),
  ('committees.view',        'Committees', 'See committees and their members'),
  ('committees.manage',      'Committees', 'Create committees and change their members'),
  ('approval_rules.view',    'Approvals',  'See approval rules'),
  ('approval_rules.manage',  'Approvals',  'Create and edit approval rules'),
  ('approvals.view',         'Approvals',  'See approval requests'),
  ('approvals.propose',      'Approvals',  'Raise an approval request'),
  ('approvals.override',     'Approvals',  'Record approval by a signed letter, or close a request as rejected'),
  ('audit.view',             'Records',    'See the audit trail'),
  ('files.upload',           'Records',    'Upload documents'),
  ('data.export',            'Records',    'Download a full export of the community''s data');

create table app.roles (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant() references app.tenants (id),
  key         text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  name        text not null,
  description text not null default '',
  permissions text[] not null default '{}',
  is_template boolean not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, key)
);
create trigger roles_touch before update on app.roles for each row execute function app.touch_updated_at();

create function app.check_role_permissions() returns trigger
language plpgsql
as $$
declare unknown text;
begin
  select p into unknown from unnest(new.permissions) p
   where not exists (select 1 from app.permission_catalog c where c.key = p) limit 1;
  if unknown is not null then
    raise exception 'Unknown permission: %', unknown using errcode = '23514';
  end if;
  return new;
end $$;
create trigger roles_permissions before insert or update of permissions on app.roles
  for each row execute function app.check_role_permissions();

-- scope_node_id null = the whole community; otherwise the role applies to that location and below.
create table app.memberships (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  person_id     uuid not null,
  role_id       uuid not null,
  scope_node_id uuid,
  status        text not null default 'active' check (status in ('active', 'disabled')),
  created_at    timestamptz not null default now(),
  disabled_at   timestamptz,
  primary key (id),
  unique (tenant_id, id),
  unique nulls not distinct (tenant_id, person_id, role_id, scope_node_id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id),
  foreign key (tenant_id, role_id) references app.roles (tenant_id, id),
  foreign key (tenant_id, scope_node_id) references app.property_nodes (tenant_id, id)
);
create index memberships_person_idx on app.memberships (tenant_id, person_id) where status = 'active';
create index memberships_role_idx on app.memberships (tenant_id, role_id);
create index memberships_scope_idx on app.memberships (tenant_id, scope_node_id);

-- ---------------------------------------------------------------------------------------------
-- Committees: an apex committee or federation council, with block committees beneath it.
-- ---------------------------------------------------------------------------------------------
create table app.committees (
  id                  uuid not null default gen_random_uuid(),
  tenant_id           uuid not null default app.current_tenant() references app.tenants (id),
  name                text not null,
  kind                text not null check (kind in ('apex', 'federation', 'block', 'sub_committee')),
  scope_node_id       uuid not null,
  parent_committee_id uuid,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, name),
  foreign key (tenant_id, scope_node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, parent_committee_id) references app.committees (tenant_id, id)
);
create index committees_scope_idx on app.committees (tenant_id, scope_node_id);
create index committees_parent_idx on app.committees (tenant_id, parent_committee_id);

create table app.committee_seats (
  id           uuid not null default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant() references app.tenants (id),
  committee_id uuid not null,
  person_id    uuid not null,
  position     text not null default 'member'
               check (position in ('president', 'vice_president', 'secretary', 'joint_secretary', 'treasurer', 'member')),
  starts_on    date not null default current_date,
  ends_on      date check (ends_on is null or ends_on >= starts_on),
  created_at   timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  foreign key (tenant_id, committee_id) references app.committees (tenant_id, id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id)
);
create unique index committee_seats_active_unique on app.committee_seats (tenant_id, committee_id, person_id)
  where ends_on is null;
create index committee_seats_person_idx on app.committee_seats (tenant_id, person_id);

-- ---------------------------------------------------------------------------------------------
-- Approval rules are settings, not code
-- ---------------------------------------------------------------------------------------------
create table app.approval_rules (
  id                    uuid not null default gen_random_uuid(),
  tenant_id             uuid not null default app.current_tenant() references app.tenants (id),
  name                  text not null,
  subject_type          text not null default '*'
                        check (subject_type in ('*', 'expense', 'project', 'vendor_selection', 'work_order',
                                                'work_order_change', 'policy', 'other')),
  scope_node_id         uuid,
  min_amount_paise      bigint not null default 0 check (min_amount_paise >= 0),
  max_amount_paise      bigint check (max_amount_paise is null or max_amount_paise > min_amount_paise),
  priority              integer not null default 0,
  proposer_auto_approve boolean not null default true,
  allow_letter_override boolean not null default true,
  active                boolean not null default true,
  version               integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  foreign key (tenant_id, scope_node_id) references app.property_nodes (tenant_id, id)
);
create index approval_rules_lookup_idx on app.approval_rules (tenant_id, subject_type) where active;
create trigger approval_rules_touch before update on app.approval_rules for each row execute function app.touch_updated_at();

-- committee_selector:
--   fixed   → the committee named in committee_id
--   nearest → the committee whose location is closest above (or at) the request's location
--   apex    → the community's apex committee or federation council
create table app.approval_rule_stages (
  id                 uuid not null default gen_random_uuid(),
  tenant_id          uuid not null default app.current_tenant() references app.tenants (id),
  rule_id            uuid not null,
  stage_no           smallint not null check (stage_no between 1 and 5),
  label              text not null,
  committee_selector text not null check (committee_selector in ('fixed', 'nearest', 'apex')),
  committee_id       uuid,
  mode               text not null check (mode in ('unanimous', 'majority', 'count', 'any')),
  required_count     smallint check (required_count is null or required_count >= 1),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, rule_id, stage_no),
  foreign key (tenant_id, rule_id) references app.approval_rules (tenant_id, id) on delete cascade,
  foreign key (tenant_id, committee_id) references app.committees (tenant_id, id),
  check ((committee_selector = 'fixed') = (committee_id is not null)),
  check ((mode = 'count') = (required_count is not null))
);
create index approval_rule_stages_committee_idx on app.approval_rule_stages (tenant_id, committee_id);

create table app.approval_requests (
  id                 uuid not null default gen_random_uuid(),
  tenant_id          uuid not null default app.current_tenant() references app.tenants (id),
  ref                text not null,
  subject_type       text not null check (subject_type in ('expense', 'project', 'vendor_selection', 'work_order',
                                                           'work_order_change', 'policy', 'other')),
  subject_id         uuid,
  title              text not null check (length(btrim(title)) between 3 and 200),
  details            text not null default '',
  amount_paise       bigint check (amount_paise is null or amount_paise >= 0),
  scope_node_id      uuid not null,
  rule_id            uuid not null,
  rule_snapshot      jsonb not null,
  status             text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  current_stage      smallint not null default 1,
  proposer_person_id uuid not null,
  outcome_note       text,
  override           jsonb,
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  foreign key (tenant_id, scope_node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, rule_id) references app.approval_rules (tenant_id, id),
  foreign key (tenant_id, proposer_person_id) references app.people (tenant_id, id)
);
create index approval_requests_status_idx on app.approval_requests (tenant_id, status, created_at desc);
create index approval_requests_scope_idx on app.approval_requests (tenant_id, scope_node_id);
create index approval_requests_rule_idx on app.approval_requests (tenant_id, rule_id);
create index approval_requests_proposer_idx on app.approval_requests (tenant_id, proposer_person_id);

create table app.approval_stages (
  tenant_id      uuid not null default app.current_tenant() references app.tenants (id),
  request_id     uuid not null,
  stage_no       smallint not null,
  label          text not null,
  committee_id   uuid not null,
  mode           text not null check (mode in ('unanimous', 'majority', 'count', 'any')),
  required_count smallint,
  status         text not null default 'waiting' check (status in ('waiting', 'open', 'approved')),
  opened_at      timestamptz,
  decided_at     timestamptz,
  primary key (tenant_id, request_id, stage_no),
  foreign key (tenant_id, request_id) references app.approval_requests (tenant_id, id) on delete cascade,
  foreign key (tenant_id, committee_id) references app.committees (tenant_id, id)
);
create index approval_stages_committee_idx on app.approval_stages (tenant_id, committee_id) where status = 'open';

-- The people asked to vote, frozen when the stage opens. Someone who later leaves the committee
-- stops counting, as in JAOA Pragati.
create table app.approval_stage_voters (
  tenant_id  uuid not null default app.current_tenant() references app.tenants (id),
  request_id uuid not null,
  stage_no   smallint not null,
  person_id  uuid not null,
  primary key (tenant_id, request_id, stage_no, person_id),
  foreign key (tenant_id, request_id, stage_no) references app.approval_stages (tenant_id, request_id, stage_no) on delete cascade,
  foreign key (tenant_id, person_id) references app.people (tenant_id, id)
);
create index approval_stage_voters_person_idx on app.approval_stage_voters (tenant_id, person_id);

create table app.approval_votes (
  tenant_id  uuid not null default app.current_tenant() references app.tenants (id),
  request_id uuid not null,
  stage_no   smallint not null,
  person_id  uuid not null,
  vote       text not null check (vote in ('approve', 'object')),
  note       text not null default '',
  voted_at   timestamptz not null default now(),
  primary key (tenant_id, request_id, stage_no, person_id),
  foreign key (tenant_id, request_id, stage_no, person_id)
    references app.approval_stage_voters (tenant_id, request_id, stage_no, person_id) on delete cascade,
  check (vote = 'approve' or length(btrim(note)) > 0)
);

-- ---------------------------------------------------------------------------------------------
-- Audit trail: append-only, for everyone including the schema owner
-- ---------------------------------------------------------------------------------------------
create table app.audit_events (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null default app.current_tenant() references app.tenants (id),
  at              timestamptz not null default now(),
  actor_person_id uuid,
  actor_user_id   uuid,
  action          text not null,
  entity_type     text not null,
  entity_id       text,
  summary         text not null,
  data            jsonb not null default '{}',
  request_id      text,
  ip              inet
);
create index audit_events_tenant_idx on app.audit_events (tenant_id, at desc);
create index audit_events_entity_idx on app.audit_events (tenant_id, entity_type, entity_id);

create function app.audit_is_append_only() returns trigger
language plpgsql
as $$ begin raise exception 'The audit trail cannot be changed or deleted' using errcode = '42501'; end $$;
create trigger audit_events_no_update before update or delete on app.audit_events
  for each row execute function app.audit_is_append_only();
create trigger audit_events_no_truncate before truncate on app.audit_events
  for each statement execute function app.audit_is_append_only();

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'tenant_counters', 'files', 'property_nodes', 'unit_types', 'units', 'parking_slots', 'meters',
    'people', 'ownerships', 'occupancies', 'roles', 'memberships', 'committees', 'committee_seats',
    'approval_rules', 'approval_rule_stages', 'approval_requests', 'approval_stages',
    'approval_stage_voters', 'approval_votes', 'audit_events']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy tenant_isolation on app.%I using (tenant_id = (select app.current_tenant())) '
                   'with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;

-- tenants and tenant_domains are not forced, so the owner-run lookup functions below can find a
-- community by its web address before any community is selected. The application role still only
-- sees its own community.
alter table app.tenants enable row level security;
create policy tenant_self on app.tenants using (id = (select app.current_tenant()));
create policy platform_all on app.tenants for select to pragati_platform using (true);

alter table app.tenant_domains enable row level security;
create policy tenant_self on app.tenant_domains for select using (tenant_id = (select app.current_tenant()));
create policy platform_all on app.tenant_domains for select to pragati_platform using (true);

-- ---------------------------------------------------------------------------------------------
-- Grants for the application role
-- ---------------------------------------------------------------------------------------------
grant usage on schema app to pragati_app, pragati_platform;
grant execute on function app.current_tenant(), app.next_ref(text, text) to pragati_app;

grant select on app.tenants, app.tenant_domains, app.permission_catalog to pragati_app;
grant update (brand_name, legal_name, registration_no, city, languages, primary_color, assistant_name, logo_file_id)
  on app.tenants to pragati_app;

grant select, insert, update on app.tenant_counters to pragati_app;
grant select, insert on app.files to pragati_app;
grant select, insert, update on
  app.property_nodes, app.unit_types, app.units, app.parking_slots, app.meters, app.people, app.ownerships,
  app.occupancies, app.roles, app.memberships, app.committees, app.committee_seats, app.approval_rules,
  app.approval_requests, app.approval_stages
  to pragati_app;
grant delete on app.parking_slots, app.meters to pragati_app;
grant select, insert, update, delete on app.approval_rule_stages to pragati_app;
grant select, insert on app.approval_stage_voters to pragati_app;
grant select, insert, update on app.approval_votes to pragati_app;
grant select, insert on app.audit_events to pragati_app;

grant select on app.tenants, app.tenant_domains to pragati_platform;
