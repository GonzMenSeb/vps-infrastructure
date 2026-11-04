output "service_name" {
  description = "OVH service name of the VPS."
  value       = module.server.service_name
}

output "state" {
  description = "State reported by OVH."
  value       = module.server.state
}

output "zone" {
  description = "OpenStack region hosting the server."
  value       = module.server.zone
}

output "ipv4" {
  description = "Public IPv4 address."
  value       = module.server.ipv4
}

output "ipv6" {
  description = "Public IPv6 address."
  value       = module.server.ipv6
}

output "ssh_user" {
  description = "Login user created by the chosen image."
  value       = var.ssh_user
}

output "ssh_command" {
  description = "Command that opens a shell on the server."
  value       = module.server.ipv4 == null ? null : "ssh ${var.ssh_user}@${module.server.ipv4}"
}

output "ansible_inventory" {
  description = "Ansible inventory for the server, written to .generated/inventory.yml by 'make inventory'."
  value = yamlencode({
    all = {
      hosts = {
        (var.ansible_host_alias) = {
          ansible_host = module.server.ipv4
          ansible_user = var.ssh_user
        }
      }
    }
  })
}
