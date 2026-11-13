FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data APP_TZ=Asia/Jerusalem
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
