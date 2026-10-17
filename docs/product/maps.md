# Place maps

Where a map of places is known to be shown, checked on 2026-10-12. This is an
inventory of clients, not a proof that no other client exists, and not the API
reference. Branch facts below are the GitHub branches on that date.

The street map is OpenFreeMap Liberty drawn with MapLibre. The other sections
are different maps and are named as such. How the implementations compare is
[map-comparison.md](map-comparison.md).

## Street map

### OpenCryptoPay website

Repository: `openCryptoPay/landingPage`.

On `opencryptopay.io`, `www.opencryptopay.io`, `dev.opencryptopay.io`, and
`www.dev.opencryptopay.io`, the homepage replaces the embedded Google My Map
with the street map of the published place list. Any other hostname keeps the
Google My Map. That behavior is on `main` and on `develop`.

### RealUnit website

Repository: `RealUnitCH/web`.

`/pay/` is the German page and `/pay/en/` is the English page. Both draw the
street map of the published shops. The homepage does not link to either page.
The pages are on `develop`. They are not on `main`.

### DFX app

Repository: `DFXswiss/app`.

The SPAR payment page draws the street map when the merchant is SPAR. The pins
are SPAR places in Switzerland. The map component is on `develop`. It is not
on `main`.

## Outline map

### RealUnit app

Repository: `RealUnitCH/app`.

The pay-info screen links to `/payLocations`. That screen draws a white outline
of Switzerland, with lakes and pins. It does not use the street map. The screen
is on `develop`. It is not on `main`.

## Google Maps

### 21.gifts

Repository: `21gifts/app`.

`/shops#map` draws member shops with Google Maps. It does not use the
OpenCryptoPay street map. The same file is on `develop` and on `main`.

## Not a drawn map

This repository, `openCryptoPay/api`, stores and serves the place list. It does
not draw a map.
