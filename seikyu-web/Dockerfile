FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/main.mjs"]
