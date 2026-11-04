variable "display_name" {
  type        = string
  description = "Name shown in the OVHcloud manager."

  validation {
    condition     = length(trimspace(var.display_name)) > 0
    error_message = "display_name must not be empty."
  }
}

variable "ovh_subsidiary" {
  type        = string
  description = "OVHcloud subsidiary that bills the order, as reported by GET /me (for example WE or CA)."

  validation {
    condition     = can(regex("^[A-Z]{2}$", var.ovh_subsidiary))
    error_message = "ovh_subsidiary must be a two-letter uppercase code such as WE."
  }
}

variable "plan_code" {
  type        = string
  description = "Catalog plan code, for example vps-2027-model3. List them with 'make catalog'."

  validation {
    condition     = can(regex("^vps-20[0-9]{2}-model[0-9]+$", var.plan_code))
    error_message = "plan_code must look like vps-2027-model3."
  }
}

variable "datacenter" {
  type        = string
  description = "Datacenter code ordered through the vps_datacenter configuration."

  validation {
    condition = contains(
      ["BHS", "DE", "EU-SOUTH-MIL", "EU-WEST-RBX", "GRA", "SBG", "SGP", "SYD", "UK", "WAW", "YNM"],
      var.datacenter,
    )
    error_message = "datacenter must be one of BHS, DE, EU-SOUTH-MIL, EU-WEST-RBX, GRA, SBG, SGP, SYD, UK, WAW, YNM."
  }
}

variable "os" {
  type        = string
  description = "Operating system ordered through the vps_os configuration, exactly as spelled in the catalog (for example Ubuntu 26.04)."

  validation {
    condition     = length(trimspace(var.os)) > 0
    error_message = "os must not be empty."
  }
}

variable "duration" {
  type        = string
  description = "Subscription duration in ISO 8601 format."
  default     = "P1M"

  validation {
    condition     = can(regex("^P[0-9]+[MY]$", var.duration))
    error_message = "duration must be an ISO 8601 period such as P1M or P1Y."
  }
}

variable "pricing_mode" {
  type        = string
  description = "Catalog pricing mode. The upfront modes commit to a prepaid term."
  default     = "default"

  validation {
    condition     = contains(["default", "upfront6", "upfront12"], var.pricing_mode)
    error_message = "pricing_mode must be default, upfront6 or upfront12."
  }
}

variable "image_id" {
  type        = string
  description = "OVH image UUID installed right after delivery. Required with public_ssh_key. Changing it later reinstalls the server in place."
  default     = null

  validation {
    condition     = var.image_id == null || can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.image_id))
    error_message = "image_id must be a UUID. List the ones offered with 'make images'."
  }

  validation {
    condition     = var.public_ssh_key == null || var.image_id != null
    error_message = "public_ssh_key can only be installed together with an image_id."
  }
}

variable "public_ssh_key" {
  type        = string
  description = "Public SSH key installed for the default user at install time. Changing it later reinstalls the server in place."
  default     = null
}

variable "do_not_send_password" {
  type        = bool
  description = "Skip generating and emailing a root password."
  default     = true

  validation {
    condition     = !var.do_not_send_password || var.public_ssh_key != null
    error_message = "do_not_send_password requires public_ssh_key, otherwise the server has no way to log in."
  }
}

variable "netboot_mode" {
  type        = string
  description = "Boot mode of the server."
  default     = "local"

  validation {
    condition     = contains(["local", "rescue"], var.netboot_mode)
    error_message = "netboot_mode must be local or rescue."
  }
}
