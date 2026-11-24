# syntax=docker/dockerfile:1
# xRoster — imagen multi-stage (REQ-2026-012 T-02 · REQ-2026-013 T-05)

# ---------- Etapa 0: web-builder (cpanel-roster SPA → web/dist) ----------
FROM node:22-bookworm-slim AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/public ./public
COPY web/src ./src
RUN npm run build

# ---------- Etapa 1: build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- Etapa 2: runtime ----------
FROM node:22-bookworm-slim AS runtime
# git + openssh-client: requeridos por Tank (SSH read-only / restart L1) y Shikamaru (xPlanning.git)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# CLI de Claude Code (CLAUDE_PROVIDER=cli). Desactivable con --build-arg INSTALL_CLAUDE_CLI=false
ARG INSTALL_CLAUDE_CLI=true
RUN if [ "$INSTALL_CLAUDE_CLI" = "true" ]; then npm install -g @anthropic-ai/claude-code && npm cache clean --force; fi

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# SPA servida por src/server.ts desde dist/web (solo index.html, /assets/* y archivos públicos de raíz)
COPY --from=web-builder /app/web/dist ./dist/web
COPY package.json ./
COPY sql ./sql

RUN mkdir -p /data/xPlanning /home/node/.ssh /home/node/.claude \
    && chown -R node:node /data /home/node
USER node

EXPOSE 3900
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3900)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
