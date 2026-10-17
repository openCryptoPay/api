# OpenCryptoPay place API.
#
# Build:
#   docker build -t dfxswiss/opencryptopay-api:beta .
#   docker build -t dfxswiss/opencryptopay-api:latest .

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine
WORKDIR /app
RUN apk add --no-cache wget \
  && addgroup -S app && adduser -S app -G app \
  && mkdir -p /data && chown app:app /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN bun build src/index.ts --target=bun --outdir=dist
USER app

ENV PORT=3000
ENV PLACE_DB=/data/places.sqlite
EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
