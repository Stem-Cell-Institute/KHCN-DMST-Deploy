# sci-stims / SCI-ACE — Ubuntu IT stack: chạy non-root, dữ liệu qua volume + APP_DATA_DIR
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Trong container nên bind rõ (reverse proxy bên ngoài map port)
ENV BIND_HOST=0.0.0.0
ENV PORT=3000

USER node

EXPOSE 3000

# Gắn volume runtime: -v /var/lib/sci-stims:/data:rw
# và trong .env: APP_DATA_DIR=/data
CMD ["node", "server.js"]
