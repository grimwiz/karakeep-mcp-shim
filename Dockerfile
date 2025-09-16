FROM node:22-slim
WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js config.js logger.js health.js openapi.js parser.js router.js ./

EXPOSE 9000
CMD ["node", "server.js"]
