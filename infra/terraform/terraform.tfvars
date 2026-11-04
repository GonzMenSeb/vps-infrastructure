name         = "vespiridion"
plan_code    = "vps-2027-model3"
datacenter   = "BHS"
os           = "Ubuntu 26.04"
duration     = "P1M"
pricing_mode = "default"

image_id             = "7244a55a-f624-4705-a2ac-e8ccfe8637a0"
ssh_public_key_path  = "~/.ssh/id_rsa.pub"
ssh_user             = "ubuntu"
do_not_send_password = true
netboot_mode         = "local"

ansible_host_alias = "vespiridion"
