# Tier 1: the shared cloud in our Azure subscription. Many communities, one database, each walled
# off by row-level security. Most communities start here.
terraform {
  backend "azurerm" {
    # Filled in at init time: terraform init -backend-config=backend.hcl
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}

variable "subscription_id" { type = string }
variable "image_tag" { type = string }
variable "db_admin_group_object_id" { type = string }
variable "operator_ip_ranges" {
  type    = list(string)
  default = []
}
variable "community_domains" {
  type    = list(string)
  default = []
}

module "pragati" {
  source                   = "../../modules/pragati"
  name                     = "pragati-shared"
  hosting_tier             = "shared"
  image_tag                = var.image_tag
  base_domain              = "pragati.example" # replace with the product domain once registered
  community_domains        = var.community_domains
  postgres_sku             = "GP_Standard_D4ds_v5"
  postgres_ha              = true
  min_replicas             = 2
  max_replicas             = 10
  db_admin_group_object_id = var.db_admin_group_object_id
  db_admin_group_name      = "pragati-db-admins"
  operator_ip_ranges       = var.operator_ip_ranges
}

output "front_door_hostname" { value = module.pragati.front_door_hostname }
output "domain_validation_records" { value = module.pragati.domain_validation_records }
output "container_registry" { value = module.pragati.container_registry }
output "migration_job" { value = module.pragati.migration_job }
output "container_app" { value = module.pragati.container_app }
output "resource_group" { value = module.pragati.resource_group }
