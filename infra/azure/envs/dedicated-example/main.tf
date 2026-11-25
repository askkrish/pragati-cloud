# Tier 2: one large or premium community with its own database, storage and keys, still in our
# subscription and run by us. Copy this folder per community and change the name and domains.
terraform {
  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}

variable "subscription_id" { type = string }
variable "image_tag" { type = string }
variable "db_admin_group_object_id" { type = string }

module "pragati" {
  source                   = "../../modules/pragati"
  name                     = "pragati-palmmeadows"
  hosting_tier             = "dedicated"
  address_space            = "10.41.0.0/16"
  image_tag                = var.image_tag
  base_domain              = "pragati.example"
  community_domains        = ["palm-meadows.pragati.example"]
  postgres_sku             = "GP_Standard_D2ds_v5"
  postgres_ha              = true
  min_replicas             = 1
  max_replicas             = 4
  db_admin_group_object_id = var.db_admin_group_object_id
  db_admin_group_name      = "pragati-db-admins"
}

output "front_door_hostname" { value = module.pragati.front_door_hostname }
