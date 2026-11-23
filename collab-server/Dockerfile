FROM node:24.22.1-bookworm-slim
WORKDIR /service/collab-server
COPY collab-server/package.json collab-server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && install -d -o node -g node /data
COPY collab-server/*.ts ./
COPY shared/blob-policy.ts ../shared/blob-policy.ts
ENV SPLITPAGE_DATA_DIR=/data SPLITPAGE_PORT=8080
USER node
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "main.ts"]
