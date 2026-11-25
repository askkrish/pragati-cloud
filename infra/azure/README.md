# Azure set-up

## The pilot (running now)

`modules/pragati-pilot`, applied from `envs/pilot` by `.github/workflows/deploy-pilot.yml` on every push to `main`. It runs on Azure's free allowances: PostgreSQL B1ms (free for 12 months), Container Apps that scale to zero (within the monthly free grant), a Standard registry (free for 12 months), identity-only Blob Storage and capped logs. No Front Door, standby database or Key Vault. The database is private to the app's network. Expect well under ₹500 a month in the first year.

- One-time preparation: `setup-pilot.sh`, run by the subscription owner in Cloud Shell. It registers services, creates `rg-pragati-pilot` and `rg-pragati-tfstate`, and creates the deployment identity `pragati-cloud-github-deploy`. That identity has no secret; only GitHub Actions in the `pilot` environment of askkrish/pragati-cloud can use it, and only inside those two resource groups.
- Each deploy: tests → build and push the image → bring the database up to date (job `caj-pragati-pilot-db`) → switch the app → load the demo communities (job `caj-pragati-pilot-seed`, skips existing) → check the live site.
- SMS is off (`SMS_PROVIDER=none`) until MSG91 and DLT registration are ready, so only demo communities (made-up data, code shown on screen) can sign in.
- Until a domain is set up, the app's own Azure address shows the Palm Meadows demo.

Move a community to `modules/pragati` (Front Door with firewall, standby database, Key Vault, private endpoints) before it pays or stores data that a breach would harm.

## Production

`modules/pragati` is one complete installation. The three folders under `envs/` use it for each hosting tier. Region: Central India, with geo-backups in South India (production). The pilot runs in South India.

These files have not yet been applied to a subscription. CI runs `terraform fmt` and `terraform validate` on every push; the first apply will be done together with the person who owns the subscription.

## What one installation contains

- Virtual network with subnets for the app, the database and private endpoints
- PostgreSQL 16 Flexible Server: private only, zone-redundant standby, 35-day backups copied to South India, TLS required, Entra ID sign-in
- Blob Storage for files: private endpoint, no access keys (identity only), versioning, 30-day soft delete
- Key Vault: private endpoint, RBAC, purge protection; holds the app secret, the migration login and the SMS key
- Container Apps environment (zone-redundant) with the web app (2–10 replicas) and a migration job
- A managed identity for the app: pulls images, reads its secrets, reads and writes files, signs in to the database
- Front Door Premium with managed certificates per community address, the Microsoft default and bot rule sets in prevention mode, and a sign-in rate limit
- Log Analytics (90 days) receiving Front Door, firewall, database and Key Vault logs

## First deployment

1. **State storage.** Create a storage account for Terraform state and a `backend.hcl`:
   ```hcl
   resource_group_name  = "rg-pragati-tfstate"
   storage_account_name = "<name>"
   container_name       = "tfstate"
   key                  = "shared.tfstate"
   use_azuread_auth     = true
   ```
2. **Apply.**
   ```sh
   cd envs/shared
   terraform init -backend-config=backend.hcl
   terraform apply -var subscription_id=… -var image_tag=<sha> -var db_admin_group_object_id=… -var 'operator_ip_ranges=["<your IP>"]'
   ```
   The first apply runs before an image exists, so the app revision will not start until step 4.
3. **Bootstrap the database** (once), from a machine that can reach the private network (for example Azure Cloud Shell with VNet integration, or a jump host), signed in as a member of the database administrators group:
   ```sh
   export PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
   psql "host=<postgres_fqdn> dbname=pragati user=pragati-db-admins sslmode=require" \
     -v owner_password=<password from the database-url-owner secret> -v app_identity=<app_identity_name> -f ../../bootstrap.sql
   ```
4. **Deploy** with the GitHub Actions *Deploy* workflow (set the repository variables it reads: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `ACR_NAME`, `RESOURCE_GROUP`, `MIGRATION_JOB`, `CONTAINER_APP`). It builds the image in the registry, runs the migrations, then switches the app.
5. **Grant the app its role** (once, after the first migration), connected as `pragati_owner`:
   ```sql
   grant pragati_app to "<app_identity_name>";
   ```
6. **SMS.** Put the MSG91 key into the `msg91-auth-key` secret in the portal and set `msg91_template_id`.
7. **Domains.** For each community address: add it to `community_domains`, apply, then add the TXT record from `domain_validation_records` and a CNAME to `front_door_hostname`.

## Customer's cloud (AMC)

The customer creates a subscription and an Entra group for their database administrators, and grants our operations group access through Azure Lighthouse. We apply `envs/customer-cloud-example` (copied and renamed) in their subscription with the same steps. Releases arrive through the same Deploy workflow. The customer can remove our access at any time; the data, keys and backups stay in their subscription.

## Phase 4: AWS

The same container and database run on AWS (ECS Fargate or App Runner, RDS for PostgreSQL 16, S3, Secrets Manager, CloudFront with AWS WAF). A Terraform module for AWS comes with the customer-cloud work in Phase 4.
