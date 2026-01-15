FROM mcr.microsoft.com/playwright:v1.40.1-jammy

WORKDIR /app

# Set Playwright browser path
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Install Firefox browser (for scraping)
RUN npx playwright install firefox --with-deps

# Copy application code
COPY . .

# Make start script executable
RUN chmod +x start.sh

# Create directories for logs and sessions
RUN mkdir -p logs /data/sessions

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
