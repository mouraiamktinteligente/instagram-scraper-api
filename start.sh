#!/bin/sh
set -e

echo "🚀 Instagram Scraper API starting..."
echo "Environment: $NODE_ENV"
echo "Redis Host: $REDIS_HOST"
echo "Redis Port: ${REDIS_PORT:-6379}"

# Wait for Redis to be ready using Node.js with proper authentication
echo "⏳ Waiting for Redis..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Use Node.js to test Redis connection with authentication
    if node -e "
        const net = require('net');
        const client = new net.Socket();
        const timeout = setTimeout(() => {
            client.destroy();
            process.exit(1);
        }, 3000);
        
        client.connect(${REDIS_PORT:-6379}, '${REDIS_HOST:-localhost}', () => {
            // Send AUTH command if password is set
            const password = '${REDIS_PASSWORD:-}';
            if (password) {
                client.write('AUTH ' + password + '\r\n');
            }
            client.write('PING\r\n');
        });
        
        client.on('data', (data) => {
            const response = data.toString();
            if (response.includes('PONG') || response.includes('+OK')) {
                clearTimeout(timeout);
                client.destroy();
                process.exit(0);
            }
        });
        
        client.on('error', () => {
            clearTimeout(timeout);
            client.destroy();
            process.exit(1);
        });
    " 2>/dev/null; then
        echo "✅ Redis is ready!"
        break
    fi
    
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Waiting for Redis... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "⚠️ Redis connection timeout after $MAX_RETRIES attempts"
    echo "Starting anyway - Bull Queue will retry connection..."
fi

# Start CRON job in background (if docid service is configured)
echo "📅 Starting CRON job..."
node cron/update-docids.cron.js &

# Wait a bit for CRON to initialize
sleep 1

# Start API server (this will also initialize workers)
echo "🌐 Starting API server on port ${PORT:-3000}..."
exec npm start
