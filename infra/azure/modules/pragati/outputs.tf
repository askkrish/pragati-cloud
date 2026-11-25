output "resource_group" {
  value = azurerm_resource_group.this.name
}

output "front_door_hostname" {
  description = "Point each community's DNS name at this host with a CNAME record."
  value       = azurerm_cdn_frontdoor_endpoint.this.host_name
}

output "front_door_id" {
  description = "Front Door's profile id; the app refuses requests that do not carry it."
  value       = azurerm_cdn_frontdoor_profile.this.resource_guid
}

output "domain_validation_records" {
  description = "TXT records to add before Front Door can issue each community's certificate."
  value       = { for k, d in azurerm_cdn_frontdoor_custom_domain.community : k => d.validation_token }
}

output "container_registry" {
  value = azurerm_container_registry.this.login_server
}

output "container_app" {
  value = azurerm_container_app.web.name
}

output "migration_job" {
  value = azurerm_container_app_job.migrate.name
}

output "postgres_fqdn" {
  value = azurerm_postgresql_flexible_server.this.fqdn
}

output "app_identity_name" {
  description = "The database role to create for the app during bootstrap (see README)."
  value       = azurerm_user_assigned_identity.app.name
}

output "key_vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}
