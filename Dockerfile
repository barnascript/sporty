# Playwright's official image ships Chromium + all system deps.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install deps first (better layer caching). Browsers are already in the base image.
COPY package.json package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
