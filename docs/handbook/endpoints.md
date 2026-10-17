# Endpoints

## Endpoint: GET /

- **Purpose:** Welcome page for a browser that opens the API host. It names the service and links the public place list, the filter list, the health check, and the website. The page is static and is not a data API.
- **Errors:** No error body. A method other than GET is not this page.
- **Used by:** A person who opens the API host in a browser.
- **Auth:** none.

## Endpoint: GET /healthz

- **Purpose:** Process health for the map API. Returns `{ ok: true }`.
- **Errors:** No error body. The process is up when this answers 200.
- **Used by:** The container health check and deploy checks.
- **Auth:** none.

## Endpoint: GET /map/places

- **Purpose:** Public map list of complete pins, newest first. Each item is `id`, `origin`, `name`, `description`, `lat`, `lon`, `category`, `techProvider`, `shopType`, `shopName`, `street`, `houseNumber`, `postalCode`, `city`, `country`, `supports`, and `activity`. A row is complete when name, description, shop type (`SPAR` or `Others`), street, house number, postal code, city, and country are non-empty and `last_transaction_at` is null or parseable; incomplete stored rows are omitted. `shopType` is the stored enum. `shopName` is deprecated for one release and is `'SPAR'` when `shopType` is `'SPAR'`, otherwise null; it is removed in the release after the rollout. Address parts are required strings on a public row. `supports` is the stored blockchain and asset pairs, sorted. `activity` is the stored token copied on read: `daily` when at least five distinct stored UTC dates lie on the UTC date of the maintenance clock or on one of the previous six UTC dates, `within7Days` when the stored instant is at most 7×24h before the maintenance clock (exactly 7 days stays in this bucket; a future instant is `within7Days`) and the row is not `daily`, `within30Days` when it is older than 7×24h and at most 30×24h (exactly 30 days stays in this bucket), `olderThan30Days` when it is older than 30×24h (one millisecond past 30×24h is `olderThan30Days`, not `none`), or `none` when there is no stored instant or the instant is unparseable and the row is not `daily`. A read copies the stored token and does not reclassify. Maintenance runs on the transaction write and when `activity_until` is due. The process does that maintenance at startup and every 1000 ms. The caller id and payment methods are not included. Omitted `origin` is every complete pin. A present `origin` must be the same token as a stored origin. Optional `country`, `shopType` (`SPAR` or `Others`), deprecated `shopName` (`SPAR` or `others`, mapped onto `shopType` for one release), `blockchain`, and `asset` further restrict the store read. If `shopType` and `shopName` are both present and map to different types, the request is 400. All predicates are AND and run before `limit`. No stored field is derived from another field; the response field `shopName` is a read-only alias of `shopType` kept for one release. Filters do not read the street, house number, postal code, or city columns. A pin that already has support rows matches only those rows. A pin with none matches the hardcoded payment-link catalog: origin `21gifts` or tech provider `21.gifts` matches Lightning and BTC only, and every other pin matches a catalog network, asset, or pair.
- **Errors:** 400 `{ error: "Invalid limit" }` when `limit` is not an integer from 1 to 1000. Omitted `limit` means 1000. 400 `{ error: "Place origin is invalid" }` when `origin` is present but not a valid origin token. 400 `{ error: "Place country is invalid" }` when `country` is present but not an assigned ISO 3166-1 alpha-2 DFX country symbol. 400 `{ error: "Place shop type is invalid" }` when `shopType` is present and not `SPAR` or `Others`, or when `shopType` and `shopName` map to different types. 400 `{ error: "Place shop name is invalid" }` when the deprecated `shopName` query is present and not `SPAR` or `others`. 400 `{ error: "Place support is invalid" }` when `blockchain` is present but not a payment-link or stored payment-network name, or when `asset` is present but not a ticker, a prefixed ticker, or a payment-link catalog name.
- **Used by:** The OpenCryptoPay map.
- **Auth:** none. Browser calls are allowed from any origin.

## Endpoint: GET /map/filters

- **Purpose:** Public list of filter values for the map. `shopTypes` is always exactly `["SPAR", "Others"]`. `shopNames` is the deprecated one-release alias `["SPAR", "others"]` and is removed in the release after the rollout. `countries` are the distinct ISO country codes of complete rows only, sorted. Incomplete stored rows do not contribute a country. `blockchains` and `assets` are the hardcoded payment-link catalog plus distinct stored values, sorted. `?blockchain=` limits the top-level `assets` to that chain and still returns every blockchain. `techProviders` lists the full hardcoded offer for `DFX.swiss` and for `21.gifts` (Lightning and BTC only) and is not narrowed by `?blockchain=`.
- **Errors:** 400 `{ error: "Place support is invalid" }` when `blockchain` is present but not a payment-link or stored payment-network name.
- **Used by:** The OpenCryptoPay map filter UI.
- **Auth:** none. Browser calls are allowed from any origin.

## Endpoint: POST /map/places

- **Purpose:** Create one complete map pin. Allowed JSON keys are exactly origin, externalId, name, description, lat, lon, category, paymentMethods, techProvider, shopType, street, houseNumber, postalCode, city, country, and supports. Any other key, including the old `shopName`, is rejected and nothing is stored. Name, description, shop type (`SPAR` or `Others`), all five address parts, and coordinates are required. House number is required, trimmed, and must match `^[0-9][0-9A-Za-z/ .&–-]{0,31}$`. No stored field is derived from another field; the response field `shopName` is a read-only alias of `shopType` kept for one release. The same `origin` and `externalId` returns the first row, including its tech provider, and does not call BTC Map again. A new row is posted once when `BTCMAP_ACCESS_TOKEN` is set. An omitted tech provider is stored as `DFX.swiss`. Omitted `supports` is stored as `[]`.
- **Errors:** 503 `{ error: "Place ingest is not configured" }` when the ingest token is unset or blank. 401 `{ error: "Unauthorized" }` when the bearer does not match. 400 with the validator message for a bad body, including `Place field is not allowed: <key>` for the first unknown key in `Object.keys` order. A BTC Map failure still returns 201 with `btcmap: "failed"`.
- **Used by:** Trusted callers that add a shop the first time it appears.
- **Auth:** `Authorization: Bearer` must equal `OCP_PLACE_INGEST_TOKEN`. Status 201 when new, 200 when the pair already exists.

## Endpoint: PUT /map/places

- **Purpose:** Full replace of one map pin, or create it when the origin and external id are new. Every stored field of the pin is replaced by the body: name, description, lat, lon, category, paymentMethods, techProvider (omitted becomes `DFX.swiss`), shopType, street, houseNumber, postalCode, city, country, and supports (omitted becomes `[]`). Id, createdAt, lastTransactionAt, payment days, and activity stay. The same validation as POST applies, including unknown-key rejection. BTC Map is called only when this request inserts the row. An update returns `btcmap: "skipped"` and does not call BTC Map. A rejected body leaves the stored shop unchanged.
- **Errors:** 503 `{ error: "Place ingest is not configured" }` when the ingest token is unset or blank. 401 `{ error: "Unauthorized" }` when the bearer does not match. 400 with the validator message for a bad body.
- **Used by:** Trusted callers that correct a shop or set its tech provider.
- **Auth:** `Authorization: Bearer` must equal `OCP_PLACE_INGEST_TOKEN`. Status 201 when new, 200 when the pair already exists.

## Endpoint: DELETE /map/places

- **Purpose:** Remove one map pin by origin and external id. A missing pair returns `{ deleted: false }` with status 200. This call does not contact BTC Map.
- **Errors:** 503 `{ error: "Place ingest is not configured" }` when the ingest token is unset or blank. 401 `{ error: "Unauthorized" }` when the bearer does not match. 400 with the validator message for a bad body.
- **Used by:** Trusted callers that take a shop off the public map.
- **Auth:** `Authorization: Bearer` must equal `OCP_PLACE_INGEST_TOKEN`. The JSON body is `origin` and `externalId`.

## Endpoint: POST /map/places/transactions

- **Purpose:** Record a transaction time on an existing pin. The JSON body is `origin`, `externalId`, and optional `occurredAt`. The response is `{ activity }` copied from the stored row after the write. This call does not create a pin and does not call BTC Map. An older or equal stored instant is kept. A parseable instant deletes stored payment days older than the 7-date window start of the request clock before classifying, stores its UTC date when that date is inside that window, then stores `activity` and `activity_until`. Maintenance also runs when `activity_until` is due. The process does that maintenance at startup and every 1000 ms. Browser CORS `allowMethods` stays `GET` and `OPTIONS`; this call is server-to-server. The write also works on an incomplete stored row; that row stays hidden from GET `/map/places` until it is complete.
- **Errors:** 503 `{ error: "Place ingest is not configured" }` when the ingest token is unset or blank. 401 `{ error: "Unauthorized" }` when the bearer does not match. 400 with the validator message for a bad body, including `Place transaction time is invalid`. 404 `{ error: "Place not found" }` when the pair is missing.
- **Used by:** Trusted callers that report a shop transaction.
- **Auth:** `Authorization: Bearer` must equal `OCP_PLACE_INGEST_TOKEN`. Browser CORS `allowMethods` stays GET and OPTIONS.
