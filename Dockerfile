FROM node:22-alpine
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY server/src server/src
COPY server/public server/public
COPY agents agents
ENV DATA_DIR=/data PORT=8080 NODE_ENV=production
VOLUME /data
EXPOSE 8080
CMD ["node", "--no-warnings", "server/src/server.js"]
