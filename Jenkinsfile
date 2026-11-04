pipeline {
    agent any

    environment {
        ANSIBLE_FORCE_COLOR    = 'true'
        ANSIBLE_HOST_KEY_CHECKING = 'False'
    }

    options {
        ansiColor('xterm')
        disableConcurrentBuilds()
        timeout(time: 15, unit: 'MINUTES')
    }

    stages {
        stage('Scope') {
            steps {
                script {
                    def base = env.GIT_PREVIOUS_SUCCESSFUL_COMMIT
                    def known = base && sh(returnStatus: true, script: "git cat-file -e ${base}^{commit}") == 0
                    env.SKIP_INFRA = 'false'
                    if (known) {
                        def changed = sh(returnStdout: true, script: "git diff --name-only ${base} ${env.GIT_COMMIT}").trim()
                        if (changed && changed.split('\n').every { it.startsWith('panel/') }) {
                            env.SKIP_INFRA = 'true'
                            echo 'Only panel/ changed since the last successful build; panel-deploy handles it.'
                        }
                    }
                }
            }
        }

        stage('Setup') {
            when { not { environment name: 'SKIP_INFRA', value: 'true' } }
            steps {
                sh 'ansible-galaxy collection install -r requirements.yml'
            }
        }

        stage('Lint') {
            when { not { environment name: 'SKIP_INFRA', value: 'true' } }
            steps {
                withCredentials([string(credentialsId: 'ansible-vault-pass', variable: 'VAULT_PASS')]) {
                    sh '''
                        echo "$VAULT_PASS" > .vault_pass_tmp
                        ANSIBLE_VAULT_PASSWORD_FILE=.vault_pass_tmp \
                            ansible-lint playbook.yml
                        rm -f .vault_pass_tmp
                    '''
                }
            }
        }

        stage('Syntax Check') {
            when { not { environment name: 'SKIP_INFRA', value: 'true' } }
            steps {
                withCredentials([string(credentialsId: 'ansible-vault-pass', variable: 'VAULT_PASS')]) {
                    sh '''
                        echo "$VAULT_PASS" > .vault_pass_tmp
                        ansible-playbook --syntax-check \
                            --vault-password-file .vault_pass_tmp \
                            playbook.yml
                        rm -f .vault_pass_tmp
                    '''
                }
            }
        }

        stage('Dry Run') {
            when { not { environment name: 'SKIP_INFRA', value: 'true' } }
            steps {
                withCredentials([
                    string(credentialsId: 'ansible-vault-pass', variable: 'VAULT_PASS'),
                    sshUserPrivateKey(credentialsId: 'vps-ssh-key', keyFileVariable: 'SSH_KEY')
                ]) {
                    sh '''
                        echo "$VAULT_PASS" > .vault_pass_tmp
                        ansible-playbook --check --diff \
                            --vault-password-file .vault_pass_tmp \
                            --private-key "$SSH_KEY" \
                            playbook.yml
                        rm -f .vault_pass_tmp
                    '''
                }
            }
        }

        stage('Deploy') {
            when { not { environment name: 'SKIP_INFRA', value: 'true' } }
            steps {
                withCredentials([
                    string(credentialsId: 'ansible-vault-pass', variable: 'VAULT_PASS'),
                    sshUserPrivateKey(credentialsId: 'vps-ssh-key', keyFileVariable: 'SSH_KEY')
                ]) {
                    sh '''
                        echo "$VAULT_PASS" > .vault_pass_tmp
                        ansible-playbook \
                            --vault-password-file .vault_pass_tmp \
                            --private-key "$SSH_KEY" \
                            playbook.yml
                        rm -f .vault_pass_tmp
                    '''
                }
            }
        }

        stage('Health Check') {
            when { not { environment name: 'SKIP_INFRA', value: 'true' } }
            steps {
                withCredentials([
                    string(credentialsId: 'ansible-vault-pass', variable: 'VAULT_PASS'),
                    sshUserPrivateKey(credentialsId: 'vps-ssh-key', keyFileVariable: 'SSH_KEY')
                ]) {
                    sh '''
                        echo "$VAULT_PASS" > .vault_pass_tmp
                        ansible-playbook \
                            --vault-password-file .vault_pass_tmp \
                            --private-key "$SSH_KEY" \
                            tests/health-check.yml
                        rm -f .vault_pass_tmp
                    '''
                }
            }
        }
    }

    post {
        always {
            sh 'rm -f .vault_pass_tmp'
        }
        failure {
            echo '❌ Pipeline failed — VPS may need manual inspection.'
        }
        success {
            echo '✅ Deployed and all health checks passed.'
        }
    }
}
