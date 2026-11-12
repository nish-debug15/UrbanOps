# UrbanOps API (Express + Socket.io)
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Report photos are written here; mount a volume on it to keep them.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
VOLUME /app/uploads

USER node
EXPOSE 5000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
