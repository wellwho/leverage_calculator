# Build from the repo root so the monitor can reuse the main app's exchange
# clients:  docker compose -f monitor/docker-compose.yml up -d --build
# (or `docker compose up -d --build` from inside monitor/).
FROM node:22-alpine
WORKDIR /app
COPY bybitClient.js mexcClient.js ./
COPY monitor/ ./monitor/
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
USER node
CMD ["node", "monitor/index.js"]
