provider "ovh" {}

data "ovh_me" "account" {}

locals {
  ovh_subsidiary = coalesce(var.ovh_subsidiary, data.ovh_me.account.ovh_subsidiary)
  public_ssh_key = var.ssh_public_key_path == null ? null : trimspace(file(pathexpand(var.ssh_public_key_path)))
}

module "server" {
  source = "./modules/ovh_vps"

  display_name         = var.name
  ovh_subsidiary       = local.ovh_subsidiary
  plan_code            = var.plan_code
  datacenter           = var.datacenter
  os                   = var.os
  duration             = var.duration
  pricing_mode         = var.pricing_mode
  image_id             = var.image_id
  public_ssh_key       = local.public_ssh_key
  do_not_send_password = var.do_not_send_password
  netboot_mode         = var.netboot_mode
}
