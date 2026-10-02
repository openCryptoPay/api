# OpenCryptoPay API

Map API. `GET /map/places` is the public list of places, each with a tech provider. `POST /map/places` adds a place once. `PUT /map/places` updates a place. `DELETE /map/places` removes a place.

The same `origin` and `externalId` returns the first pin and does not submit it again. When `BTCMAP_ACCESS_TOKEN` is set, a new pin is posted once to `https://api.btcmap.org/v4/place-submissions`. A missing token stores the pin and skips that call.

## Run

Requires [Bun](https://bun.sh).

```sh
export OCP_PLACE_INGEST_TOKEN=replace-me
bun install
bun run start
```

The process listens on port `3000` unless `PORT` is set. The database file is `data/places.sqlite` unless `PLACE_DB` is set.

`GET /healthz` returns `{ "ok": true }`.

## Branches

Pull requests target `develop`. `main` moves only through the release pull request from `develop`. This repository does not publish a container image.

## Checks

`bun run typecheck`, `bun run lint`, `bun run handbook:check`, `bun run e2e:check`, `bun run test:coverage`, `bun run build`, and `bun run e2e`. Coverage on `src` is 100 percent. `src/index.ts` is the process entry and is exercised by the HTTP end-to-end run.
