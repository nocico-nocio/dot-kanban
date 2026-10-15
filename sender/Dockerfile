FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs ./server.mjs
USER node
EXPOSE 8080
ENV PORT=8080
ENV SENDER_BIND=0.0.0.0
CMD ["node", "server.mjs"]
