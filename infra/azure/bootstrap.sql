-- One-time database bootstrap for a new installation, run by a member of the database
-- administrators group signed in with Entra ID (see README.md, step 3).
--
--   psql "host=<postgres_fqdn> dbname=pragati user=<group name> sslmode=require" \
--        -v owner_password=<from Key Vault: database-url-owner> -v app_identity=<app_identity_name> -f bootstrap.sql
--
-- Step A: the schema owner. It can create roles but is not a superuser, so the migrations prove
-- they need nothing more than Azure grants.
select format('create role pragati_owner login createrole password %L', :'owner_password')
 where not exists (select 1 from pg_roles where rolname = 'pragati_owner') \gexec
alter database pragati owner to pragati_owner;
grant all on schema public to pragati_owner;

-- Step B: the app's managed identity as a database login. It signs in with Entra ID tokens only.
select * from pgaadauth_create_principal(:'app_identity', false, false)
 where not exists (select 1 from pg_roles where rolname = :'app_identity');

-- Step C (after the first migration run): connect as pragati_owner and give the identity the
-- application role, which can see one community at a time and nothing else:
--   grant pragati_app to "<app_identity_name>";
-- For the onboarding command, create a separate login for the operations team:
--   create role pragati_ops login password '<from Key Vault>'; grant pragati_platform to pragati_ops;
