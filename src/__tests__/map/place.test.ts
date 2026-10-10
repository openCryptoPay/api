import { describe, expect, it } from 'vitest';
import {
  normalizeMapPlace,
  normalizeMapPlaceFilter,
  normalizeMapPlaceKey,
  normalizePlaceOrigin,
  normalizePlaceTransaction,
  placeActivity,
  toPublicMapPlace,
} from '@/lib/map/place';
import type { StoredMapPlace } from '@/lib/map/place';

const valid = {
  origin: 'dfx',
  externalId: 'store-1',
  name: 'SPAR',
  lat: 47.37,
  lon: 8.54,
  category: 'groceries',
  paymentMethods: 'lightning',
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
    expect(normalizeMapPlace({ ...valid, name: 'bad\u007fname' }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, category: 1 }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, category: 'Cafe' }).ok).toBe(false);
    expect(normalizeMapPlace({ ...valid, category: '' }).ok).toBe(false);
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
      value: { ...valid, techProvider: 'DFX.swiss' },
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

  it('omits an absent or null country and stores a trimmed lowercase code as uppercase', () => {
    const absent = normalizeMapPlace(valid);
    expect(absent.ok && !('country' in absent.value)).toBe(true);
    const nulled = normalizeMapPlace({ ...valid, country: null });
    expect(nulled.ok && !('country' in nulled.value)).toBe(true);
    const trimmed = normalizeMapPlace({ ...valid, country: ' ch ' });
    expect(trimmed).toEqual({ ok: true, value: { ...valid, country: 'CH' } });
    for (const country of ['CH', 'LI', 'DE', 'AT', 'FR', 'IT', 'PH']) {
      const result = normalizeMapPlace({ ...valid, country });
      expect(result).toEqual({ ok: true, value: { ...valid, country } });
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

  it('omits an absent or null shop name and trims a present brand', () => {
    const absent = normalizeMapPlace(valid);
    expect(absent.ok && !('shopName' in absent.value)).toBe(true);
    const nulled = normalizeMapPlace({ ...valid, shopName: null });
    expect(nulled.ok && !('shopName' in nulled.value)).toBe(true);
    const trimmed = normalizeMapPlace({ ...valid, shopName: ' SPAR ' });
    expect(trimmed).toEqual({ ok: true, value: { ...valid, shopName: 'SPAR' } });
    const other = normalizeMapPlace({ ...valid, shopName: 'Migros' });
    expect(other.ok && other.value.shopName).toBe('Migros');
    const max = normalizeMapPlace({ ...valid, shopName: 'x'.repeat(40) });
    expect(max.ok && max.value.shopName).toBe('x'.repeat(40));
  });

  it('rejects an empty, too long, control, or non-string shop name', () => {
    expect(normalizeMapPlace({ ...valid, shopName: '' })).toEqual({
      ok: false,
      error: 'Place shop name is invalid',
    });
    expect(normalizeMapPlace({ ...valid, shopName: ' ' })).toEqual({
      ok: false,
      error: 'Place shop name is invalid',
    });
    expect(normalizeMapPlace({ ...valid, shopName: 'x'.repeat(41) })).toEqual({
      ok: false,
      error: 'Place shop name is invalid',
    });
    expect(normalizeMapPlace({ ...valid, shopName: 'bad\nname' })).toEqual({
      ok: false,
      error: 'Place shop name is invalid',
    });
    expect(normalizeMapPlace({ ...valid, shopName: 1 })).toEqual({
      ok: false,
      error: 'Place shop name is invalid',
    });
  });

  it('omits supports when absent and stores an empty list when sent', () => {
    const absent = normalizeMapPlace(valid);
    expect(absent.ok && !('supports' in absent.value)).toBe(true);
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

  it('uppercases a trimmed country and accepts SPAR or others as shopName', () => {
    expect(normalizeMapPlaceFilter(' ch ', ' SPAR ', ' Ethereum ', ' dEURO ')).toEqual({
      ok: true,
      value: {
        country: 'CH',
        shopName: 'SPAR',
        blockchain: 'Ethereum',
        asset: 'dEURO',
      },
    });
    expect(normalizeMapPlaceFilter(undefined, ' others ')).toEqual({
      ok: true,
      value: { shopName: 'others' },
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, ' BinancePay ', ' ckBTC ')).toEqual({
      ok: true,
      value: { blockchain: 'BinancePay', asset: 'ckBTC' },
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, undefined, 'ZCHF')).toEqual({
      ok: true,
      value: { asset: 'ZCHF' },
    });
  });

  it('rejects a bad country, shop name, blockchain, or asset query', () => {
    expect(normalizeMapPlaceFilter('ZZ')).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlaceFilter('CHE')).toEqual({
      ok: false,
      error: 'Place country is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, 'Migros')).toEqual({
      ok: false,
      error: 'Place shop name is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, 'Frick')).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, 'ethereum')).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, undefined, 'Ethereum/ZCHF')).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, 'KucoinPay', 'USDC.e')).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
    expect(normalizeMapPlaceFilter(undefined, undefined, undefined, 'USDbC')).toEqual({
      ok: false,
      error: 'Place support is invalid',
    });
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
});

describe('placeActivity', () => {
  const nowMs = Date.parse('2026-10-08T00:00:00.000Z');

  it('classifies null, unparseable, future, and the 7-day and 30-day bounds', () => {
    expect(placeActivity(null, nowMs)).toBe('none');
    expect(placeActivity('not-a-date', nowMs)).toBe('none');
    expect(placeActivity(new Date(nowMs + 1).toISOString(), nowMs)).toBe('within7Days');
    expect(placeActivity(new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString(), nowMs)).toBe(
      'within7Days',
    );
    expect(placeActivity(new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString(), nowMs)).toBe(
      'within7Days',
    );
    expect(
      placeActivity(new Date(nowMs - (7 * 24 * 60 * 60 * 1000 + 1)).toISOString(), nowMs),
    ).toBe('within30Days');
    expect(placeActivity(new Date(nowMs - 15 * 24 * 60 * 60 * 1000).toISOString(), nowMs)).toBe(
      'within30Days',
    );
    expect(placeActivity(new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString(), nowMs)).toBe(
      'within30Days',
    );
    expect(
      placeActivity(new Date(nowMs - (30 * 24 * 60 * 60 * 1000 + 1)).toISOString(), nowMs),
    ).toBe('none');
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

describe('toPublicMapPlace', () => {
  const nowMs = Date.parse('2026-09-26T00:00:00.000Z');

  it('omits the caller id and payment methods', () => {
    const stored: StoredMapPlace = {
      ...valid,
      techProvider: 'DFX.swiss',
      id: 'id-1',
      createdAt: '2026-09-26T00:00:00.000Z',
      country: null,
      shopName: null,
      supports: [],
      lastTransactionAt: null,
    };
    expect(toPublicMapPlace(stored, nowMs)).toEqual({
      id: 'id-1',
      origin: 'dfx',
      name: 'SPAR',
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      techProvider: 'DFX.swiss',
      country: null,
      shopName: null,
      supports: [],
      activity: 'none',
    });
  });

  it('returns country, shop name, and a copy of supports', () => {
    const supports = [{ blockchain: 'Ethereum', asset: 'ZCHF' }];
    const stored: StoredMapPlace = {
      ...valid,
      techProvider: 'DFX.swiss',
      id: 'id-1',
      createdAt: '2026-09-26T00:00:00.000Z',
      country: 'CH',
      shopName: 'SPAR',
      supports,
      lastTransactionAt: null,
    };
    const publicPlace = toPublicMapPlace(stored, nowMs);
    expect(publicPlace).toEqual({
      id: 'id-1',
      origin: 'dfx',
      name: 'SPAR',
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      techProvider: 'DFX.swiss',
      country: 'CH',
      shopName: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
      activity: 'none',
    });
    publicPlace.supports.push({ blockchain: 'Polygon', asset: 'ETH' });
    expect(stored.supports).toEqual([{ blockchain: 'Ethereum', asset: 'ZCHF' }]);
  });
});
