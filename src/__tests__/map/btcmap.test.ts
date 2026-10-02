import { describe, expect, it } from 'vitest';
import { mapSubmissionBody, pushMapPlace, type FetchLike } from '@/lib/map/btcmap';
import type { StoredMapPlace } from '@/lib/map/place';

const place: StoredMapPlace = {
  id: 'id-1',
  origin: 'dfx',
  externalId: 'store-1',
  name: 'SPAR',
  lat: 47.37,
  lon: 8.54,
  category: 'groceries',
  paymentMethods: 'lightning',
  techProvider: 'DFX.swiss',
  createdAt: '2026-09-26T00:00:00.000Z',
};

describe('mapSubmissionBody', () => {
  it('includes payment methods only when they are set', () => {
    expect(mapSubmissionBody(place).extra_fields).toEqual({
      source: 'dfx',
      payment_methods: 'lightning',
    });
    expect(mapSubmissionBody({ ...place, paymentMethods: null }).extra_fields).toEqual({
      source: 'dfx',
    });
  });
});

describe('pushMapPlace', () => {
  it('skips when the token is missing or blank', async () => {
    expect(await pushMapPlace(place, {}, fetch)).toBe('skipped');
    expect(await pushMapPlace(place, { BTCMAP_ACCESS_TOKEN: '  ' }, fetch)).toBe('skipped');
  });

  it('posts once to the configured url and reports the outcome', async () => {
    const calls: string[] = [];
    const ok: FetchLike = async (input, init) => {
      calls.push(String(input));
      expect(JSON.parse(String(init.body))).toMatchObject({ name: 'SPAR' });
      return new Response('{}', { status: 201 });
    };
    expect(
      await pushMapPlace(
        place,
        { BTCMAP_ACCESS_TOKEN: ' map-token ', BTCMAP_SUBMIT_URL: 'https://example.test/submit/' },
        ok,
      ),
    ).toBe('sent');
    expect(calls).toEqual(['https://example.test/submit']);

    const blankUrl = await pushMapPlace(
      place,
      { BTCMAP_ACCESS_TOKEN: 't', BTCMAP_SUBMIT_URL: '   ' },
      async (input) => {
        expect(input).toBe('https://api.btcmap.org/v4/place-submissions');
        return new Response('{}', { status: 200 });
      },
    );
    expect(blankUrl).toBe('sent');

    const failed = await pushMapPlace(place, { BTCMAP_ACCESS_TOKEN: 't' }, async () => {
      return new Response('no', { status: 500 });
    });
    expect(failed).toBe('failed');

    const thrown = await pushMapPlace(place, { BTCMAP_ACCESS_TOKEN: 't' }, async () => {
      throw new Error('down');
    });
    expect(thrown).toBe('failed');
  });
});
