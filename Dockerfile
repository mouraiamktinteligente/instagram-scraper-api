FROM mcr.microsoft.com/playwright:v1.40.1-jammy

WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
# Use npm install as fallback if package-lock.json doesn't exist or is incompatible
RUN npm install --omit=dev

# Copy application code
COPY . .

# Make start script executable
RUN chmod +x start.sh

# Create logs directory
RUN mkdir -p logs

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
# Playwright browsers are installed at /ms-playwright in the official image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start application
CMD ["./start.sh"]
