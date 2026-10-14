FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY login.html login.js index.html app.js styles.css requirements.json domain.mjs demo-store.mjs runtime.json ./
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/main.mjs"]
