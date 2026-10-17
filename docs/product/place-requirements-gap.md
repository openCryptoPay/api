# Place requirements: target and current state

This note compares the [place requirements](place-requirements.md) (target)
with the current state. It was checked on 2026-10-16 against:

- code: `develop` at `707b349`
- production: `api.opencryptopay.io`, image built from `e603b76a` (#17), which
  does not contain #18 (street, house number, postal code, and city fields)
  or #19 (the `daily` and `olderThan30Days` activity levels)
- development: `dev-api.opencryptopay.io`, image `beta` built from `develop`
- live data: `GET /map/places` on both hosts, all rows

Every row below that is not "met" is a defect against the requirements.

## Summary

| Req | Topic             | Code on `develop`                     | Production | Data                | Sources |
| --- | ----------------- | ------------------------------------- | ---------- | ------------------- | ------- |
| R1  | Activity          | met                                   | not met    | unknown (see R1)    | partly  |
| R2  | Address           | met                                   | not met    | 0 of 193 complete   | not met |
| R3  | GPS coordinates   | met except coordinates at the address | partly     | 193 of 193 present  | partly  |
| R4  | Name, description | met                                   | not met    | 0 of 193 described  | not met |
| R5  | Shop type         | met                                   | not met    | no enum (see R5)    | not met |
| R6  | Enforcement       | met except coordinates at the address | not met    | 193 of 193 accepted | n/a     |

## Live data

Counts of rows with a non-empty value, per origin.

| Field                                         | Prod `spar` (170) | Prod `21gifts` (23) | Dev `spar` (170) | Dev `21gifts` (21) |
| --------------------------------------------- | ----------------- | ------------------- | ---------------- | ------------------ |
| `street`, `houseNumber`, `postalCode`, `city` | field absent      | field absent        | 0                | 0                  |
| `country`                                     | 170               | 4                   | 170              | 21                 |
| `lat`, `lon`                                  | 170               | 23                  | 170              | 21                 |
| description                                   | field absent      | field absent        | field absent     | field absent       |
| `shopName`                                    | 170 (`SPAR`)      | 0                   | 170 (`SPAR`)     | 0                  |
| name contains a 4-digit postal code           | 170               | 0                   | 170              | 0                  |

Activity on production: `spar` 170 `none`; `21gifts` 20 `within7Days`, 3
`none`. Activity on development: every row `none`.

Name examples: `SPAR Maschlinastrasse 4, 9495 Triesen` (`spar`) and
`Sta. Bakhita st. Happy land tondo ( Infront of the chapel )` (`21gifts`).

## R1 Activity

- **Target:** one of daily, last 7 days, last 30 days, older than 30 days,
  never; always present.
- **Code:** met. `activity` is always one of `daily`, `within7Days`,
  `within30Days`, `olderThan30Days`, `none` (`src/lib/map/place.ts`,
  `placeActivity`). `daily` is defined as at least five distinct UTC payment
  dates within the last seven UTC dates. A source cannot set it. A stored
  transaction time that cannot be parsed is classified `none` unless the row
  is `daily`, and that row is not public until the instant is parseable or
  null.
- **Production:** not met. It runs `e603b76a`, which only knows
  `within7Days`, `within30Days`, and `none`. `daily` and `olderThan30Days` are
  missing, so an old transaction shows as `none`.
- **Data:** unknown. Production shows `none` for all 170 SPAR rows and 3
  21.gifts rows, and development shows `none` for every row. `none` is correct
  only if those shops never had a transaction, which is not established.
- **Sources:** both report transactions through
  `POST /map/places/transactions`. On development, which has all five levels,
  all 170 SPAR rows show `none`, so no usable SPAR transaction time is stored
  there: either none has been reported or reports do not reach these rows.
  Which of the two is not established. On production, `none` also covers an
  old transaction and proves nothing.

## R2 Address

- **Target:** street, house number, postal code, city, country; all required,
  each its own field, official spelling.
- **Code:** met. `street`, `houseNumber`, `postalCode`, `city`, and `country`
  are required on every `POST` and `PUT /map/places` (`normalizeMapPlace` in
  `src/lib/map/place.ts`). A rejected body stores nothing. `PUT` is a full
  replace (`src/lib/map/store.ts`, `src/lib/map/sqlite.ts`). Incomplete
  stored rows are not public. Country is not derived from the name.
- **Production:** not met. `street`, `houseNumber`, `postalCode`, and `city`
  do not exist in the response. `country` does: 170 of 170 SPAR rows and 4 of
  23 21.gifts rows have one.
- **Data:** no row has a street, house number, postal code, or city. The SPAR
  address is only inside `name`. The 21.gifts names are free text with
  landmarks, not addresses.
- **DFX.swiss:** does not send any address. Its payment backend calls only
  `POST /map/places/transactions`. The 170 SPAR rows were registered by a
  manual import that accepts `origin`, `externalId`, `name`, `lat`, `lon`,
  `category`, `techProvider`, `paymentMethods`, and `country` and rejects any
  other key, so it cannot send `street`, `houseNumber`, `postalCode`, or
  `city` either. DFX.swiss does hold
  a structured merchant address for a payment link but does not send it.
- **21.gifts:** sends `origin`, `externalId`, `name`, `lat`, `lon`,
  `category`, `paymentMethods`, and `techProvider`. It sends no address part,
  including no `country`, and holds no structured address for a shop. On
  production, 4 of its rows have a `country` from the fixed name table. On
  development, all 21 of its rows have one; how those values got there is not
  established.

## R3 GPS coordinates

- **Target:** latitude and longitude, required, at the shop.
- **Code:** met for required in-range coordinates rounded to six decimal
  places. Whether the point lies at the R2 address is the source's
  responsibility (user decision 2026-10-16); the API does not derive or check
  that.
- **Data:** every row on both hosts has both. Whether each point lies at the
  shop is not checked.
- **Sources:** both send coordinates. Neither ties them to an address.

## R4 Name and description

- **Target:** a short descriptive name without the address, and a longer
  description; both required.
- **Code:** met. `name` is required, 1 to 80 characters. The name must not
  contain the street as a whole word. It must not contain the postal code as a
  standalone token. `description` is required, 20 to 1000 characters, longer
  than the name and not equal to it, and is stored and returned.
- **Data:** all 170 SPAR names are `SPAR` plus the full address. 21.gifts names
  are the pin label, the author name, or `Shop`, cut to 80 characters.
- **Sources:** neither sends a description. 21.gifts has the shop post text,
  which it does not send. DFX.swiss has no description field for a shop.

## R5 Shop type

- **Target:** its own required enum field, values `SPAR` and `Others` for
  now, extensible, independent of the name.
- **Code:** met. `shopType` is a required enum, `SPAR` or `Others`. The query
  filter and `shopTypes` of `GET /map/filters` use the same values. For one
  release, `shopName` remains a query alias (`SPAR` / `others`) and a
  read-only response field derived from `shopType`. Shop type is not derived
  from origin or name.
- **Data:** no shop-type enum exists. `shopName` is `SPAR` on 170 rows and
  null on 23 (prod) and 21 (dev) rows.
- **Sources:** neither sends a shop type.

## R6 Enforcement at registration

- **Target:** a registration or an update whose resulting stored shop lacks a
  field of R2 to R5, or has one below the expected quality, is rejected. A
  rejected registration stores nothing, and a rejected update leaves the
  stored shop unchanged. Incomplete stored rows are not public.
- **Code:** met, except that coordinates lying at the address is the
  source's responsibility (user decision 2026-10-16). `POST` and
  `PUT /map/places` reject a shop that lacks name, description, shop type,
  any address part, or coordinates, and store nothing on 400. `PUT` is a full
  replace. Unknown keys including `shopName` are rejected. Incomplete stored
  rows are not public. No stored field is derived from another field; the
  response field `shopName` is a read-only alias of `shopType` kept for one
  release.
- **Data:** every one of the 193 production rows was accepted without a
  complete address, description, or shop type.

## What closes the gap

1. API: done on this branch, except that coordinates lying at the address is
   the source's responsibility (user decision 2026-10-16). The API requires
   description, shop type (`SPAR`, `Others`), every address part, and
   coordinates; rejects a failed `POST` or `PUT /map/places` without storing;
   does not derive `country` or shop type; and leaves incomplete stored rows,
   including an unparseable transaction time, out of `GET /map/places`.
2. DFX.swiss: send a short descriptive name without the address, a
   description, the shop type, the full address, and coordinates for every
   SPAR shop through `PUT /map/places`.
3. 21.gifts: collect a descriptive name without the address, a structured
   address, and a description for every shop, and send them with the shop
   type.
4. Production: release `develop` so that R1 is served with all five levels.
   The release stores at most one payment date per shop: the UTC date of its
   latest transaction, and only if that date lies within the last seven.
   `daily` needs five distinct payment dates in that window, so a shop needs
   four more payment dates while the stored date stays in the window, and five
   otherwise.

Until steps 2 and 3 are done, step 1 removes every current shop from the
public list.
