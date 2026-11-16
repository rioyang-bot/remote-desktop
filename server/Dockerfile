FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production DATA_DIR=/app/data PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
