FROM node:22-alpine
WORKDIR /app
COPY *.js ./
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
USER node
CMD ["node", "index.js"]
