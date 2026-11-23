FROM node:24.22.1-bookworm-slim AS app
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY build.mjs VERSION sw.js manifest.webmanifest icon.svg icon-maskable.svg ./
COPY src/ src/
COPY shared/ shared/
COPY docs/help.md docs/help.md
COPY tools/css-inputs.mjs tools/css-inputs.json tools/main-module.mjs tools/release-hooks.mjs tools/
RUN node build.mjs

FROM node:24.22.1-bookworm-slim
WORKDIR /service/collab-server
COPY collab-server/package.json collab-server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && install -d -o node -g node /data
COPY collab-server/*.ts ./
COPY shared/blob-policy.ts ../shared/blob-policy.ts
COPY --from=app /build/index.html /build/sw.js /build/manifest.webmanifest /build/icon.svg /build/icon-maskable.svg /app/
ENV SPLITPAGE_DATA_DIR=/data SPLITPAGE_PORT=8080 SPLITPAGE_APP_DIR=/app
USER node
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "main.ts"]
