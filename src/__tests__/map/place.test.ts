import { describe, expect, it } from 'vitest';
import { normalizeMapPlace, normalizeMapPlaceKey, toPublicMapPlace } from '@/lib/map/place';
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

describe('toPublicMapPlace', () => {
  it('omits the caller id and payment methods', () => {
    const stored: StoredMapPlace = {
      ...valid,
      techProvider: 'DFX.swiss',
      id: 'id-1',
      createdAt: '2026-09-26T00:00:00.000Z',
    };
    expect(toPublicMapPlace(stored)).toEqual({
      id: 'id-1',
      origin: 'dfx',
      name: 'SPAR',
      lat: 47.37,
      lon: 8.54,
      category: 'groceries',
      techProvider: 'DFX.swiss',
    });
  });
});
