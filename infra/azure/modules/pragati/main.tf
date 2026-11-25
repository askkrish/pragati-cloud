# Pragati Cloud on Azure: one complete, isolated installation.
#
# The same module is used three ways (see ../../envs):
#   shared          our subscription, many communities in one database, walled off by row-level security
#   dedicated       our subscription, one large or premium community with its own database and storage
#   customer cloud  the customer's own subscription; they own the data and the bill, we run it under an AMC
#
# Everything private by default: the database and file storage have no public endpoint, the app
# reaches them over the virtual network, secrets live in Key Vault, the app signs in with a managed
# identity, and visitors only ever reach Azure Front Door with its web application firewall.

terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.20" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

data "azurerm_client_config" "current" {}

locals {
  tags  = merge({ product = "pragati-cloud", installation = var.name, hosting_tier = var.hosting_tier }, var.tags)
  short = substr(replace(var.name, "-", ""), 0, 16)
  image = "${azurerm_container_registry.this.login_server}/pragati-cloud:${var.image_tag}"
}

resource "azurerm_resource_group" "this" {
  name     = "rg-${var.name}"
  location = var.location
  tags     = local.tags
}

# ---------------------------------------------------------------------------------- network
resource "azurerm_virtual_network" "this" {
  name                = "vnet-${var.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  address_space       = [var.address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.address_space, 7, 0)] # /23, required for a zone-redundant environment
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
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.address_space, 8, 2)]
  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "endpoints" {
  name                 = "snet-private-endpoints"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.address_space, 8, 3)]
}

# ---------------------------------------------------------------------------------- database
resource "azurerm_private_dns_zone" "postgres" {
  name                = "${var.name}.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "postgres"
  resource_group_name   = azurerm_resource_group.this.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.this.id
}

resource "random_password" "pg_admin" {
  length  = 40
  special = false
}

resource "random_password" "pg_owner" {
  length  = 40
  special = false
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "psql-${var.name}"
  resource_group_name           = azurerm_resource_group.this.name
  location                      = var.location
  version                       = "16"
  sku_name                      = var.postgres_sku
  storage_mb                    = var.postgres_storage_mb
  auto_grow_enabled             = true
  backup_retention_days         = 35
  geo_redundant_backup_enabled  = var.geo_redundant_backup
  delegated_subnet_id           = azurerm_subnet.db.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false
  administrator_login           = "pgadmin"
  administrator_password        = random_password.pg_admin.result
  zone                          = "1"
  tags                          = local.tags

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = true # only for the one-time bootstrap and the migration job
    tenant_id                     = data.azurerm_client_config.current.tenant_id
  }

  dynamic "high_availability" {
    for_each = var.postgres_ha ? [1] : []
    content {
      mode                      = "ZoneRedundant"
      standby_availability_zone = "2"
    }
  }

  maintenance_window {
    day_of_week  = 0 # Sunday 21:30 UTC = Monday 03:00 IST
    start_hour   = 21
    start_minute = 30
  }

  lifecycle {
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "ops" {
  server_name         = azurerm_postgresql_flexible_server.this.name
  resource_group_name = azurerm_resource_group.this.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  object_id           = var.db_admin_group_object_id
  principal_name      = var.db_admin_group_name
  principal_type      = "Group"
}

resource "azurerm_postgresql_flexible_server_database" "pragati" {
  name      = "pragati"
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_configuration" "settings" {
  for_each = {
    require_secure_transport   = "on"
    ssl_min_protocol_version   = "TLSv1.2"
    log_min_duration_statement = "1000"
    log_connections            = "on"
    idle_in_transaction_session_timeout = "60000"
  }
  name      = each.key
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = each.value
}

# ---------------------------------------------------------------------------------- files
resource "azurerm_storage_account" "files" {
  name                              = substr("st${local.short}files", 0, 24)
  resource_group_name               = azurerm_resource_group.this.name
  location                          = var.location
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = var.storage_replication
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  allow_nested_items_to_be_public   = false
  shared_access_key_enabled         = false # identity-based access only
  public_network_access_enabled     = false
  infrastructure_encryption_enabled = true
  tags                              = local.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
  }
}

resource "azurerm_storage_container" "files" {
  name                  = "community-files"
  storage_account_id    = azurerm_storage_account.files.id
  container_access_type = "private"
}

resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  name                  = "blob"
  resource_group_name   = azurerm_resource_group.this.name
  private_dns_zone_name = azurerm_private_dns_zone.blob.name
  virtual_network_id    = azurerm_virtual_network.this.id
}

resource "azurerm_private_endpoint" "blob" {
  name                = "pe-${var.name}-blob"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "blob"
    private_connection_resource_id = azurerm_storage_account.files.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }
}

# ---------------------------------------------------------------------------------- secrets
resource "azurerm_key_vault" "this" {
  name                          = substr("kv-${local.short}", 0, 24)
  location                      = var.location
  resource_group_name           = azurerm_resource_group.this.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  enable_rbac_authorization     = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = true # reachable only from the listed operator addresses
  tags                          = local.tags

  network_acls {
    default_action = "Deny"
    bypass         = "AzureServices"
    ip_rules       = var.operator_ip_ranges
  }
}

resource "azurerm_private_dns_zone" "vault" {
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "vault" {
  name                  = "vault"
  resource_group_name   = azurerm_resource_group.this.name
  private_dns_zone_name = azurerm_private_dns_zone.vault.name
  virtual_network_id    = azurerm_virtual_network.this.id
}

resource "azurerm_private_endpoint" "vault" {
  name                = "pe-${var.name}-vault"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "vault"
    private_connection_resource_id = azurerm_key_vault.this.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.vault.id]
  }
}

resource "azurerm_role_assignment" "deployer_secrets" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "random_password" "app_secret" {
  length  = 64
  special = false
}

resource "azurerm_key_vault_secret" "app_secret" {
  name         = "pragati-secret"
  value        = random_password.app_secret.result
  key_vault_id = azurerm_key_vault.this.id
  depends_on   = [azurerm_role_assignment.deployer_secrets]
}

resource "azurerm_key_vault_secret" "pg_admin" {
  name         = "postgres-admin-password"
  value        = random_password.pg_admin.result
  key_vault_id = azurerm_key_vault.this.id
  depends_on   = [azurerm_role_assignment.deployer_secrets]
}

# The schema owner is created by the one-time bootstrap (see README); only the migration job uses it.
resource "azurerm_key_vault_secret" "owner_url" {
  name         = "database-url-owner"
  value        = "postgres://pragati_owner:${random_password.pg_owner.result}@${azurerm_postgresql_flexible_server.this.fqdn}:5432/pragati?sslmode=require"
  key_vault_id = azurerm_key_vault.this.id
  depends_on   = [azurerm_role_assignment.deployer_secrets]
}

# The SMS provider key is entered by an operator in the portal, never in code or state.
resource "azurerm_key_vault_secret" "sms_key" {
  name         = "msg91-auth-key"
  value        = "set-in-portal"
  key_vault_id = azurerm_key_vault.this.id
  depends_on   = [azurerm_role_assignment.deployer_secrets]
  lifecycle {
    ignore_changes = [value]
  }
}

# ---------------------------------------------------------------------------------- identity, images, logs
resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${var.name}-app"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

resource "azurerm_container_registry" "this" {
  name                = substr("cr${local.short}", 0, 50)
  resource_group_name = azurerm_resource_group.this.name
  location            = var.location
  sku                 = "Standard"
  admin_enabled       = false
  tags                = local.tags
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

resource "azurerm_role_assignment" "app_secrets" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${var.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = 90
  tags                = local.tags
}

# ---------------------------------------------------------------------------------- application
resource "azurerm_container_app_environment" "this" {
  name                       = "cae-${var.name}"
  location                   = var.location
  resource_group_name        = azurerm_resource_group.this.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id
  zone_redundancy_enabled    = true
  tags                       = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_container_app" "web" {
  name                         = "ca-${var.name}-web"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
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
    name                = "pragati-secret"
    key_vault_secret_id = azurerm_key_vault_secret.app_secret.versionless_id
    identity            = azurerm_user_assigned_identity.app.id
  }

  secret {
    name                = "msg91-auth-key"
    key_vault_secret_id = azurerm_key_vault_secret.sms_key.versionless_id
    identity            = azurerm_user_assigned_identity.app.id
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
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "web"
      image  = local.image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "DATABASE_URL_APP"
        value = "postgres://${azurerm_user_assigned_identity.app.name}@${azurerm_postgresql_flexible_server.this.fqdn}:5432/pragati?sslmode=require"
      }
      env {
        name  = "AZURE_PG_ENTRA"
        value = "1"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.app.client_id
      }
      env {
        name  = "PRAGATI_BASE_DOMAIN"
        value = var.base_domain
      }
      env {
        name  = "PRAGATI_FRONT_DOOR_ID"
        value = azurerm_cdn_frontdoor_profile.this.resource_guid
      }
      env {
        name        = "PRAGATI_SECRET"
        secret_name = "pragati-secret"
      }
      env {
        name  = "SMS_PROVIDER"
        value = "msg91"
      }
      env {
        name        = "MSG91_AUTH_KEY"
        secret_name = "msg91-auth-key"
      }
      env {
        name  = "MSG91_TEMPLATE_ID"
        value = var.msg91_template_id
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

      liveness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }
      readiness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/healthz"
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "60"
    }
  }

  depends_on = [azurerm_role_assignment.app_pull, azurerm_role_assignment.app_secrets]
}

# Runs the database migrations; the deploy pipeline starts it before switching to a new image.
resource "azurerm_container_app_job" "migrate" {
  name                         = "caj-${var.name}-migrate"
  location                     = var.location
  resource_group_name          = azurerm_resource_group.this.name
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
    name                = "owner-url"
    key_vault_secret_id = azurerm_key_vault_secret.owner_url.versionless_id
    identity            = azurerm_user_assigned_identity.app.id
  }

  template {
    container {
      name    = "migrate"
      image   = local.image
      command = ["node", "dist/server/migrate.js"]
      cpu     = 0.5
      memory  = "1Gi"
      env {
        name        = "DATABASE_URL_OWNER"
        secret_name = "owner-url"
      }
    }
  }

  depends_on = [azurerm_role_assignment.app_pull, azurerm_role_assignment.app_secrets]
}

# ---------------------------------------------------------------------------------- front door and firewall
resource "azurerm_cdn_frontdoor_profile" "this" {
  name                     = "afd-${var.name}"
  resource_group_name      = azurerm_resource_group.this.name
  sku_name                 = "Premium_AzureFrontDoor"
  response_timeout_seconds = 60
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_endpoint" "this" {
  name                     = "fde-${var.name}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_origin_group" "web" {
  name                     = "web"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  session_affinity_enabled = false

  load_balancing {
    sample_size                 = 4
    successful_samples_required = 3
  }

  health_probe {
    path                = "/healthz"
    protocol            = "Https"
    interval_in_seconds = 60
    request_type        = "GET"
  }
}

resource "azurerm_cdn_frontdoor_origin" "web" {
  name                           = "container-app"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.web.id
  enabled                        = true
  host_name                      = azurerm_container_app.web.ingress[0].fqdn
  origin_host_header             = azurerm_container_app.web.ingress[0].fqdn
  certificate_name_check_enabled = true
  http_port                      = 80
  https_port                     = 443
  priority                       = 1
  weight                         = 1000
}

# One entry per community address, each with a certificate Front Door manages and renews.
resource "azurerm_cdn_frontdoor_custom_domain" "community" {
  for_each                 = toset(var.community_domains)
  name                     = substr(replace(each.value, ".", "-"), 0, 60)
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  host_name                = each.value

  tls {
    certificate_type = "ManagedCertificate"
  }
}

resource "azurerm_cdn_frontdoor_route" "web" {
  name                            = "web"
  cdn_frontdoor_endpoint_id       = azurerm_cdn_frontdoor_endpoint.this.id
  cdn_frontdoor_origin_group_id   = azurerm_cdn_frontdoor_origin_group.web.id
  cdn_frontdoor_origin_ids        = [azurerm_cdn_frontdoor_origin.web.id]
  cdn_frontdoor_custom_domain_ids = [for d in azurerm_cdn_frontdoor_custom_domain.community : d.id]
  supported_protocols             = ["Http", "Https"]
  https_redirect_enabled          = true
  forwarding_protocol             = "HttpsOnly"
  patterns_to_match               = ["/*"]
  link_to_default_domain          = true
}

resource "azurerm_cdn_frontdoor_firewall_policy" "this" {
  name                = substr("waf${local.short}", 0, 128)
  resource_group_name = azurerm_resource_group.this.name
  sku_name            = "Premium_AzureFrontDoor"
  enabled             = true
  mode                = "Prevention"
  tags                = local.tags

  managed_rule {
    type    = "Microsoft_DefaultRuleSet"
    version = "2.1"
    action  = "Block"
  }

  managed_rule {
    type    = "Microsoft_BotManagerRuleSet"
    version = "1.1"
    action  = "Block"
  }

  # A second line of defence for sign-in; the app and the database also limit codes per number.
  custom_rule {
    name                           = "SignInRateLimit"
    enabled                        = true
    priority                       = 10
    type                           = "RateLimitRule"
    rate_limit_duration_in_minutes = 1
    rate_limit_threshold           = 30
    action                         = "Block"

    match_condition {
      match_variable = "RequestUri"
      operator       = "Contains"
      match_values   = ["/api/auth/"]
    }
  }
}

resource "azurerm_cdn_frontdoor_security_policy" "this" {
  name                     = "waf"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id

  security_policies {
    firewall {
      cdn_frontdoor_firewall_policy_id = azurerm_cdn_frontdoor_firewall_policy.this.id
      association {
        domain {
          cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_endpoint.this.id
        }
        dynamic "domain" {
          for_each = azurerm_cdn_frontdoor_custom_domain.community
          content {
            cdn_frontdoor_domain_id = domain.value.id
          }
        }
        patterns_to_match = ["/*"]
      }
    }
  }
}

# ---------------------------------------------------------------------------------- diagnostics
resource "azurerm_monitor_diagnostic_setting" "frontdoor" {
  name                       = "logs"
  target_resource_id         = azurerm_cdn_frontdoor_profile.this.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  enabled_log {
    category = "FrontDoorAccessLog"
  }
  enabled_log {
    category = "FrontDoorWebApplicationFirewallLog"
  }
}

resource "azurerm_monitor_diagnostic_setting" "postgres" {
  name                       = "logs"
  target_resource_id         = azurerm_postgresql_flexible_server.this.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  enabled_log {
    category = "PostgreSQLLogs"
  }
}

resource "azurerm_monitor_diagnostic_setting" "vault" {
  name                       = "logs"
  target_resource_id         = azurerm_key_vault.this.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  enabled_log {
    category = "AuditEvent"
  }
}
