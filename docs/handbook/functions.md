# Functions

## Function: normalizePlaceOrigin

- **Purpose:** Trim a pin origin and accept only `^[a-z0-9][a-z0-9-]{0,31}$`. A leading digit is valid. Uppercase tokens such as SPAR are invalid.
- **Inputs:** Unknown value, typically a JSON field or the `origin` query string.
- **Returns / side effects:** `{ ok: true, value }` with the trimmed origin, or `{ ok: false, error: "Place origin is invalid" }`. No I/O.
- **Used by:** `normalizeMapPlace`, `normalizeMapPlaceKey`, and `mapRoutes` on `GET /map/places`.

## Function: normalizeMapPlace

- **Purpose:** Validate a JSON body for one map pin. Coordinates must be finite and in range, then they are rounded to six decimals. An unknown payment list becomes null instead of an error. An omitted tech provider is left unset so the store can default it. Optional `country` is the DFX country symbol (ISO 3166-1 alpha-2), trimmed and uppercased, or omitted. Optional `shopName` is a brand of 1 to 40 characters, not casefolded. Optional `supports` is a list of DFX payment-network and asset-name pairs; omitted leaves the field unset so an upsert can keep the stored rows.
- **Inputs:** Unknown JSON. Required fields are `origin`, `externalId`, `name`, `lat`, `lon`, and `category`. `techProvider`, `country`, `shopName`, and `supports` are optional.
- **Returns / side effects:** `{ ok: true, value }` or `{ ok: false, error }` with a fixed English message. No I/O.
- **Used by:** `mapRoutes` on `POST /map/places` and `PUT /map/places`.

## Function: normalizeMapPlaceFilter

- **Purpose:** Validate the optional `country`, `shopName`, `blockchain`, and `asset` query strings for the public map. Omitted parameters stay off the filter. `country` is trimmed and uppercased. `shopName` is trimmed and must be `SPAR` or `others`. `blockchain` and `asset` are trimmed and not casefolded. A filter blockchain may be a stored payment-network name or a payment-link network such as BinancePay or KucoinPay. A filter asset may be a ticker, a prefixed ticker, or a catalog name such as ckBTC or dEURO. A support body still uses the stricter stored-pair rules.
- **Inputs:** Four optional raw query strings.
- **Returns / side effects:** `{ ok: true, value }` with the present filter fields, or `{ ok: false, error }` with `Place country is invalid`, `Place shop name is invalid`, or `Place support is invalid`. No I/O.
- **Used by:** `mapRoutes` on `GET /map/places` and `GET /map/filters`.

## Function: isCatalogBlockchain

- **Purpose:** Report whether a trimmed blockchain query is in the hardcoded payment-link catalog. Test networks, Plasma, and names that are not payment-link networks are excluded. BinancePay and KucoinPay are included.
- **Inputs:** A trimmed blockchain string.
- **Returns / side effects:** True or false. No I/O.
- **Used by:** `normalizeMapPlaceFilter` when a blockchain query is not a stored payment-network name.

## Function: isCatalogAsset

- **Purpose:** Report whether a trimmed asset query is in the hardcoded payment-link catalog. This includes names that are not plain tickers, such as ckBTC and dEURO.
- **Inputs:** A trimmed asset string.
- **Returns / side effects:** True or false. No I/O.
- **Used by:** `normalizeMapPlaceFilter` when an asset query is not a ticker or a prefixed ticker.

## Function: matchesUnstatedPayment

- **Purpose:** Decide whether a pin with no stored support rows matches a blockchain or asset filter. Origin `21gifts` or tech provider `21.gifts` matches Lightning and BTC only. Every other pin matches a catalog network, a catalog asset, or a catalog pair. An omitted filter matches.
- **Inputs:** Stored origin, stored tech provider, and the optional blockchain and asset from the query.
- **Returns / side effects:** True when the pin stays in the list. No I/O.
- **Used by:** `MemoryMapPlaceStore.list`. The SQLite driver uses `unstatedPaymentSql` for the same rule.

## Function: unstatedPaymentSql

- **Purpose:** Build the SQLite predicate for a blockchain or asset filter. Stored support rows still match. A pin with no support rows matches only when the hardcoded catalog offers that network or asset for its origin and tech provider. A request outside the catalog returns null so only stored rows match.
- **Inputs:** Optional blockchain and asset query values.
- **Returns / side effects:** A parenthesised SQL fragment and its bound parameters, or null. No I/O.
- **Used by:** `SqliteMapPlaceStore.list`.

## Function: publicFilterResponse

- **Purpose:** Merge distinct stored filter values with the hardcoded payment-link catalog for `GET /map/filters`. `?blockchain=` limits the top-level asset list. `techProviders` always contains the full `DFX.swiss` offer and the `21.gifts` offer of Lightning and BTC.
- **Inputs:** Stored countries, blockchains, and assets, plus an optional blockchain query.
- **Returns / side effects:** `{ shopNames, countries, blockchains, assets, techProviders }`. No I/O.
- **Used by:** `mapRoutes` on `GET /map/filters`.

## Function: normalizeMapPlaceKey

- **Purpose:** Validate origin and external id for deleting a map pin. Extra JSON fields are ignored. The body does not need coordinates or a name.
- **Inputs:** Unknown JSON. Required fields are `origin` and `externalId`, with the same rules as `normalizeMapPlace`.
- **Returns / side effects:** `{ ok: true, value: { origin, externalId } }` or `{ ok: false, error }` with the same English messages as create. No I/O.
- **Used by:** `mapRoutes` on `DELETE /map/places`.

## Function: placeActivity

- **Purpose:** Classify a stored transaction instant into `within7Days`, `within30Days`, or `none` relative to the request clock. `null` or an unparseable instant is `none`. Age is `nowMs` minus the parsed epoch. A future instant (negative age) is `within7Days`. Age at most `7 * 24 * 60 * 60 * 1000` ms is `within7Days`; one millisecond later through `30 * 24 * 60 * 60 * 1000` ms is `within30Days`; older than that is `none`. Exactly 7 days is `within7Days`. Exactly 30 days is `within30Days`.
- **Inputs:** `lastTransactionAt` (`string | null`) and `nowMs` (request clock in milliseconds).
- **Returns / side effects:** One of the three mutually exclusive activity strings. No I/O.
- **Used by:** `toPublicMapPlace` on `GET /map/places` and `mapRoutes` on `POST /map/places/transactions`.

## Function: normalizePlaceTransaction

- **Purpose:** Validate a JSON body that records a shop transaction. `origin` and `externalId` use `normalizeMapPlaceKey` and the same error strings. Extra JSON fields are ignored. Omitted `occurredAt` becomes `new Date(nowMs).toISOString()`. A present `occurredAt` must be a parseable string at most 120 seconds after `nowMs`; exactly `nowMs + 120_000` is valid and one millisecond later is not. The returned instant is canonical ISO (`new Date(parsed).toISOString()`), not the raw string.
- **Inputs:** Unknown JSON and `nowMs`. Required fields are `origin` and `externalId`. `occurredAt` is optional.
- **Returns / side effects:** `{ ok: true, value: { origin, externalId, occurredAt } }` or `{ ok: false, error }` including `Place transaction time is invalid`. No I/O.
- **Used by:** `mapRoutes` on `POST /map/places/transactions`.

## Function: toPublicMapPlace

- **Purpose:** Strip the caller id and payment methods before a pin is shown on the public map. The tech provider, country, shop name, and supports stay on the public row. `activity` is set from `placeActivity(place.lastTransactionAt, nowMs)`.
- **Inputs:** A stored map pin and `nowMs` (request clock in milliseconds).
- **Returns / side effects:** `id`, `origin`, `name`, `lat`, `lon`, `category`, `techProvider`, `country`, `shopName`, `supports`, and `activity`. No I/O.
- **Used by:** `mapRoutes` on `GET /map/places`.

## Function: MemoryMapPlaceStore

- **Purpose:** In-memory map store with the same insert-once, upsert, delete, and `recordTransaction` rules as SQLite. New rows store `lastTransactionAt` null. A repeat of origin plus external id on insert returns the first row unchanged, including its tech provider, country, shop name, supports, and last transaction instant. An upsert updates the fields it already updates and does not clear the timestamp.
- **Inputs:** `insertIfNew` and `upsert` take a validated pin. `recordTransaction` takes origin, external id, and an occurred-at string. `deleteByKey` takes origin and external id. `list` takes a positive limit and an optional filter object (`origin`, `country`, `shopName`, `blockchain`, `asset`). `filters` takes an optional blockchain.
- **Returns / side effects:** `insertIfNew` reports whether it created the row. `upsert` inserts or updates country and shop name from the body (`null` when omitted) and replaces supports only when that field is sent. `recordTransaction` returns a copy or undefined when the pair is missing. An unparseable `occurredAt` does not change the row. A written instant is `new Date(newMs).toISOString()`. It does not insert, does not move an equal or newer stored instant backward, and replaces a null or unparseable stored value. `deleteByKey` is true only when a row was removed. `list` is newest first, then id descending. Predicates are AND and apply before sort and limit. `shopName` `SPAR` matches that stored brand; `others` matches every other pin, including a missing brand. A pin with support rows matches a blockchain or asset only on those rows, and a pair must be the same row. A pin with no support rows matches the hardcoded payment-link catalog. `filters` returns distinct stored countries, blockchains, and assets; shop names are not read. `close` drops the rows.
- **Used by:** Unit tests. The process uses `SqliteMapPlaceStore`.

## Function: SqliteMapPlaceStore

- **Purpose:** SQLite driver for map pins. The schema is `MAP_PLACE_SCHEMA_SQL`. Opening an older file adds `tech_provider`, `country`, `shop_name`, and `last_transaction_at` when those columns are missing, creates `map_place_support` and its indexes if missing, and backfills `shop_name` to SPAR for origin `spar` when that column is null. It also sets a null country from the last four-digit word in a SPAR name, or from four known shop names, and does not replace a country that is already stored. New rows store `last_transaction_at` null. An upsert and a repeat insert do not clear the timestamp. A conflicting insert does not overwrite the first row.
- **Inputs:** Constructor takes a SQLite filename or `:memory:`. `upsert`, `recordTransaction`, and `deleteByKey` use the same origin and external id pair as insert. `list` takes a positive limit and an optional filter object. Predicates are AND and apply before sort and limit. A pin with no support rows uses the same hardcoded payment-link catalog as the memory store. SQLite binds every value. `filters` takes an optional blockchain.
- **Returns / side effects:** Opens the file, enables foreign keys, applies the schema, and implements `MapPlaceStore`. `recordTransaction` updates only `last_transaction_at` with the same rules as the memory store. An unparseable `occurredAt` does not change the row. A written instant is `new Date(newMs).toISOString()`. Present filter fields are AND-ed before the sort and the limit. Deleting a pin deletes its support rows. `close` closes the handle.
- **Used by:** The process entrypoint. The HTTP end-to-end run exercises it.

## Function: mapSubmissionBody

- **Purpose:** Build the JSON body for the BTC Map user submission. `extra_fields.source` is the pin origin. `payment_methods` is included only when the pin has them.
- **Inputs:** A stored map pin.
- **Returns / side effects:** `{ lat, lon, category, name, extra_fields }`. No I/O.
- **Used by:** `pushMapPlace`.

## Function: pushMapPlace

- **Purpose:** POST one new pin to BTC Map. A missing or blank token skips the call. A network or HTTP failure returns `failed` and does not throw. The token is not logged.
- **Inputs:** Stored pin, environment (`BTCMAP_ACCESS_TOKEN`, optional `BTCMAP_SUBMIT_URL`), and fetch. The default URL is `https://api.btcmap.org/v4/place-submissions`.
- **Returns / side effects:** `sent`, `failed`, or `skipped`. Timeout is 5000 ms.
- **Used by:** `mapRoutes` after a new insert from POST or PUT.

## Function: mapRoutes

- **Purpose:** `GET /map/places` is public and may take `origin`, `country`, `shopName`, `blockchain`, and `asset` to restrict the list. `GET /map/filters` is public and returns the shop name tokens, distinct countries, the payment-link catalog merged with stored blockchains and assets, and `techProviders`. `POST /map/places` requires the ingest bearer and creates a pin at most once. `PUT /map/places` upserts a pin. `DELETE /map/places` removes a pin by origin and external id. `POST /map/places/transactions` records a transaction time on an existing pin and does not call BTC Map.
- **Inputs:** Store, optional ingest token, environment, fetch, and optional `now` (defaults to `Date.now`).
- **Returns / side effects:** GET `/places` returns `{ places }` with `activity` from the request clock. GET `/filters` returns `{ shopNames, countries, blockchains, assets, techProviders }`. POST and PUT return 201 `{ created: true, id, btcmap }` or 200 `{ created: false, id, btcmap: "skipped" }`. DELETE returns 200 `{ deleted: true }` or `{ deleted: false }`. POST `/places/transactions` returns 200 `{ activity }` or 404 `{ error: "Place not found" }` and does not call BTC Map.
- **Used by:** `createApp`, mounted at `/map`.

## Function: healthRoutes

- **Purpose:** `GET /healthz` answers `{ ok: true }` when the process is up.
- **Inputs:** None.
- **Returns / side effects:** A Hono app with one public GET. No I/O.
- **Used by:** `createApp`, mounted at `/healthz`.

## Function: createApp

- **Purpose:** Build the HTTP application: health and the map routes.
- **Inputs:** Store, optional ingest token, environment, fetch, and an optional clock. When the clock is omitted the routes use `Date.now`.
- **Returns / side effects:** A Hono app. It does not listen and does not open a second database.
- **Used by:** The process entrypoint and the tests.
