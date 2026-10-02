# Endpoints

## Endpoint: GET /healthz

- **Purpose:** Process health for the map API. Returns `{ ok: true }`.
- **Errors:** No error body. The process is up when this answers 200.
- **Used by:** The container health check and deploy checks.
- **Auth:** none.

## Endpoint: GET /map/places

- **Purpose:** Public map list, newest first. Each item is `id`, `origin`, `name`, `lat`, `lon`, `category`, and `techProvider`. The caller id and payment methods are not included.
- **Errors:** 400 `{ error: "Invalid limit" }` when `limit` is not an integer from 1 to 1000. Omitted `limit` means 1000.
- **Used by:** The OpenCryptoPay map.
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
