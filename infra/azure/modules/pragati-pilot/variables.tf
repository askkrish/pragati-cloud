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

variable "anthropic_api_key" {
  description = "Key for Ask Pragathi (Claude API). Empty leaves Ask Pragathi switched off. Supplied from the ANTHROPIC_API_KEY repository secret."
  type        = string
  default     = ""
  sensitive   = true
}

variable "ask_model" {
  description = "Claude model Ask Pragathi uses."
  type        = string
  default     = "claude-haiku-5-5"
}
