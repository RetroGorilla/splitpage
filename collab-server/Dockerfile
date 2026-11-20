FROM node:24.22.1-bookworm-slim
WORKDIR /service
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && install -d -o node -g node /data
COPY *.ts ./
ENV SPLITPAGE_DATA_DIR=/data SPLITPAGE_PORT=8080
USER node
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "main.ts"]
