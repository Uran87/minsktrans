# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# 1. Сборка статики
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# package-lock.json появится после npm install; звёздочка позволяет собрать
# образ и без него.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

COPY . .

# Значения по умолчанию можно переопределить при сборке:
#   docker build --build-arg VITE_MOCK_DEFAULT=true .
ARG VITE_API_BASE=/api/v1
ARG VITE_MOCK_DEFAULT=false
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_MOCK_DEFAULT=$VITE_MOCK_DEFAULT

RUN npm run build

# ---------------------------------------------------------------------------
# 2. Раздача статики + reverse-proxy к API (обходим CORS)
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Адрес API подставляется в nginx.conf при старте контейнера (envsubst).
ENV API_ORIGIN=http://194.158.195.62:41290

COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
