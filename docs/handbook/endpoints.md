# Endpoints

## Endpoint: GET /healthz

- **Purpose:** Process health for the map API. Returns `{ ok: true }`.
- **Errors:** No error body. The process is up when this answers 200.
- **Used by:** The container health check and deploy checks.
- **Auth:** none.

## Endpoint: GET /map/places

- **Purpose:** Public map list, newest first. Each item is `id`, `origin`, `name`, `lat`, `lon`, `category`, `techProvider`, `country`, `shopName`, `supports`, and `activity`. `country` is the stored DFX country symbol or null. `shopName` is the stored brand or null. `supports` is the stored blockchain and asset pairs, sorted. `activity` is `within7Days` when the stored instant is at most 7×24h before the request clock (exactly 7 days stays in this bucket; a future instant is `within7Days`), `within30Days` when it is older than 7×24h and at most 30×24h (exactly 30 days stays in this bucket; one millisecond later is `none`), or `none` when there is no stored instant, the instant is unparseable, or it is older than 30×24h. The caller id and payment methods are not included. Omitted `origin` is every pin. A present `origin` must be the same token as a stored origin. Optional `country`, `shopName` (`SPAR` or `others`), `blockchain`, and `asset` further restrict the store read. All predicates are AND and run before `limit`. `country` is a stored column, not inferred from an address. `others` includes a pin with no brand. A pin that already has support rows matches only those rows. A pin with none matches the hardcoded payment-link catalog: origin `21gifts` or tech provider `21.gifts` matches Lightning and BTC only, and every other pin matches a catalog network, asset, or pair.
- **Errors:** 400 `{ error: "Invalid limit" }` when `limit` is not an integer from 1 to 1000. Omitted `limit` means 1000. 400 `{ error: "Place origin is invalid" }` when `origin` is present but not a valid origin token. 400 `{ error: "Place country is invalid" }` when `country` is present but not an assigned ISO 3166-1 alpha-2 DFX country symbol. 400 `{ error: "Place shop name is invalid" }` when `shopName` is present and not `SPAR` or `others`. 400 `{ error: "Place support is invalid" }` when `blockchain` is present but not a payment-link or stored payment-network name, or when `asset` is present but not a ticker, a prefixed ticker, or a payment-link catalog name.
- **Used by:** The OpenCryptoPay map.
- **Auth:** none. Browser calls are allowed from any origin.

## Endpoint: GET /map/filters

- **Purpose:** Public list of filter values for the map. `shopNames` is always exactly `["SPAR", "others"]`. `countries` are the distinct stored ISO country codes, sorted. `blockchains` and `assets` are the hardcoded payment-link catalog plus distinct stored values, sorted. `?blockchain=` limits the top-level `assets` to that chain and still returns every blockchain. `techProviders` lists the full hardcoded offer for `DFX.swiss` and for `21.gifts` (Lightning and BTC only) and is not narrowed by `?blockchain=`.
- **Errors:** 400 `{ error: "Place support is invalid" }` when `blockchain` is present but not a payment-link or stored payment-network name.
- **Used by:** The OpenCryptoPay map filter UI.
- **Auth:** none. Browser calls are allowed from any origin.

## Endpoint: POST /map/places

- **Purpose:** Create one map pin. The same `origin` and `externalId` returns the first row, including its tech provider, and does not call BTC Map again. A new row is posted once when `BTCMAP_ACCESS_TOKEN` is set. An omitted tech provider is stored as `DFX.swiss`.
- **Errors:** 503 `{ error: "Place ingest is not configured" }` when the ingest token is unset or blank. 401 `{ error: "Unauthorized" }` when the bearer does not match. 400 with the validator message for a bad body. A BTC Map failure still returns 201 with `btcmap: "failed"`.
- **Used by:** Trusted callers that add a shop the first time it appears.
- **Auth:** `Authorization: Bearer` must equal `OCP_PLACE_INGEST_TOKEN`. Status 201 when new, 200 when the pair already exists.

## Endpoint: PUT /map/places

- **Purpose:** Update one map pin, or create it when the origin and external id are new. BTC Map is called only when this request inserts the row. An update returns `btcmap: "skipped"` and does not call BTC Map.
- **Errors:** 503 `{ error: "Place ingest is not configured" }` when the ingest token is unset or blank. 401 `{ error: "Unauthorized" }` when the bearer does not match. 400 with the validator message for a bad body.
- **Used by:** Trusted callers that correct a shop or set its tech provider.
- **Auth:** `Authorization: Bearer` must equal `OCP_PLACE_INGEST_TOKEN`. Status 201 when new, 200 when the pair already exists.

## Endpoint: DELETE /map/places

- **Purpose:** Remove one map pin by origin and external id. A missing pair returns `{ deleted: false }` with status 200. This call does not contact BTC Map.
- **Errors:** 503 `{ error: "Place ingest is not configured" }` when the ingest token is unset or blank. 401 `{ error: "Unauthorized" }` when the bearer does not match. 400 with the validator message for a bad body.
- **Used by:** Trusted callers that take a shop off the public map.
- **Auth:** `Authorization: Bearer` must equal `OCP_PLACE_INGEST_TOKEN`. The JSON body is `origin` and `externalId`.

## Endpoint: POST /map/places/transactions

- **Purpose:** Record a transaction time on an existing pin. The JSON body is `origin`, `externalId`, and optional `occurredAt`. The response is `{ activity }` classified at the request clock, not at `occurredAt`. This call does not create a pin and does not call BTC Map. An older or equal stored instant is kept. Browser CORS `allowMethods` stays `GET` and `OPTIONS`; this call is server-to-server.
- **Errors:** 503 `{ error: "Place ingest is not configured" }` when the ingest token is unset or blank. 401 `{ error: "Unauthorized" }` when the bearer does not match. 400 with the validator message for a bad body, including `Place transaction time is invalid`. 404 `{ error: "Place not found" }` when the pair is missing.
- **Used by:** Trusted callers that report a shop transaction.
- **Auth:** `Authorization: Bearer` must equal `OCP_PLACE_INGEST_TOKEN`. Browser CORS `allowMethods` stays GET and OPTIONS.
