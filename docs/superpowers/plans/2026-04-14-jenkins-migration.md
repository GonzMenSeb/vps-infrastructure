# Jenkins Migration to Dedicated VPS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Jenkins from the main VPS (148.113.172.15) to a dedicated VPS (178.105.0.118), breaking the circular dependency where Jenkins deploys to the server it runs on.

**Architecture:** Reuse existing `base`, `docker`, and `traefik` roles on the new Jenkins host. A new `jenkins-playbook.yml` targets only the Jenkins VPS. The main `playbook.yml` drops the Jenkins role entirely. The `base` role gets a minor tweak to support root login (the Jenkins VPS uses root). The Jenkinsfile removes all `--skip-tags jenkins` workarounds.

**Tech Stack:** Ansible, Docker Compose, Traefik v3, Jenkins LTS (JDK17), Let's Encrypt

---

### Task 1: Make base role support root SSH login

The Jenkins VPS connects as root. The current `sshd-hardening.conf.j2` hardcodes `PermitRootLogin no`. Make it configurable.

**Files:**
- Modify: `roles/base/defaults/main.yml`
- Modify: `roles/base/templates/sshd-hardening.conf.j2`

- [ ] **Step 1: Add `permit_root_login` default**

In `roles/base/defaults/main.yml`, add:

```yaml
permit_root_login: "no"
```

- [ ] **Step 2: Use variable in sshd template**

In `roles/base/templates/sshd-hardening.conf.j2`, change:

```
PermitRootLogin no
```

to:

```
PermitRootLogin {{ permit_root_login }}
```

- [ ] **Step 3: Commit**

```bash
git add roles/base/defaults/main.yml roles/base/templates/sshd-hardening.conf.j2
git commit -m "feat(base): make PermitRootLogin configurable for multi-host support"
```

---

### Task 2: Add Jenkins host to inventory and configure host vars

**Files:**
- Modify: `inventory.yml`
- Create: `host_vars/jenkins.yml`

- [ ] **Step 1: Add jenkins host to inventory**

Replace `inventory.yml` contents with:

```yaml
all:
  hosts:
    vps:
      ansible_host: 148.113.172.15
      ansible_user: ubuntu
    jenkins:
      ansible_host: 178.105.0.118
      ansible_user: root
```

- [ ] **Step 2: Create host_vars/jenkins.yml**

```yaml
---
permit_root_login: "yes"
ssh_allowed_users: root
ssh_max_auth_tries: 3

ufw_allowed_ports:
  - { port: 22, proto: tcp, comment: "SSH" }
  - { port: 80, proto: tcp, comment: "HTTP" }
  - { port: 443, proto: tcp, comment: "HTTPS" }

traefik_dashboard_host: "traefik-ci.{{ web_subdomain }}"
```

- [ ] **Step 3: Commit**

```bash
git add inventory.yml host_vars/jenkins.yml
git commit -m "feat: add Jenkins VPS to inventory with host-specific vars"
```

---

### Task 3: Create Jenkins server playbook

**Files:**
- Create: `jenkins-playbook.yml`

- [ ] **Step 1: Create jenkins-playbook.yml**

```yaml
---
- name: Configure Jenkins server
  hosts: jenkins
  become: true
  vars_files:
    - vault.yml

  roles:
    - base
    - docker
    - traefik
    - jenkins
```

- [ ] **Step 2: Commit**

```bash
git add jenkins-playbook.yml
git commit -m "feat: add dedicated playbook for Jenkins server"
```

---

### Task 4: Remove Jenkins from main VPS playbook and Jenkinsfile

**Files:**
- Modify: `playbook.yml`
- Modify: `Jenkinsfile`

- [ ] **Step 1: Remove Jenkins role from playbook.yml**

Change line 15 from:

```yaml
    - { role: jenkins, tags: ['jenkins'] }
```

Remove that line entirely. The roles list becomes:

```yaml
  roles:
    - base
    - docker
    - traefik
    - dns
    - vaultwarden
    - monitoring
```

- [ ] **Step 2: Clean up Jenkinsfile**

Remove the `--skip-tags jenkins` flags from the Dry Run stage (line 60) and Deploy stage (line 79). Remove `--exclude roles/jenkins` from the Lint stage (line 28).

Updated Lint `sh` block:

```groovy
sh '''
    echo "$VAULT_PASS" > .vault_pass_tmp
    ANSIBLE_VAULT_PASSWORD_FILE=.vault_pass_tmp \
        ansible-lint playbook.yml
    rm -f .vault_pass_tmp
'''
```

Updated Dry Run `sh` block:

```groovy
sh '''
    echo "$VAULT_PASS" > .vault_pass_tmp
    ansible-playbook --check --diff \
        --vault-password-file .vault_pass_tmp \
        --private-key "$SSH_KEY" \
        playbook.yml
    rm -f .vault_pass_tmp
'''
```

Updated Deploy `sh` block:

```groovy
sh '''
    echo "$VAULT_PASS" > .vault_pass_tmp
    ansible-playbook \
        --vault-password-file .vault_pass_tmp \
        --private-key "$SSH_KEY" \
        playbook.yml
    rm -f .vault_pass_tmp
'''
```

- [ ] **Step 3: Commit**

```bash
git add playbook.yml Jenkinsfile
git commit -m "feat: remove Jenkins from main VPS — now on dedicated server"
```

---

### Task 5: Deploy Jenkins to the new VPS

This task is operational — run from local machine.

- [ ] **Step 1: Install Ansible Galaxy requirements**

```bash
ansible-galaxy collection install -r requirements.yml
```

- [ ] **Step 2: Dry-run the Jenkins playbook**

```bash
ansible-playbook --check --diff \
    --vault-password-file <vault-pass-file> \
    jenkins-playbook.yml
```

Verify: no errors, all tasks show expected changes.

- [ ] **Step 3: Deploy for real**

```bash
ansible-playbook \
    --vault-password-file <vault-pass-file> \
    jenkins-playbook.yml
```

Verify: all tasks succeed, Jenkins container is running.

- [ ] **Step 4: Verify Jenkins is reachable on port 8080**

```bash
ssh root@178.105.0.118 "docker ps --filter name=jenkins --filter name=traefik"
```

Both `jenkins` and `traefik` containers should be running.

---

### Task 6: Update DNS and verify TLS

- [ ] **Step 1: Update DNS record**

In PowerDNS Admin (https://dns.web.vespiridion.org), update the A record for `jenkins.web.vespiridion.org` from `148.113.172.15` to `178.105.0.118`.

If `traefik-ci.web.vespiridion.org` dashboard access is desired, add an A record pointing to `178.105.0.118` as well.

- [ ] **Step 2: Wait for DNS propagation and verify**

```bash
dig jenkins.web.vespiridion.org +short
```

Expected: `178.105.0.118`

- [ ] **Step 3: Verify Jenkins responds with TLS**

```bash
curl -sI https://jenkins.web.vespiridion.org | head -5
```

Expected: HTTP 200 or 403 (login required).

---

### Task 7: Clean up Jenkins from the old VPS

- [ ] **Step 1: Stop and remove Jenkins container on old VPS**

```bash
ssh ubuntu@148.113.172.15 "sudo docker compose -f /opt/jenkins/docker-compose.yml down && sudo rm -rf /opt/jenkins"
```

- [ ] **Step 2: Remove the jenkins-ansible image from old VPS**

```bash
ssh ubuntu@148.113.172.15 "sudo docker rmi jenkins-ansible:latest 2>/dev/null; true"
```

- [ ] **Step 3: Verify main VPS pipeline still works**

Push a commit to trigger the Jenkins pipeline. Verify all stages (Setup, Lint, Syntax Check, Dry Run, Deploy, Health Check) pass from the new Jenkins server.
