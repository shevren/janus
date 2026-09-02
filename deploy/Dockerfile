FROM node:22-bookworm-slim AS api
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 \
    xdg-utils bash && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY services/api/package.json services/api/package.json
RUN npm install --workspace=@janus/api --include-workspace-root
COPY services/api services/api
COPY skills /src/skills
RUN npx --yes playwright install chromium
RUN npm run build -w @janus/api
ENV JANUS_DATA=/data
ENV JANUS_SKILLS=/src/skills
ENV JANUS_LISTEN=0.0.0.0
EXPOSE 8788
CMD ["node", "services/api/dist/index.js"]
