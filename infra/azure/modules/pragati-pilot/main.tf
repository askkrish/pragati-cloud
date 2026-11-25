# Pragati Cloud pilot: the same app, sized to run on Azure's free allowances.
#
#   PostgreSQL 16 Burstable B1ms, 32 GB    free for 12 months on a free account (750 hours/month)
#   Container Apps, scales to zero          within the monthly free grant at pilot traffic
#   Container Registry Standard             free for 12 months
#   Blob Storage, Log Analytics (capped)    a few rupees a month
#
# What the pilot leaves out compared with modules/pragati: Front Door and its firewall, the
# high-availability standby, geo-copied backups, Key Vault and private endpoints. The database is
# still private (reachable only from the app's network), file storage accepts no keys (identity
# only), and isolation between communities is unchanged because it lives in the database.
# Move a community to modules/pragati before it pays or holds data a breach would harm.

terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.20" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
    time    = { source = "hashicorp/time", version = "~> 0.12" }
  }
}

data "azurerm_client_config" "current" {}

data "azurerm_resource_group" "this" {
  name = var.resource_group_name
}

# Names get a fresh suffix if the pilot moves region, so new resources never collide with old ones.
resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
  keepers = {
    location = coalesce(var.location, data.azurerm_resource_group.this.location)
  }
}

locals {
  sfx      = random_string.suffix.result
  location = coalesce(var.location, data.azurerm_resource_group.this.location)
  rg       = data.azurerm_resource_group.this.name
  tags     = merge({ product = "pragati-cloud", installation = var.name, hosting_tier = "pilot" }, var.tags)
  image    = "${azurerm_container_registry.this.login_server}/pragati-cloud:${var.image_tag}"
  pg_host  = azurerm_postgresql_flexible_server.this.fqdn
}

# ---------------------------------------------------------------------------------- network
resource "azurerm_virtual_network" "this" {
  name                = "vnet-${var.name}"
  location            = local.location
  resource_group_name = local.rg
  address_space       = ["10.50.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = local.rg
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.50.0.0/24"]
  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "db" {
  name                 = "snet-postgres"
  resource_group_name  = local.rg
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.50.1.0/27"]
  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${var.name}.private.postgres.database.azure.com"
  resource_group_name = local.rg
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "postgres"
  resource_group_name   = local.rg
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.this.id
}

# ---------------------------------------------------------------------------------- database
resource "random_password" "db" {
  for_each = toset(["admin", "owner", "web", "ops"])
  length   = 32
  special  = false
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "psql-${var.name}-${local.sfx}"
  resource_group_name           = local.rg
  location                      = local.location
  version                       = "16"
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  auto_grow_enabled             = false
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false
  delegated_subnet_id           = azurerm_subnet.db.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false
  administrator_login           = "pgadmin"
  administrator_password        = random_password.db["admin"].result
  tags                          = local.tags

  authentication {
    active_directory_auth_enabled = false
    password_auth_enabled         = true
  }

  lifecycle {
    ignore_changes = [zone]
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

resource "azurerm_postgresql_flexible_server_database" "pragati" {
  name      = "pragati"
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_configuration" "tls" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = "on"
}

# ---------------------------------------------------------------------------------- files
resource "azurerm_storage_account" "files" {
  name                            = "stpragati${local.sfx}"
  resource_group_name             = local.rg
  location                        = local.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false # identity-based access only
  tags                            = local.tags

  blob_properties {
    delete_retention_policy {
      days = 14
    }
  }
}

resource "azurerm_storage_container" "files" {
  name                  = "community-files"
  storage_account_id    = azurerm_storage_account.files.id
  container_access_type = "private"
}

# ---------------------------------------------------------------------------------- identity, images, logs
resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${var.name}-app"
  location            = local.location
  resource_group_name = local.rg
  tags                = local.tags
}

resource "azurerm_container_registry" "this" {
  name                = "crpragati${local.sfx}"
  resource_group_name = local.rg
  location            = local.location
  sku                 = "Standard" # free for 12 months on a free account
  admin_enabled       = false
  tags                = local.tags
}

# The GitHub deployment identity pushes images; the app's identity only pulls them.
resource "azurerm_role_assignment" "deployer_push" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPush"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_role_assignment" "app_pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "app_blobs" {
  scope                = azurerm_storage_container.files.resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# New role assignments take a minute to reach every Azure service; wait before the first image pull.
resource "time_sleep" "roles" {
  depends_on      = [azurerm_role_assignment.app_pull, azurerm_role_assignment.app_blobs]
  create_duration = "90s"
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${var.name}"
  location            = local.location
  resource_group_name = local.rg
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.2 # keeps logging within the free allowance
  tags                = local.tags
}

# ---------------------------------------------------------------------------------- application
resource "azurerm_container_app_environment" "this" {
  name                       = "cae-${var.name}"
  location                   = local.location
  resource_group_name        = local.rg
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id
  tags                       = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

locals {
  db_url = {
    admin = "postgres://pgadmin:${random_password.db["admin"].result}@${local.pg_host}:5432/pragati?sslmode=require"
    web   = "postgres://pragati_web:${random_password.db["web"].result}@${local.pg_host}:5432/pragati?sslmode=require"
    ops   = "postgres://pragati_ops:${random_password.db["ops"].result}@${local.pg_host}:5432/pragati?sslmode=require"
  }
}

resource "random_password" "app_secret" {
  length  = 64
  special = false
}

resource "azurerm_container_app" "web" {
  name                         = "ca-${var.name}-web"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = local.rg
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "app-secret"
    value = random_password.app_secret.result
  }
  secret {
    name  = "db-url-app"
    value = local.db_url.web
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0 # sleeps when nobody is using it; the first visit takes a few seconds
    max_replicas = 2

    container {
      name   = "web"
      image  = local.image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name        = "DATABASE_URL_APP"
        secret_name = "db-url-app"
      }
      env {
        name        = "PRAGATI_SECRET"
        secret_name = "app-secret"
      }
      env {
        name  = "PRAGATI_BASE_DOMAIN"
        value = var.base_domain
      }
      env {
        name  = "PRAGATI_TRUST_PROXY_HOPS"
        value = "1"
      }
      env {
        name  = "PRAGATI_DB_POOL"
        value = "5"
      }
      env {
        name  = "SMS_PROVIDER"
        value = "none" # until MSG91 and DLT registration are ready; demo communities show the code on screen
      }
      env {
        name  = "STORAGE_DRIVER"
        value = "azure"
      }
      env {
        name  = "AZURE_STORAGE_ACCOUNT"
        value = azurerm_storage_account.files.name
      }
      env {
        name  = "AZURE_STORAGE_CONTAINER"
        value = azurerm_storage_container.files.name
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.app.client_id
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "30"
    }
  }

  depends_on = [time_sleep.roles]
}

# Brings the database up to date: schema owner, migrations, service logins. Run before each release.
resource "azurerm_container_app_job" "db" {
  name                         = "caj-${var.name}-db"
  location                     = local.location
  resource_group_name          = local.rg
  container_app_environment_id = azurerm_container_app_environment.this.id
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 0
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "db-url-admin"
    value = local.db_url.admin
  }
  secret {
    name  = "owner-password"
    value = random_password.db["owner"].result
  }
  secret {
    name  = "web-password"
    value = random_password.db["web"].result
  }
  secret {
    name  = "ops-password"
    value = random_password.db["ops"].result
  }

  template {
    container {
      name    = "db"
      image   = local.image
      command = ["node", "dist/server/bootstrap.js"]
      cpu     = 0.25
      memory  = "0.5Gi"
      env {
        name        = "DATABASE_URL_ADMIN"
        secret_name = "db-url-admin"
      }
      env {
        name        = "PRAGATI_OWNER_PASSWORD"
        secret_name = "owner-password"
      }
      env {
        name        = "PRAGATI_WEB_PASSWORD"
        secret_name = "web-password"
      }
      env {
        name        = "PRAGATI_OPS_PASSWORD"
        secret_name = "ops-password"
      }
    }
  }

  depends_on = [time_sleep.roles, azurerm_postgresql_flexible_server_database.pragati, azurerm_postgresql_flexible_server_configuration.tls]
}

# Loads the three made-up demo communities (skips any that exist) and points the app's Azure
# address at Palm Meadows until communities have their own domains.
resource "azurerm_container_app_job" "seed" {
  name                         = "caj-${var.name}-seed"
  location                     = local.location
  resource_group_name          = local.rg
  container_app_environment_id = azurerm_container_app_environment.this.id
  replica_timeout_in_seconds   = 900
  replica_retry_limit          = 0
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name  = "db-url-app"
    value = local.db_url.web
  }
  secret {
    name  = "db-url-ops"
    value = local.db_url.ops
  }

  template {
    container {
      name    = "seed"
      image   = local.image
      command = ["node", "dist/server/samples.js"]
      cpu     = 0.25
      memory  = "0.5Gi"
      env {
        name        = "DATABASE_URL_APP"
        secret_name = "db-url-app"
      }
      env {
        name        = "DATABASE_URL_PLATFORM"
        secret_name = "db-url-ops"
      }
      env {
        name  = "PRAGATI_BASE_DOMAIN"
        value = var.base_domain
      }
      env {
        name  = "PRAGATI_DEMO_HOST"
        value = azurerm_container_app.web.ingress[0].fqdn
      }
    }
  }

  depends_on = [time_sleep.roles]
}
