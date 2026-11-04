mock_provider "ovh" {
  mock_resource "ovh_vps" {
    defaults = {
      service_name = "vps-test.vps.ovh.ca"
    }
  }

  mock_data "ovh_vps" {
    defaults = {
      ips = ["2001:db8::10", "203.0.113.10"]
    }
  }
}

variables {
  display_name   = "test"
  ovh_subsidiary = "WE"
  plan_code      = "vps-2027-model3"
  datacenter     = "SGP"
  os             = "Ubuntu 26.04"
  image_id       = "7244a55a-f624-4705-a2ac-e8ccfe8637a0"
  public_ssh_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample test"
}

run "orders_the_requested_spec" {
  command = apply

  assert {
    condition     = ovh_vps.this.plan[0].plan_code == "vps-2027-model3" && ovh_vps.this.plan[0].pricing_mode == "default" && ovh_vps.this.plan[0].duration == "P1M"
    error_message = "The order must use the requested plan, default pricing and a one month duration."
  }

  assert {
    condition     = [for c in ovh_vps.this.plan[0].configuration : c.value if c.label == "vps_datacenter"][0] == "SGP"
    error_message = "The datacenter must be passed through the vps_datacenter configuration."
  }

  assert {
    condition     = [for c in ovh_vps.this.plan[0].configuration : c.value if c.label == "vps_os"][0] == "Ubuntu 26.04"
    error_message = "The OS must be passed through the vps_os configuration."
  }
}

run "picks_the_ipv4_address" {
  command = apply

  assert {
    condition     = output.ipv4 == "203.0.113.10" && output.ipv6 == "2001:db8::10"
    error_message = "ipv4 and ipv6 must be split out of the address list."
  }
}

run "rejects_unknown_datacenter" {
  command = plan

  variables {
    datacenter = "MARS"
  }

  expect_failures = [var.datacenter]
}

run "rejects_malformed_plan_code" {
  command = plan

  variables {
    plan_code = "s1-2"
  }

  expect_failures = [var.plan_code]
}

run "rejects_unknown_pricing_mode" {
  command = plan

  variables {
    pricing_mode = "upfront24"
  }

  expect_failures = [var.pricing_mode]
}

run "rejects_ssh_key_without_image" {
  command = plan

  variables {
    image_id = null
  }

  expect_failures = [var.image_id]
}

run "rejects_malformed_image_id" {
  command = plan

  variables {
    image_id = "not-a-uuid"
  }

  expect_failures = [var.image_id]
}

run "rejects_lockout_without_key_or_password" {
  command = plan

  variables {
    image_id       = null
    public_ssh_key = null
  }

  expect_failures = [var.do_not_send_password]
}

run "allows_password_login_without_key" {
  command = plan

  variables {
    image_id             = null
    public_ssh_key       = null
    do_not_send_password = false
  }
}
