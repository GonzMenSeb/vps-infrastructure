pipeline {
    agent any

    environment {
        ANSIBLE_FORCE_COLOR    = 'true'
        ANSIBLE_HOST_KEY_CHECKING = 'False'
    }

    options {
        ansiColor('xterm')
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 15, unit: 'MINUTES')
    }

    stages {
        stage('Lint') {
            steps {
                sh 'ansible-lint playbook.yml --exclude roles/jenkins'
            }
        }

        stage('Syntax Check') {
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
                            --skip-tags jenkins \
                            playbook.yml
                        rm -f .vault_pass_tmp
                    '''
                }
            }
        }

        stage('Deploy') {
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
                            --skip-tags jenkins \
                            playbook.yml
                        rm -f .vault_pass_tmp
                    '''
                }
            }
        }

        stage('Health Check') {
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
