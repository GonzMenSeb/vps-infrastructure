resource "ovh_vps" "this" {
  display_name         = var.display_name
  ovh_subsidiary       = var.ovh_subsidiary
  image_id             = var.image_id
  public_ssh_key       = var.public_ssh_key
  do_not_send_password = var.do_not_send_password
  netboot_mode         = var.netboot_mode

  plan = [
    {
      duration     = var.duration
      plan_code    = var.plan_code
      pricing_mode = var.pricing_mode

      configuration = [
        {
          label = "vps_datacenter"
          value = var.datacenter
        },
        {
          label = "vps_os"
          value = var.os
        },
      ]
    },
  ]
}

data "ovh_vps" "this" {
  service_name = ovh_vps.this.service_name
}

locals {
  ipv4_addresses = [for ip in data.ovh_vps.this.ips : ip if can(regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$", ip))]
  ipv6_addresses = [for ip in data.ovh_vps.this.ips : ip if can(regex(":", ip))]
}
