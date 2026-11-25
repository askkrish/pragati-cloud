-- Pragati Cloud · 0006 procurement
--
-- Carried over from JAOA Pragati's procurement and vendor review:
--   * a vendor directory for the community
--   * quotations recorded against a work order, each with its GST basis, scope, exclusions,
--     timeline, warranty, validity and payment terms; a revised quote replaces the earlier one
--     but the earlier one is kept
--   * choosing a vendor: a reason is always recorded, a single quotation needs a justification,
--     and the choice goes through the community's approval rules as a 'vendor_selection'
--   * reviews of a vendor's work after it is done

insert into app.permission_catalog (key, area, label) values
  ('procurement.view',   'Procurement', 'See vendors, quotations and comparisons'),
  ('procurement.manage', 'Procurement', 'Add vendors and record quotations');

alter table app.files drop constraint files_purpose_check;
alter table app.files add constraint files_purpose_check
  check (purpose in ('logo', 'approval_letter', 'ownership_document', 'import', 'other', 'work_photo', 'contract', 'quotation'));

create table app.vendors (
  id           uuid not null default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant() references app.tenants (id),
  ref          text not null,
  name         text not null check (length(btrim(name)) between 2 and 120),
  categories   text[] not null default '{}' check (categories <@ array['security', 'housekeeping', 'garden', 'electrical', 'plumbing', 'lifts',
                 'water', 'fire_safety', 'pool', 'waste', 'general', 'civil', 'painting', 'pest_control', 'supplies', 'professional']),
  contact_name text check (contact_name is null or length(contact_name) <= 120),
  phone        text check (phone is null or length(phone) <= 30),
  email        text check (email is null or length(email) <= 160),
  gstin        text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  city         text check (city is null or length(city) <= 80),
  address      text check (address is null or length(address) <= 400),
  website      text check (website is null or length(website) <= 200),
  notes        text not null default '' check (length(notes) <= 4000),
  status       text not null default 'active' check (status in ('active', 'on_hold', 'blocked')),
  status_note  text not null default '',
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  check (status = 'active' or length(btrim(status_note)) > 0),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);
create unique index vendors_name_idx on app.vendors (tenant_id, lower(btrim(name)));
create trigger vendors_touch before update on app.vendors for each row execute function app.touch_updated_at();

create table app.quotes (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  ref           text not null,
  work_order_id uuid not null,
  vendor_id     uuid not null,
  received_on   date not null default current_date,
  amount_paise  bigint not null check (amount_paise > 0),
  tax           text not null default 'unclear' check (tax in ('included', 'excluded', 'unclear')),
  gst_paise     bigint check (gst_paise is null or gst_paise >= 0),
  scope         text not null check (length(btrim(scope)) between 3 and 2000),
  exclusions    text not null default '' check (length(exclusions) <= 1000),
  timeline      text not null default '' check (length(timeline) <= 200),
  warranty      text not null default '' check (length(warranty) <= 200),
  valid_until   date,
  payment_terms text not null default '' check (length(payment_terms) <= 500),
  reference     text check (reference is null or length(reference) <= 80),
  file_id       uuid,
  replaced_by   uuid,
  withdrawn_at  timestamptz,
  withdrawn_note text,
  entered_by    uuid not null,
  created_at    timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  check (tax = 'excluded' or gst_paise is null),
  check (withdrawn_at is null or length(btrim(withdrawn_note)) > 0),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, vendor_id) references app.vendors (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, replaced_by) references app.quotes (tenant_id, id),
  foreign key (tenant_id, entered_by) references app.people (tenant_id, id)
);
create index quotes_work_idx on app.quotes (tenant_id, work_order_id);
create index quotes_vendor_idx on app.quotes (tenant_id, vendor_id);

-- A recommendation to award the work. Its outcome is the outcome of its approval request.
create table app.vendor_selections (
  id                  uuid not null default gen_random_uuid(),
  tenant_id           uuid not null default app.current_tenant() references app.tenants (id),
  work_order_id       uuid not null,
  quote_id            uuid not null,
  reason              text not null check (length(btrim(reason)) between 3 and 1500),
  single_quote_reason text check (single_quote_reason is null or length(btrim(single_quote_reason)) > 0),
  compared_quote_ids  uuid[] not null,
  approval_request_id uuid not null,
  chosen_by           uuid not null,
  created_at          timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, quote_id) references app.quotes (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references app.approval_requests (tenant_id, id),
  foreign key (tenant_id, chosen_by) references app.people (tenant_id, id)
);
create index vendor_selections_work_idx on app.vendor_selections (tenant_id, work_order_id);

create table app.vendor_reviews (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  vendor_id     uuid not null,
  work_order_id uuid,
  quality       smallint not null check (quality between 1 and 5),
  timeliness    smallint not null check (timeliness between 1 and 5),
  value         smallint not null check (value between 1 and 5),
  would_rehire  boolean not null,
  comment       text not null default '' check (length(comment) <= 2000),
  reviewed_by   uuid not null,
  created_at    timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique nulls not distinct (tenant_id, vendor_id, work_order_id, reviewed_by),
  foreign key (tenant_id, vendor_id) references app.vendors (tenant_id, id),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, reviewed_by) references app.people (tenant_id, id)
);
create index vendor_reviews_vendor_idx on app.vendor_reviews (tenant_id, vendor_id);

do $$
declare t text;
begin
  foreach t in array array['vendors', 'quotes', 'vendor_selections', 'vendor_reviews']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy tenant_isolation on app.%I using (tenant_id = (select app.current_tenant())) '
                   'with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;

grant select, insert, update on app.vendors, app.quotes to pragati_app;
grant select, insert on app.vendor_selections to pragati_app;
grant select, insert, update on app.vendor_reviews to pragati_app;

create or replace function platform.role_templates()
returns table (key text, name text, description text, permissions text[])
language sql stable set search_path = ''
as $$
  values
  ('administrator', 'Administrator', 'Full access to the community''s platform',
     array(select c.key from app.permission_catalog c order by c.key)),
  ('office_bearer', 'Office bearer', 'President, Secretary or Treasurer: committee access plus signed-letter approvals',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','approvals.override','audit.view','files.upload','operations.view',
           'procurement.view','procurement.manage']),
  ('committee_member', 'Committee member', 'Sees the community''s records and raises approval requests',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view','procurement.view']),
  ('block_committee_member', 'Block committee member', 'Committee access limited to one block or phase',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view','procurement.view']),
  ('facility_manager', 'Facility manager', 'Runs day-to-day operations',
     array['property.view','units.view','people.view','approvals.view','approvals.propose','files.upload',
           'operations.view','operations.update','operations.manage','procurement.view','procurement.manage']),
  ('staff', 'Staff', 'On-site staff: their own routines and work', array['property.view','units.view','operations.update']),
  ('owner', 'Owner', 'Sees their own homes, notices and requests', array[]::text[]),
  ('resident', 'Resident', 'Tenant or family member living in a home', array[]::text[]),
  ('auditor', 'Auditor (view only)', 'Reads records and the audit trail, and can export data',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'audit.view','data.export','operations.view','procurement.view'])
$$;

do $$
declare
  t record;
  new_keys text[] := array['procurement.view', 'procurement.manage'];
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
