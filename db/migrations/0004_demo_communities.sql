-- Pragati Cloud · 0004 demo communities
-- A demo community holds only made-up sample data. Its sign-in code is shown on screen, so people
-- can try the platform before SMS is set up. Only the platform role can mark a community as a demo;
-- a real community is never one.
alter table app.tenants add column is_demo boolean not null default false;

drop function app.resolve_tenant(text, text);
create function app.resolve_tenant(p_host text, p_base_domain text)
returns table (id uuid, slug text, brand_name text, platform_name text, primary_color text,
               logo_file_id uuid, languages text[], assistant_name text, status text, is_demo boolean)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.slug, t.brand_name, t.platform_name, t.primary_color, t.logo_file_id, t.languages,
         t.assistant_name, t.status, t.is_demo
    from app.tenants t
   where t.id = coalesce(
           (select d.tenant_id from app.tenant_domains d where d.domain = lower(p_host)),
           (select t2.id from app.tenants t2
             where lower(p_host) = t2.slug || '.' || lower(p_base_domain)))
$$;
revoke all on function app.resolve_tenant(text, text) from public;
grant execute on function app.resolve_tenant(text, text) to pragati_app, pragati_platform;

create function platform.set_demo(p_tenant uuid, p_demo boolean) returns void
language sql security definer set search_path = ''
as $$ update app.tenants set is_demo = p_demo where id = p_tenant $$;
revoke all on function platform.set_demo(uuid, boolean) from public;
grant execute on function platform.set_demo(uuid, boolean) to pragati_platform;
