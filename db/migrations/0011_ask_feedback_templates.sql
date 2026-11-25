-- Pragati Cloud · 0011 answer ratings, notice templates and feedback
--
-- Carried over from JAOA Pragati:
--   * people rate Ask Pragathi's answers, so the committee can see where it helps and where it does not
--   * notice templates with fill-in fields ({{date}}, {{time}}), such as a water shut-off or a lift outage
--   * a feedback route from every screen to the platform team

alter table app.ask_questions
  add column rating      smallint check (rating in (-1, 1)),
  add column rating_note text check (rating_note is null or length(rating_note) <= 1000);
grant update (rating, rating_note) on app.ask_questions to pragati_app;

create table app.notice_templates (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant() references app.tenants (id),
  title       text not null check (length(btrim(title)) between 3 and 160),
  body        text not null check (length(btrim(body)) between 3 and 8000),
  category    text not null default 'general' check (category in ('general', 'maintenance', 'meeting', 'finance', 'security', 'event', 'emergency')),
  audience    text not null default 'everyone' check (audience in ('everyone', 'owners', 'committee', 'staff')),
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  primary key (id), unique (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);

create table app.feedback (
  id         uuid not null default gen_random_uuid(),
  tenant_id  uuid not null default app.current_tenant() references app.tenants (id),
  person_id  uuid not null,
  kind       text not null check (kind in ('problem', 'idea', 'question', 'praise')),
  body       text not null check (length(btrim(body)) between 3 and 3000),
  page       text check (page is null or length(page) <= 200),
  created_at timestamptz not null default now(),
  primary key (id), unique (tenant_id, id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['notice_templates', 'feedback']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy tenant_isolation on app.%I using (tenant_id = (select app.current_tenant())) '
                   'with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;
grant select, insert, update on app.notice_templates to pragati_app;
grant select, insert on app.feedback to pragati_app;

-- The platform team reads feedback across communities.
create policy platform_read on app.feedback for select to pragati_platform using (true);
grant select on app.feedback to pragati_platform;
