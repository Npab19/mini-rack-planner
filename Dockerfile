# syntax=docker/dockerfile:1

# Build stage: always runs on the build host's own platform (no emulation for npm, tsc or Vite).
# The output is plain static files, so one build serves every target architecture.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Shown on the About page. Without it the build falls back to "dev" (.git is not in the context).
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
# The Vite manifest is only for scripts/check-budgets.ts; it is not served.
RUN npm run build && rm -rf dist/.vite

# Runtime stage: copy-only (no RUN), so multi-arch publishing needs no QEMU.
# nginx-unprivileged runs as uid 101 on port 8080 and works with `docker run --read-only --tmpfs /tmp`.
FROM nginxinc/nginx-unprivileged:1.31-alpine

ARG GIT_SHA
ARG VERSION=dev
# Published images get these from docker/metadata-action. The empty defaults keep local builds
# from inheriting the nginx base image's source, url, created and maintainer labels.
ARG SOURCE_URL=""
ARG BUILD_DATE=""
LABEL maintainer="Mini Rack Planner contributors" \
      org.opencontainers.image.title="Mini Rack Planner" \
      org.opencontainers.image.description="Browser-only planner for 3D-printed 10-inch homelab racks: layout, 3D preview and a shopping list." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="$SOURCE_URL" \
      org.opencontainers.image.url="$SOURCE_URL" \
      org.opencontainers.image.created="$BUILD_DATE" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$GIT_SHA"

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
