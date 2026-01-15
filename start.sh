#!/bin/sh
set -e

echo "🚀 Instagram Scraper API starting..."
echo "Environment: $NODE_ENV"
echo "Redis Host: $REDIS_HOST"

# Wait for Redis to be ready
echo "⏳ Waiting for Redis..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if wget -q --spider "http://$REDIS_HOST:${REDIS_PORT:-6379}" 2>/dev/null || \
       node -e "const net = require('net'); const s = new net.Socket(); s.connect(${REDIS_PORT:-6379}, '${REDIS_HOST:-localhost}', () => { console.log('Redis OK'); process.exit(0); }); s.on('error', () => process.exit(1));" 2>/dev/null; then
        echo "✅ Redis is ready!"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Waiting for Redis... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "⚠️ Redis not available, starting anyway..."
fi

# Start CRON job in background
echo "📅 Starting CRON job..."
node cron/update-docids.cron.js &

# Wait a bit for CRON to initialize
sleep 1

# Start API server (this will also initialize workers)
echo "🌐 Starting API server on port ${PORT:-3000}..."
exec node src/api/server.js
