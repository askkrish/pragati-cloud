output "app_url" {
  value = "https://${azurerm_container_app.web.ingress[0].fqdn}"
}

output "acr_name" {
  value = azurerm_container_registry.this.name
}

output "acr_login_server" {
  value = azurerm_container_registry.this.login_server
}

output "container_app" {
  value = azurerm_container_app.web.name
}

output "db_job" {
  value = azurerm_container_app_job.db.name
}

output "seed_job" {
  value = azurerm_container_app_job.seed.name
}

output "resource_group" {
  value = local.rg
}

output "postgres_server" {
  value = azurerm_postgresql_flexible_server.this.name
}
