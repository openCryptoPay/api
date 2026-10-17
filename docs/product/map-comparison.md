# How the place maps differ

What the five known place maps share, and where they diverge. Where each one
is shown is [maps.md](maps.md). This is a product note, not the API reference.

Compared on 2026-10-12 from the `develop` commits below. A later commit can
move a client without this note changing.

| Client                | Repository                  | Commit                                     |
| --------------------- | --------------------------- | ------------------------------------------ |
| OpenCryptoPay website | `openCryptoPay/landingPage` | `4fcfdc8edda1869e5949ab56c94c9bc35172a856` |
| RealUnit website      | `RealUnitCH/web`            | `ddd2d12b3cb10c28efafbc68e5b2f36a765be0d4` |
| DFX app, SPAR payment | `DFXswiss/app`              | `b9e403131a1c4090bdb59ecf5212870adfe2e1b8` |
| RealUnit app          | `RealUnitCH/app`            | `3a330fcbc61099d04e7bd05540776e29fd59d61a` |
| 21.gifts              | `21gifts/app`               | `518a7844ad9128e290320be330840454efd9ba96` |

Files: `js/ocp-places.js` and `css/ocp-places.css`; `public/pay/pay.js`,
`public/js/lib/pay-places-core.js`, and the pin style in `public/pay/index.html`;
`src/components/payment/spar-place-map.tsx`; `lib/screens/pay/pay_locations_page.dart`
and `lib/screens/pay/pay_locations.dart`; `src/components/PlacesMapScreen.tsx`.

## Release branches

`main` of the website (`f5b2316540cb59f37ee1f5b8ed7cd300865a875a`) is the same
street map and the same hostname gate, with only a tech-provider control built
from the loaded places. It does not request `/map/filters` and has no country,
name, blockchain, or asset control. Those controls are on `develop`.

The RealUnit website pages are not on `main` (`ad4271104bfa402cadb995f1160a5c0d0de7b660`
has no `public/pay/pay.js`). The DFX SPAR map is not on `main`. The RealUnit
app screen is not on `main`. The two app files above match on `staging`
(`713bc0ffd6bc0f5bc89b9111bbe46af71d48a97d`) and on `develop`. The 21.gifts
file has the same contents on `main` and on `develop`.

## What all five share

Each one draws places as points. The shop name can be read once a place is
chosen. Where that name sits is not the same: a map popup on the OpenCryptoPay
website and on the DFX page, a card under the map on the RealUnit website, the
outline and the list under the map in the RealUnit app, and the list under the
map on 21.gifts.

That is the whole overlap. They do not share a renderer, a tile source, a
place list, a pin, a filter, or a camera frame.

Three of them are the OpenCryptoPay street map. The RealUnit app is an outline
of Switzerland. 21.gifts is a Google map of its own member shops.

## What the three street maps share

The OpenCryptoPay website, the RealUnit website, and the DFX SPAR payment page:

- Draw OpenFreeMap Liberty with MapLibre. The style URL is
  `https://tiles.openfreemap.org/styles/liberty`.
- Open at longitude 8.23, latitude 46.8, zoom 7, with the zoom control at the
  top right.
- Read the OpenCryptoPay place list with `credentials: 'omit'`. The body is an
  object with a `places` array. A point needs a finite latitude and longitude.
- Draw one marker per kept place. None of them draws a numbered cluster.
- Show the place name, and the category when the place has one, after the
  visitor selects a point.
- Frame several places with `fitBounds` and a maximum zoom of 12. One place is
  shown at zoom 12.

The website on `opencryptopay.io` and `www.opencryptopay.io` calls
`https://api.opencryptopay.io`. On `dev.opencryptopay.io` and
`www.dev.opencryptopay.io` it calls `https://dev-api.opencryptopay.io`. The
RealUnit website, the RealUnit app, and the DFX app always call
`https://api.opencryptopay.io`. Any other hostname on the OpenCryptoPay website
keeps the embedded Google My Map and does not draw the street map.

## Where they differ

### Which places are requested

| Client                | Request                                                           |
| --------------------- | ----------------------------------------------------------------- |
| OpenCryptoPay website | `GET /map/places` plus the selected query, and `GET /map/filters` |
| RealUnit website      | `GET /map/places?blockchain=Ethereum&asset=ZCHF` only             |
| RealUnit app          | the same Ethereum and ZCHF URL as the RealUnit website            |
| DFX SPAR page         | `GET /map/places?shopName=SPAR&country=CH` only                   |
| 21.gifts              | its own signed-in shop list, not the OpenCryptoPay place list     |

The RealUnit pages and the DFX page do not call `/map/filters`. The DFX page
mounts the map only when the payment merchant is SPAR. 21.gifts loads a Google
Maps key from its own `GET /maps/key`.

The website then drops a returned place that does not match the selection. A
missing country is not the selected country. A missing shop name is not SPAR.
The name value `others` keeps every place that is not SPAR. A blank
`techProvider` is treated as `DFX.swiss`. The tech-provider control starts at
All and only shows or hides markers already drawn. Country, name, blockchain,
and asset each load the list again.

### Payment rows

On the website, payment is filtered only when a blockchain or an asset is
selected. A non-empty `supports` array must contain a matching pair. A value
that is present and not an array is dropped. A missing `supports` value, and
an empty array, follow the catalog `/map/filters` published for that provider
(`21.gifts`, otherwise `DFX.swiss`). A missing catalog is not a match.

On the RealUnit website and in the RealUnit app the rule is different. A
missing `supports` value is kept. A present list must include blockchain
`Ethereum` and asset `ZCHF` exactly. An empty list, a non-array, and any other
pair are dropped. Country is not read and is not inferred. The app applies the
same keep rule as the website, then a text search over the places already
loaded.

The DFX page does not read `supports`. It keeps a place only when `shopName`
is `SPAR`, `country` is `CH`, and both coordinates are finite. It does not
require a name.

21.gifts does not read this place list.

### Pins and the shop name

| Client                | Pin                                                               | Where the name appears                                                       |
| --------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| OpenCryptoPay website | 14px circle, `#d23b3b`, 2px white border                          | MapLibre popup, offset 16. No selected ring.                                 |
| RealUnit website      | the same 14px circle, anchor center                               | Card under the map. A selected pin keeps the red fill and gains a blue ring. |
| DFX SPAR page         | 28×36 teardrop, fill `#C8102E`, white inner circle, anchor bottom | MapLibre popup, offset 18, with a close button.                              |
| RealUnit app          | red circle, 16px, 2px white border                                | On the outline and in the shop list under the map.                           |
| 21.gifts              | default Google marker                                             | In the list. The marker has no popup.                                        |

The website marker uses the library default anchor. A place with no name is
labeled `Location` and still drawn. The RealUnit website drops a place with no
name. Its selected pin adds a blue ring (`#1988C6`) and does not open a card
until a pin is clicked. The live list does not select the first pin.

The RealUnit app takes the selected shop out of the cluster and draws it at
18px with a 3px white border. One loaded shop starts selected. Tapping a shop
in the list or on the map selects it. The list splits a name on its last
comma into the street and the place, and shows the street only when that
comma is there. The map and the list share the flexible height, three parts
to two, with the search field and the count between them. The search keeps
pins whose name contains the query.

21.gifts keeps the list when the map is drawn. A moderator can edit a shop
pin. A chosen `pin` query bolds that row.

### Clusters

Only the RealUnit app groups nearby shops. A group of two or more is a
numbered dark-blue circle, 34px, with a white border. Opening it frames that
group at a maximum zoom of 14. The three street maps and the 21.gifts map draw
every kept place as its own marker.

### Camera

The street maps share the start view and the zoom cap of 12 described above.
Padding differs. The website and the RealUnit website use 48 on every side.
The DFX page uses 48 on the top and right and 40 on the bottom and left. The
website leaves the fit animation on. The RealUnit website and the DFX page
turn it off. One place on the website and on the DFX page is centered and set
to zoom 12. One place on the RealUnit website uses `jumpTo` at zoom 12.

The RealUnit app starts from the same point and zoom, then fits the country
outline with 28px of padding. Zoom stays between 5 and 16. A search with
several matches fits those matches at a maximum zoom of 12 and 36px of
padding. A search that leaves one shop uses zoom 12. A single loaded shop
stays on the country view until a search or a tap. A tap uses zoom 13. The
country fill is white. Lakes use the map background color. There are no
street tiles. City names are drawn at zoom 9 and when zoomed further out.

21.gifts, with more than one shop and no chosen pin, starts at zoom 2, fits
the shops with 32px of padding, and if that fit is closer than zoom 14 sets
the zoom back to 14. One shop, or the shop named by the `pin` query, is shown
at zoom 14.

### When the list does not load

| Client                | Failed list                                   | Empty list                                    |
| --------------------- | --------------------------------------------- | --------------------------------------------- |
| OpenCryptoPay website | the street map stays, with a note on the map  | the street map stays, with a note             |
| RealUnit website      | the map is hidden and an error state is shown | the map is hidden and an empty state is shown |
| DFX SPAR page         | the map is replaced by an error message       | the street map stays, with a note over it     |
| RealUnit app          | an error message, no outline                  | the outline stays, with a card over it        |
| 21.gifts              | an error message and a retry, no map          | text only, no map                             |

The RealUnit website aborts the request after 15 seconds. The RealUnit app
aborts after 20 seconds. The website and the DFX page set no timeout in the
page. A failed map script on the website sets the same note. On 21.gifts a
failed map script leaves the list usable, and a missing key leaves the list
without a map.

The RealUnit website does not treat a MapLibre error as a failed page. That
event also fires when one tile fails and the map is still drawn. The page
already has an error state for a place list that did not load.

### Controls and language

The RealUnit website is the only street map that sets a MapLibre locale. The
German page names the controls Karte, Vergrössern, Verkleinern, Norden
ausrichten, and Quellen einblenden. The English page sets the library's own
English strings. The OpenCryptoPay website and the DFX page pass no locale, so
the controls stay the library English defaults.

The RealUnit website and the DFX page set `fadeDuration` to 0 and
`preserveDrawingBuffer`. The OpenCryptoPay website sets neither. The DFX page
sets the MapLibre worker URL because its build would otherwise point the
worker at a file that never loads. The two websites load MapLibre as a page
script and do not set a worker URL.

The RealUnit app draws its own zoom-in and zoom-out buttons. It has no
north control. 21.gifts leaves the default Google Maps controls in place.
