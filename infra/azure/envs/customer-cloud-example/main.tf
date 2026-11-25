# Tier 3: the same software in the customer's own Azure subscription. They own the subscription,
# the data and the bill; we deploy and support it under an annual maintenance contract (AMC),
# with access granted to our operations group through Azure Lighthouse, which they can revoke.
terraform {
  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  subscription_id     = var.customer_subscription_id
  storage_use_azuread = true
}

variable "customer_subscription_id" { type = string }
variable "image_tag" { type = string }
variable "customer_db_admin_group_object_id" { type = string }
variable "customer_domain" { type = string } # e.g. pragati.greenwoods-rwa.in

module "pragati" {
  source                   = "../../modules/pragati"
  name                     = "pragati-greenwoods"
  hosting_tier             = "customer_cloud"
  image_tag                = var.image_tag
  base_domain              = var.customer_domain
  community_domains        = [var.customer_domain]
  postgres_sku             = "GP_Standard_D2ds_v5"
  postgres_ha              = false
  min_replicas             = 1
  max_replicas             = 3
  db_admin_group_object_id = var.customer_db_admin_group_object_id
  db_admin_group_name      = "customer-db-admins"
  tags                     = { amc = "pragati" }
}

output "front_door_hostname" { value = module.pragati.front_door_hostname }
