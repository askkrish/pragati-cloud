-- Pragati Cloud · 0008 notices and the records library
--
-- Carried over from JAOA Pragati's notices and records library:
--   * notices for everyone, owners only, the committee or staff, for the whole community or one
--     block; published now or later, pinned, with an end date, and read receipts
--   * a records library: bye-laws, minutes, audited accounts, contracts and the rest, each with who
--     may see it and when it is next due for review; a new version keeps the old one

insert into app.permission_catalog (key, area, label) values
  ('notices.publish',  'Notices', 'Publish notices to residents, owners, the committee or staff'),
  ('documents.manage', 'Records', 'Add and update documents in the records library');

alter table app.files drop constraint files_purpose_check;
alter table app.files add constraint files_purpose_check
  check (purpose in ('logo', 'approval_letter', 'ownership_document', 'import', 'other', 'work_photo', 'contract', 'quotation',
                     'invoice', 'payment_proof', 'bank_statement', 'document', 'notice'));

create table app.notices (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  ref           text not null,
  title         text not null check (length(btrim(title)) between 3 and 160),
  body          text not null check (length(btrim(body)) between 3 and 8000),
  category      text not null default 'general' check (category in ('general', 'maintenance', 'meeting', 'finance', 'security', 'event', 'emergency')),
  audience      text not null default 'everyone' check (audience in ('everyone', 'owners', 'committee', 'staff')),
  scope_node_id uuid,
  publish_at    timestamptz not null default now(),
  expires_on    date,
  pinned        boolean not null default false,
  file_id       uuid,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  withdrawn_at  timestamptz,
  withdrawn_note text,
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  check (withdrawn_at is null or length(btrim(withdrawn_note)) > 0),
  foreign key (tenant_id, scope_node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);
create index notices_publish_idx on app.notices (tenant_id, publish_at desc);

create table app.notice_reads (
  tenant_id uuid not null default app.current_tenant() references app.tenants (id),
  notice_id uuid not null,
  person_id uuid not null,
  read_at   timestamptz not null default now(),
  primary key (tenant_id, notice_id, person_id),
  foreign key (tenant_id, notice_id) references app.notices (tenant_id, id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id)
);

create table app.documents (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant() references app.tenants (id),
  ref         text not null,
  title       text not null check (length(btrim(title)) between 3 and 160),
  category    text not null check (category in ('bye_laws', 'minutes', 'agm', 'financial', 'audit', 'legal', 'contracts', 'insurance', 'statutory',
                'circulars', 'plans', 'other')),
  description text not null default '' check (length(description) <= 2000),
  file_id     uuid not null,
  visibility  text not null default 'committee' check (visibility in ('everyone', 'owners', 'committee', 'finance')),
  node_id     uuid,
  dated_on    date,
  review_on   date,
  version     smallint not null default 1 check (version between 1 and 999),
  replaced_by uuid,
  uploaded_by uuid not null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, replaced_by) references app.documents (tenant_id, id),
  foreign key (tenant_id, uploaded_by) references app.people (tenant_id, id)
);
create index documents_category_idx on app.documents (tenant_id, category) where replaced_by is null and archived_at is null;

do $$
declare t text;
begin
  foreach t in array array['notices', 'notice_reads', 'documents']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy tenant_isolation on app.%I using (tenant_id = (select app.current_tenant())) '
                   'with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;

grant select, insert, update on app.notices, app.documents to pragati_app;
grant select, insert on app.notice_reads to pragati_app;

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
           'notices.publish','documents.manage']),
  ('office_bearer', 'Office bearer', 'President, Secretary or Treasurer: committee access plus signed-letter approvals',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','approvals.override','audit.view','files.upload','operations.view',
           'procurement.view','procurement.manage','finance.view','notices.publish','documents.manage']),
  ('committee_member', 'Committee member', 'Sees the community''s records and raises approval requests',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view','procurement.view','finance.view']),
  ('block_committee_member', 'Block committee member', 'Committee access limited to one block or phase',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view','procurement.view','notices.publish']),
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
  new_keys text[] := array['notices.publish', 'documents.manage'];
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
