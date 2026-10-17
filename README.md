# OpenCryptoPay API

Map API. `GET /map/places` is the public list of complete places, each with a tech provider; `?origin=` limits that list to one origin. The list can also be limited by country, shopType (`SPAR` or `Others`), blockchain, and asset. For one release, `shopName` (`SPAR` or `others`) is a query alias for shopType and a read-only response field (`SPAR` or null) derived from shopType. Country is a stored ISO 3166-1 alpha-2 column. A place includes name, description, shopType, street, houseNumber, postalCode, city, country, and coordinates; all of those are required on write. A pin with support rows matches only those rows. A pin with none uses a hardcoded payment-link catalog: `21.gifts` is Lightning and BTC, and other pins use the DFX payment-link networks and assets. `GET /map/filters` lists shop types, the deprecated shop-name alias, countries of complete rows, and that catalog plus any stored values. `POST /map/places` adds a place once. `PUT /map/places` fully replaces a place. `DELETE /map/places` removes a place. Incomplete stored rows are not public. No stored field is derived from another field; the response field `shopName` is a read-only alias of `shopType` kept for one release.

The same `origin` and `externalId` returns the first pin and does not submit it again. When `BTCMAP_ACCESS_TOKEN` is set, a new pin is posted once to `https://api.btcmap.org/v4/place-submissions`. A missing token stores the pin and skips that call.

## Run

Requires [Bun](https://bun.sh).

```sh
export OCP_PLACE_INGEST_TOKEN=replace-me
bun install
bun run start
```

The process listens on port `3000` unless `PORT` is set. The database file is `data/places.sqlite` unless `PLACE_DB` is set.

`GET /` returns a short HTML welcome page. `GET /healthz` returns `{ "ok": true }`.

## Branches

Pull requests target `develop`. A push there publishes `dfxswiss/opencryptopay-api:beta`, except a push that changes only Markdown. `main` publishes `dfxswiss/opencryptopay-api:latest` the same way and moves only through the release pull request from `develop`. A manual run publishes only when it is started on that branch.

## Checks

`bun run typecheck`, `bun run lint`, `bun run handbook:check`, `bun run e2e:check`, `bun run test:coverage`, `bun run build`, and `bun run e2e`. Coverage on `src` is 100 percent. `src/index.ts` is the process entry and is exercised by the HTTP end-to-end run.

## Product notes

Notes that are not specific to this API are in [docs/product](docs/product/README.md). [Where place maps are shown](docs/product/maps.md) is the first of those notes.
