pipeline {
    agent any
    tools {
        nodejs 'NodeJS' // Cấu hình NodeJS trong Jenkins Global Tool Configuration
    }
    environment {
        BRANCH_DEPLOY = 'deploy'
        PRODUCTION_HOST = "34.158.42.23"
        DOCKER_HUB_REPO = 'ledonchung'
        APP_NAME = 'asset-management-iuh-sckt'
    }
    stages {
        stage('Checkout') {
            steps {
                git branch: env.BRANCH_DEPLOY, url: 'https://github.com/LeDonChung/asset-management-iuh-sckt.git'
            }
        }

        stage('Load .env') {
            steps {
                withCredentials([file(credentialsId: 'asset-management-iuh-sckt', variable: 'ENV_FILE')]) {
                    sh 'rm -f .env'
                    sh 'cp "$ENV_FILE" .env'
                }
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm install'
            }
        }

        stage('Build Docker Image') {
            steps {
                script {
                    sh "docker build -f Dockerfile -t ${DOCKER_HUB_REPO}/${APP_NAME}:${env.BUILD_NUMBER} ."
                    sh "docker tag ${DOCKER_HUB_REPO}/${APP_NAME}:${env.BUILD_NUMBER} ${DOCKER_HUB_REPO}/${APP_NAME}:latest"
                }
            }
        }

        stage('Push to Docker Hub') {
            steps {
                withCredentials([usernamePassword(credentialsId: 'docker-credentials', usernameVariable: 'DOCKER_USERNAME', passwordVariable: 'DOCKER_PASSWORD')]) {
                    sh 'echo $DOCKER_PASSWORD | docker login --username $DOCKER_USERNAME --password-stdin'
                    sh "docker push ${DOCKER_HUB_REPO}/${APP_NAME}:${env.BUILD_NUMBER}"
                    sh "docker push ${DOCKER_HUB_REPO}/${APP_NAME}:latest"
                }
            }
        }

        stage('Deploy to Production') {
            steps {
                withCredentials([
                    sshUserPrivateKey(credentialsId: 'production-server-ssh-key', keyFileVariable: 'KEY', usernameVariable: 'USER'),
                    usernamePassword(credentialsId: 'docker-credentials', usernameVariable: 'DOCKER_USERNAME', passwordVariable: 'DOCKER_PASSWORD')
                ]) {
                    withEnv(["DEPLOY_DIR=/home/${USER}/asset-management", "REMOTE_HOST=${PRODUCTION_HOST}"]) {
                        script {
                            // Copy .env và docker-compose.yml lên server
                            sh """
                                scp -i \$KEY -o StrictHostKeyChecking=no .env \$USER@\$REMOTE_HOST:\$DEPLOY_DIR/.env || true
                                scp -i \$KEY -o StrictHostKeyChecking=no docker-compose.yml \$USER@\$REMOTE_HOST:\$DEPLOY_DIR/docker-compose.yml || true
                            """

                            // SSH vào server và deploy
                            sh """
                                ssh -i \$KEY -o StrictHostKeyChecking=no \$USER@\$REMOTE_HOST << EOF
                                set -e

                                # Tạo thư mục deploy nếu chưa có
                                mkdir -p \$DEPLOY_DIR
                                cd \$DEPLOY_DIR

                                # Clone hoặc pull repository
                                if [ ! -d "\$DEPLOY_DIR/.git" ]; then
                                    git clone -b ${BRANCH_DEPLOY} https://github.com/LeDonChung/asset-management-iuh-sckt.git \$DEPLOY_DIR
                                else
                                    git fetch origin
                                    git checkout ${BRANCH_DEPLOY}
                                    git pull origin ${BRANCH_DEPLOY}
                                fi

                                # Docker login
                                echo "\$DOCKER_PASSWORD" | docker login --username "\$DOCKER_USERNAME" --password-stdin

                                # Stop và remove containers cũ
                                docker-compose -f docker-compose.yml --env-file .env down || true

                                # Pull image mới
                                docker pull ${DOCKER_HUB_REPO}/${APP_NAME}:${env.BUILD_NUMBER}

                                # Update docker-compose.yml để sử dụng image mới
                                sed -i "s|image: ${DOCKER_HUB_REPO}/${APP_NAME}:.*|image: ${DOCKER_HUB_REPO}/${APP_NAME}:${env.BUILD_NUMBER}|g" docker-compose.yml

                                # Start services
                                docker-compose -f docker-compose.yml --env-file .env up -d

                                # Show running containers
                                docker-compose ps

                                # Cleanup old images
                                docker image prune -f
EOF
                            """
                        }
                    }
                }
            }
        }
    }

    post {
        always {
            sh 'docker logout'

            // Cleanup old local images
            sh """
            for image in \$(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^${DOCKER_HUB_REPO}/${APP_NAME}'); do
                tag=\$(echo \$image | cut -d':' -f2)
                if [ "\$tag" != "latest" ] && echo "\$tag" | grep -E '^[0-9]+\$' > /dev/null; then
                    if [ "\$tag" -lt ${BUILD_NUMBER} ]; then
                        echo "🧹 Removing old image \$image"
                        docker rmi "\$image" || true
                    fi
                fi
            done
            """
        }

        success {
            echo "✅ Deployment successful! Application is running at http://${PRODUCTION_HOST}:3001"
        }

        failure {
            echo "❌ Deployment failed! Please check the logs."
        }
    }
}
