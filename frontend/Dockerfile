# UrbanOps web app (Next.js)
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The API address is compiled into the browser bundle, so it is a build argument:
# it must be the URL the *browser* uses to reach the API.
ARG NEXT_PUBLIC_API_URL=http://localhost:5000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "--port", "3000"]
