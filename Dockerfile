FROM mcr.microsoft.com/playwright:v1.40.1-jammy

WORKDIR /app

# Set Playwright browser path BEFORE any npm install
# This ensures browsers are downloaded to the correct location
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Verify Playwright browsers are available (they come pre-installed in this image)
# If not found, install them
RUN npx playwright install chromium || true

# Copy application code
COPY . .

# Make start script executable
RUN chmod +x start.sh

# Create logs directory
RUN mkdir -p logs

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start application
CMD ["./start.sh"]
