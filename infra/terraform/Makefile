SHELL := bash
.DEFAULT_GOAL := help
.PHONY: help init fmt validate test key stock plan up down status inventory ping ssh images catalog backup resume-old cutover restore converge jenkins migrate retire

ROOT := $(abspath ../..)
GENERATED := .generated
PLAN := .plan

-include $(ROOT)/local.env
export OVH_ENDPOINT OVH_APPLICATION_KEY OVH_APPLICATION_SECRET OVH_CONSUMER_KEY

ifneq ($(wildcard backend_override.tf),)
export AWS_ACCESS_KEY_ID := $(R2_ACCESS_KEY_ID)
export AWS_SECRET_ACCESS_KEY := $(R2_SECRET_ACCESS_KEY)
endif

help:
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

init: ## Download providers and configure the backend
	terraform init -input=false

fmt: ## Format every Terraform file
	terraform fmt -recursive

validate: init ## Check the configuration
	terraform validate

test: ## Run the module tests (mocked provider) and the migration script tests
	cd modules/ovh_vps && terraform init -backend=false -input=false && terraform test
	tests/migrate.sh

key: ## Check the OVH API key rights and expiry
	scripts/check-key.sh

stock: ## Check that the configured datacenter has stock for the plan
	scripts/check-stock.sh

plan: init ## Show what would change (read-only)
	terraform plan

up: key stock init ## Order or update the server, then write the Ansible inventory
	terraform plan -out=$(PLAN)
	scripts/check-destructive.sh $(PLAN)
	@read -r -p "Apply this plan? Type yes: " answer && [ "$$answer" = yes ]
	terraform apply $(PLAN)
	rm -f $(PLAN)
	$(MAKE) inventory

down: key init ## Terminate the server
	@echo "Requests termination of the OVH VPS. Its IP is lost, and billing may run to the end of the paid period."
	terraform destroy
	rm -rf $(GENERATED) $(PLAN)

backup: key ## Cold backup of the current main VPS (stops its containers)
	scripts/backup-vps.sh

resume-old: ## Restart the containers the last backup stopped on the old VPS
	scripts/resume-old.sh

cutover: init ## Point the vault at the new server and run the playbook on it
	scripts/cutover.sh

restore: ## Restore the last backup onto the new server
	scripts/restore-vps.sh

converge: ## Run the playbook again after the restore, then the health checks
	cd $(ROOT) && ansible-playbook playbook.yml && ansible-playbook tests/health-check.yml

jenkins: ## Re-run the Jenkins playbook so VPS_HOST follows the new server (restarts Jenkins)
	@read -r -p "No Jenkins build may be running. Type yes: " answer && [ "$$answer" = yes ]
	cd $(ROOT) && ansible-playbook jenkins-playbook.yml

migrate: cutover restore converge ## cutover, restore and converge in order

retire: key init ## Terminate the old VPS recorded by the last backup
	scripts/retire-old.sh

status: init ## Show the server outputs
	terraform output

inventory: ## Write .generated/inventory.yml for Ansible
	mkdir -p $(GENERATED)
	terraform output -raw ansible_inventory > $(GENERATED)/inventory.yml

ping: ## Check that Ansible can reach the server
	cd $(ROOT) && ansible -i infra/terraform/$(GENERATED)/inventory.yml all -m ping

ssh: ## Open a shell on the server
	ssh "$$(terraform output -raw ssh_user)@$$(terraform output -raw ipv4)"

images: ## List installable OS images (SERVICE=<name> to query a specific VPS)
	scripts/ovh.sh images $(SERVICE)

catalog: ## List VPS plan codes and monthly prices
	scripts/ovh.sh catalog
