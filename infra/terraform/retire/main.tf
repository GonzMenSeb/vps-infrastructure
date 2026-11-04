terraform {
  required_version = ">= 1.10"

  required_providers {
    ovh = {
      source  = "ovh/ovh"
      version = "~> 2.24"
    }
  }
}

provider "ovh" {}

resource "ovh_vps" "old" {
  ovh_subsidiary = "WE"

  plan = [{
    duration      = "P1M"
    plan_code     = "vps-2027-model3"
    pricing_mode  = "default"
    configuration = []
  }]

  lifecycle {
    ignore_changes = all
  }
}
