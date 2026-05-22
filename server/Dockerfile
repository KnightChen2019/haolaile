FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY src ./src

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
