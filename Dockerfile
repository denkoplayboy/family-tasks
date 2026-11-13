FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data APP_TZ=Asia/Jerusalem
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
