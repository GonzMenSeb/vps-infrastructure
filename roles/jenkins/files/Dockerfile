FROM jenkins/jenkins:lts-jdk17

USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3-full \
        python3-pip \
        python3-venv \
        sshpass \
        openssh-client \
        dnsutils \
        curl && \
    python3 -m venv /opt/ansible-venv && \
    /opt/ansible-venv/bin/pip install --no-cache-dir \
        ansible \
        ansible-lint && \
    ln -s /opt/ansible-venv/bin/ansible /usr/local/bin/ansible && \
    ln -s /opt/ansible-venv/bin/ansible-playbook /usr/local/bin/ansible-playbook && \
    ln -s /opt/ansible-venv/bin/ansible-vault /usr/local/bin/ansible-vault && \
    ln -s /opt/ansible-venv/bin/ansible-lint /usr/local/bin/ansible-lint && \
    rm -rf /var/lib/apt/lists/*

USER jenkins

COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt

ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false"
ENV CASC_JENKINS_CONFIG=/var/jenkins_home/casc.yml
