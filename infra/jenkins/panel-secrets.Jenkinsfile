pipeline {
    agent any

    // Concurrency, build retention and the VAR_NAME/VAR_VALUE parameters are job properties
    // set by Job DSL in casc.yml.j2. Declaring any of them here would make Declarative rewrite them.
    options {
        timeout(time: 10, unit: 'MINUTES')
    }

    stages {
        stage('Edit and push') {
            steps {
                withCredentials([string(credentialsId: 'ansible-vault-pass', variable: 'VAULT_PASS')]) {
                    sshagent(credentials: ['github-write-ssh-key']) {
                        sh '''
                            set +x
                            set -eu
                            umask 077
                            base=/dev/shm
                            [ -d "$base" ] && [ -w "$base" ] && [ -x "$base" ] || { echo "panel-secrets: $base is not usable; refusing to write the vault password to disk" >&2; exit 1; }
                            scratch=$(mktemp -d "$base/panel-secrets.XXXXXX")
                            trap 'exit 143' TERM INT HUP
                            trap 'rm -rf "$scratch" "$WORKSPACE/repo"' EXIT
                            printf %s "$VAULT_PASS" > "$scratch/vault-pass"
                            rm -rf "$WORKSPACE/repo" "$WORKSPACE/result.txt"
                            git clone --quiet --branch main --single-branch "$PANEL_SECRETS_REPO" "$WORKSPACE/repo"
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
            sh 'rm -rf "$WORKSPACE/repo" "$WORKSPACE/result.txt" /dev/shm/panel-secrets.* "${TMPDIR:-/tmp}"/panel-secrets.* || true'
        }
    }
}
