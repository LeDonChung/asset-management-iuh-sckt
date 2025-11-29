pipeline {
    agent any
    tools {
        nodejs 'NodeJS'
    }
    environment {
        BRANCH_DEPLOY = 'production'
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
                    sh "docker build -f Dockerfile -t ${DOCKER_HUB_REPO}/${APP_NAME}:${env.BUILD_NUMBER} --build-arg BUILD_NUMBER=${env.BUILD_NUMBER} ."
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
                    usernamePassword(credentialsId: 'docker-credentials', usernameVariable: 'DOCKER_USERNAME', passwordVariable: 'DOCKER_PASSWORD'),
                    string(credentialsId: 'production-host', variable: 'PRODUCTION_HOST')
                ]) {
                    script {
                        def remoteHost = "${PRODUCTION_HOST}"
                        def deployDir = "/home/$USER/asset-management"
        
                        // Gửi file .env từ Jenkins sang server
                        sh """
                            scp -i $KEY -o StrictHostKeyChecking=no .env $USER@$remoteHost:${deployDir}/.env || true
                        """
                        
                        // Gửi file docker-compose.yml từ Jenkins sang server
                        sh """
                            scp -i $KEY -o StrictHostKeyChecking=no docker-compose.yml $USER@$remoteHost:${deployDir}/docker-compose.yml || true
                        """
        
                        sh """
                            ssh -i $KEY -o StrictHostKeyChecking=no $USER@$remoteHost << 'EOF'
                            set -e
        
                            # Tạo thư mục deploy nếu chưa có và clone repository nếu chưa tồn tại
                            if [ ! -d "${deployDir}" ]; then
                                git clone -b ${BRANCH_DEPLOY} https://github.com/LeDonChung/asset-management-iuh-sckt.git ${deployDir}
                            else
                                cd ${deployDir}
                                git fetch origin
                                git checkout ${BRANCH_DEPLOY}
                                
                                # Reset any local changes to avoid conflicts
                                git reset --hard HEAD
                                git clean -fd
                                
                                # Pull latest changes
                                git pull origin ${BRANCH_DEPLOY}
                            fi
        
                            cd ${deployDir}
        
                            # Login Docker Hub
                            echo "$DOCKER_PASSWORD" | docker login --username "$DOCKER_USERNAME" --password-stdin
        
                            # Stop và remove containers cũ
                            docker-compose -f docker-compose.yml --env-file .env down || true
        
                            # Pull image mới
                            docker pull ${DOCKER_HUB_REPO}/${APP_NAME}:${env.BUILD_NUMBER}
                            
                            # Update docker-compose để sử dụng image mới
                            sed -i "s|image: ${DOCKER_HUB_REPO}/${APP_NAME}:.*|image: ${DOCKER_HUB_REPO}/${APP_NAME}:${env.BUILD_NUMBER}|g" docker-compose.yml
        
                            # Stop existing containers and remove old containers
                            docker-compose -f docker-compose.yml --env-file .env down --remove-orphans
                            
                            # Remove old images
                            docker rmi \$(docker images ${DOCKER_HUB_REPO}/${APP_NAME} -q) 2>/dev/null || true
                            
                            # Start services with new image
                            docker-compose -f docker-compose.yml --env-file .env up -d --force-recreate
        
                            # Wait for service to be ready
                            sleep 10
                            
                            # Show running containers with image info
                            docker-compose ps
                            echo "=== Verification: Container is using the correct image ==="
                            docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" | grep asset-socket-server
                            
                            # Verify the application is responding
                            echo "=== Verification: Application health check ==="
                            sleep 5  # Give more time for the app to start
                            
                            # Check if container is running
                            if docker ps | grep -q "asset-socket-server"; then
                                echo "✅ Container is running"
                                
                                # Test health endpoint
                                if curl -f http://localhost:${PORT:-3001}/health; then
                                    echo "✅ Health check passed"
                                    
                                    # Check build number
                                    echo "=== Build Number Verification ==="
                                    curl -s http://localhost:${PORT:-3001}/api/status | grep -o '"buildNumber":"[^"]*"' || echo "Build number not found"
                                else
                                    echo "❌ Health check failed"
                                fi
                            else
                                echo "❌ Container is not running"
                                docker logs asset-socket-server || true
                            fi
        
                            # Cleanup old images
                            docker image prune -f
EOF
                        """
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
            withCredentials([string(credentialsId: 'production-host', variable: 'PRODUCTION_HOST')]) {
                echo "http://${PRODUCTION_HOST}:3001/health"
            }
        }

        failure {
            echo "Deployment failed! Please check the logs."
        }
    }
}
