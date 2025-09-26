# Use Node.js LTS version
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --only=production

# Copy source code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs \
    && adduser -S socketio -u 1001 \
    && chown -R socketio:nodejs /app

# Switch to non-root user
USER socketio

# Expose port
EXPOSE 3001

# Start the application
CMD ["node", "server.js"]
