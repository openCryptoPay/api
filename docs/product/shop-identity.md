# Shop identity, photos and shop page

Status: **specified, not implemented**. Nothing here changes runtime behavior
yet. A change that builds a part of this adds its routes to
[endpoints.md](../handbook/endpoints.md), its exported functions to
[functions.md](../handbook/functions.md) and its columns and tables to
[map-place.sql](../schema/map-place.sql) in that same change, and documents
any new environment variable in the README. Step 1a adds R7 to
[place-requirements.md](place-requirements.md) and records it as accepted,
not enforced, in [place-requirements-gap.md](place-requirements-gap.md);
step 1b updates that entry to enforced.

Every shop is registered with a NOSTR public key. That key is the shop's
identifier everywhere: in the API, in the public page
`https://opencryptopay.io/{npub}`, and in every new route. The
page shows everything the API knows about the shop, including its photos. The
API stores the photos and serves them.

OpenCryptoPay does not hold NOSTR keys, does not sign anything and does not
publish or maintain NOSTR profiles. The source that registers a shop owns its
identity. Whether that identity has a profile, and whether it is kept up to
date, does not matter to OpenCryptoPay: the key is used as a unique id.

21.gifts gives each of its shops such an identity and maintains its profile,
see [21gifts/api `docs/shop-identity.md`](https://github.com/21gifts/api/blob/develop/docs/shop-identity.md)
(until that is merged: 21gifts/api#487).
It sends that key here when it registers the shop, so a 21.gifts shop has the
same npub on both platforms.

"Shop" means one place in the public list of `GET /map/places`, as in
[place-requirements.md](place-requirements.md).

## R7 NOSTR identity (new hard requirement)

Every shop must state a NOSTR public key:

- Field `nostrPubkey` in `POST` and `PUT /map/places`: exactly 64 lowercase hex
  characters, the x-only secp256k1 public key from NIP-01. It must be a valid
  point on the curve. An `npub` string, uppercase hex or any other form is
  rejected.
- It is required. A body without it is rejected with **400** and nothing is
  stored, as in R6. It is never defaulted, generated or derived by the API.
  This rejection is switched on in step 1b of the order of work below, once
  every source sends keys; step 1a already hides shops without a key and
  stores the writes.
- It is unique across all shops of all sources, also over time. Once a key
  has been stored for an `origin` + `externalId`, it stays reserved for that
  pair, also after `DELETE /map/places`. A key reserved for another pair is
  rejected with **409** `{ "error": "nostrPubkey belongs to another place" }`.
  So an old shared `/{npub}` link can never lead to a different shop.
- It is fixed once stored. A `POST` or `PUT` for the same `origin` +
  `externalId` with a different key is rejected with **409**
  `{ "error": "nostrPubkey of a place cannot change" }`. To move a shop to a new
  key, the source deletes the place and registers it again with the new
  key; the old key stays reserved for that pair, and its npub answers 404.
  The same pair may also register again with its old key.
- When a write breaks both 409 rules, the place's stored key decides: a
  place that already has a key answers
  `nostrPubkey of a place cannot change`; the reservation check applies only
  to a place without a stored key. POST and PUT, and both stores, use this
  order.
- A `POST` for an existing `origin` + `externalId` that has no key yet stores
  the key it carries. Without that, a source could never add a key to an
  existing row through `POST`, which otherwise leaves an existing row as it
  is.
- `nostrPubkey` is added to `ALLOWED_PLACE_KEYS`.
- A stored row without `nostrPubkey` is not complete. `COMPLETE_PLACE_SQL`
  and the memory store's `isCompletePlace` both require it, so such a row
  stays out of `GET /map/places` and `GET /map/places/{npub}`, in the same
  way PR #22 handles the other fields. `GET /map/filters` keeps reading
  blockchains and assets from every row, as it does today for any
  incomplete row. Its `countries` list comes from complete rows, so a
  country whose only shops have no key drops out of it. An existing row
  becomes public once it carries a key and passes the completeness check of
  PR #22 (R2 to R5), whether the key arrives with a `PUT` or, as described
  above, with a `POST`.

The npub is not stored. It is `nip19.npubEncode(nostrPubkey)` wherever it is
shown.

### Storage

`map_place` gains `nostr_pubkey TEXT`, added by the existing startup
`ALTER TABLE ADD COLUMN` path. SQLite cannot add a `UNIQUE` column, so
uniqueness is a separate
`CREATE UNIQUE INDEX IF NOT EXISTS map_place_nostr_pubkey ON map_place (nostr_pubkey)`,
run after the column exists. SQLite allows several nulls under that index.

The reservation lives in its own table, which a place `DELETE` does not
touch and nothing ever deletes from:

```sql
CREATE TABLE IF NOT EXISTS map_pubkey_reservation (
  nostr_pubkey TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Every write that stores a key that has no reservation row yet inserts one
(`nostr_pubkey`, `origin`, `external_id`, `created_at`) in the same
transaction, so each
key a pair ever used stays reserved. The memory store keeps the same map.

The column is nullable for old rows and, until step 1b, for writes without a
key. A write without `nostrPubkey` never clears a key that is already stored:
`PUT` replaces every other field and keeps the key, as it keeps `id` and
`createdAt`. From step 1b on, the write path never stores a null.

`origin` + `externalId` stay the source's own key for idempotent writes. Every
public response and every new route uses the NOSTR key instead. The internal
UUID no longer appears in any JSON: the `id` in the answers of `POST` and
`PUT /map/places` is the npub, or `null` for a place without a key (step 1a
only).

## R8 Request order

R8 is a rule of the write protocol, not a requirement every listed shop
must meet, so it is not recorded in `place-requirements.md`.

A source can time out a request that OpenCryptoPay still applies later. So
that such a late request can never overwrite newer state, every write may
carry a revision:

- Field `revision`, an integer from 1 to 9007199254740991 (the largest
  integer JSON keeps exactly), in `POST`, `PUT` and `DELETE` on
  `/map/places` and in `PUT /map/places/photos`. Any other value gets
  **400**. It is optional; a source that sends it must raise it for every
  request of the same place, places and photos sharing one counter.
- OpenCryptoPay keeps the highest accepted revision per `origin` +
  `externalId` in its own table, which a place `DELETE` does not touch. The
  memory store keeps the same map.

  ```sql
  CREATE TABLE IF NOT EXISTS map_place_revision (
    origin TEXT NOT NULL,
    external_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (origin, external_id)
  );
  ```

- The comparison and the store happen in the same transaction as the write
  itself. A write whose revision is not higher than the stored one changes
  nothing and gets **409** `{ "error": "Stale revision" }`.
- Every accepted write stores its revision, also when it changes nothing:
  a `DELETE` that finds no place (`deleted: false`) and a `POST` that leaves
  an existing row as it is. Otherwise a late older `PUT` could recreate a
  place after the source had removed it.
- A write without `revision` for a place that has no stored revision is
  not checked and stores nothing, as today. Once a revision is stored for
  an `origin` + `externalId`, a write without `revision` for it changes
  nothing and gets the same **409** `Stale revision`, checked in the same
  transaction. A request a source sent before it switched to revisions, and
  that arrives late, then cannot overwrite the newer state.
- Order of answers on `POST`, `PUT` and `DELETE /map/places` and on
  `PUT /map/places/photos`, in both stores: the existing **503** (ingest
  not configured) and **401** (bearer) first, then **413** for an oversized
  photo body, **400** for the body format (including `revision`), then on the
  photo route **404** for an unknown key or another origin, then
  `Stale revision`, then on `POST` and `PUT /map/places` the two R7 rules in
  their stated order. `POST /map/places/transactions` carries no revision
  and is not affected.
- `revision` is added to `ALLOWED_PLACE_KEYS` and to the allowed keys of the
  photo route. `DELETE /map/places` today ignores unknown keys; from step 1a
  it accepts exactly `origin`, `externalId` and `revision` and answers
  **400** to any other key, like `POST`, `PUT /map/places` and the photo
  route. This check belongs to the `DELETE` route only:
  `POST /map/places/transactions` reads its key through the same
  `normalizeMapPlaceKey` and keeps ignoring unknown keys.

## Photos

### Delivery by the source

New endpoint `PUT /map/places/photos`, same bearer as the other write routes
(`OCP_PLACE_INGEST_TOKEN`).

```json
{
  "origin": "21gifts",
  "nostrPubkey": "<64 hex>",
  "revision": 42,
  "photos": [{ "contentType": "image/jpeg", "data": "<base64>", "caption": "Front" }]
}
```

- The shop is addressed by its `nostrPubkey` together with the `origin`
  that registered it. All sources share one bearer, so they are fully
  trusted by each other; the `origin` only keeps one source from changing
  another source's photos by mistake, because the npub is public. Separate
  credentials per origin would be needed to stop a hostile source and are
  not part of this.
  Photos are accepted for the stored place with that key and that origin,
  listed or not. **404** `{ "error": "Place not found" }` when no stored
  place has the key, or when it belongs to another origin.
- `photos` replaces the whole photo list of that shop. An empty array removes
  every photo. Order is the order shown; the first photo is the cover.
- At most 10 photos per shop.
- Photos are separate from `PUT /map/places`, so a source does not resend
  megabytes on every text change.
- Allowed keys: `origin`, `nostrPubkey`, `revision` (R8), `photos`; per photo
  `contentType`, `data`, `caption`. Any other key rejects the request, as
  `POST` and `PUT /map/places` do.
- The route accepts a body of up to 15 MiB. Larger bodies get **413**
  before any photo is checked, so the guarantee below holds only while each
  photo stays within the 1 MiB rule.
- A malformed envelope is rejected with **400** and stores nothing: an
  unknown key at the top level or in a photo, more than 10 photos,
  `photos` that is not an array, a photo entry that is not an object, a
  `nostrPubkey` that breaks the R7 format rule, an `origin` or `revision`
  of the wrong form.
- A single photo that breaks a rule below, including a missing
  `contentType` or `data`, or a field of the wrong type in `contentType`,
  `data` or `caption`, is skipped and reported by index; the others are
  stored in their order. One bad photo never blocks the rest, because a
  source's own upload rules can be looser than these.
- Response **200**:
  `{ "photos": [ { "url", "width", "height", "caption" } ], "skipped": [ { "index", "error" } ] }`.
  `index` is the 0-based position in the request; the `error` sentence
  numbers photos from 1, so `index` 2 reads `Photo 3 …`. `caption` is `null`
  when unset. `skipped` is `[]` when nothing was skipped.
- `DELETE /map/places` drops the photos with the place. A source that
  registers the place again sends its photos again.

Rules per photo. 21.gifts checks only size and magic bytes on its own
uploads, so the header rules here are stricter:

- `contentType` is `image/jpeg`, `image/png` or `image/webp`.
- `data` is strict base64. The decoded size is at most 1 048 576 bytes.
- The file type is read from the magic bytes and must equal `contentType`.
- The markers or chunks must walk cleanly: a JPEG to its `EOI`, a PNG to
  its `IEND`, with no segment or chunk length past the end of the file. For a
  WebP, 8 plus the RIFF size must not exceed the file length, and its chunks
  must end exactly at byte 8 plus the RIFF size. Otherwise the photo is
  skipped (`Photo N could not be read`), so metadata that cannot be found is
  never stored.
- Animated images are not accepted: a PNG with `acTL`, or a WebP with
  `ANIM` or `ANMF` or with the animation flag (`0x02`) set in `VP8X`, is
  skipped (`Photo N is animated`). A shop photo is a still
  picture, and this keeps the metadata walk to one level.
- Width and height are read from the file header, which must parse. Each is
  between 1 and 4096. The API returns the displayed size: for a JPEG whose
  EXIF orientation is 5 to 8, width and height are swapped. Orientation
  values outside 2 to 8 count as 1.
- `caption` is optional, 1–200 characters, no control characters.

The `error` of a skipped photo is a sentence, for example
`Photo 3 is not a JPEG, PNG or WebP image` or `Photo 2 is larger than 1 MiB`.

### Metadata removal

The API removes metadata before storing. It does not rely on the source
having re-encoded the image, because a phone photo can carry its GPS position:

- JPEG, by allow-list:
  - keep `APP0` only as a plain JFIF header: an `APP0` that starts with
    `JFIF\0` is rewritten with a thumbnail size of 0×0 and no thumbnail
    bytes; a `JFXX`, any other `APP0`, or a JFIF `APP0` whose content is
    shorter than 14 bytes is dropped. This removes embedded previews of the
    original;
  - keep `APP14` only when it starts with `Adobe` and its content is at
    least 12 bytes (needed for the color transform), cut to those fixed 12
    bytes (`Adobe`, version, two flag words, transform); drop any other
    `APP14`, including a shorter `Adobe` one;
  - drop every other `APPn` segment, which removes EXIF, XMP, MPF, ICC
    profiles and maker data, and every `COM` segment;
  - when the dropped EXIF held an orientation from 2 to 8, write back a
    minimal `APP1` EXIF with only that orientation tag and no other IFD
    entry, so portrait photos keep showing upright;
  - walk the markers through the whole image, also between the scans of a
    progressive JPEG. Keep every marker other than `APPn` and `COM`, among
    them `SOI`, `SOFn`, `DHT`, `DAC`, `DQT`, `DRI`, `DNL`, `SOS` with its
    entropy-coded data, `RSTn` and `EOI`. Every `APPn` and `COM` goes
    through the allow-list above. Cut every byte after the main image's
    `EOI`; this removes appended previews, depth maps and motion-photo
    videos.
- PNG, by allow-list: keep `IHDR`, `PLTE`, `IDAT`, `IEND`, `tRNS`, `gAMA`,
  `cHRM`, `sRGB`, `cICP`, `sBIT`, `pHYs` and `bKGD`; drop every other
  chunk, which removes `eXIf`, `iCCP`, text, time and C2PA chunks. Walk to
  `IEND` and cut every byte after it.
- WebP, by allow-list: keep `VP8 `, `VP8L`, `VP8X` and `ALPH`; drop every
  other chunk, each together with its pad byte when the chunk size is odd,
  which removes `EXIF`, `XMP `, `ICCP` and C2PA chunks. Walk to byte 8 plus
  the RIFF size and cut every byte after it. Clear the ICC (`0x20`), EXIF
  (`0x08`) and XMP (`0x04`) flags in `VP8X` and rewrite the RIFF size to the
  new file length minus 8.
- No format keeps an embedded ICC profile (JPEG `APP2`, PNG `iCCP`, WebP
  `ICCP`). Such a photo is shown as sRGB, or as its PNG `sRGB`, `cICP`,
  `gAMA` and `cHRM` chunks say; this is accepted so that no profile text
  (device, author, copyright) is stored.
- PNG and WebP keep no orientation; their width and height are the raw
  header values.

This is a byte-level cut, not a re-encode, so it needs no image library. The
stored bytes are the stripped bytes.

### Storage and URL

- `map_photo` holds each distinct file once; `sha256` is the hash of the
  stripped bytes. `map_place_photo` orders a place's photos:

  ```sql
  CREATE TABLE IF NOT EXISTS map_photo (
    sha256 TEXT PRIMARY KEY,
    content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
    data BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_place_photo (
    place_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
    sha256 TEXT NOT NULL,
    caption TEXT,
    PRIMARY KEY (place_id, position),
    FOREIGN KEY (place_id) REFERENCES map_place(id) ON DELETE CASCADE,
    FOREIGN KEY (sha256) REFERENCES map_photo(sha256)
  );
  ```

  The second foreign key has no cascade, so a file that a shop still uses
  cannot be deleted.

- `PUT /map/places` keeps the photos. `DELETE /map/places` removes them.
- After `PUT /map/places/photos` and after `DELETE /map/places`, the same
  transaction deletes every `map_photo` row that no `map_place_photo` row of
  any shop uses any more. The same file can belong to several shops, so the
  check runs across all shops.
- Public URL: `GET /map/photos/{sha256}.{jpg|png|webp}`.
  - The extension must match the stored `content_type`, otherwise **404**, so
    each file has exactly one URL.
  - The 200 answer carries the stored `content_type` as `Content-Type` and
    `X-Content-Type-Options: nosniff`, so a browser never reads the bytes as
    another type. A file whose structure walks cleanly but whose image data
    is broken is accepted by design (no decoding, see metadata removal) and
    shows as a broken image.
  - `Cache-Control: public, max-age=31536000, immutable` on 200 only;
    `Cache-Control: no-store` on 404, because the same URL can answer 404
    first and 200 later. A store failure answers **503**
    `{ "error": "Places are unavailable" }` with `Cache-Control: no-store`.
    CORS as the other map routes (origin `*`, methods `GET` and `OPTIONS`).
  - Every photo `url` in a JSON answer is absolute:
    `<OCP_PUBLIC_BASE_URL>/map/photos/{sha256}.{ext}`. `OCP_PUBLIC_BASE_URL`
    is a new environment variable, required from step 2 on: an `https://`
    origin without a trailing slash, `https://api.opencryptopay.io` in
    production and `https://dev-api.opencryptopay.io` on dev. It is not a
    secret and is set in the deployment's environment configuration. The
    process refuses to start without a valid value. The request's `Host`
    header is never used, because a client controls it.
  - A new photo has a new hash and therefore a new URL, so a replaced photo
    never stays stale in a cache.
  - The API serves the file only while a shop in the public list uses it,
    otherwise **404**. A cache that already holds the file keeps its copy
    until it expires; removing a photo does not purge caches.

## Public API

### `GET /map/places`

- `id` is the shop's npub. The internal UUID is no longer returned.
- New field `coverPhoto`: `null`, or `{ "url", "width", "height" }` for the
  first photo.

### `GET /map/places/{npub}`

New. No authentication, CORS as the other map routes (origin `*`, methods
`GET` and `OPTIONS`). `Cache-Control: public, max-age=60` on
200, 301 and 404; `Cache-Control: no-store` on 503.

| Request                                   | Response                                        |
| ----------------------------------------- | ----------------------------------------------- |
| npub of a shop in the public list         | **200** `{ "place": PublicMapPlaceDetail }`     |
| 64 lowercase hex of such a shop           | **301** to `/map/places/{npub}`                 |
| anything else, including an unlisted shop | **404** `{ "error": "Place not found" }`        |
| store failure                             | **503** `{ "error": "Places are unavailable" }` |

`PublicMapPlaceDetail` is the list entry plus `photos`: an array in display
order, each `{ "url", "width", "height", "caption" }` with `caption` `null`
when unset.

## Shop page on opencryptopay.io

These changes are in the website repository, openCryptoPay/landingPage; paths
in this section and the next are paths there. The website is static HTML on an
Apache host. The page needs a small amount of server-side code so that a
shared link shows the shop's name and photo.

- **Route:** a rewrite in `.htaccess` sends `^npub1[02-9ac-hj-np-z]{58}$` and
  `^[0-9a-f]{64}$` to `shop.php`. A trailing slash gets a 301 to the path
  without it, so each shop has one canonical URL. No existing file or folder
  starts with `npub1` or is 64 hex characters long.
- **Hex:** `^[0-9a-f]{64}$` is passed to the API; on its 301 the page answers
  with a 301 to `/{npub}`.
- **Rendering:** `shop.php` calls `GET /map/places/{npub}` with a 3-second
  timeout. The API base is one of two fixed URLs: the dev API when the host
  name is exactly one of the two dev names `ocp-places.js` lists, the
  production API for any other host. The URL is never built from the
  `Host` header. The page writes into the HTML:
  - `<title>`, `description`, `og:title`, `og:description`, `og:image` (cover
    photo, otherwise the site OG image), `twitter:*`;
  - `<link rel="canonical" href="https://opencryptopay.io/{npub}">`;
  - JSON-LD `LocalBusiness` with name, address, geo and image.
- **Encoding:** names, descriptions, addresses and captions are source data
  and may contain `<`, `>`, quotes or `</script>`. `shop.php` escapes every
  value for its context:
  - text and attributes: `htmlspecialchars` with `ENT_QUOTES`;
  - the JSON-LD block: `json_encode` with
    `JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT`;
  - URLs: built from the npub, the photo URLs the API returns and the
    numeric coordinates; shop text put into a query string (the directions
    link) goes through `rawurlencode` first, and every URL then through
    `htmlspecialchars` with `ENT_QUOTES` in its attribute;
  - any other inline data for scripts (the map pin, the gallery) uses the
    same `json_encode` flags as the JSON-LD block, or `data-*` attributes
    escaped with `htmlspecialchars`.

  These rules are the requirement. The fixed sample shop behind the
  baseline has quotes, tags and `</script>` in its name, description,
  address and photo caption. The baseline image only shows that they render
  as text; the change that builds the page also checks the page source of
  that shop and confirms it has no element, attribute or script beyond the
  template's.

- **Statuses:** the API call does not follow redirects. API 200 → the page
  is rendered. API 301 (hex path) → HTTP 301 to `/{npub}`, with the npub
  taken from the redirect target and checked against the npub pattern. API
  404 → HTTP 404 with a shop-not-found page. Any other status, a network
  error, a timeout or an answer that is not valid JSON → HTTP 503 with a
  retry message, never a blank page. Like the API route, the page sends
  `Cache-Control: public, max-age=60` on 200, 301 and 404 and
  `Cache-Control: no-store` on 503.
- **Content:**
  - photo gallery: grid, opens full screen, keyboard and swipe navigation;
  - name and description;
  - full address with a "Directions" link to OpenStreetMap;
  - small MapLibre map with one pin, same tiles as the home page;
  - shop type, tech provider, accepted blockchains and assets;
  - activity in words, for example "Payments in the last 7 days";
  - the npub with a copy button and a link "Open in NOSTR" to
    `https://njump.me/{npub}`. The page reads nothing from NOSTR; what that
    link shows is up to the identity's owner.
- **Check before building:** a probe `.php` file on the dev host must return
  rendered output. If the host does not run PHP, the same page is built as a
  worker in front of the site instead, with the same contract.
- The page uses root-absolute asset paths and copies the shared nav and
  footer, as every page does today.
- Baseline: `baselines/website-shop.png` at 1440 px, rendered against a fixed
  sample shop, so live data never changes it.

## Map and table

- **Map pin:** the popup shows the cover photo (if any), name, category and a
  "Details →" link to `/{npub}`. A click on the pin opens the popup, not the
  page directly, so a phone user can read the popup first.
- **Table** (`stores.html`): the name is a link to `/{npub}`.
- **CSV export:** keeps the visible text of each cell and adds a column `URL`
  with `https://opencryptopay.io/{npub}`.

## Sources

- **21.gifts:** sends the shop's `nostrPubkey` with every place `PUT` and a
  `revision` (R8) with every write. It
  sends the shop note's photos (up to 10, in note order) to
  `PUT /map/places/photos` whenever the photo set differs from the one it
  last sent, and again after the place was deleted and registered anew. It
  generates and maintains those identities itself.
- **DFX.swiss (SPAR):** must create one NOSTR key pair per SPAR shop before
  its next import, keep the secret keys on its side, and send each public key
  as `nostrPubkey`. Photos arrive through the same photo endpoint. Until then
  its shops stay out of the public list.
- Any further source follows the same rules. There is no source without a
  key and no key that OpenCryptoPay creates.

## Order of work

The steps are named by label, in this order:

- **Step 1a, R7 accepted and R8:** `revision` checked and stored;
  `nostrPubkey` accepted, validated, unique and fixed; shops without a key
  are not complete and leave the public list; `id` = npub;
  `GET /map/places/{npub}` without photos. A write without the key is still
  stored, so no source breaks while it adds keys.
- **Step 2, photos:** photo endpoint, photo route, metadata removal,
  `coverPhoto` and `photos`.
- **Step 3, sources,** after steps 1a and 2: 21.gifts sends its keys and
  photos; DFX.swiss creates and sends keys for SPAR.
- **Step 1b, R7 enforced:** once every source sends keys, a write without
  `nostrPubkey` is rejected with **400**.
- **Step 4, website,** any time after step 1a: shop page, map and table
  links. Until step 2 is live the page treats missing `coverPhoto` and
  `photos` as no photos.

Steps 1a, 2 and 1b are each one pull request with handbook entries, e2e tests
and the 100% coverage gate, as in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Not part of this

- Generating, storing or rotating NOSTR keys in OpenCryptoPay.
- Publishing or reading NOSTR profiles, notes or relay lists.
- NIP-05 on `opencryptopay.io`.
- A shop owner uploading or editing photos directly.
- Thumbnails generated on the server.
