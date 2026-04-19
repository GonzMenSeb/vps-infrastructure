FROM jenkins/jenkins:lts-jdk21

USER root

# System deps + Ansible
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3-full \
        python3-pip-whl \
        python3-setuptools-whl \
        openssh-client \
        bind9-dnsutils \
        curl \
        ca-certificates \
        gnupg && \
    python3 -m venv /opt/ansible-venv && \
    /opt/ansible-venv/bin/pip install --no-cache-dir \
        ansible \
        ansible-lint && \
    ln -s /opt/ansible-venv/bin/ansible /usr/local/bin/ansible && \
    ln -s /opt/ansible-venv/bin/ansible-playbook /usr/local/bin/ansible-playbook && \
    ln -s /opt/ansible-venv/bin/ansible-vault /usr/local/bin/ansible-vault && \
    ln -s /opt/ansible-venv/bin/ansible-lint /usr/local/bin/ansible-lint && \
    ln -s /opt/ansible-venv/bin/ansible-galaxy /usr/local/bin/ansible-galaxy && \
    rm -rf /var/lib/apt/lists/*

# Docker CLI (to drive the host's Docker daemon via mounted socket)
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

# Node.js 22 + corepack (for pnpm)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    corepack enable && \
    rm -rf /var/lib/apt/lists/*

USER jenkins

COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt

ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false"
ENV CASC_JENKINS_CONFIG=/var/jenkins_home/casc.yml
