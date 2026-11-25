variable "name" {
  description = "Installation name, e.g. pragati-shared or pragati-palmmeadows. Lowercase letters, digits and hyphens."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use 3 to 31 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "hosting_tier" {
  description = "shared, dedicated or customer_cloud. Recorded as a tag."
  type        = string
  validation {
    condition     = contains(["shared", "dedicated", "customer_cloud"], var.hosting_tier)
    error_message = "Choose shared, dedicated or customer_cloud."
  }
}

variable "location" {
  description = "Azure region. Central India keeps residents' data in India; geo-backups go to its pair, South India."
  type        = string
  default     = "centralindia"
}

variable "address_space" {
  description = "Private address range for the installation's virtual network (a /16)."
  type        = string
  default     = "10.40.0.0/16"
}

variable "image_tag" {
  description = "Container image tag to run, normally the git commit SHA."
  type        = string
}

variable "base_domain" {
  description = "Communities are reached at <slug>.<base_domain>, e.g. palm-meadows.pragati.example."
  type        = string
}

variable "community_domains" {
  description = "Every community web address served by this installation. Front Door issues and renews a certificate for each."
  type        = list(string)
  default     = []
}

variable "postgres_sku" {
  description = "PostgreSQL Flexible Server size."
  type        = string
  default     = "GP_Standard_D2ds_v5"
}

variable "postgres_storage_mb" {
  type    = number
  default = 131072
}

variable "postgres_ha" {
  description = "Zone-redundant standby with automatic failover."
  type        = bool
  default     = true
}

variable "geo_redundant_backup" {
  description = "Copy backups to the paired region."
  type        = bool
  default     = true
}

variable "storage_replication" {
  description = "ZRS keeps three copies across zones in the region; GZRS adds the paired region."
  type        = string
  default     = "ZRS"
}

variable "min_replicas" {
  type    = number
  default = 2
}

variable "max_replicas" {
  type    = number
  default = 10
}

variable "db_admin_group_object_id" {
  description = "Entra ID group whose members administer the database (our operations team, or the customer's under an AMC)."
  type        = string
}

variable "db_admin_group_name" {
  type = string
}

variable "operator_ip_ranges" {
  description = "Public addresses allowed to manage Key Vault (operators and the deployment runner)."
  type        = list(string)
  default     = []
}

variable "msg91_template_id" {
  description = "DLT-registered SMS template for sign-in codes."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
