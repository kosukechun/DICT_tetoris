FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
