output "service_name" {
  description = "OVH service name of the VPS, for example vps-1a2b3c4d.vps.ovh.ca."
  value       = ovh_vps.this.service_name
}

output "display_name" {
  description = "Name shown in the OVHcloud manager."
  value       = ovh_vps.this.display_name
}

output "state" {
  description = "State reported by OVH."
  value       = ovh_vps.this.state
}

output "zone" {
  description = "OpenStack region hosting the server."
  value       = ovh_vps.this.zone
}

output "vcore" {
  description = "Number of virtual cores."
  value       = ovh_vps.this.vcore
}

output "memory_limit" {
  description = "RAM in MB."
  value       = ovh_vps.this.memory_limit
}

output "ipv4" {
  description = "First public IPv4 address, null until OVH attaches one."
  value       = try(local.ipv4_addresses[0], null)
}

output "ipv6" {
  description = "First public IPv6 address, null when none is attached."
  value       = try(local.ipv6_addresses[0], null)
}
