FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
ENV PATH="/app/node_modules/.bin:$PATH"
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node scripts/with-app-env.mjs vite build

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:$PATH"
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=8 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "docker/entrypoint-gateway.sh"]
