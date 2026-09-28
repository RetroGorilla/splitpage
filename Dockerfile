# Splitpage — app + document server in one small image, built from a plain
# checkout of this repository.
#
#   docker build -t splitpage .
#
# That is all deploy.sh runs on the server (DEPLOY.md). Nothing has to be
# built beforehand: index.html is generated and not in the repository (#80),
# so the first stage below runs `node build.mjs` itself, and only what that
# produces reaches the second stage. The finished image holds the built app,
# the server and VERSION — no source, no node_modules, no build tools.
#
# Already have a built copy (CI's `splitpage-app` artifact)? That zip carries
# Dockerfile.prebuilt instead, which skips the build:
#   docker build -f Dockerfile.prebuilt -t splitpage .
#
# Only classic-builder features on purpose (no RUN --mount, no heredocs, no
# COPY --chmod): unRAID's docker may have no buildx, in which case `docker
# build` there is the legacy builder, and CI's docker.yml builds with that one
# too so a BuildKit-only line fails there first.
#
# .dockerignore keeps data/, backups/ and .env out of the build context —
# deploy.sh keeps the live documents and the owner key INSIDE the clone this
# is built from, and none of it may ever end up in an image layer.

# ---------- stage 1: build index.html ----------
FROM node:22-alpine AS build

# NOT NODE_ENV=production here: npm ci would then skip devDependencies, and
# esbuild — the one thing the build needs — is one.
WORKDIR /build

# The lockfile first and on its own, so the install layer is reused until the
# dependencies actually change. Everything in package.json is a
# devDependency (esbuild for the build; eslint and jsdom come along because
# the lockfile is installed whole, exactly as CI does). None of it leaves
# this stage.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Exactly what build.mjs reads:
#   src/            page.html, app.css, seed-state.json, js/ (the bundle
#                   entry and every module), starters/ (imported as JSON)
#   shared/         imported from src/js as ../../shared/*.js; its own
#                   package.json says "commonjs" and has to come along
#   docs/help.md    rendered into the in-app Help page
#   VERSION         stamped into index.html and sw.js
#   sw.js           stamped IN PLACE with the cache name, so the copy the
#                   runtime stage takes is this stage's, never the checkout's
COPY build.mjs VERSION sw.js ./
COPY src/ ./src/
COPY shared/ ./shared/
COPY docs/help.md ./docs/help.md
RUN node build.mjs

# ---------- stage 2: what actually runs ----------
FROM node:22-alpine

# Run as the image's built-in non-root user. deploy.sh overrides it with
# --user 99:100 (unRAID's nobody:users) so the files in the data folder
# belong to the share's usual owner. If the container cannot write there,
# fix the folder's owner rather than running as root (see DEPLOY.md, Traps).
ENV NODE_ENV=production \
    PORT=8791 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    STATIC_DIR=/app/public

WORKDIR /app

# The app the browser downloads, in its own directory so STATIC_DIR can never
# expose the server source or the data volume. index.html and sw.js are the
# build stage's outputs; the rest are committed files served as they are.
COPY --from=build /build/index.html /build/sw.js ./public/
COPY manifest.webmanifest icon.svg icon-maskable.svg ./public/
# server.js reads VERSION for /api/health. Beside public/, not in it, so it is
# found (server.js looks in STATIC_DIR/..) without being served as a file.
COPY VERSION ./
# server.js is CommonJS, and package.json beside it says so out loud — a
# "type": "module" anywhere above it in a tree would otherwise stop it running.
COPY server/ ./server/

# /app stays root's: the server only reads it, and a process that cannot
# rewrite its own code or pages is one less thing to worry about. /data is
# created so a quick `docker run` with no -v still works for a smoke test.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8791

# Plain HTTP check against the API. Uses node itself, so the image needs no
# curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:process.env.PORT,path:'/api/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/server.js"]
