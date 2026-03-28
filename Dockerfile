FROM node:22-slim

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files and install
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy application code
COPY server/ ./server/
COPY web/ ./web/
COPY docs/ ./docs/

# Create data directory for SQLite
RUN mkdir -p /data

WORKDIR /app/server

EXPOSE 3100

CMD ["node", "server.js"]
