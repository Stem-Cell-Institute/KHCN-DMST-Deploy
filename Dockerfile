# sci-stims / SCI-ACE — Ubuntu IT stack: chạy non-root, dữ liệu qua volume + APP_DATA_DIR
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# .npmrc phải vào CÙNG bước này, không đợi `COPY . .` phía dưới: npm chỉ đọc
# engine-strict tại thời điểm chạy `npm ci`. Copy sau thì cổng chặn phiên bản
# Node chỉ có tác dụng trên máy dev, còn build production vẫn lọt.
COPY package.json package-lock.json .npmrc ./
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
