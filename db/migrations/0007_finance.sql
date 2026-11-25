-- Pragati Cloud · 0007 finance
--
-- Full books for each community, carried over from JAOA Pragati's cash book, dues, vouchers and
-- reconciliation, rebuilt as double-entry:
--   * a chart of accounts per community, with bank and cash accounts, funds (general, corpus,
--     sinking) and a receivables account kept per home and a payables account kept per vendor
--   * journals that always balance and are never changed: a mistake is corrected by a reversal
--   * a closed period, and each bank account's reconciled-through date, are enforced here in the
--     database, so nothing can be posted into them by any route
--   * maintenance billing by area, unit type or a flat amount, for the whole community or one block
--   * owners' payment intimations, payment vouchers approved through the approval rules, bank
--     statement reconciliation and budgets

insert into app.permission_catalog (key, area, label) values
  ('finance.view',    'Finance', 'See the books, dues and finance reports'),
  ('finance.prepare', 'Finance', 'Prepare payment vouchers'),
  ('finance.manage',  'Finance', 'Record receipts and payments, bill homes, reconcile the bank and close periods');

alter table app.files drop constraint files_purpose_check;
alter table app.files add constraint files_purpose_check
  check (purpose in ('logo', 'approval_letter', 'ownership_document', 'import', 'other', 'work_photo', 'contract', 'quotation',
                     'invoice', 'payment_proof', 'bank_statement'));

-- ---------------------------------------------------------------------------------------------
-- Settings and the chart of accounts
-- ---------------------------------------------------------------------------------------------
create table app.finance_settings (
  tenant_id            uuid primary key default app.current_tenant() references app.tenants (id),
  fy_start_month       smallint not null default 4 check (fy_start_month between 1 and 12),
  books_closed_through date,
  payment_instructions text not null default '' check (length(payment_instructions) <= 1000),
  upi_id               text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$'),
  updated_at           timestamptz not null default now()
);

create table app.ledger_accounts (
  id                 uuid not null default gen_random_uuid(),
  tenant_id          uuid not null default app.current_tenant() references app.tenants (id),
  code               text not null check (code ~ '^[0-9A-Z-]{2,12}$'),
  name               text not null check (length(btrim(name)) between 2 and 80),
  type               text not null check (type in ('asset', 'liability', 'funds', 'income', 'expense')),
  system_key         text check (system_key in ('receivables', 'payables', 'general_fund', 'corpus_fund', 'sinking_fund',
                       'maintenance', 'late_fees', 'interest', 'tds_payable', 'advances')),
  cash_kind          text check (cash_kind in ('bank', 'cash')),
  bank_name          text check (bank_name is null or length(bank_name) <= 80),
  account_last4      text check (account_last4 is null or account_last4 ~ '^[0-9]{4}$'),
  reconciled_through date,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, code),
  check (cash_kind is null or type = 'asset'),
  check (account_last4 is null or cash_kind = 'bank')
);
create unique index ledger_accounts_system_idx on app.ledger_accounts (tenant_id, system_key) where system_key is not null;
create unique index ledger_accounts_name_idx on app.ledger_accounts (tenant_id, lower(name));

-- The standard chart a new community starts with; each community can add its own accounts.
create function app.create_default_chart() returns void
language sql
as $$
  insert into app.finance_settings default values on conflict do nothing;
  insert into app.ledger_accounts (code, name, type, system_key) values
    ('1100', 'Maintenance receivable', 'asset', 'receivables'),
    ('1200', 'Fixed deposits', 'asset', null),
    ('1300', 'Advances to vendors', 'asset', 'advances'),
    ('2100', 'Vendor payables', 'liability', 'payables'),
    ('2300', 'Refundable deposits', 'liability', null),
    ('2400', 'TDS payable', 'liability', 'tds_payable'),
    ('3000', 'General fund', 'funds', 'general_fund'),
    ('3100', 'Corpus fund', 'funds', 'corpus_fund'),
    ('3200', 'Sinking fund', 'funds', 'sinking_fund'),
    ('4000', 'Maintenance charges', 'income', 'maintenance'),
    ('4010', 'Late payment charges', 'income', 'late_fees'),
    ('4020', 'Facility and clubhouse bookings', 'income', null),
    ('4030', 'Interest on deposits', 'income', 'interest'),
    ('4040', 'Parking charges', 'income', null),
    ('4090', 'Other income', 'income', null),
    ('5000', 'Staff salaries', 'expense', null),
    ('5010', 'Security services', 'expense', null),
    ('5020', 'Housekeeping', 'expense', null),
    ('5030', 'Electricity for common areas', 'expense', null),
    ('5040', 'Water', 'expense', null),
    ('5050', 'Repairs and maintenance', 'expense', null),
    ('5060', 'AMC charges', 'expense', null),
    ('5070', 'Diesel for generators', 'expense', null),
    ('5080', 'Garden and landscaping', 'expense', null),
    ('5090', 'Insurance', 'expense', null),
    ('5100', 'Professional and audit fees', 'expense', null),
    ('5110', 'Bank charges', 'expense', null),
    ('5200', 'Major repairs and projects', 'expense', null),
    ('5900', 'Miscellaneous expenses', 'expense', null)
  on conflict do nothing;
$$;

-- ---------------------------------------------------------------------------------------------
-- Journals: the books
-- ---------------------------------------------------------------------------------------------
create table app.journals (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant() references app.tenants (id),
  ref         text not null,
  kind        text not null check (kind in ('opening', 'receipt', 'payment', 'transfer', 'charge', 'journal', 'reversal')),
  txn_date    date not null,
  due_on      date,
  narration   text not null check (length(btrim(narration)) between 2 and 500),
  reference   text check (reference is null or length(reference) <= 100),
  mode        text check (mode in ('upi', 'neft', 'imps', 'rtgs', 'cheque', 'cash', 'card', 'other')),
  unit_id     uuid,
  vendor_id   uuid,
  reverses_id uuid,
  source      text not null default 'manual' check (source in ('manual', 'billing', 'voucher', 'claim', 'import', 'opening', 'seed')),
  file_id     uuid,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  unique (tenant_id, reverses_id),
  check ((kind = 'reversal') = (reverses_id is not null)),
  foreign key (tenant_id, unit_id) references app.units (tenant_id, id),
  foreign key (tenant_id, vendor_id) references app.vendors (tenant_id, id),
  foreign key (tenant_id, reverses_id) references app.journals (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);
create index journals_date_idx on app.journals (tenant_id, txn_date);

create table app.journal_lines (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null default app.current_tenant() references app.tenants (id),
  journal_id   uuid not null,
  account_id   uuid not null,
  debit_paise  bigint not null default 0 check (debit_paise >= 0),
  credit_paise bigint not null default 0 check (credit_paise >= 0),
  unit_id      uuid,
  vendor_id    uuid,
  node_id      uuid,
  memo         text not null default '' check (length(memo) <= 300),
  unique (tenant_id, id),
  check ((debit_paise > 0) <> (credit_paise > 0)),
  foreign key (tenant_id, journal_id) references app.journals (tenant_id, id),
  foreign key (tenant_id, account_id) references app.ledger_accounts (tenant_id, id),
  foreign key (tenant_id, unit_id) references app.units (tenant_id, id),
  foreign key (tenant_id, vendor_id) references app.vendors (tenant_id, id),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id)
);
create index journal_lines_journal_idx on app.journal_lines (tenant_id, journal_id);
create index journal_lines_account_idx on app.journal_lines (tenant_id, account_id);
create index journal_lines_unit_idx on app.journal_lines (tenant_id, unit_id) where unit_id is not null;
create index journal_lines_vendor_idx on app.journal_lines (tenant_id, vendor_id) where vendor_id is not null;

-- Every journal balances, with at least two lines. Checked when the transaction commits.
create function app.journal_balances() returns trigger
language plpgsql
as $$
declare d bigint; c bigint; n int;
begin
  select coalesce(sum(debit_paise), 0), coalesce(sum(credit_paise), 0), count(*) into d, c, n
    from app.journal_lines where tenant_id = new.tenant_id and journal_id = new.journal_id;
  if n < 2 or d <> c then
    raise exception 'A journal must balance: debits % and credits % (in paise) across % lines', d, c, n using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger journal_lines_balance after insert on app.journal_lines
  deferrable initially deferred for each row execute function app.journal_balances();

-- Nothing is posted into a closed period, or into a bank account on or before the date it was reconciled.
create function app.journal_period_open() returns trigger
language plpgsql
as $$
declare closed date;
begin
  select books_closed_through into closed from app.finance_settings where tenant_id = new.tenant_id;
  if closed is not null and new.txn_date <= closed then
    raise exception 'The books are closed up to %. Post this on a later date.', closed using errcode = '23514';
  end if;
  return new;
end $$;
create trigger journals_period before insert on app.journals for each row execute function app.journal_period_open();

create function app.journal_line_account_open() returns trigger
language plpgsql
as $$
declare a record; d date;
begin
  select reconciled_through, archived_at, name into a from app.ledger_accounts where tenant_id = new.tenant_id and id = new.account_id;
  select txn_date into d from app.journals where tenant_id = new.tenant_id and id = new.journal_id;
  if a.archived_at is not null then
    raise exception 'The account % is no longer in use.', a.name using errcode = '23514';
  end if;
  if a.reconciled_through is not null and d <= a.reconciled_through then
    raise exception '% is reconciled with the bank up to %. Post this on a later date.', a.name, a.reconciled_through using errcode = '23514';
  end if;
  return new;
end $$;
create trigger journal_lines_open before insert on app.journal_lines for each row execute function app.journal_line_account_open();

create function app.books_are_permanent() returns trigger
language plpgsql
as $$ begin raise exception 'Posted entries cannot be changed or deleted. Post a reversal instead.' using errcode = '42501'; end $$;
create trigger journals_permanent before update or delete on app.journals for each row execute function app.books_are_permanent();
create trigger journal_lines_permanent before update or delete on app.journal_lines for each row execute function app.books_are_permanent();

-- ---------------------------------------------------------------------------------------------
-- Billing: what each home is charged
-- ---------------------------------------------------------------------------------------------
create table app.charge_plans (
  id                uuid not null default gen_random_uuid(),
  tenant_id         uuid not null default app.current_tenant() references app.tenants (id),
  ref               text not null,
  name              text not null check (length(btrim(name)) between 3 and 120),
  frequency         text not null check (frequency in ('monthly', 'quarterly', 'half_yearly', 'annually', 'once')),
  basis             text not null check (basis in ('area', 'unit_type', 'flat')),
  area_field        text check (area_field in ('carpet_sqft', 'builtup_sqft', 'super_sqft', 'plot_sqft', 'uds_sqft')),
  rate_paise        bigint check (rate_paise is null or rate_paise > 0),
  unit_type_rates   jsonb not null default '{}' check (jsonb_typeof(unit_type_rates) = 'object'),
  scope_node_id     uuid not null,
  categories        text[] not null default '{apartment,villa,row_house,plot,other}'
                      check (categories <@ '{apartment,villa,row_house,plot,commercial,other}'::text[] and cardinality(categories) > 0),
  account_id        uuid not null,
  due_days          smallint not null default 15 check (due_days between 0 and 120),
  active            boolean not null default true,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  check (basis <> 'area' or (area_field is not null and rate_paise is not null)),
  check (basis <> 'flat' or rate_paise is not null),
  foreign key (tenant_id, scope_node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, account_id) references app.ledger_accounts (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);

create table app.billing_runs (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  ref           text not null,
  plan_id       uuid not null,
  period_label  text not null check (length(btrim(period_label)) between 2 and 40),
  issue_on      date not null,
  due_on        date not null,
  status        text not null default 'draft' check (status in ('draft', 'posted', 'cancelled')),
  total_paise   bigint not null default 0,
  units         integer not null default 0,
  skipped       jsonb not null default '[]',
  journal_id    uuid,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  posted_by     uuid,
  posted_at     timestamptz,
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  check (due_on >= issue_on),
  check (status <> 'posted' or journal_id is not null),
  foreign key (tenant_id, plan_id) references app.charge_plans (tenant_id, id),
  foreign key (tenant_id, journal_id) references app.journals (tenant_id, id)
);
create unique index billing_runs_once_idx on app.billing_runs (tenant_id, plan_id, period_label) where status <> 'cancelled';

create table app.billing_run_lines (
  tenant_id    uuid not null default app.current_tenant() references app.tenants (id),
  run_id       uuid not null,
  unit_id      uuid not null,
  amount_paise bigint not null check (amount_paise > 0),
  basis        text not null,
  primary key (tenant_id, run_id, unit_id),
  foreign key (tenant_id, run_id) references app.billing_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, unit_id) references app.units (tenant_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Owners telling the treasurer they have paid
-- ---------------------------------------------------------------------------------------------
create table app.payment_claims (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  unit_id       uuid not null,
  person_id     uuid not null,
  amount_paise  bigint not null check (amount_paise > 0),
  paid_on       date not null,
  mode          text not null check (mode in ('upi', 'neft', 'imps', 'rtgs', 'cheque', 'cash', 'card', 'other')),
  reference     text not null check (length(btrim(reference)) between 3 and 100),
  note          text not null default '' check (length(note) <= 500),
  file_id       uuid,
  status        text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,
  journal_id    uuid,
  created_at    timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  check ((status = 'confirmed') = (journal_id is not null)),
  check (status <> 'rejected' or length(btrim(decision_note)) > 0),
  foreign key (tenant_id, unit_id) references app.units (tenant_id, id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, journal_id) references app.journals (tenant_id, id)
);
create index payment_claims_status_idx on app.payment_claims (tenant_id, status);

-- ---------------------------------------------------------------------------------------------
-- Payment vouchers: prepared by staff, decided by the approval rules, paid by the treasurer
-- ---------------------------------------------------------------------------------------------
create table app.vouchers (
  id                  uuid not null default gen_random_uuid(),
  tenant_id           uuid not null default app.current_tenant() references app.tenants (id),
  ref                 text not null,
  vendor_id           uuid,
  payee               text not null check (length(btrim(payee)) between 2 and 120),
  description         text not null check (length(btrim(description)) between 3 and 1000),
  amount_paise        bigint not null check (amount_paise > 0),
  tds_paise           bigint not null default 0 check (tds_paise >= 0),
  account_id          uuid not null,
  node_id             uuid not null,
  work_order_id       uuid,
  invoice_no          text check (invoice_no is null or length(invoice_no) <= 60),
  invoice_date        date,
  file_id             uuid,
  status              text not null default 'submitted' check (status in ('submitted', 'paid', 'cancelled')),
  approval_request_id uuid,
  journal_id          uuid,
  prepared_by         uuid not null,
  created_at          timestamptz not null default now(),
  cancelled_note      text,
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, ref),
  check (tds_paise < amount_paise),
  check ((status = 'paid') = (journal_id is not null)),
  foreign key (tenant_id, vendor_id) references app.vendors (tenant_id, id),
  foreign key (tenant_id, account_id) references app.ledger_accounts (tenant_id, id),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id),
  foreign key (tenant_id, work_order_id) references app.work_orders (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, approval_request_id) references app.approval_requests (tenant_id, id),
  foreign key (tenant_id, journal_id) references app.journals (tenant_id, id),
  foreign key (tenant_id, prepared_by) references app.people (tenant_id, id)
);
create index vouchers_status_idx on app.vouchers (tenant_id, status);
create unique index vouchers_invoice_idx on app.vouchers (tenant_id, vendor_id, lower(invoice_no))
  where vendor_id is not null and invoice_no is not null and status <> 'cancelled';

-- ---------------------------------------------------------------------------------------------
-- Bank reconciliation
-- ---------------------------------------------------------------------------------------------
create table app.bank_statements (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  account_id    uuid not null,
  period_start  date not null,
  period_end    date not null,
  opening_paise bigint not null,
  closing_paise bigint not null,
  file_id       uuid,
  status        text not null default 'open' check (status in ('open', 'reconciled')),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  reconciled_at timestamptz,
  primary key (id),
  unique (tenant_id, id),
  check (period_end >= period_start),
  foreign key (tenant_id, account_id) references app.ledger_accounts (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id)
);
create table app.bank_statement_lines (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null default app.current_tenant() references app.tenants (id),
  statement_id    uuid not null,
  txn_date        date not null,
  description     text not null default '',
  reference       text not null default '',
  amount_paise    bigint not null check (amount_paise <> 0),
  matched_line_id bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, statement_id) references app.bank_statements (tenant_id, id) on delete cascade,
  foreign key (tenant_id, matched_line_id) references app.journal_lines (tenant_id, id)
);
create unique index bank_statement_lines_matched_idx on app.bank_statement_lines (tenant_id, matched_line_id) where matched_line_id is not null;

create table app.budgets (
  tenant_id    uuid not null default app.current_tenant() references app.tenants (id),
  fy_start     smallint not null check (fy_start between 2000 and 2100),
  account_id   uuid not null,
  amount_paise bigint not null check (amount_paise >= 0),
  primary key (tenant_id, fy_start, account_id),
  foreign key (tenant_id, account_id) references app.ledger_accounts (tenant_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['finance_settings', 'ledger_accounts', 'journals', 'journal_lines', 'charge_plans', 'billing_runs',
    'billing_run_lines', 'payment_claims', 'vouchers', 'bank_statements', 'bank_statement_lines', 'budgets']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy tenant_isolation on app.%I using (tenant_id = (select app.current_tenant())) '
                   'with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;

grant select, insert, update on app.finance_settings, app.ledger_accounts, app.charge_plans, app.billing_runs, app.payment_claims,
  app.vouchers to pragati_app;
grant select, insert, update, delete on app.bank_statements to pragati_app;
grant select, insert on app.journals, app.journal_lines to pragati_app;
grant select, insert, delete on app.billing_run_lines to pragati_app;
grant select, insert, update, delete on app.bank_statement_lines, app.budgets to pragati_app;
grant execute on function app.create_default_chart() to pragati_app;

-- ---------------------------------------------------------------------------------------------
-- Role templates: a Treasurer role keeps the books; committees and auditors read them;
-- facility managers prepare vouchers.
-- ---------------------------------------------------------------------------------------------
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
           'procurement.view','procurement.manage','finance.view','finance.prepare','finance.manage','data.export']),
  ('office_bearer', 'Office bearer', 'President, Secretary or Treasurer: committee access plus signed-letter approvals',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','approvals.override','audit.view','files.upload','operations.view',
           'procurement.view','procurement.manage','finance.view']),
  ('committee_member', 'Committee member', 'Sees the community''s records and raises approval requests',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view','procurement.view','finance.view']),
  ('block_committee_member', 'Block committee member', 'Committee access limited to one block or phase',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'approvals.propose','files.upload','operations.view','procurement.view']),
  ('facility_manager', 'Facility manager', 'Runs day-to-day operations',
     array['property.view','units.view','people.view','approvals.view','approvals.propose','files.upload',
           'operations.view','operations.update','operations.manage','procurement.view','procurement.manage','finance.prepare']),
  ('staff', 'Staff', 'On-site staff: their own routines and work', array['property.view','units.view','operations.update']),
  ('owner', 'Owner', 'Sees their own homes, dues, notices and requests', array[]::text[]),
  ('resident', 'Resident', 'Tenant or family member living in a home', array[]::text[]),
  ('auditor', 'Auditor (view only)', 'Reads records and the audit trail, and can export data',
     array['property.view','units.view','people.view','committees.view','approval_rules.view','approvals.view',
           'audit.view','data.export','operations.view','procurement.view','finance.view'])
$$;

-- Existing communities: a default chart, the new Treasurer role, and the new permissions on their
-- template roles (permissions a community removed earlier stay removed).
do $$
declare
  t record;
  new_keys text[] := array['finance.view', 'finance.prepare', 'finance.manage'];
begin
  for t in select id from app.tenants loop
    perform set_config('app.tenant_id', t.id::text, true);
    perform app.create_default_chart();
    insert into app.roles (key, name, description, permissions, is_template)
    select r.key, r.name, r.description, r.permissions, true from platform.role_templates() r where r.key = 'treasurer'
    on conflict (tenant_id, key) do nothing;
    update app.roles r
       set permissions = r.permissions || array(
             select p from unnest(tpl.permissions) p where p = any (new_keys) and not (p = any (r.permissions)) order by p)
      from platform.role_templates() tpl
     where r.key = tpl.key and r.is_template;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;

-- New communities get the standard chart when their top-level place is created, which happens
-- once, inside platform.create_tenant.
create function app.new_community_books() returns trigger
language plpgsql
as $$ begin perform app.create_default_chart(); return null; end $$;
create trigger property_nodes_new_community after insert on app.property_nodes
  for each row when (new.parent_id is null) execute function app.new_community_books();
