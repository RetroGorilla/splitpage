# Splitpage — app + document server in one small image.
#
# No build step and no dependencies: the app is static files and the server is
# a single Node file, so there is nothing to compile and nothing to audit
# beyond what you can read in server/server.js.

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
COPY server/server.js ./server/server.js

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
