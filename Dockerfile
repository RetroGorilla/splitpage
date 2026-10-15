FROM node:24-alpine AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY build.mjs VERSION sw.js ./
COPY src/ ./src/
COPY shared/ ./shared/
COPY docs/help.md ./docs/help.md
RUN node build.mjs

FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8791 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    STATIC_DIR=/app/public

WORKDIR /app

COPY --from=build /build/index.html /build/sw.js ./public/
COPY manifest.webmanifest icon.svg icon-maskable.svg ./public/
COPY VERSION ./
COPY server/ ./server/

RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8791

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:process.env.PORT,path:'/api/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/server.js"]
