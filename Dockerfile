# Splitpage — app + document server in one small image.
#
# No build step and no dependencies: the app is static files and the server is
# a single Node file, so there is nothing to compile and nothing to audit
# beyond what you can read in server/server.js.
#
# That means the build context must ALREADY contain a built index.html. It is
# generated and not in the repository (#80), so either unzip CI's
# `splitpage-app` artifact — which is exactly this context, this Dockerfile
# included — or run `node build.mjs` in a checkout first. Building from a
# fresh clone without doing so fails on the COPY below, which is the right
# answer: the alternative is an image serving an app nobody built.

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
COPY index.html manifest.webmanifest icon.svg sw.js ./public/
# server.js is CommonJS, and package.json beside it says so out loud — a
# "type": "module" anywhere above it in a tree would otherwise stop it running.
COPY server/server.js server/package.json ./server/

# Created here so the path exists even when no volume is mounted — that way a
# quick `docker run` with no -v still works for a smoke test.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 8791

# Plain TCP check against the API. Uses node itself, so the image needs no
# curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:process.env.PORT,path:'/api/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/server.js"]
