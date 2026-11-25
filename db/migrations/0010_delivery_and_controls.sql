-- Pragati Cloud · 0010 project delivery and controls
--
-- Carried over from JAOA Pragati:
--   * project delivery: requests for quotation, the contract (work order) with its signed copy,
--     milestones, change orders decided through the approval rules, and a handover with tests,
--     defects and warranty that the receiving person accepts or returns
--   * a service and inspection log for each asset, with the outcome and the next due date
--   * GST checks on payment vouchers: the preparer records the GSTIN and invoice, the treasurer verifies
--   * permits for requests that need the committee's permission (terrace drilling and cabling,
--     renovation, moving in or out), decided, and revocable, by the committee
--   * decisions that have waited too long are flagged after a number of days the community sets

insert into app.permission_catalog (key, area, label) values
  ('permits.decide', 'Operations', 'Grant, decline or revoke permits for work that needs the committee''s permission');

alter table app.files drop constraint files_purpose_check;
alter table app.files add constraint files_purpose_check
  check (purpose in ('logo', 'approval_letter', 'ownership_document', 'import', 'other', 'work_photo', 'contract', 'quotation',
                     'invoice', 'payment_proof', 'bank_statement', 'document', 'notice', 'evidence'));

alter table app.tenants add column escalation_days integer not null default 7 check (escalation_days between 1 and 90);
grant update (escalation_days) on app.tenants to pragati_app;

-- ---------------------------------------------------------------- project delivery
create table app.rfqs (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  ref           text not null,
  work_order_id uuid not null,
  scope         text not null check (length(btrim(scope)) between 10 and 4000),
  reply_by      date not null,
  vendor_ids    uuid[] not null default '{}',
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  primary key (id), unique (tenant_id, id), unique (tenant_id, ref),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);

create table app.contracts (
  id               uuid not null default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant() references app.tenants (id),
  ref              text not null,
  work_order_id    uuid not null,
  vendor_id        uuid not null,
  quote_id         uuid,
  selection_id     uuid,
  -- An agreement made before the platform, recorded without a selection, says so.
  earlier_note     text check (earlier_note is null or length(btrim(earlier_note)) >= 3),
  amount_paise     bigint not null check (amount_paise > 0),
  starts_on        date,
  finish_by        date,
  terms            text not null default '' check (length(terms) <= 6000),
  signed_on        date,
  signed_reference text,
  signed_file_id   uuid,
  created_by       uuid not null,
  created_at       timestamptz not null default now(),
  primary key (id), unique (tenant_id, id), unique (tenant_id, ref), unique (tenant_id, work_order_id),
  check (selection_id is not null or earlier_note is not null),
  check ((signed_on is null) = (signed_file_id is null)),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, vendor_id) references app.vendors (tenant_id, id),
  foreign key (tenant_id, quote_id) references app.quotes (tenant_id, id),
  foreign key (tenant_id, selection_id) references app.vendor_selections (tenant_id, id),
  foreign key (tenant_id, signed_file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);

create table app.contract_changes (
  id                  uuid not null default gen_random_uuid(),
  tenant_id           uuid not null default app.current_tenant() references app.tenants (id),
  ref                 text not null,
  contract_id         uuid not null,
  scope               text not null check (length(btrim(scope)) between 5 and 3000),
  reason              text not null check (length(btrim(reason)) between 3 and 1500),
  delta_paise         bigint not null,
  days_delta          integer not null default 0 check (days_delta between -365 and 365),
  approval_request_id uuid not null,
  proposed_by         uuid not null,
  created_at          timestamptz not null default now(),
  primary key (id), unique (tenant_id, id), unique (tenant_id, ref),
  foreign key (tenant_id, contract_id) references app.contracts (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references app.approval_requests (tenant_id, id),
  foreign key (tenant_id, proposed_by) references app.people (tenant_id, id)
);

create table app.milestones (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  work_order_id uuid not null,
  title         text not null check (length(btrim(title)) between 3 and 200),
  due_on        date not null,
  amount_paise  bigint check (amount_paise is null or amount_paise > 0),
  done_on       date,
  done_note     text,
  done_by       uuid,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  primary key (id), unique (tenant_id, id),
  check ((done_on is null) = (done_by is null)),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, done_by) references app.people (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);
create index milestones_work_idx on app.milestones (tenant_id, work_order_id, due_on);

create table app.handovers (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  ref           text not null,
  work_order_id uuid not null,
  tests         text not null check (length(btrim(tests)) between 3 and 3000),
  defects       text not null check (length(btrim(defects)) between 2 and 2000),
  warranty      text not null default '' check (length(warranty) <= 1000),
  asset_ids     uuid[] not null default '{}',
  file_id       uuid,
  recipient_id  uuid not null,
  status        text not null default 'submitted' check (status in ('submitted', 'accepted', 'returned', 'superseded')),
  response_note text,
  response_file_id uuid,
  responded_at  timestamptz,
  submitted_by  uuid not null,
  created_at    timestamptz not null default now(),
  primary key (id), unique (tenant_id, id), unique (tenant_id, ref),
  check (recipient_id <> submitted_by),
  check ((status in ('accepted', 'returned')) = (responded_at is not null)),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, response_file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, recipient_id) references app.people (tenant_id, id),
  foreign key (tenant_id, submitted_by) references app.people (tenant_id, id)
);
create unique index handovers_one_open on app.handovers (tenant_id, work_order_id) where status = 'submitted';

-- ---------------------------------------------------------------- asset service log
create table app.asset_services (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  ref           text not null,
  asset_id      uuid not null,
  serviced_on   date not null,
  kind          text not null default 'service' check (kind in ('service', 'inspection', 'repair', 'statutory')),
  provider      text not null check (length(btrim(provider)) between 2 and 150),
  outcome       text not null check (outcome in ('passed', 'follow_up', 'out_of_service')),
  notes         text not null default '' check (length(notes) <= 3000),
  next_due_on   date,
  file_id       uuid,
  work_order_id uuid,
  recorded_by   uuid not null,
  created_at    timestamptz not null default now(),
  primary key (id), unique (tenant_id, id), unique (tenant_id, ref),
  check (next_due_on is null or next_due_on > serviced_on),
  foreign key (tenant_id, asset_id) references app.assets (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, recorded_by) references app.people (tenant_id, id)
);
create index asset_services_asset_idx on app.asset_services (tenant_id, asset_id, serviced_on desc);

-- ---------------------------------------------------------------- GST checks on vouchers
alter table app.vouchers
  add column gst_status     text check (gst_status in ('not_charged', 'pending', 'verified')),
  add column gstin          text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  add column gst_note       text,
  add column gst_checked_by uuid,
  add column gst_checked_at timestamptz,
  add constraint vouchers_gst_verified check (gst_status is distinct from 'verified' or (gstin is not null and gst_checked_by is not null));

-- ---------------------------------------------------------------- permits
alter table app.work_orders add column permit_kind text
  check (permit_kind in ('terrace_work', 'renovation', 'moving', 'other'));

create table app.work_permits (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  work_order_id uuid not null,
  status        text not null check (status in ('approved', 'declined', 'revoked')),
  note          text not null check (length(btrim(note)) between 3 and 2000),
  conditions    text not null default '' check (length(conditions) <= 2000),
  valid_until   date,
  decided_by    uuid not null,
  decided_at    timestamptz not null default now(),
  primary key (id), unique (tenant_id, id),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, decided_by) references app.people (tenant_id, id)
);
create index work_permits_work_idx on app.work_permits (tenant_id, work_order_id, decided_at desc);

-- ---------------------------------------------------------------- security
do $$
declare t text;
begin
  foreach t in array array['rfqs', 'contracts', 'contract_changes', 'milestones', 'handovers', 'asset_services', 'work_permits']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy tenant_isolation on app.%I using (tenant_id = (select app.current_tenant())) '
                   'with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;

grant select, insert on app.rfqs, app.contract_changes, app.asset_services, app.work_permits to pragati_app;
grant select, insert, update on app.contracts, app.milestones, app.handovers to pragati_app;
grant update (gst_status, gstin, gst_note, gst_checked_by, gst_checked_at) on app.vouchers to pragati_app;
grant update (permit_kind) on app.work_orders to pragati_app;

-- ---------------------------------------------------------------- roles
create or replace function platform.role_templates()
returns table (key text, name text, description text, permissions text[])
language sql stable set search_path = ''
as $$
  values
  ('administrator', 'Administrator', 'Full access to the community''s platform',
     array(select c.key from app.permission_catalog c order by c.key)),
  ('treasurer', 'Treasurer', 'Keeps the books: billing, receipts, payments and the bank',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','approvals.override','audit.view','files.upload','operations.view',
           'procurement.view','procurement.manage','finance.view','finance.prepare','finance.manage','data.export',
           'notices.publish','documents.manage','permits.decide']),
  ('office_bearer', 'Office bearer', 'President, Secretary or Treasurer: committee access plus signed-letter approvals',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','approvals.override','audit.view','files.upload','operations.view',
           'procurement.view','procurement.manage','finance.view','notices.publish','documents.manage','permits.decide']),
  ('committee_member', 'Committee member', 'Sees the community''s records and raises approval requests',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view','procurement.view','finance.view','permits.decide']),
  ('block_committee_member', 'Block committee member', 'Committee access limited to one block or phase',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view','procurement.view','notices.publish','permits.decide']),
  ('facility_manager', 'Facility manager', 'Runs day-to-day operations',
     array['property.view','units.view','people.view','approvals.view','approvals.propose','files.upload',
           'operations.view','operations.update','operations.manage','procurement.view','procurement.manage','finance.prepare',
           'notices.publish','documents.manage']),
  ('staff', 'Staff', 'On-site staff: their own routines and work', array['property.view','units.view','operations.update']),
  ('owner', 'Owner', 'Sees their own homes, dues, notices and requests', array[]::text[]),
  ('resident', 'Resident', 'Tenant or family member living in a home', array[]::text[]),
  ('auditor', 'Auditor (view only)', 'Reads records and the audit trail, and can export data',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'audit.view','data.export','operations.view','procurement.view','finance.view'])
$$;

do $$
declare
  t record;
  new_keys text[] := array['permits.decide'];
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
