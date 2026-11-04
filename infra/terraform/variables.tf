variable "name" {
  type        = string
  description = "Display name of the server in the OVHcloud manager."
}

variable "plan_code" {
  type        = string
  description = "Catalog plan code, for example vps-2027-model3. List them with 'make catalog'."
}

variable "datacenter" {
  type        = string
  description = "Datacenter code, for example SGP or BHS."
}

variable "os" {
  type        = string
  description = "Operating system exactly as spelled in the OVH catalog, for example Ubuntu 26.04."
}

variable "duration" {
  type        = string
  description = "Subscription duration in ISO 8601 format."
  default     = "P1M"
}

variable "pricing_mode" {
  type        = string
  description = "Catalog pricing mode: default, upfront6 or upfront12."
  default     = "default"
}

variable "image_id" {
  type        = string
  description = "OVH image UUID installed after delivery, needed to pre-install the SSH key. List them with 'make images'."
  default     = null
}

variable "ssh_public_key_path" {
  type        = string
  description = "Public key file installed on the server. Null installs no key."
  default     = null
}

variable "ssh_user" {
  type        = string
  description = "Login user created by the chosen image."
  default     = "ubuntu"
}

variable "do_not_send_password" {
  type        = bool
  description = "Skip generating and emailing a root password."
  default     = true
}

variable "netboot_mode" {
  type        = string
  description = "Boot mode of the server: local or rescue."
  default     = "local"
}

variable "ovh_subsidiary" {
  type        = string
  description = "Overrides the subsidiary reported by GET /me."
  default     = null
}

variable "ansible_host_alias" {
  type        = string
  description = "Inventory name used for the server in the generated Ansible inventory."
  default     = "vespiridion"

  validation {
    condition     = !contains(["vps", "jenkins"], var.ansible_host_alias)
    error_message = "ansible_host_alias must not reuse the names of the existing production hosts (vps, jenkins)."
  }
}
