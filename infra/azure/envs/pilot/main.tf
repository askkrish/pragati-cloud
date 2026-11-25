# The pilot: one small installation on Azure's free allowances (see modules/pragati-pilot).
# Applied by .github/workflows/deploy-pilot.yml; the deployment identity can only act inside
# rg-pragati-pilot and the Terraform state storage.
terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.20" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
    time    = { source = "hashicorp/time", version = "~> 0.12" }
  }
  backend "azurerm" {
    resource_group_name  = "rg-pragati-tfstate"
    storage_account_name = "pragatitfd7i0sk"
    container_name       = "tfstate"
    key                  = "pilot.tfstate"
    use_azuread_auth     = true
    use_oidc             = true
  }
}

provider "azurerm" {
  features {}
  use_oidc                        = true
  storage_use_azuread             = true
  resource_provider_registrations = "none" # registered once by setup-pilot.sh
}

variable "image_tag" { type = string }

module "pilot" {
  source              = "../../modules/pragati-pilot"
  resource_group_name = "rg-pragati-pilot"
  # South India (Chennai): Central India refused new free-tier PostgreSQL servers (SkuNotAvailable).
  location  = "southindia"
  image_tag = var.image_tag
}

output "app_url" { value = module.pilot.app_url }
output "acr_name" { value = module.pilot.acr_name }
output "acr_login_server" { value = module.pilot.acr_login_server }
output "container_app" { value = module.pilot.container_app }
output "db_job" { value = module.pilot.db_job }
output "seed_job" { value = module.pilot.seed_job }
output "resource_group" { value = module.pilot.resource_group }
