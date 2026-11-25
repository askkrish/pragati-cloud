variable "name" {
  type    = string
  default = "pragati-pilot"
}

variable "resource_group_name" {
  description = "Existing resource group (created once by setup-pilot.sh); the deployment identity can act only inside it."
  type        = string
}

variable "location" {
  description = "Azure region for the pilot's resources; defaults to the resource group's region."
  type        = string
  default     = null
}

variable "image_tag" {
  description = "Container image tag, normally the git commit SHA."
  type        = string
}

variable "base_domain" {
  description = "Communities are reached at <slug>.<base_domain> once a domain is set up. Until then the app's Azure address shows the demo community."
  type        = string
  default     = "pragati.invalid"
}

variable "tags" {
  type    = map(string)
  default = {}
}
