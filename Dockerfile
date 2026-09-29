# Splitpage — app + document server in one small image.

FROM node:22-alpine AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY build.mjs VERSION sw.js ./
COPY src/ ./src/
COPY shared/ ./shared/
COPY docs/help.md ./docs/help.md
RUN node build.mjs

FROM node:22-alpine

# Run as the image's built-in non-root user. If the container cannot write to
# your Unraid share, that is almost always this: fix it by passing --user with
# the share's uid/gid rather than by running as root (see DEPLOY.md).
ENV NODE_ENV=production \
    PORT=8791 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    STATIC_DIR=/app/public

WORKDIR /app

# The app the browser downloads. Kept in its own directory so STATIC_DIR can
# never accidentally expose the server source or the data volume.
COPY --from=build /build/index.html /build/sw.js ./public/
COPY manifest.webmanifest icon.svg icon-maskable.svg ./public/
COPY VERSION ./
# server.js is CommonJS, and package.json beside it says so out loud — a
# "type": "module" anywhere above it in a tree would otherwise stop it running.
COPY server/ ./server/

# Created here so the path exists even when no volume is mounted — that way a
# quick `docker run` with no -v still works for a smoke test.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8791

# Plain TCP check against the API. Uses node itself, so the image needs no
# curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:process.env.PORT,path:'/api/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/server.js"]
