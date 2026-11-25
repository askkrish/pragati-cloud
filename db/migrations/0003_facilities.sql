-- Pragati Cloud · 0003 shared facilities
-- Clubhouses, pools, courts, a golf course: each belongs to a location (the whole community, a
-- phase or one block), which later decides who may book it and who shares its costs.
create table app.facilities (
  id          uuid not null default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant() references app.tenants (id),
  node_id     uuid not null,
  name        text not null check (length(btrim(name)) between 1 and 80),
  kind        text not null check (kind in ('clubhouse', 'pool', 'gym', 'court', 'golf_course', 'park', 'hall',
                                            'play_area', 'parking_area', 'other')),
  bookable    boolean not null default false,
  capacity    integer check (capacity is null or capacity > 0),
  notes       text not null default '',
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, name),
  foreign key (tenant_id, node_id) references app.property_nodes (tenant_id, id)
);
create index facilities_node_idx on app.facilities (tenant_id, node_id);

alter table app.facilities enable row level security;
alter table app.facilities force row level security;
create policy tenant_isolation on app.facilities using (tenant_id = (select app.current_tenant()))
  with check (tenant_id = (select app.current_tenant()));
grant select, insert, update on app.facilities to pragati_app;
