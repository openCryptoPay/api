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

## Admin

A device signs admin requests with its own Ed25519 key. Allowed public keys are `OCP_ADMIN_PUBLIC_KEYS`. `OCP_ADMIN_HOST` is the hostname those signatures must name. The ingest routes are unchanged: `POST`, `PUT`, and `DELETE` `/map/places`, and `POST /map/places/transactions`, still require `Authorization: Bearer` equal to `OCP_PLACE_INGEST_TOKEN`.

`OCP_ADMIN_PUBLIC_KEYS` is one environment value, not a secret. It is newline-separated. A blank line is ignored. A line whose first non-whitespace character is `#` is a comment and is ignored. Every other line is `ed25519`, the base64 of the raw 32-byte public key, and a name, or `ssh-ed25519`, the base64 of the OpenSSH wire blob, and a name. `ssh-ed25519` is allowed. Base64 may be padded or unpadded. The name matches `^[A-Za-z0-9._@-]{1,64}$` and must be unique. Line numbers count every line, including blanks and comments.

```
# desk laptop; replace the placeholder, this is not a key
ed25519 <base64 of the raw 32-byte public key> desk
ssh-ed25519 <base64 of the OpenSSH wire blob> phone
```

A bad line, a repeated name, or the same key material under a second name throws before the process listens. The message is `OCP_ADMIN_PUBLIC_KEYS line <N>: malformed key`, `OCP_ADMIN_PUBLIC_KEYS line <N>: duplicate key name`, or `OCP_ADMIN_PUBLIC_KEYS line <N>: duplicate key`, and `<N>` is the 1-based line number. Duplicate material is rejected because the replay key is the key name plus the nonce. An unset value, a blank value, or only blanks and comments does not throw.

`OCP_ADMIN_HOST` is trimmed and lowercased. It is a hostname, with no scheme and no port. The signature is checked against this configured value. The request `Host` header is not used.

When no key was loaded, or the host is missing or blank, admin is disabled. The process still starts. Every `/admin` request returns 503 `{ "error": "Admin is not configured" }`. Public reads and the ingest routes keep working.

Admin request bodies are limited to 64 KiB. A larger body returns 413 `{ "error": "Payload too large" }` before its signature is checked. The unconfigured 503 check runs first.

The signed UTF-8 string has no trailing newline. The lines, joined by `\n`, are `OCP-ADMIN-v1`, the method in upper case, `OCP_ADMIN_HOST`, the path and query as the server parses the request URL (pathname plus search, so a lone trailing `?` is dropped and the URL standard's normalisation applies; the CLI refuses a path that changes when parsed), the unix timestamp in seconds, the nonce, and the lowercase hex SHA-256 of the raw body. An empty body is the hash of zero bytes. The headers are `OCP-Admin-Key` (the key name, not part of the string), `OCP-Admin-Timestamp`, `OCP-Admin-Nonce` (16 to 64 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`; the device generates a fresh random one for every request, for example 16 random bytes as base64url), and `OCP-Admin-Signature` (standard base64). A missing or malformed nonce is 401.

The timestamp must be within 60 seconds of the server clock, and 60 seconds is still accepted. The replay key is the key name plus the nonce, not the signature. A nonce already accepted for that key is a replay and returns 401 `{ "error": "Unauthorized" }` until its timestamp ages out of the 60 second window. Two requests with identical content in the same second are fine as long as their nonces differ.

`scripts/ocp-admin.mjs` is the device CLI (Node 20 or newer, no packages). `keygen` writes the PKCS8 private key to `~/.ocp-admin/<name>.key` with mode `0600` and refuses to overwrite it. The directory is mode `0700`. Stdout is only the public config line. The private key is never printed.

```sh
node scripts/ocp-admin.mjs keygen desk
node scripts/ocp-admin.mjs list --base https://api.example.test --key desk
node scripts/ocp-admin.mjs put places.json --base https://api.example.test --key desk
node scripts/ocp-admin.mjs delete fremd shop-1 --base https://api.example.test --key desk
```

`--key` is the key name, not a path. A CLI key name must not start with `-`. The signed host is the hostname of `--base`, which must equal `OCP_ADMIN_HOST`. `list` signs `GET /admin/places`. `put` reads a JSON array and signs one `PUT /admin/places` per element. `delete` signs `DELETE /admin/places` with `origin` and `externalId`. The CLI sends a fresh nonce with every request. `delete` prints `missing <externalId>` and exits with status 1 when no pin had that origin and external id.

## Branches

Pull requests target `develop`. A push there publishes `dfxswiss/opencryptopay-api:beta`, except a push that changes only Markdown. `main` publishes `dfxswiss/opencryptopay-api:latest` the same way and moves only through the release pull request from `develop`. A manual run publishes only when it is started on that branch.

## Checks

`bun run typecheck`, `bun run lint`, `bun run handbook:check`, `bun run e2e:check`, `bun run test:coverage`, `bun run build`, and `bun run e2e`. Coverage on `src` is 100 percent. `src/index.ts` is the process entry and is exercised by the HTTP end-to-end run.

## Product notes

Notes that are not specific to this API are in [docs/product](docs/product/README.md). [Where place maps are shown](docs/product/maps.md) is the first of those notes.
