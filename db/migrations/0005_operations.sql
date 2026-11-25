-- Pragati Cloud · 0005 operations
--
-- Carried over from JAOA Pragati's daily operations, projects, service requests and asset register,
-- rebuilt for communities of many blocks:
--   * assets and their renewals (AMC, warranty, insurance, licences, statutory inspections)
--   * routines with versioned schedules, so a change from next month never rewrites past days
--   * one check per routine per scheduled day: done, skipped (with a reason), blocked or in progress;
--     a scheduled day with no check after its window closes counts as missed
--   * work orders for owners' service requests, incidents, maintenance and projects, with an
--     append-only trail of updates; some updates are for staff only
-- Every record belongs to a place in the property tree, so block-level roles see only their block.

insert into app.permission_catalog (key, area, label) values
  ('operations.view',   'Operations', 'See routines, daily checks, work orders and the asset register'),
  ('operations.update', 'Operations', 'Record checks and update the work given to them'),
  ('operations.manage', 'Operations', 'Set up routines, work orders and assets, and assign people');

alter table app.files drop constraint files_purpose_check;
alter table app.files add constraint files_purpose_check
  check (purpose in ('logo', 'approval_letter', 'ownership_document', 'import', 'other', 'work_photo', 'contract'));

-- ---------------------------------------------------------------------------------------------
-- Asset register
-- ---------------------------------------------------------------------------------------------
create table app.assets (
  id           uuid not null default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant() references app.tenants (id),
  ref          text not null,
  node_id      uuid not null,
  facility_id  uuid,
  name         text not null check (length(btrim(name)) between 2 and 120),
  kind         text not null check (kind in ('lift', 'generator', 'pump', 'transformer', 'electrical', 'water_treatment',
                                             'sewage_treatment', 'fire_safety', 'cctv', 'access_control', 'pool', 'hvac',
                                             'solar', 'gym', 'garden', 'vehicle', 'other')),
  make         text check (make is null or length(make) <= 80),
  model        text check (model is null or length(model) <= 80),
  serial_no    text check (serial_no is null or length(serial_no) <= 80),
  installed_on date,
  service_by   text check (service_by is null or length(service_by) <= 120),
  notes        text not null default '' check (length(notes) <= 4000),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, facility_id) references app.facilities (tenant_id, id)
);
create index assets_node_idx on app.assets (tenant_id, node_id);
create trigger assets_touch before update on app.assets for each row execute function app.touch_updated_at();

-- AMCs, warranties, insurance, licences and inspections: anything with an end date to renew.
-- A renewal is a new row; the old one points at it, so the history of each contract is kept.
create table app.asset_contracts (
  id           uuid not null default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant() references app.tenants (id),
  ref          text not null,
  asset_id     uuid,
  node_id      uuid not null,
  kind         text not null check (kind in ('amc', 'warranty', 'insurance', 'licence', 'inspection', 'other')),
  title        text not null check (length(btrim(title)) between 3 and 160),
  provider     text check (provider is null or length(provider) <= 120),
  reference    text check (reference is null or length(reference) <= 80),
  starts_on    date,
  ends_on      date not null,
  remind_days  smallint not null default 30 check (remind_days between 0 and 365),
  amount_paise bigint check (amount_paise is null or amount_paise >= 0),
  file_id      uuid,
  renewed_by   uuid,
  notes        text not null default '' check (length(notes) <= 2000),
  archived_at  timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  check (starts_on is null or ends_on >= starts_on),
  check (renewed_by is null or renewed_by <> id),
  foreign key (tenant_id, asset_id) references app.assets (tenant_id, id),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, renewed_by) references app.asset_contracts (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);
create index asset_contracts_due_idx on app.asset_contracts (tenant_id, ends_on) where renewed_by is null and archived_at is null;
create index asset_contracts_asset_idx on app.asset_contracts (tenant_id, asset_id);

-- ---------------------------------------------------------------------------------------------
-- Routines and daily checks
-- ---------------------------------------------------------------------------------------------
create table app.routines (
  id                 uuid not null default gen_random_uuid(),
  tenant_id          uuid not null default app.current_tenant() references app.tenants (id),
  ref                text not null,
  title              text not null check (length(btrim(title)) between 3 and 120),
  instructions       text not null default '' check (length(instructions) <= 4000),
  category           text not null default 'general' check (category in ('security', 'housekeeping', 'garden', 'electrical',
                       'plumbing', 'lifts', 'water', 'fire_safety', 'pool', 'waste', 'general')),
  node_id            uuid not null,
  asset_id           uuid,
  assignee_person_id uuid,
  backup_person_id   uuid,
  archived_at        timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  check (backup_person_id is null or backup_person_id is distinct from assignee_person_id),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, asset_id) references app.assets (tenant_id, id),
  foreign key (tenant_id, assignee_person_id) references app.people (tenant_id, id),
  foreign key (tenant_id, backup_person_id) references app.people (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);
create index routines_node_idx on app.routines (tenant_id, node_id) where archived_at is null;
create index routines_assignee_idx on app.routines (tenant_id, assignee_person_id);
create trigger routines_touch before update on app.routines for each row execute function app.touch_updated_at();

-- A schedule applies from its effective date until the next version starts. Past days are always
-- judged by the version that applied on that day.
create table app.routine_schedules (
  tenant_id          uuid not null default app.current_tenant() references app.tenants (id),
  routine_id         uuid not null,
  effective_from     date not null,
  frequency          text not null check (frequency in ('once', 'daily', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'annually')),
  every              smallint not null default 1 check (every between 1 and 366),
  weekdays           smallint[] not null default '{}' check (weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]),
  month_days         smallint[] not null default '{}'
                       check (month_days <@ '{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31}'::smallint[]),
  starts_on          date not null,
  ends_on            date,
  start_time         time,
  end_time           time,
  paused             boolean not null default false,
  remarks            text not null default 'exception' check (remarks in ('optional', 'required', 'exception')),
  reading_label      text check (reading_label is null or length(reading_label) between 1 and 50),
  reading_unit       text check (reading_unit is null or length(reading_unit) between 1 and 16),
  photo_required     boolean not null default false,
  reference_required boolean not null default false,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  primary key (tenant_id, routine_id, effective_from),
  foreign key (tenant_id, routine_id) references app.routines (tenant_id, id) on delete cascade,
  check (ends_on is null or ends_on >= starts_on),
  check (end_time is null or (start_time is not null and end_time > start_time)),
  check (frequency <> 'weekly' or cardinality(weekdays) > 0),
  check (frequency not in ('monthly', 'quarterly', 'half_yearly', 'annually') or cardinality(month_days) > 0),
  check (reading_unit is null or reading_label is not null)
);

create table app.routine_checks (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  routine_id    uuid not null,
  occurrence_on date not null,
  status        text not null check (status in ('done', 'skipped', 'blocked', 'in_progress')),
  performed_at  timestamptz,
  note          text not null default '' check (length(note) <= 2400),
  reading       numeric(18, 6),
  reference     text check (reference is null or length(reference) <= 120),
  photo_file_id uuid,
  late          boolean not null default false,
  work_order_id uuid,
  recorded_by   uuid not null,
  recorded_at   timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, routine_id, occurrence_on),
  check (status not in ('skipped', 'blocked') or length(btrim(note)) > 0),
  foreign key (tenant_id, routine_id) references app.routines (tenant_id, id),
  foreign key (tenant_id, photo_file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, recorded_by) references app.people (tenant_id, id)
);
create index routine_checks_day_idx on app.routine_checks (tenant_id, occurrence_on);

-- ---------------------------------------------------------------------------------------------
-- Work orders: service requests, incidents, maintenance and projects
-- ---------------------------------------------------------------------------------------------
create table app.work_orders (
  id                  uuid not null default gen_random_uuid(),
  tenant_id           uuid not null default app.current_tenant() references app.tenants (id),
  ref                 text not null,
  kind                text not null check (kind in ('request', 'incident', 'maintenance', 'project')),
  title               text not null check (length(btrim(title)) between 3 and 200),
  details             text not null default '' check (length(details) <= 8000),
  category            text not null default 'general' check (category in ('security', 'housekeeping', 'garden', 'electrical',
                        'plumbing', 'lifts', 'water', 'fire_safety', 'pool', 'waste', 'general')),
  priority            text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status              text not null default 'open' check (status in ('new', 'open', 'in_progress', 'on_hold', 'done', 'closed', 'cancelled')),
  node_id             uuid not null,
  unit_id             uuid,
  asset_id            uuid,
  routine_id          uuid,
  occurrence_on       date,
  raised_by           uuid not null,
  assignee_person_id  uuid,
  due_on              date,
  estimate_paise      bigint check (estimate_paise is null or estimate_paise >= 0),
  approval_request_id uuid,
  started_at          timestamptz,
  completed_at        timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  check ((routine_id is null) = (occurrence_on is null)),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, unit_id) references app.units (tenant_id, id),
  foreign key (tenant_id, asset_id) references app.assets (tenant_id, id),
  foreign key (tenant_id, routine_id) references app.routines (tenant_id, id),
  foreign key (tenant_id, raised_by) references app.people (tenant_id, id),
  foreign key (tenant_id, assignee_person_id) references app.people (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references app.approval_requests (tenant_id, id)
);
create index work_orders_status_idx on app.work_orders (tenant_id, status, due_on);
create index work_orders_node_idx on app.work_orders (tenant_id, node_id);
create index work_orders_assignee_idx on app.work_orders (tenant_id, assignee_person_id) where status not in ('closed', 'cancelled');
create index work_orders_raised_idx on app.work_orders (tenant_id, raised_by);
create index work_orders_asset_idx on app.work_orders (tenant_id, asset_id) where asset_id is not null;
create trigger work_orders_touch before update on app.work_orders for each row execute function app.touch_updated_at();

alter table app.routine_checks
  add foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id);

-- The trail of a work order. Rows are never changed or removed, so what staff reported stays as reported.
create table app.work_updates (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  work_order_id uuid not null,
  at            timestamptz not null default now(),
  person_id     uuid not null,
  kind          text not null check (kind in ('created', 'note', 'status', 'assigned', 'due', 'details', 'photo', 'approval')),
  body          text not null default '' check (length(body) <= 4000),
  from_status   text,
  to_status     text,
  staff_only    boolean not null default false,
  file_id       uuid,
  primary key (id),
  unique (tenant_id, id),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id)
);
create index work_updates_order_idx on app.work_updates (tenant_id, work_order_id, at);
create index work_updates_file_idx on app.work_updates (tenant_id, file_id) where file_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['assets', 'asset_contracts', 'routines', 'routine_schedules', 'routine_checks', 'work_orders', 'work_updates']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy tenant_isolation on app.%I using (tenant_id = (select app.current_tenant())) '
                   'with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;

grant select, insert, update on app.assets, app.asset_contracts, app.routines, app.routine_checks, app.work_orders to pragati_app;
grant select, insert, update, delete on app.routine_schedules to pragati_app;
grant select, insert on app.work_updates to pragati_app;

-- ---------------------------------------------------------------------------------------------
-- Role templates gain the operations permissions. Staff without operations.view see only the
-- routines and work given to them, as at JAOA.
-- ---------------------------------------------------------------------------------------------
create or replace function platform.role_templates()
returns table (key text, name text, description text, permissions text[])
language sql stable set search_path = ''
as $$
  values
  ('administrator', 'Administrator', 'Full access to the community''s platform',
     array(select c.key from app.permission_catalog c order by c.key)),
  ('office_bearer', 'Office bearer', 'President, Secretary or Treasurer: committee access plus signed-letter approvals',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','approvals.override','audit.view','files.upload','operations.view']),
  ('committee_member', 'Committee member', 'Sees the community''s records and raises approval requests',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view']),
  ('block_committee_member', 'Block committee member', 'Committee access limited to one block or phase',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view']),
  ('facility_manager', 'Facility manager', 'Runs day-to-day operations',
     array['property.view','units.view','people.view','approvals.view','approvals.propose','files.upload',
           'operations.view','operations.update','operations.manage']),
  ('staff', 'Staff', 'On-site staff: their own routines and work', array['property.view','units.view','operations.update']),
  ('owner', 'Owner', 'Sees their own homes, notices and requests', array[]::text[]),
  ('resident', 'Resident', 'Tenant or family member living in a home', array[]::text[]),
  ('auditor', 'Auditor (view only)', 'Reads records and the audit trail, and can export data',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'audit.view','data.export','operations.view'])
$$;

-- Existing communities: add the new permissions to their template roles. Permissions a community
-- removed from a role earlier stay removed; only the new ones are added.
do $$
declare
  t record;
  new_keys text[] := array['operations.view', 'operations.update', 'operations.manage'];
begin
  for t in select id from app.tenants loop
    perform set_config('app.tenant_id', t.id::text, true);
    update app.roles r
       set permissions = r.permissions || array(
             select p from unnest(tpl.permissions) p where p = any (new_keys) and not (p = any (r.permissions)) order by p)
      from platform.role_templates() tpl
     where r.key = tpl.key and r.is_template;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
