FROM node:20-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY index.html telegram-config.js ./
EXPOSE 8080
CMD ["npm", "start"]
