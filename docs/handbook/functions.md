# Functions

## Function: normalizePlaceOrigin

- **Purpose:** Trim a pin origin and accept only `^[a-z0-9][a-z0-9-]{0,31}$`. A leading digit is valid. Uppercase tokens such as SPAR are invalid.
- **Inputs:** Unknown value, typically a JSON field or the `origin` query string.
- **Returns / side effects:** `{ ok: true, value }` with the trimmed origin, or `{ ok: false, error: "Place origin is invalid" }`. No I/O.
- **Used by:** `normalizeMapPlace`, `normalizeMapPlaceKey`, and `mapRoutes` on `GET /map/places`.

## Function: normalizeMapPlace

- **Purpose:** Validate a JSON body for one map pin. The body must be a JSON object whose keys are exactly origin, externalId, name, description, lat, lon, category, paymentMethods, techProvider, shopType, street, houseNumber, postalCode, city, country, and supports. The first unknown key in `Object.keys` order, including the old `shopName`, is `Place field is not allowed: <key>` with `<key>` cut to its first 40 characters. Coordinates must be finite and in range, then they are rounded to six decimals. An unknown payment list becomes null instead of an error. An omitted tech provider is left unset so the store can default it. An omitted `supports` list is `[]`. Country is required, trimmed, and uppercased as an assigned ISO 3166-1 alpha-2 code. Street is required, trimmed, 1 to 120 characters, without control characters. House number is required, trimmed, and must match `^[0-9][0-9A-Za-z/ .&–-]{0,31}$`. Postal code is required and trimmed: CH and LI must be exactly four digits, other countries `^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$`. City is required, trimmed, 1 to 80 characters, without control characters, and must contain a letter. Name is required, trimmed, 1 to 80 characters, without control characters. The name must not contain the street as a whole word. It must not contain the postal code as a standalone token. Description normalises `\r\n` and lone `\r` to `\n` before any check and is then trimmed. It must be 20 to 1000 characters, may contain newlines but no other control characters, and must be longer than the trimmed name and not equal to it case-insensitively. Shop type is required and exactly `SPAR` or `Others`. No stored field is derived from another field.
- **Inputs:** Unknown JSON. Required fields are `origin`, `externalId`, `name`, `description`, `lat`, `lon`, `category`, `shopType`, `street`, `houseNumber`, `postalCode`, `city`, and `country`. `techProvider` and `supports` may be omitted.
- **Returns / side effects:** `{ ok: true, value }` or `{ ok: false, error }` with a fixed English message. First failure wins. No I/O.
- **Used by:** `mapRoutes` on `POST /map/places`, and `putPlace`, shared by `mapRoutes` and `adminRoutes` for PUT.

## Function: normalizeMapPlaceFilter

- **Purpose:** Validate the optional `country`, `shopType`, deprecated `shopName`, `blockchain`, and `asset` query strings for the public map. Omitted parameters stay off the filter. Unknown query parameters stay ignored. `country` is trimmed and uppercased. `shopType` is trimmed and must be `SPAR` or `Others`. The deprecated `shopName` query maps `SPAR` to `SPAR` and `others` to `Others` for one release and is removed in the release after the rollout. If both `shopType` and `shopName` are present and map to different types, the result is `Place shop type is invalid`. `blockchain` and `asset` are trimmed and not casefolded. A filter blockchain may be a stored payment-network name or a payment-link network such as BinancePay or KucoinPay. A filter asset may be a ticker, a prefixed ticker, or a catalog name such as ckBTC or dEURO. A support body still uses the stricter stored-pair rules.
- **Inputs:** Five optional raw query strings: country, shopType, legacy shopName, blockchain, and asset.
- **Returns / side effects:** `{ ok: true, value }` with the present filter fields, or `{ ok: false, error }` with `Place country is invalid`, `Place shop type is invalid`, `Place shop name is invalid`, or `Place support is invalid`. No I/O.
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

- **Purpose:** Merge distinct stored filter values with the hardcoded payment-link catalog for `GET /map/filters`. `shopTypes` is always `["SPAR", "Others"]`. `shopNames` is the deprecated one-release alias `["SPAR", "others"]` and is removed in the release after the rollout. `?blockchain=` limits the top-level asset list. `techProviders` always contains the full `DFX.swiss` offer and the `21.gifts` offer of Lightning and BTC.
- **Inputs:** Stored countries, blockchains, and assets, plus an optional blockchain query.
- **Returns / side effects:** `{ shopTypes, shopNames, countries, blockchains, assets, techProviders }`. No I/O.
- **Used by:** `mapRoutes` on `GET /map/filters`.

## Function: normalizeMapPlaceKey

- **Purpose:** Validate origin and external id for deleting a map pin. Extra JSON fields are ignored. The body does not need coordinates or a name.
- **Inputs:** Unknown JSON. Required fields are `origin` and `externalId`, with the same rules as `normalizeMapPlace`.
- **Returns / side effects:** `{ ok: true, value: { origin, externalId } }` or `{ ok: false, error }` with the same English messages as create. No I/O.
- **Used by:** `deletePlace`, shared by `mapRoutes` and `adminRoutes`.

## Function: placeActivity

- **Purpose:** Classify a stored transaction instant and payment days into `daily`, `within7Days`, `within30Days`, `olderThan30Days`, or `none`. First match wins. `daily` is at least five distinct stored UTC dates (`YYYY-MM-DD`) that lie on the UTC date of `nowMs` or on one of the previous six UTC dates. Duplicates and strings that are not that date form or that lie outside the window are ignored. `within7Days` is a parseable instant whose age is at most `7 * 24 * 60 * 60 * 1000` ms (exactly 7 days stays here; a future instant stays here) when the row is not `daily`. `within30Days` is older than 7×24h and at most 30×24h (exactly 30 days stays here). One millisecond past 30×24h is `olderThan30Days`, not `none`. `none` is a null or unparseable instant when the row is not `daily`.
- **Inputs:** `lastTransactionAt` (`string | null`), `paymentDays` (readonly UTC date strings), and `nowMs` (maintenance clock in milliseconds).
- **Returns / side effects:** `{ activity, until }`. For `daily`, `until` is UTC midnight at the start of the fifth-newest counted day plus 7 days. For `within7Days` and `within30Days`, `until` is one millisecond after the 7-day or 30-day bound. For `olderThan30Days` and `none`, `until` is null. No I/O.
- **Used by:** `MemoryMapPlaceStore` and `SqliteMapPlaceStore` on the transaction write and when `activity_until` is due.

## Function: normalizePlaceTransaction

- **Purpose:** Validate a JSON body that records a shop transaction. `origin` and `externalId` use `normalizeMapPlaceKey` and the same error strings. Extra JSON fields are ignored. Omitted `occurredAt` becomes `new Date(nowMs).toISOString()`. A present `occurredAt` must be a parseable string at most 120 seconds after `nowMs`; exactly `nowMs + 120_000` is valid and one millisecond later is not. The returned instant is canonical ISO (`new Date(parsed).toISOString()`), not the raw string.
- **Inputs:** Unknown JSON and `nowMs`. Required fields are `origin` and `externalId`. `occurredAt` is optional.
- **Returns / side effects:** `{ ok: true, value: { origin, externalId, occurredAt } }` or `{ ok: false, error }` including `Place transaction time is invalid`. No I/O.
- **Used by:** `mapRoutes` on `POST /map/places/transactions`.

## Function: toPublicMapPlace

- **Purpose:** Strip the caller id and payment methods before a pin is shown on the public map. The tech provider, description, shop type, street, house number, postal code, city, country, and supports stay on the public row. `shopName` is derived for one release as `'SPAR'` when `shopType` is `'SPAR'`, otherwise null, and is removed in the release after the rollout. Address parts on a public row are strings. `activity` is copied from the stored pin. A read does not reclassify.
- **Inputs:** A stored map pin. Public map callers pass a complete row; `adminRoutes` may pass an incomplete row.
- **Returns / side effects:** `id`, `origin`, `name`, `description`, `lat`, `lon`, `category`, `techProvider`, `shopType`, `shopName`, `country`, `street`, `houseNumber`, `postalCode`, `city`, `supports`, and `activity`. No I/O.
- **Used by:** `mapRoutes` on `GET /map/places` and `adminRoutes` on `GET /admin/places`.

## Function: MemoryMapPlaceStore

- **Purpose:** In-memory map store with the same insert-once, full-replace upsert, delete, `recordTransaction`, and `refreshActivity` rules as SQLite. New rows store `lastTransactionAt` null, `activity` `none`, `activity_until` null, and no payment days. Completeness: a row is complete when name, description, shop type (`SPAR` or `Others`), street, house number, postal code, city, and country are non-empty and `lastTransactionAt` is null or `Number.isFinite(Date.parse(...))`. `list` and the `countries` of `filters` use only complete rows. `listAll` returns every row, including incomplete rows, newest first with no filter or limit. Payment days and `activity_until` stay beside the row, not on `StoredMapPlace`. A repeat of origin plus external id on insert returns the first row unchanged, including its tech provider, description, shop type, address, supports, last transaction instant, `activity`, `activity_until`, and payment days. An upsert replaces every field of the pin and does not clear the timestamp, `activity`, `activity_until`, or payment days. An omitted tech provider becomes `DFX.swiss`. An omitted supports list becomes `[]`. No field is derived from another field.
- **Inputs:** `insertIfNew` and `upsert` take a validated pin. `recordTransaction` takes origin, external id, an occurred-at string, and `nowMs`. `refreshActivity` takes `nowMs`. `deleteByKey` takes origin and external id. `list` takes a positive limit and an optional filter object (`origin`, `country`, `shopType`, `blockchain`, `asset`). `listAll` takes no arguments. `filters` takes an optional blockchain.
- **Returns / side effects:** `insertIfNew` reports whether it created the row. `upsert` replaces name, description, lat, lon, category, paymentMethods, techProvider, shopType, street, houseNumber, postalCode, city, country, and supports. `recordTransaction` returns a copy or undefined when the pair is missing. An unparseable `occurredAt` does not change the row. A written instant is `new Date(newMs).toISOString()`. It does not insert, does not move an equal or newer stored instant backward, and replaces a null or unparseable stored value. A parseable instant deletes stored payment days older than the 7-date window start of `nowMs` before classifying, stores its UTC date only when that date is inside that window, then stores `activity` and `activity_until` from `placeActivity`. `refreshActivity` updates only rows whose stored `activity_until` is non-null and due, deletes payment days older than the window start, and stores the new token and `until`. `deleteByKey` is true only when a row was removed and drops that row's payment days. `list` is newest complete pins first, then id descending. `listAll` is every row, including incomplete rows, newest first, with no limit. Neither calls `refreshActivity` or joins payment days. Predicates are AND and apply before sort and limit. `shopType` matches the stored enum. A pin with support rows matches a blockchain or asset only on those rows, and a pair must be the same row. A pin with no support rows matches the hardcoded payment-link catalog. `filters` returns distinct countries of complete rows, plus blockchains and assets from every row. `close` drops the rows.
- **Used by:** Unit tests. The process uses `SqliteMapPlaceStore`.

## Function: SqliteMapPlaceStore

- **Purpose:** SQLite driver for map pins. The schema is `MAP_PLACE_SCHEMA_SQL` (`description` and `shop_type` columns, no `shop_name` on a new database). Opening an older file adds `tech_provider`, `country`, `street`, `house_number`, `postal_code`, `city`, `description`, `shop_type`, `last_transaction_at`, `activity`, and `activity_until` when those columns are missing, and creates `map_place_support`, `map_place_payment_day`, and their indexes if missing. An existing leftover `shop_name` column is left in place and is never read or written. Country and shop type are not backfilled from the name or origin. Opening a file that lacks `activity` then backfills every existing row once from `last_transaction_at` at `Date.now()`: at most that one UTC day when it is inside the window, then `activity` and `activity_until`. It does not invent the other days. Every constructor open, including a file that already has the column, ends by calling `refreshActivity(Date.now())`. Completeness: a row is complete when name, description, shop_type in (`SPAR`, `Others`), street, house_number, postal_code, city, and country are non-null and non-empty, and `last_transaction_at` is null or `julianday(last_transaction_at) IS NOT NULL`. `list` and the `countries` of `filters` use only complete rows. `listAll` returns every row, including incomplete rows, newest first with no filter or limit. An upsert is a full replace of every pin field. New rows store `last_transaction_at` null, `activity` `none`, `activity_until` null, and no payment days. An upsert and a repeat insert do not clear the timestamp, `activity`, `activity_until`, or payment days. A conflicting insert does not overwrite the first row. `recordTransaction` and `deleteByKey` also work on incomplete rows.
- **Inputs:** Constructor takes a SQLite filename or `:memory:`. `upsert`, `recordTransaction`, and `deleteByKey` use the same origin and external id pair as insert. `recordTransaction` also takes `nowMs`. `refreshActivity` takes `nowMs`. `list` takes a positive limit and an optional filter object; `listAll` takes no arguments. Predicates are AND and apply before sort and limit. A pin with no support rows uses the same hardcoded payment-link catalog as the memory store. SQLite binds every value. `filters` takes an optional blockchain.
- **Returns / side effects:** Opens the file, enables foreign keys, applies the schema, and implements `MapPlaceStore`. `recordTransaction` uses the same last-instant and payment-day rules as the memory store. A parseable instant deletes stored payment days older than the 7-date window start of `nowMs` before classifying, stores its UTC date only when that date is inside that window, then stores `activity` and `activity_until` from `placeActivity`. An unparseable `occurredAt` does not change the row. A written instant is `new Date(newMs).toISOString()`. `refreshActivity` updates only rows whose stored `activity_until` is non-null and due. `list` returns complete rows; `listAll` returns every row, including incomplete rows, newest first and without a limit. Neither calls `refreshActivity` or joins payment days. Present filter fields are AND-ed before the sort and the limit, including `shop_type = ?`. Support rows for lists are loaded in chunks of at most 500 place ids. Deleting a pin deletes its support rows and payment days. The process calls `refreshActivity(Date.now())` at startup and every 1000 ms. `close` closes the handle.
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
- **Used by:** `mapRoutes` after a new POST insert, and `putPlace`, shared by `mapRoutes` and `adminRoutes`, after a new PUT insert.

## Function: mapRoutes

- **Purpose:** `GET /map/places` is public and may take `origin`, `country`, `shopType`, deprecated `shopName`, `blockchain`, and `asset` to restrict the complete-row list. A read copies the stored `activity` token and does not reclassify. `GET /map/filters` is public and returns `shopTypes`, the deprecated `shopNames` alias, distinct countries of complete rows, the payment-link catalog merged with stored blockchains and assets, and `techProviders`. `POST /map/places` requires the ingest bearer and creates a pin at most once. `PUT /map/places` is a full replace. `DELETE /map/places` removes a pin by origin and external id. `POST /map/places/transactions` records a transaction time on an existing pin, passes the request clock into `recordTransaction`, returns the stored `activity`, and does not call `placeActivity` or BTC Map. Maintenance happens on that write and when `activity_until` is due. The process does that maintenance at startup and every 1000 ms.
- **Inputs:** Store, optional ingest token, environment, fetch, and optional `now` (defaults to `Date.now`).
- **Returns / side effects:** GET `/places` returns `{ places }` with the stored `activity`. It never calls `refreshActivity`. GET `/filters` returns `{ shopTypes, shopNames, countries, blockchains, assets, techProviders }`. POST and PUT return 201 `{ created: true, id, btcmap }` or 200 `{ created: false, id, btcmap: "skipped" }`. DELETE returns 200 `{ deleted: true }` or `{ deleted: false }`. POST `/places/transactions` returns 200 `{ activity }` from the stored row or 404 `{ error: "Place not found" }` and does not call BTC Map.
- **Used by:** `createApp`, mounted at `/map`.

## Function: healthRoutes

- **Purpose:** `GET /healthz` answers `{ ok: true }` when the process is up.
- **Inputs:** None.
- **Returns / side effects:** A Hono app with one public GET. No I/O.
- **Used by:** `createApp`, mounted at `/healthz`.

## Function: welcomeRoutes

- **Purpose:** `GET /` returns a static HTML welcome page for the API host. It links `GET /map/places`, `GET /map/filters`, `GET /healthz`, and the public website. It does not read the store.
- **Inputs:** None.
- **Returns / side effects:** A Hono app with one public GET. No I/O.
- **Used by:** `createApp`, mounted at `/`.

## Function: createApp

- **Purpose:** Build the HTTP application: the welcome page, health, map routes, and the `/admin` mount. Admin answers 503 when either its keys or host is missing.
- **Inputs:** Store, optional ingest token, environment, fetch, optional `adminKeys` and `adminHost`, and an optional clock. When the clock is omitted the routes use `Date.now`.
- **Returns / side effects:** A Hono app. It does not listen and does not open a second database.
- **Used by:** The process entrypoint and the tests.

## Function: parseAdminPublicKeys

- **Purpose:** Parse `OCP_ADMIN_PUBLIC_KEYS` into the devices allowed to call `/admin`. The value is split on `\n` or `\r\n`. A blank line is skipped. A line whose first non-whitespace character is `#` is a comment and is skipped. Every other line is three fields: `ed25519`, the base64 of the raw 32-byte public key, and a name, or `ssh-ed25519`, the base64 of the OpenSSH wire blob, and a name. The wire blob is a uint32 length, the text `ssh-ed25519`, a uint32 length, and the 32-byte key, and nothing after that. The name matches `^[A-Za-z0-9._@-]{1,64}$` and is unique. Base64 may be padded or unpadded.
- **Inputs:** The environment string. Line numbers are 1-based and count every line, including blanks and comments.
- **Returns / side effects:** The keys in file order. Empty when every line is blank or a comment. A bad line throws `OCP_ADMIN_PUBLIC_KEYS line <N>: malformed key`. A repeated name throws `OCP_ADMIN_PUBLIC_KEYS line <N>: duplicate key name`. The same key material under a second name throws `OCP_ADMIN_PUBLIC_KEYS line <N>: duplicate key`, because the replay key is the key name plus the nonce. Nothing is returned when it throws. No I/O.
- **Used by:** The process entrypoint before it listens.

## Function: decodeBase64

- **Purpose:** Decode strict standard base64. Padded and unpadded input is accepted. A bad alphabet, a length of 4n+1, or padding that does not match the body is rejected.
- **Inputs:** One base64 token.
- **Returns / side effects:** Decoded bytes, or undefined when the token is invalid. No I/O.
- **Used by:** `parseAdminPublicKeys` for public keys and `verifyAdminRequest` for signatures.

## Function: canonicalString

- **Purpose:** Build the UTF-8 string an admin signature covers. The fields are `OCP-ADMIN-v1`, the method in upper case, the host, the path plus the query exactly as sent, the decimal unix timestamp, the nonce, and the lowercase hex SHA-256 of the raw body. An empty body hashes as zero bytes (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`). The fields are joined with `\n`. There is no trailing newline. The key name is not a field.
- **Inputs:** Method, host, path with query, unix seconds, the nonce (16 to 64 characters of `[A-Za-z0-9_-]`), and the raw body bytes.
- **Returns / side effects:** The string the device signs and the server rebuilds. Throws `Admin timestamp must be an integer` when the timestamp is not a safe integer. Throws `Admin nonce is invalid` when the nonce does not match. No I/O.
- **Used by:** `signAdminRequest` and `verifyAdminRequest`.

## Function: signAdminRequest

- **Purpose:** Sign one admin request with an Ed25519 private key. The host is the name the server was configured with, not a header the client picked. The signature is standard base64 of the 64-byte signature over the UTF-8 canonical string. The key name is sent as `OCP-Admin-Key` and is not part of that string. The nonce is part of the signed string and is sent as `OCP-Admin-Nonce`. When the nonce is omitted, 16 random bytes are generated as base64url.
- **Inputs:** Method, host, path with query, unix seconds, raw body, PKCS8 Ed25519 private key, key name, and an optional nonce.
- **Returns / side effects:** The headers `OCP-Admin-Key`, `OCP-Admin-Timestamp` (the decimal timestamp), `OCP-Admin-Signature`, and `OCP-Admin-Nonce`. Throws `Admin timestamp must be an integer` when the timestamp is not a safe integer. Throws `Admin nonce is invalid` when a given nonce does not match. Does not record a replay. No other I/O.
- **Used by:** A device that calls `/admin`. `scripts/ocp-admin.mjs` builds the same four headers. The server checks them with `verifyAdminRequest`.

## Function: verifyAdminRequest

- **Purpose:** Accept one admin request only when the nonce matches, the key name is known, the timestamp header is an integer within 60 seconds of the server clock (the difference may be 60 and must not be 61), and the signature verifies over `canonicalString` for the configured host, the method, the path plus query, the nonce, and the raw body. A missing or malformed nonce returns false before any signature work. A nonce already stored for that key is rejected. Expired entries (expiry strictly before the current unix second) are removed at the start of every call. The replay key is `<keyName>\n<nonce>`, not the signature. On success that key is stored until `timestamp + 60`. Every failure returns false and does not store the nonce. The host argument is the server config, never the request `Host` header.
- **Inputs:** Allowed keys, the header values including the nonce, method, host, path with query, raw body, current unix seconds, and the process replay map.
- **Returns / side effects:** True only when the request is fresh, signed by an allowed key, and not a replay. False for a missing or malformed nonce, a missing or unknown key, a timestamp that is not an integer, a timestamp outside the 60-second window, a bad or wrong-length signature, a signature that does not verify, or a reused nonce. Does not throw. Updates the replay map only after a successful check.
- **Used by:** `adminRoutes` on every `/admin` request once admin is configured.

## Function: adminRoutes

- **Purpose:** Signed maintenance of pins for any origin, mounted at `/admin`. When no key is loaded or the host is blank, every request returns 503 `{ error: "Admin is not configured" }` and the body is not checked. Otherwise a body above 64 KiB returns 413 `{ error: "Payload too large" }` before the signature is checked. The raw body is read once, `verifyAdminRequest` runs against the trimmed configured host and the path plus query of the request URL, and a failure returns 401 `{ error: "Unauthorized" }`. `GET /places` lists every stored pin, including incomplete rows, newest first. Each item is the public place plus `complete` and `problems` from one `placeProblems` call. The caller id and payment methods are omitted. `PUT /places` and `DELETE /places` parse those same bytes as JSON (empty or invalid JSON is null) and call `putPlace` and `deletePlace`. The request `Host` header is not the signed host.
- **Inputs:** Store, environment, fetch, the allowed keys, the configured host, and an optional clock in milliseconds (default `Date.now`). One replay map lives for the life of the app.
- **Returns / side effects:** A Hono app. GET returns 200 `{ places }`. PUT and DELETE return the status and body of `putPlace` and `deletePlace`. A valid signature for an unknown path falls through as 404. No second database.
- **Used by:** `createApp`, mounted at `/admin`.

## Function: putPlace

- **Purpose:** Full replace of one map pin, or insert it when the origin and external id are new. Validation, the store write, and the BTC Map call are the same as `PUT /map/places`. A new row is posted to BTC Map only when this call inserts it. An update does not call BTC Map. A rejected body leaves the stored pin unchanged. This function does not check the ingest bearer or the admin signature.
- **Inputs:** Store, BTC Map environment, fetch, and the request JSON. Null, an array, and a non-object are invalid.
- **Returns / side effects:** 400 `{ error }` with the validator message, 201 `{ created: true, id, btcmap }` when the row is new, or 200 `{ created: false, id, btcmap }` when the pair already existed. `btcmap` is `sent`, `failed`, or `skipped`.
- **Used by:** `mapRoutes` on `PUT /map/places` after the ingest check, and `adminRoutes` on `PUT /admin/places` after the signature check.

## Function: deletePlace

- **Purpose:** Remove one map pin by origin and external id. Validation is the same as `DELETE /map/places`. A missing pair is still 200 with `{ deleted: false }`. This call does not contact BTC Map. Extra JSON fields are ignored. This function does not check the ingest bearer or the admin signature.
- **Inputs:** Store, and the request JSON. Null, an array, and a non-object are invalid. Required fields are `origin` and `externalId`.
- **Returns / side effects:** 400 `{ error }` with the validator message, or 200 `{ deleted: true }` or `{ deleted: false }`. A true result means a row was removed.
- **Used by:** `mapRoutes` on `DELETE /map/places` after the ingest check, and `adminRoutes` on `DELETE /admin/places` after the signature check.

## Function: placeProblems

- **Purpose:** List why the public map hides a stored pin. This is the completeness rule of `MemoryMapPlaceStore` and the source of `complete` and `problems` on `GET /admin/places`. `SqliteMapPlaceStore` applies the same rule in SQL (`COMPLETE_PLACE_SQL`) for its public list. A row is complete when name, description, street, house number, postal code, city, and country are non-empty, shop type is `SPAR` or `Others`, and `lastTransactionAt` is null or `Number.isFinite(Date.parse(...))`. The messages, in that order, are `name is empty`, `description is empty`, `street is empty`, `houseNumber is empty`, `postalCode is empty`, `city is empty`, `country is empty`, `shopType must be SPAR or Others`, and `lastTransactionAt is not a valid instant`. Only the failures are included.
- **Inputs:** A stored pin, including an incomplete row.
- **Returns / side effects:** The problem strings in check order, or `[]` when the pin is complete. No I/O. The public list treats a pin as complete when this list is empty.
- **Used by:** `MemoryMapPlaceStore` completeness check, and `adminRoutes` on `GET /admin/places`.
