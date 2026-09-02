FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
COPY services/api/package.json services/api/package.json
RUN npm install --workspace=@janus/web --include-workspace-root
COPY apps/web apps/web
COPY packages/tokens packages/tokens
RUN npm run build -w @janus/web

FROM node:22-bookworm-slim AS api
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 \
    xdg-utils bash && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
COPY services/api/package.json services/api/package.json
RUN npm install --workspace=@janus/api --include-workspace-root
COPY services/api services/api
COPY skills /src/skills
RUN npx --yes playwright install chromium
RUN npm run build -w @janus/api
COPY --from=web /src/apps/web/dist /src/apps/web/dist
ENV JANUS_WEB=/src/apps/web/dist
ENV JANUS_DATA=/data
ENV JANUS_SKILLS=/src/skills
ENV JANUS_LISTEN=0.0.0.0
EXPOSE 8788
CMD ["node", "services/api/dist/index.js"]
