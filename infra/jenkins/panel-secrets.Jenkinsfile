pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timeout(time: 10, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }

    stages {
        stage('Edit and push') {
            steps {
                script {
                    env.REPO_URL = scm.userRemoteConfigs[0].url
                }
                withCredentials([string(credentialsId: 'ansible-vault-pass', variable: 'VAULT_PASS')]) {
                    sshagent(credentials: ['github-write-ssh-key']) {
                        sh '''
                            set +x
                            set -eu
                            umask 077
                            base=/dev/shm
                            [ -d "$base" ] && [ -w "$base" ] || base="${TMPDIR:-/tmp}"
                            scratch=$(mktemp -d "$base/panel-secrets.XXXXXX")
                            trap 'rm -rf "$scratch" "$WORKSPACE/repo"' EXIT
                            printf %s "$VAULT_PASS" > "$scratch/vault-pass"
                            rm -rf "$WORKSPACE/repo" "$WORKSPACE/result.txt"
                            git clone --quiet --branch main --single-branch "$REPO_URL" "$WORKSPACE/repo"
                            cp "$WORKSPACE/repo/infra/jenkins/panel-secrets.sh" "$WORKSPACE/repo/infra/jenkins/panel-secrets-verify.yml" "$scratch/"
                            VAULT_PASSWORD_FILE="$scratch/vault-pass" \
                                WORK_DIR="$WORKSPACE/repo" \
                                OUTPUT_FILE="$WORKSPACE/result.txt" \
                                bash "$scratch/panel-secrets.sh"
                        '''
                    }
                }
                script {
                    currentBuild.description = readFile('result.txt').trim()
                }
            }
        }
    }

    post {
        always {
            sh 'rm -rf "$WORKSPACE/repo" "$WORKSPACE/result.txt"'
        }
    }
}
