-- Pragati Cloud · 0009 Ask Pragathi
-- The assistant answers from the community's own records, with only what the person asking may see:
-- every lookup it makes goes through the same API, permissions and row-level security as the app.
-- A community switches it on in its settings, because questions and the records used to answer them
-- are sent to the AI provider. Each question is logged with its cost, for limits and for the person's
-- own history.

alter table app.tenants add column assistant_enabled boolean not null default false;
grant update (assistant_enabled) on app.tenants to pragati_app;

-- Demo communities hold only made-up data, so the assistant is on for them.
update app.tenants set assistant_enabled = true where is_demo;

drop function app.resolve_tenant(text, text);
create function app.resolve_tenant(p_host text, p_base_domain text)
returns table (id uuid, slug text, brand_name text, platform_name text, primary_color text,
               logo_file_id uuid, languages text[], assistant_name text, status text, is_demo boolean, assistant_enabled boolean)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.slug, t.brand_name, t.platform_name, t.primary_color, t.logo_file_id, t.languages,
         t.assistant_name, t.status, t.is_demo, t.assistant_enabled
    from app.tenants t
   where t.id = coalesce(
           (select d.tenant_id from app.tenant_domains d where d.domain = lower(p_host)),
           (select t2.id from app.tenants t2
             where lower(p_host) = t2.slug || '.' || lower(p_base_domain)))
$$;
revoke all on function app.resolve_tenant(text, text) from public;
grant execute on function app.resolve_tenant(text, text) to pragati_app, pragati_platform;

-- A demo community made by the platform later starts with the assistant on.
create or replace function platform.set_demo(p_tenant uuid, p_demo boolean) returns void
language sql security definer set search_path = ''
as $$ update app.tenants set is_demo = p_demo, assistant_enabled = assistant_enabled or p_demo where id = p_tenant $$;

create table app.ask_questions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default app.current_tenant() references app.tenants (id) on delete cascade,
  person_id      uuid not null,
  question       text not null check (length(question) between 1 and 1000),
  answer         text,
  language       text not null default 'en',
  lookups        text[] not null default '{}',
  model          text,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  error          text,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id)
);
create index ask_questions_person on app.ask_questions (tenant_id, person_id, created_at desc);
create index ask_questions_month on app.ask_questions (tenant_id, created_at);

alter table app.ask_questions enable row level security;
alter table app.ask_questions force row level security;
create policy tenant_isolation on app.ask_questions using (tenant_id = (select app.current_tenant()))
  with check (tenant_id = (select app.current_tenant()));
grant select, insert on app.ask_questions to pragati_app;
