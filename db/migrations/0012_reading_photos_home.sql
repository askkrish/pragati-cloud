-- Pragati Cloud · 0012 document reading, paper registers, profile photos and home layouts
--
-- Carried over from JAOA Pragati:
--   * Claude reads a quotation, an invoice or a page of a paper maintenance register into a draft
--     that the person checks; each read is logged with its cost
--   * entries from a paper register become routine checks, with the scan kept as their evidence;
--     the same scan cannot be entered twice
--   * people can add a profile photo
--   * each person arranges their own home screen

alter table app.files drop constraint files_purpose_check;
alter table app.files add constraint files_purpose_check
  check (purpose in ('logo', 'approval_letter', 'ownership_document', 'import', 'other', 'work_photo', 'contract', 'quotation',
                     'invoice', 'payment_proof', 'bank_statement', 'document', 'notice', 'evidence', 'avatar'));

create table app.document_reads (
  id            uuid not null default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant() references app.tenants (id),
  person_id     uuid not null,
  kind          text not null check (kind in ('quotation', 'invoice', 'register')),
  file_id       uuid not null,
  model         text,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  error         text,
  created_at    timestamptz not null default now(),
  primary key (id), unique (tenant_id, id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id)
);
create index document_reads_person on app.document_reads (tenant_id, person_id, created_at desc);

create table app.register_imports (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant() references app.tenants (id),
  file_id     uuid not null,
  sha256      text not null,
  title       text not null default 'Maintenance register',
  entries     integer not null check (entries > 0),
  read_by_ai  boolean not null default false,
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  primary key (id), unique (tenant_id, id), unique (tenant_id, sha256), unique (tenant_id, file_id),
  foreign key (tenant_id, file_id) references app.files (tenant_id, id),
  foreign key (tenant_id, created_by) references app.people (tenant_id, id)
);

alter table app.routine_checks add column register_import_id uuid;
alter table app.routine_checks add constraint routine_checks_register_fk
  foreign key (tenant_id, register_import_id) references app.register_imports (tenant_id, id);

alter table app.people add column photo_file_id uuid;
alter table app.people add constraint people_photo_fk foreign key (tenant_id, photo_file_id) references app.files (tenant_id, id);
grant update (photo_file_id) on app.people to pragati_app;

create table app.person_settings (
  tenant_id   uuid not null default app.current_tenant() references app.tenants (id),
  person_id   uuid not null,
  home_layout jsonb not null default '[]'::jsonb check (jsonb_typeof(home_layout) = 'array' and jsonb_array_length(home_layout) <= 30),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, person_id),
  foreign key (tenant_id, person_id) references app.people (tenant_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['document_reads', 'register_imports', 'person_settings']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('create policy tenant_isolation on app.%I using (tenant_id = (select app.current_tenant())) '
                   'with check (tenant_id = (select app.current_tenant()))', t);
  end loop;
end $$;
grant select, insert on app.document_reads, app.register_imports to pragati_app;
grant select, insert, update on app.person_settings to pragati_app;
grant update (register_import_id) on app.routine_checks to pragati_app;
