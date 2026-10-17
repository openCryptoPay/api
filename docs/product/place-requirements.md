# Place requirements

These are hard requirements for every shop the API serves. They are product
requirements, not a description of the current code. Where the code or the
stored data differ, the requirement wins and the difference is a defect. The
current state is compared in [place-requirements-gap.md](place-requirements-gap.md).

"Shop" means one place in the public list of `GET /map/places`. "Must" means
the API guarantees it for every shop in that list, without exception.

## R1 Activity

Every shop must state how active it is, as exactly one of these levels. The
first level that applies, top to bottom, is the shop's level:

| Level              | Token             | Meaning                                                                  |
| ------------------ | ----------------- | ------------------------------------------------------------------------ |
| daily              | `daily`           | Payments on at least five distinct UTC dates within the last seven.      |
| last 7 days        | `within7Days`     | Not daily, and the latest transaction is at most 7×24 hours old.         |
| last 30 days       | `within30Days`    | The latest transaction is older than 7×24 hours and at most 30×24 hours. |
| older than 30 days | `olderThan30Days` | The latest transaction is older than 30×24 hours.                        |
| never              | `none`            | The shop has never had a transaction.                                    |

- The token is the value of `activity` in `GET /map/places`. The exact
  boundaries are in the [handbook](../handbook/endpoints.md).
- The level is always present. It is never null and never omitted.
- "Never" (`none`) is only for a shop with no transaction at all. A shop with
  an old transaction is "older than 30 days", not "never".

## R2 Address

Every shop must state its exact postal address, written the way a postal
address is correctly written in that country:

- street
- house number
- postal code
- city
- country

Rules:

- All five parts are required. None of them may be empty or null.
- Each part is its own field. The address is not hidden in the shop name, the
  description, or any other field.
- The house number includes its suffix as written on the building, for example
  `1A`.
- The postal code and the city are the official ones for that address.
- The country is an ISO 3166-1 alpha-2 code, for example `CH`.
- Spelling and capitalization follow the official address, for example
  `Maschlinastrasse 4, 9495 Triesen, LI`. Landmarks, directions, or notes such
  as "next to the chapel" are not an address and do not belong in these fields.

## R3 GPS coordinates

Every shop must state its GPS coordinates:

- latitude and longitude in WGS 84 decimal degrees
- both are required and never null
- they point at the shop at the address of R2

## R4 Name and description

Every shop must have both:

- **Name:** a short, concise name that says what the shop is, for example
  `SPAR Triesen`. It is required. It is not the address, and it does not repeat
  the street or postal code.
- **Description:** a longer text that describes the shop in more detail than
  the name. It is required and is never empty or null.

## R5 Shop type

In addition to the name, every shop must have its own field that states the
shop type:

- The field is required and is never null.
- The allowed values are exactly `SPAR` and `Others`, for now.
- The value set is an enum. It will be extended with further values later.
  Adding a value must not change the meaning of `SPAR` or `Others`.
- The shop type is independent of the name. It is never derived from the name
  text, and the name is never derived from it.

## R6 Enforcement at registration

The API must enforce R2 to R5 on its sources. Today the sources are DFX.swiss
and 21.gifts. The same rules apply to both, and to any later source.

- Registering a shop that does not deliver every required field of R2 to R5
  in the expected quality is forbidden. The API rejects the request with an
  error and stores nothing.
- The same holds for an update. An update that would leave a shop without a
  required field, or with a field below the expected quality, is rejected and
  the stored shop stays unchanged.
- A missing field is never filled with a default, a guess, or a value derived
  from another field.
- The source supplies the data of R2 to R5. The API derives the activity of
  R1 from the transactions it records. A source cannot set the activity.
- A shop already stored that does not meet R2 to R5 is not served in the public
  list until its source delivers the complete data.
