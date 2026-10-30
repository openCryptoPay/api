import { describe, expect, it } from 'vitest';
import { publicPlaceSupports } from '@/lib/map/filter-catalog';
import googleMapsSeed from '@/lib/map/google-maps-seed.json' with { type: 'json' };
import { npubDecode } from '@/lib/map/nostr-key';
import {
  isGoogleMapsUrl,
  normalizeMapPlace,
  normalizeMapPlaceDelete,
  normalizeMapPlaceFilter,
  normalizeMapPlaceKey,
  normalizePlaceOrigin,
  normalizePlaceTransaction,
  placeActivity,
  toPublicMapPlace,
} from '@/lib/map/place';
import type { StoredMapPlace } from '@/lib/map/place';

const DESCRIPTION =
  'SPAR supermarket in Triesen. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';

const KEY = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';

const valid = {
  origin: 'dfx',
  externalId: 'store-1',
  name: 'SPAR Triesen',
  description: DESCRIPTION,
  lat: 47.37,
  lon: 8.54,
  category: 'groceries',
  paymentMethods: 'lightning',
  shopType: 'SPAR',
  street: 'Maschlinastrasse',
  houseNumber: '4',
  postalCode: '9495',
  city: 'Triesen',
  country: 'LI',
  nostrPubkey: KEY,
};

describe('normalizePlaceOrigin', () => {
  it('trims a valid origin', () => {
    expect(normalizePlaceOrigin(' spar ')).toEqual({ ok: true, value: 'spar' });
  });

  it('trims an origin that starts with a digit', () => {
    expect(normalizePlaceOrigin(' 21gifts ')).toEqual({ ok: true, value: '21gifts' });
  });

  it('accepts a 32-character origin that starts with a digit', () => {
    const origin = '2' + 'a'.repeat(31);
    expect(normalizePlaceOrigin(origin)).toEqual({ ok: true, value: origin });
  });

  it('rejects SPAR and any other invalid value', () => {
    expect(normalizePlaceOrigin('SPAR')).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceOrigin(1)).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceOrigin('')).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceOrigin('2' + 'a'.repeat(32))).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceOrigin('-a')).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceOrigin('21.gifts')).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceOrigin('21Gifts')).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceOrigin('   ')).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
  });
});

describe('normalizeMapPlace', () => {
  it('rejects a non-object and an array', () => {
    expect(normalizeMapPlace(null)).toEqual({
      ok: false,
      error: 'Place must be a latitude and longitude',
    });
    expect(normalizeMapPlace([])).toEqual({
      ok: false,
      error: 'Place must be a latitude and longitude',
    });
    expect(normalizeMapPlace('x')).toEqual({
      ok: false,
      error: 'Place must be a latitude and longitude',
    });
  });

  it('rejects the first unknown key in Object.keys order', () => {
    expect(normalizeMapPlace({ shopName: 'SPAR', extra: 1, ...valid })).toEqual({
      ok: false,
      error: 'Place field is not allowed: shopName',
    });
    expect(normalizeMapPlace({ ...valid, extra: 1 })).toEqual({
      ok: false,
      error: 'Place field is not allowed: extra',
    });
    expect(
      normalizeMapPlace({
        ...valid,
        address: { street: 'Bahnhofstrasse' },
      }),
    ).toEqual({
      ok: false,
      error: 'Place field is not allowed: address',
    });
    const longKey = 'k'.repeat(60);
    expect(normalizeMapPlace({ ...valid, [longKey]: 1 })).toEqual({
      ok: false,
      error: `Place field is not allowed: ${'k'.repeat(40)}`,
    });
  });

  it('rejects coordinates that are not finite numbers in range', () => {
    expect(normalizeMapPlace({ ...valid, lat: '47' }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, lon: Number.NaN }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, lat: 91 }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, lon: -181 }).ok).toBe(false);
  });

  it('rounds coordinates, trims the origin, and drops an unknown payment list', () => {
    const result = normalizeMapPlace({
      ...valid,
      origin: ' dfx ',
      lat: 47.1234567,
      lon: -0,
      paymentMethods: 'cash',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...valid,
        lat: 47.123457,
        lon: 0,
        paymentMethods: null,
        supports: [],
      },
    });
  });

  it('keeps a known payment list and ignores a non-string', () => {
    const kept = normalizeMapPlace({ ...valid, paymentMethods: ' onchain,lightning ' });
    expect(kept.ok && kept.value.paymentMethods).toBe('onchain,lightning');
    const ignored = normalizeMapPlace({ ...valid, paymentMethods: 1 });
    expect(ignored.ok && ignored.value.paymentMethods).toBeNull();
    const blank = normalizeMapPlace({ ...valid, paymentMethods: '  ' });
    expect(blank.ok && blank.value.paymentMethods).toBeNull();
  });

  it('rejects a bad origin, external id, name, and category', () => {
    expect(normalizeMapPlace({ ...valid, origin: 1 }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, origin: 'DFX' }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, externalId: 1 }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, externalId: '' }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, externalId: 'a'.repeat(81) }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, externalId: 'bad\nid' }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, name: 1 }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, name: ' ' }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, name: 'n'.repeat(81) }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, name: 'bad\u007fname' }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, category: 1 }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, category: 'Cafe' }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, category: '' }).ok).toBe(false);
  });

  it('rejects a name that contains a standalone postal code', () => {
    expect(normalizeMapPlace({ ...valid, name: 'SPAR 9495' })).toEqual({
      ok: false,
      error: 'Place name must not contain the address',
    });
    expect(normalizeMapPlace({ ...valid, name: 'Shop (9495)' })).toEqual({
      ok: false,
      error: 'Place name must not contain the address',
    });
  });

  it('accepts a name that contains the street', () => {
    const fullStreet = normalizeMapPlace({ ...valid, name: 'SPAR Maschlinastrasse' });
    expect(fullStreet.ok && fullStreet.value.name).toBe('SPAR Maschlinastrasse');
    const lowerStreet = normalizeMapPlace({ ...valid, name: 'near maschlinastrasse' });
    expect(lowerStreet.ok && lowerStreet.value.name).toBe('near maschlinastrasse');
    const shortStreet = normalizeMapPlace({ ...valid, name: 'SPAR Dorf 3', street: 'Dorf' });
    expect(shortStreet.ok && shortStreet.value.name).toBe('SPAR Dorf 3');
    const zurich = normalizeMapPlace({
      ...valid,
      name: 'SPAR Zürich Schaffhauserstrasse',
      street: 'Schaffhauserstrasse',
      city: 'Zürich',
      postalCode: '8057',
    });
    expect(zurich.ok && zurich.value.name).toBe('SPAR Zürich Schaffhauserstrasse');
  });

  it('accepts a name that only shares a street prefix or a longer postal code', () => {
    const village = normalizeMapPlace({
      ...valid,
      name: 'SPAR Dorfladen',
      street: 'Dorf',
    });
    expect(village.ok && village.value.name).toBe('SPAR Dorfladen');
    const longerPostal = normalizeMapPlace({ ...valid, name: 'SPAR 94950' });
    expect(longerPostal.ok && longerPostal.value.name).toBe('SPAR 94950');
    const gluedPostal = normalizeMapPlace({ ...valid, name: 'Shop9495' });
    expect(gluedPostal.ok && gluedPostal.value.name).toBe('Shop9495');
    const dottedStreet = normalizeMapPlace({
      ...valid,
      name: 'SPAR St. Gallen',
      street: 'St. Gallerstrasse',
    });
    expect(dottedStreet.ok && dottedStreet.value.name).toBe('SPAR St. Gallen');
  });

  it('omits an absent, null, or trim-empty tech provider', () => {
    const absent = normalizeMapPlace(valid);
    expect(absent.ok && absent.value.techProvider).toBeUndefined();
    const missing = normalizeMapPlace({ ...valid });
    expect(missing.ok && !('techProvider' in missing.value)).toBe(true);
    const nulled = normalizeMapPlace({ ...valid, techProvider: null });
    expect(nulled.ok && nulled.value.techProvider).toBeUndefined();
    const blank = normalizeMapPlace({ ...valid, techProvider: '  ' });
    expect(blank.ok && blank.value.techProvider).toBeUndefined();
  });

  it('stores a trimmed tech provider and accepts 21.gifts', () => {
    const trimmed = normalizeMapPlace({ ...valid, techProvider: ' DFX.swiss ' });
    expect(trimmed).toEqual({
      ok: true,
      value: { ...valid, techProvider: 'DFX.swiss', supports: [] },
    });
    const gifts = normalizeMapPlace({ ...valid, techProvider: '21.gifts' });
    expect(gifts.ok && gifts.value.techProvider).toBe('21.gifts');
    const max = normalizeMapPlace({ ...valid, techProvider: `A${'a'.repeat(39)}` });
    expect(max.ok && max.value.techProvider).toBe(`A${'a'.repeat(39)}`);
  });

  it('rejects a non-string or invalid tech provider', () => {
    expect(normalizeMapPlace({ ...valid, techProvider: 1 })).toEqual({
      ok: false,
      error: 'Place tech provider is invalid',
    });
    expect(normalizeMapPlace({ ...valid, techProvider: true })).toEqual({
      ok: false,
      error: 'Place tech provider is invalid',
    });
    expect(normalizeMapPlace({ ...valid, techProvider: 'bad provider' })).toEqual({
      ok: false,
      error: 'Place tech provider is invalid',
    });
    expect(normalizeMapPlace({ ...valid, techProvider: '-leading' })).toEqual({
      ok: false,
      error: 'Place tech provider is invalid',
    });
    expect(normalizeMapPlace({ ...valid, techProvider: `A${'a'.repeat(40)}` })).toEqual({
      ok: false,
      error: 'Place tech provider is invalid',
    });
  });

  it('requires a country and stores a trimmed lowercase code as uppercase', () => {
    expect(normalizeMapPlace({ ...valid, country: undefined })).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: null })).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    const trimmed = normalizeMapPlace({ ...valid, country: ' ch ', postalCode: '8001' });
    expect(trimmed.ok && trimmed.value.country).toBe('CH');
    for (const country of ['LI', 'DE', 'AT', 'FR', 'IT', 'PH']) {
      const postalCode = country === 'LI' ? '9495' : '10115';
      const result = normalizeMapPlace({ ...valid, country, postalCode });
      expect(result.ok && result.value.country).toBe(country);
    }
  });

  it('rejects Switzerland, C, empty, CHE, ZZ, and a non-string country', () => {
    expect(normalizeMapPlace({ ...valid, country: 'Switzerland' })).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: 'C' })).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: '' })).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: 'CHE' })).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: 'ZZ' })).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: 1 })).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
  });

  it('requires shopType SPAR or Others and rejects the old shop name values', () => {
    const others = normalizeMapPlace({ ...valid, shopType: 'Others' });
    expect(others.ok && others.value.shopType).toBe('Others');
    const trimmedSpar = normalizeMapPlace({ ...valid, shopType: ' SPAR ' });
    expect(trimmedSpar.ok && trimmedSpar.value.shopType).toBe('SPAR');
    expect(normalizeMapPlace({ ...valid, shopType: 'others' })).toEqual({
      ok: false,
      error: 'Place shop type is invalid',
    });
    expect(normalizeMapPlace({ ...valid, shopType: 'Migros' })).toEqual({
      ok: false,
      error: 'Place shop type is invalid',
    });
    expect(normalizeMapPlace({ ...valid, shopType: '' })).toEqual({
      ok: false,
      error: 'Place shop type is invalid',
    });
    expect(normalizeMapPlace({ ...valid, shopType: 1 })).toEqual({
      ok: false,
      error: 'Place shop type is invalid',
    });
  });

  it('stores trimmed address parts and a house-number suffix', () => {
    const result = normalizeMapPlace({
      ...valid,
      country: 'DE',
      street: ' Bahnhofstraße  ',
      houseNumber: ' 12a-B ',
      postalCode: ' 10115 ',
      city: ' Zürich ',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...valid,
        country: 'DE',
        street: 'Bahnhofstraße',
        houseNumber: '12a-B',
        postalCode: '10115',
        city: 'Zürich',
        supports: [],
      },
    });
    const maxStreet = normalizeMapPlace({ ...valid, street: 's'.repeat(120) });
    expect(maxStreet.ok && maxStreet.value.street).toBe('s'.repeat(120));
    const maxCity = normalizeMapPlace({ ...valid, city: `${'c'.repeat(79)}a` });
    expect(maxCity.ok && maxCity.value.city).toBe(`${'c'.repeat(79)}a`);
    const house = normalizeMapPlace({ ...valid, houseNumber: '1A' });
    expect(house.ok && house.value.houseNumber).toBe('1A');
    const slash = normalizeMapPlace({ ...valid, houseNumber: '12/1' });
    expect(slash.ok && slash.value.houseNumber).toBe('12/1');
    const range = normalizeMapPlace({ ...valid, houseNumber: '1–3' });
    expect(range.ok && range.value.houseNumber).toBe('1–3');
    const ampersand = normalizeMapPlace({ ...valid, houseNumber: '6&8' });
    expect(ampersand.ok && ampersand.value.houseNumber).toBe('6&8');
  });

  it('rejects a non-string, blank, too long, or control street', () => {
    expect(normalizeMapPlace({ ...valid, street: 1 })).toEqual({
      ok: false,
      error: 'Place street is invalid',
    });
    expect(normalizeMapPlace({ ...valid, street: true })).toEqual({
      ok: false,
      error: 'Place street is invalid',
    });
    expect(normalizeMapPlace({ ...valid, street: '' })).toEqual({
      ok: false,
      error: 'Place street is invalid',
    });
    expect(normalizeMapPlace({ ...valid, street: '  ' })).toEqual({
      ok: false,
      error: 'Place street is invalid',
    });
    expect(normalizeMapPlace({ ...valid, street: 's'.repeat(121) })).toEqual({
      ok: false,
      error: 'Place street is invalid',
    });
    expect(normalizeMapPlace({ ...valid, street: 'bad\nstreet' })).toEqual({
      ok: false,
      error: 'Place street is invalid',
    });
    expect(normalizeMapPlace({ ...valid, street: 'bad\u007fstreet' })).toEqual({
      ok: false,
      error: 'Place street is invalid',
    });
  });

  it('rejects an invalid house number', () => {
    expect(normalizeMapPlace({ ...valid, houseNumber: 1 })).toEqual({
      ok: false,
      error: 'Place house number is invalid',
    });
    expect(normalizeMapPlace({ ...valid, houseNumber: '' })).toEqual({
      ok: false,
      error: 'Place house number is invalid',
    });
    expect(normalizeMapPlace({ ...valid, houseNumber: '  ' })).toEqual({
      ok: false,
      error: 'Place house number is invalid',
    });
    expect(normalizeMapPlace({ ...valid, houseNumber: 'A1' })).toEqual({
      ok: false,
      error: 'Place house number is invalid',
    });
    expect(normalizeMapPlace({ ...valid, houseNumber: '4,'.repeat(20) })).toEqual({
      ok: false,
      error: 'Place house number is invalid',
    });
    expect(normalizeMapPlace({ ...valid, houseNumber: '4'.repeat(33) })).toEqual({
      ok: false,
      error: 'Place house number is invalid',
    });
    expect(normalizeMapPlace({ ...valid, houseNumber: '4\n' })).toEqual({
      ok: false,
      error: 'Place house number is invalid',
    });
  });

  it('rejects an invalid postal code, including CH and LI that are not four digits', () => {
    expect(normalizeMapPlace({ ...valid, postalCode: 1 })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    expect(normalizeMapPlace({ ...valid, postalCode: '' })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    expect(normalizeMapPlace({ ...valid, postalCode: '  ' })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    expect(normalizeMapPlace({ ...valid, postalCode: '949' })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    expect(normalizeMapPlace({ ...valid, postalCode: 'CH-8001' })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: 'CH', postalCode: '800' })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: 'CH', postalCode: '80011' })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: 'LI', postalCode: '94951' })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    expect(normalizeMapPlace({ ...valid, postalCode: '8001\n' })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    expect(normalizeMapPlace({ ...valid, country: 'DE', postalCode: 'A' })).toEqual({
      ok: false,
      error: 'Place postal code is invalid',
    });
    const other = normalizeMapPlace({ ...valid, country: 'DE', postalCode: 'SW1A 1AA' });
    expect(other.ok && other.value.postalCode).toBe('SW1A 1AA');
  });

  it('rejects an invalid city, including a value with no letter', () => {
    expect(normalizeMapPlace({ ...valid, city: 1 })).toEqual({
      ok: false,
      error: 'Place city is invalid',
    });
    expect(normalizeMapPlace({ ...valid, city: '' })).toEqual({
      ok: false,
      error: 'Place city is invalid',
    });
    expect(normalizeMapPlace({ ...valid, city: '  ' })).toEqual({
      ok: false,
      error: 'Place city is invalid',
    });
    expect(normalizeMapPlace({ ...valid, city: 'c'.repeat(81) })).toEqual({
      ok: false,
      error: 'Place city is invalid',
    });
    expect(normalizeMapPlace({ ...valid, city: 'bad\ncity' })).toEqual({
      ok: false,
      error: 'Place city is invalid',
    });
    expect(normalizeMapPlace({ ...valid, city: '9495' })).toEqual({
      ok: false,
      error: 'Place city is invalid',
    });
  });

  it('requires a longer description and allows a newline', () => {
    expect(normalizeMapPlace({ ...valid, description: 1 })).toEqual({
      ok: false,
      error: 'Place description is invalid',
    });
    expect(normalizeMapPlace({ ...valid, description: 'short' })).toEqual({
      ok: false,
      error: 'Place description is invalid',
    });
    expect(normalizeMapPlace({ ...valid, description: valid.name })).toEqual({
      ok: false,
      error: 'Place description is invalid',
    });
    expect(normalizeMapPlace({ ...valid, description: valid.name.toLowerCase() })).toEqual({
      ok: false,
      error: 'Place description is invalid',
    });
    const longName = 'SPAR Triesen supermarket';
    expect(
      normalizeMapPlace({ ...valid, name: longName, description: longName.toLowerCase() }),
    ).toEqual({
      ok: false,
      error: 'Place description is invalid',
    });
    expect(normalizeMapPlace({ ...valid, name: longName, description: 'x'.repeat(20) })).toEqual({
      ok: false,
      error: 'Place description is invalid',
    });
    expect(
      normalizeMapPlace({
        ...valid,
        description: `${valid.name} extra`,
      }),
    ).toEqual({
      ok: false,
      error: 'Place description is invalid',
    });
    expect(
      normalizeMapPlace({
        ...valid,
        description: `${DESCRIPTION}\tmore text about the shop.`,
      }),
    ).toEqual({
      ok: false,
      error: 'Place description is invalid',
    });
    const withNewline = normalizeMapPlace({
      ...valid,
      description: `${DESCRIPTION}\nSecond line about the checkout.`,
    });
    expect(withNewline.ok && withNewline.value.description).toContain('\n');
    const withCrlf = normalizeMapPlace({
      ...valid,
      description: `${DESCRIPTION}\r\nSecond line about the checkout.`,
    });
    expect(withCrlf.ok && withCrlf.value.description).toBe(
      `${DESCRIPTION}\nSecond line about the checkout.`,
    );
    const withCr = normalizeMapPlace({
      ...valid,
      description: `${DESCRIPTION}\rSecond line about the checkout.`,
    });
    expect(withCr.ok && withCr.value.description).toBe(
      `${DESCRIPTION}\nSecond line about the checkout.`,
    );
    const shortName = 'SPAR';
    const twenty = normalizeMapPlace({
      ...valid,
      name: shortName,
      description: 'd'.repeat(20),
    });
    expect(twenty.ok && twenty.value.description).toBe('d'.repeat(20));
    const thousand = normalizeMapPlace({
      ...valid,
      name: shortName,
      description: 'd'.repeat(1000),
    });
    expect(thousand.ok && thousand.value.description).toBe('d'.repeat(1000));
    expect(
      normalizeMapPlace({
        ...valid,
        description: 'x'.repeat(1001),
      }),
    ).toEqual({
      ok: false,
      error: 'Place description is invalid',
    });
  });

  it('rejects an omitted, null, or undefined required place field', () => {
    const cases = [
      ['description', 'Place description is invalid'],
      ['shopType', 'Place shop type is invalid'],
      ['street', 'Place street is invalid'],
      ['houseNumber', 'Place house number is invalid'],
      ['postalCode', 'Place postal code is invalid'],
      ['city', 'Place city is invalid'],
    ] as const;
    for (const [field, error] of cases) {
      const omitted: Record<string, unknown> = { ...valid };
      delete omitted[field];
      expect(normalizeMapPlace(omitted)).toEqual({ ok: false, error });
      expect(normalizeMapPlace({ ...valid, [field]: null })).toEqual({ ok: false, error });
      expect(normalizeMapPlace({ ...valid, [field]: undefined })).toEqual({ ok: false, error });
    }
  });

  it('stores an empty supports list when omitted', () => {
    const absent = normalizeMapPlace(valid);
    expect(absent).toEqual({ ok: true, value: { ...valid, supports: [] } });
    const empty = normalizeMapPlace({ ...valid, supports: [] });
    expect(empty).toEqual({ ok: true, value: { ...valid, supports: [] } });
  });

  it('stores a duplicate support pair once and sorts by blockchain then asset', () => {
    const result = normalizeMapPlace({
      ...valid,
      supports: [
        { blockchain: 'Polygon', asset: 'ZCHF' },
        { blockchain: 'Ethereum', asset: 'ZCHF' },
        { blockchain: 'Ethereum', asset: 'ETH' },
        { blockchain: 'Ethereum', asset: 'ZCHF' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...valid,
        supports: [
          { blockchain: 'Ethereum', asset: 'ETH' },
          { blockchain: 'Ethereum', asset: 'ZCHF' },
          { blockchain: 'Polygon', asset: 'ZCHF' },
        ],
      },
    });
  });

  it('stores a trimmed dEURO asset unchanged', () => {
    const result = normalizeMapPlace({
      ...valid,
      supports: [{ blockchain: ' Ethereum ', asset: ' dEURO ' }],
    });
    expect(result).toEqual({
      ok: true,
      value: { ...valid, supports: [{ blockchain: 'Ethereum', asset: 'dEURO' }] },
    });
  });

  it('rejects too many support items, a non-array, and a bad item', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({
      blockchain: 'Ethereum',
      asset: `A${String(i).padStart(2, '0')}`,
    }));
    expect(normalizeMapPlace({ ...valid, supports: many })).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    const thirtyTwo = many.slice(0, 32);
    expect(normalizeMapPlace({ ...valid, supports: thirtyTwo }).ok).toBe(true);
    expect(normalizeMapPlace({ ...valid, supports: null })).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlace({ ...valid, supports: 'Ethereum' })).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlace({ ...valid, supports: [null] })).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlace({ ...valid, supports: [[]] })).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlace({ ...valid, supports: [1] })).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlace({ ...valid, supports: [{ blockchain: 'Ethereum' }] })).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlace({ ...valid, supports: [{ asset: 'ZCHF' }] })).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
  });

  it('rejects payment providers, exchanges, banks, and a manual position as blockchain', () => {
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'BinancePay', asset: 'USDT' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'Kraken', asset: 'BTC' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'PLoan', asset: 'CHF' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'ethereum', asset: 'ZCHF' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'ETHEREUM', asset: 'ZCHF' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'Frick', asset: 'ZCHF' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
  });

  it('rejects lowercase, uniqueName, and invalid assets', () => {
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'Ethereum', asset: 'zchf' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'Ethereum', asset: 'deuro' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'Spark', asset: 'Spark/BTC' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'Ethereum', asset: 'Ethereum/ZCHF' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
    expect(
      normalizeMapPlace({
        ...valid,
        supports: [{ blockchain: 'BinanceSmartChain', asset: 'opBNB' }],
      }),
    ).toEqual({ ok: false, error: 'Place support is invalid' });
  });
});

describe('normalizeMapPlaceFilter', () => {
  it('returns an empty filter when every query is omitted', () => {
    expect(normalizeMapPlaceFilter()).toEqual({ ok: true, value: {} });
  });

  it('uppercases a trimmed country and accepts SPAR or Others as shopType', () => {
    expect(normalizeMapPlaceFilter(' ch ', 'SPAR', undefined, ' Ethereum ', ' dEURO ')).toEqual({
      ok: true,
      value: {
        country: 'CH',
        shopType: 'SPAR',
        blockchain: 'Ethereum',
        asset: 'dEURO',
      },
    });
    expect(normalizeMapPlaceFilter(undefined, ' Others ')).toEqual({
      ok: true,
      value: { shopType: 'Others' },
    });
    expect(
      normalizeMapPlaceFilter(undefined, undefined, undefined, ' BinancePay ', ' ckBTC '),
    ).toEqual({
      ok: true,
      value: { blockchain: 'BinancePay', asset: 'ckBTC' },
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, undefined, undefined, 'ZCHF')).toEqual({
      ok: true,
      value: { asset: 'ZCHF' },
    });
  });

  it('maps the deprecated shopName alias and rejects a conflict', () => {
    expect(normalizeMapPlaceFilter(undefined, undefined, ' SPAR ')).toEqual({
      ok: true,
      value: { shopType: 'SPAR' },
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, ' others ')).toEqual({
      ok: true,
      value: { shopType: 'Others' },
    });
    expect(normalizeMapPlaceFilter(undefined, 'SPAR', 'SPAR')).toEqual({
      ok: true,
      value: { shopType: 'SPAR' },
    });
    expect(normalizeMapPlaceFilter(undefined, 'Others', 'others')).toEqual({
      ok: true,
      value: { shopType: 'Others' },
    });
    expect(normalizeMapPlaceFilter(undefined, 'SPAR', 'others')).toEqual({
      ok: false,
      error: 'Place shop type is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, 'Others', 'SPAR')).toEqual({
      ok: false,
      error: 'Place shop type is invalid',
    });
  });

  it('rejects a bad country, shop type, shop name, blockchain, or asset query', () => {
    expect(normalizeMapPlaceFilter('ZZ')).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlaceFilter('CHE')).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, 'others')).toEqual({
      ok: false,
      error: 'Place shop type is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, 'Migros')).toEqual({
      ok: false,
      error: 'Place shop name is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, undefined, 'Frick')).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, undefined, 'ethereum')).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(
      normalizeMapPlaceFilter(undefined, undefined, undefined, undefined, 'Ethereum/ZCHF'),
    ).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, undefined, 'KucoinPay', 'USDC.e')).toEqual(
      {
        ok: false,
        error: 'Place support is invalid',
      },
    );
    expect(normalizeMapPlaceFilter(undefined, undefined, undefined, undefined, 'USDbC')).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    for (const pair of publicPlaceSupports('21.gifts')) {
      expect(
        normalizeMapPlaceFilter(undefined, undefined, undefined, pair.blockchain, pair.asset).ok,
      ).toBe(true);
    }
  });
});

describe('normalizeMapPlaceKey', () => {
  it('rejects a non-object and an array', () => {
    expect(normalizeMapPlaceKey(null)).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizeMapPlaceKey([])).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizeMapPlaceKey('x')).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
  });

  it('rejects a bad origin and external id with the create error strings', () => {
    expect(normalizeMapPlaceKey({ origin: 1, externalId: 'store-1' })).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizeMapPlaceKey({ origin: 'DFX', externalId: 'store-1' })).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizeMapPlaceKey({ origin: 'dfx', externalId: 1 })).toEqual({
      ok: false,
      error: 'Place external id is required',
    });
    expect(normalizeMapPlaceKey({ origin: 'dfx', externalId: '' })).toEqual({
      ok: false,
      error: 'Place external id is required',
    });
    expect(normalizeMapPlaceKey({ origin: 'dfx', externalId: 'a'.repeat(81) })).toEqual({
      ok: false,
      error: 'Place external id is required',
    });
    expect(normalizeMapPlaceKey({ origin: 'dfx', externalId: 'bad\nid' })).toEqual({
      ok: false,
      error: 'Place external id is required',
    });
  });

  it('returns the trimmed key and ignores extra fields', () => {
    expect(
      normalizeMapPlaceKey({
        origin: ' dfx ',
        externalId: ' store-1 ',
        name: 'ignored',
        lat: 1,
      }),
    ).toEqual({
      ok: true,
      value: { origin: 'dfx', externalId: 'store-1' },
    });
  });

  it('rejects an own id and still ignores other extra fields', () => {
    expect(normalizeMapPlaceKey({ id: 'pin-1' })).toEqual({
      ok: false,
      error: 'Place field is not allowed: id',
    });
    expect(normalizeMapPlaceKey({ origin: 'dfx', externalId: 'store-1', id: null })).toEqual({
      ok: false,
      error: 'Place field is not allowed: id',
    });
    expect(
      normalizeMapPlaceKey({
        origin: ' dfx ',
        externalId: ' store-1 ',
        name: 'ignored',
      }),
    ).toEqual({
      ok: true,
      value: { origin: 'dfx', externalId: 'store-1' },
    });
  });
});

describe('placeActivity', () => {
  const nowMs = Date.parse('2026-10-08T00:00:00.000Z');
  const seven = 7 * 24 * 60 * 60 * 1000;
  const thirty = 30 * 24 * 60 * 60 * 1000;

  it('classifies null, unparseable, future, and the 7-day and 30-day bounds', () => {
    expect(placeActivity(null, [], nowMs)).toEqual({ activity: 'none', until: null });
    expect(placeActivity('not-a-date', [], nowMs)).toEqual({ activity: 'none', until: null });
    const future = new Date(nowMs + 1).toISOString();
    expect(placeActivity(future, [], nowMs)).toEqual({
      activity: 'within7Days',
      until: new Date(nowMs + 1 + seven + 1).toISOString(),
    });
    const threeDays = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(placeActivity(threeDays, [], nowMs)).toEqual({
      activity: 'within7Days',
      until: new Date(nowMs - 3 * 24 * 60 * 60 * 1000 + seven + 1).toISOString(),
    });
    const sevenDays = new Date(nowMs - seven).toISOString();
    expect(placeActivity(sevenDays, [], nowMs)).toEqual({
      activity: 'within7Days',
      until: new Date(nowMs + 1).toISOString(),
    });
    const sevenPlus = new Date(nowMs - (seven + 1)).toISOString();
    expect(placeActivity(sevenPlus, [], nowMs)).toEqual({
      activity: 'within30Days',
      until: new Date(nowMs - (seven + 1) + thirty + 1).toISOString(),
    });
    const fifteenDays = new Date(nowMs - 15 * 24 * 60 * 60 * 1000).toISOString();
    expect(placeActivity(fifteenDays, [], nowMs)).toEqual({
      activity: 'within30Days',
      until: new Date(nowMs - 15 * 24 * 60 * 60 * 1000 + thirty + 1).toISOString(),
    });
    const thirtyDays = new Date(nowMs - thirty).toISOString();
    expect(placeActivity(thirtyDays, [], nowMs)).toEqual({
      activity: 'within30Days',
      until: new Date(nowMs + 1).toISOString(),
    });
    const thirtyPlus = new Date(nowMs - (thirty + 1)).toISOString();
    expect(placeActivity(thirtyPlus, [], nowMs)).toEqual({
      activity: 'olderThan30Days',
      until: null,
    });
  });

  it('treats 4 distinct UTC days as not daily and 5 as daily', () => {
    const four = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
    const recent = new Date(nowMs).toISOString();
    expect(placeActivity(recent, four, nowMs)).toEqual({
      activity: 'within7Days',
      until: new Date(nowMs + seven + 1).toISOString(),
    });
    const five = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
    expect(placeActivity(recent, five, nowMs)).toEqual({
      activity: 'daily',
      until: '2026-10-11T00:00:00.000Z',
    });
    expect(placeActivity('not-a-date', five, nowMs).activity).toBe('daily');
    const six = ['2026-10-03', ...five];
    expect(placeActivity(null, six, nowMs)).toEqual({
      activity: 'daily',
      until: '2026-10-11T00:00:00.000Z',
    });
  });

  it('counts the same UTC day twice as one day and ignores out-of-window strings', () => {
    const recent = new Date(nowMs).toISOString();
    const duplicated = ['2026-10-08', '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05'];
    expect(placeActivity(recent, duplicated, nowMs).activity).toBe('within7Days');
    const withOutside = [
      '2026-10-01',
      '2026-10-09',
      '2026-10-8',
      'not-a-date',
      '2026-10-08T00:00:00.000Z',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ];
    expect(placeActivity(recent, withOutside, nowMs).activity).toBe('within7Days');
    expect(placeActivity(recent, [...withOutside, '2026-10-04'], nowMs)).toEqual({
      activity: 'daily',
      until: '2026-10-11T00:00:00.000Z',
    });
    expect(
      placeActivity(
        recent,
        ['2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'],
        nowMs,
      ),
    ).toEqual({
      activity: 'daily',
      until: '2026-10-09T00:00:00.000Z',
    });
  });
});

describe('normalizePlaceTransaction', () => {
  const nowMs = Date.parse('2026-10-08T00:00:00.000Z');
  const key = { origin: 'dfx', externalId: 'store-1' };

  it('rejects a non-object and an array with the key error', () => {
    expect(normalizePlaceTransaction(null, nowMs)).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceTransaction([], nowMs)).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceTransaction('x', nowMs)).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
  });

  it('rejects a bad origin and external id with the key error strings', () => {
    expect(normalizePlaceTransaction({ origin: 1, externalId: 'store-1' }, nowMs)).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceTransaction({ origin: 'DFX', externalId: 'store-1' }, nowMs)).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizePlaceTransaction({ origin: 'dfx', externalId: 1 }, nowMs)).toEqual({
      ok: false,
      error: 'Place external id is required',
    });
    expect(normalizePlaceTransaction({ origin: 'dfx', externalId: '' }, nowMs)).toEqual({
      ok: false,
      error: 'Place external id is required',
    });
  });

  it('defaults omitted occurredAt and canonicalizes a parseable instant', () => {
    expect(normalizePlaceTransaction(key, nowMs)).toEqual({
      ok: true,
      value: { ...key, occurredAt: new Date(nowMs).toISOString() },
    });
    expect(
      normalizePlaceTransaction({ ...key, occurredAt: '2026-10-01T00:00:00Z' }, nowMs),
    ).toEqual({
      ok: true,
      value: { ...key, occurredAt: '2026-10-01T00:00:00.000Z' },
    });
    expect(
      normalizePlaceTransaction({ ...key, occurredAt: '2026-10-01T02:00:00+02:00' }, nowMs),
    ).toEqual({
      ok: true,
      value: { ...key, occurredAt: '2026-10-01T00:00:00.000Z' },
    });
  });

  it('rejects a null, number, blank, whitespace, or unparseable occurredAt', () => {
    expect(normalizePlaceTransaction({ ...key, occurredAt: null }, nowMs)).toEqual({
      ok: false,
      error: 'Place transaction time is invalid',
    });
    expect(normalizePlaceTransaction({ ...key, occurredAt: 1 }, nowMs)).toEqual({
      ok: false,
      error: 'Place transaction time is invalid',
    });
    expect(normalizePlaceTransaction({ ...key, occurredAt: '' }, nowMs)).toEqual({
      ok: false,
      error: 'Place transaction time is invalid',
    });
    expect(normalizePlaceTransaction({ ...key, occurredAt: '   ' }, nowMs)).toEqual({
      ok: false,
      error: 'Place transaction time is invalid',
    });
    expect(normalizePlaceTransaction({ ...key, occurredAt: 'not-a-date' }, nowMs)).toEqual({
      ok: false,
      error: 'Place transaction time is invalid',
    });
  });

  it('rejects an occurredAt whose year is not four digits', () => {
    expect(
      normalizePlaceTransaction({ ...key, occurredAt: '-000001-01-01T00:00:00Z' }, nowMs),
    ).toEqual({
      ok: false,
      error: 'Place transaction time is invalid',
    });
  });

  it('accepts exactly 120 seconds of future skew and rejects one millisecond later', () => {
    const atSkew = nowMs + 120_000;
    expect(
      normalizePlaceTransaction({ ...key, occurredAt: new Date(atSkew).toISOString() }, nowMs),
    ).toEqual({
      ok: true,
      value: { ...key, occurredAt: new Date(atSkew).toISOString() },
    });
    expect(
      normalizePlaceTransaction(
        { ...key, occurredAt: new Date(nowMs + 120_001).toISOString() },
        nowMs,
      ),
    ).toEqual({
      ok: false,
      error: 'Place transaction time is invalid',
    });
  });
});

describe('normalizeMapPlace google maps link', () => {
  const search = 'https://www.google.com/maps/search/?api=1&query_place_id=ChIJtest';
  const goo = 'https://maps.app.goo.gl/abc';
  const linkError = 'Place Google Maps link is invalid';

  it('leaves the property off when the key is absent and keeps JSON null', () => {
    const absent = normalizeMapPlace(valid);
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(Object.hasOwn(absent.value, 'googleMapsUrl')).toBe(false);
    }
    const cleared = normalizeMapPlace({ ...valid, googleMapsUrl: null });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(Object.hasOwn(cleared.value, 'googleMapsUrl')).toBe(true);
      expect(cleared.value.googleMapsUrl).toBeNull();
    }
  });

  it('rejects a value that is not a Google Maps https link', () => {
    const prefix = 'https://www.google.com/maps/';
    const tooLong = `${prefix}${'a'.repeat(2001 - prefix.length)}`;
    for (const googleMapsUrl of [
      1,
      { href: search },
      '',
      '   ',
      'http://www.google.com/maps',
      'https://user@www.google.com/maps',
      'https://www.google.com:8443/maps',
      'https://www.google.com:443/maps',
      'https:///www.google.com:8443/maps',
      'https:///user:pw@www.google.com/maps',
      'https:\\\\www.google.com:8443/maps',
      'https://www.google.com\\maps/x',
      'https://www.google.com/maps/place/\u0000x',
      'https://www.google.com/maps/place/\u007fx',
      'https://www.google.com/maps/place/\u200bx',
      'https://evil.example/maps',
      'javascript:alert(1)',
      'https://www.google.com/search',
      'https://www.google.com',
      'https://maps.app.goo.gl/',
      'https://maps.app.goo.gl',
      'https://[',
      'https://www.google.com/maps/a b',
      tooLong,
    ]) {
      expect(normalizeMapPlace({ ...valid, googleMapsUrl })).toEqual({
        ok: false,
        error: linkError,
      });
    }
  });

  it('stores a trimmed https link for the allowed hosts and paths', () => {
    const prefix = 'https://www.google.com/maps/';
    const exactLength = `${prefix}${'a'.repeat(2000 - prefix.length)}`;
    expect(exactLength.length).toBe(2000);
    for (const googleMapsUrl of [
      search,
      `  ${search}  `,
      goo,
      'https://www.google.com/maps',
      'https://www.google.com/maps/',
      'https://google.com/maps',
      'https://maps.google.com/maps/place',
      'https://www.google.com/maps#place',
      exactLength,
    ]) {
      const parsed = normalizeMapPlace({ ...valid, googleMapsUrl });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.googleMapsUrl).toBe(googleMapsUrl.trim());
      }
    }
  });
});

describe('toPublicMapPlace', () => {
  it('omits the caller id and payment methods, derives shopName and gives a keyless row a null id', () => {
    const stored: StoredMapPlace = {
      origin: 'dfx',
      externalId: 'store-1',
      name: 'SPAR Triesen',
      description: DESCRIPTION,
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      paymentMethods: 'lightning',
      techProvider: 'DFX.swiss',
      shopType: 'Others',
      street: 'Maschlinastrasse',
      houseNumber: '4',
      postalCode: '9495',
      city: 'Triesen',
      country: 'LI',
      supports: [],
      photos: [],
      lastTransactionAt: null,
      activity: 'none',
      active: true,
      googleMapsUrl: null,
      nostrPubkey: null,
      id: 'id-1',
      createdAt: '2026-09-26T00:00:00.000Z',
    };
    expect(toPublicMapPlace(stored, 'https://api.test')).toEqual({
      id: null,
      origin: 'dfx',
      name: 'SPAR Triesen',
      description: DESCRIPTION,
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      techProvider: 'DFX.swiss',
      shopType: 'Others',
      shopName: null,
      country: 'LI',
      street: 'Maschlinastrasse',
      houseNumber: '4',
      postalCode: '9495',
      city: 'Triesen',
      supports: publicPlaceSupports('DFX.swiss'),
      activity: 'none',
      coverPhoto: null,
      googleMapsUrl: null,
    });
    const hidden = toPublicMapPlace(stored, 'https://api.test');
    expect(hidden).not.toHaveProperty('externalId');
    expect(hidden).not.toHaveProperty('paymentMethods');
    expect(Object.hasOwn(hidden, 'active')).toBe(false);
  });

  it('returns SPAR shopName, the tech-provider offer and the npub as id', () => {
    const supports = [{ blockchain: 'Ethereum', asset: 'ZCHF' }];
    const stored: StoredMapPlace = {
      origin: 'dfx',
      externalId: 'store-1',
      name: 'SPAR Triesen',
      description: DESCRIPTION,
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      paymentMethods: 'lightning',
      techProvider: 'DFX.swiss',
      shopType: 'SPAR',
      street: 'Maschlinastrasse',
      houseNumber: '4',
      postalCode: '9495',
      city: 'Triesen',
      country: 'LI',
      supports,
      photos: [],
      lastTransactionAt: null,
      activity: 'daily',
      active: false,
      googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query_place_id=ChIJtest',
      nostrPubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
      id: 'id-1',
      createdAt: '2026-09-26T00:00:00.000Z',
    };
    const publicPlace = toPublicMapPlace(stored, 'https://api.test');
    expect(Object.hasOwn(publicPlace, 'active')).toBe(false);
    expect(publicPlace).toEqual({
      id: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
      origin: 'dfx',
      name: 'SPAR Triesen',
      description: DESCRIPTION,
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      techProvider: 'DFX.swiss',
      shopType: 'SPAR',
      shopName: 'SPAR',
      country: 'LI',
      street: 'Maschlinastrasse',
      houseNumber: '4',
      postalCode: '9495',
      city: 'Triesen',
      supports: publicPlaceSupports('DFX.swiss'),
      activity: 'daily',
      coverPhoto: null,
      googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query_place_id=ChIJtest',
    });
    publicPlace.supports.push({ blockchain: 'Polygon', asset: 'ETH' });
    expect(stored.supports).toEqual([{ blockchain: 'Ethereum', asset: 'ZCHF' }]);
  });
});

describe('normalizeMapPlace NOSTR key and revision', () => {
  it('stores a valid key and returns the revision next to the pin', () => {
    const parsed = normalizeMapPlace({ ...valid, nostrPubkey: KEY, revision: 7 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.nostrPubkey).toBe(KEY);
      expect(parsed.revision).toBe(7);
    }
  });

  it('requires the key and leaves the revision unset when it is omitted', () => {
    const withoutKey: Record<string, unknown> = { ...valid };
    delete withoutKey['nostrPubkey'];
    expect(normalizeMapPlace(withoutKey)).toEqual({
      ok: false,
      error: 'Place NOSTR public key is required',
    });
    const parsed = normalizeMapPlace(valid);
    expect(parsed.ok && parsed.value.nostrPubkey).toBe(KEY);
    expect(parsed.ok && parsed.revision).toBeUndefined();
  });

  it('rejects a key that is not 64 lowercase hex characters on the curve', () => {
    for (const nostrPubkey of [
      KEY.toUpperCase(),
      'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
      '0'.repeat(64),
      null,
      1,
    ]) {
      expect(normalizeMapPlace({ ...valid, nostrPubkey })).toEqual({
        ok: false,
        error: 'Place NOSTR public key is invalid',
      });
    }
  });

  it('accepts revisions from 1 to the largest exact JSON integer and rejects anything else', () => {
    const top = normalizeMapPlace({ ...valid, revision: Number.MAX_SAFE_INTEGER });
    expect(top.ok && top.revision).toBe(Number.MAX_SAFE_INTEGER);
    for (const revision of [0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeMapPlace({ ...valid, revision })).toEqual({
        ok: false,
        error: 'Place revision is invalid',
      });
    }
  });
});

describe('normalizeMapPlaceDelete', () => {
  it('accepts origin, external id and an optional revision', () => {
    expect(normalizeMapPlaceDelete({ origin: 'dfx', externalId: 'store-1' })).toEqual({
      ok: true,
      value: { origin: 'dfx', externalId: 'store-1' },
      revision: undefined,
    });
    expect(normalizeMapPlaceDelete({ origin: 'dfx', externalId: 'store-1', revision: 3 })).toEqual({
      ok: true,
      value: { origin: 'dfx', externalId: 'store-1' },
      revision: 3,
    });
  });

  it('rejects a non-object, an array and any other key', () => {
    expect(normalizeMapPlaceDelete(null)).toEqual({ ok: false, error: 'Place origin is invalid' });
    expect(normalizeMapPlaceDelete([])).toEqual({ ok: false, error: 'Place origin is invalid' });
    expect(
      normalizeMapPlaceDelete({ origin: 'dfx', externalId: 'store-1', nostrPubkey: KEY }),
    ).toEqual({ ok: false, error: 'Place field is not allowed: nostrPubkey' });
  });

  it('rejects a bad origin, external id or revision', () => {
    expect(normalizeMapPlaceDelete({ origin: 'SPAR', externalId: 'store-1' })).toEqual({
      ok: false,
      error: 'Place origin is invalid',
    });
    expect(normalizeMapPlaceDelete({ origin: 'dfx', externalId: '' })).toEqual({
      ok: false,
      error: 'Place external id is required',
    });
    expect(normalizeMapPlaceDelete({ origin: 'dfx', externalId: 'store-1', revision: 0 })).toEqual({
      ok: false,
      error: 'Place revision is invalid',
    });
  });
});

describe('google maps seed', () => {
  it('holds one valid link for each distinct place key', () => {
    const keys = new Set<string>();
    for (const entry of googleMapsSeed) {
      expect(npubDecode(entry.npub)).not.toBeNull();
      expect(isGoogleMapsUrl(entry.googleMapsUrl)).toBe(true);
      keys.add(entry.npub);
    }
    expect(keys.size).toBe(googleMapsSeed.length);
  });
});
