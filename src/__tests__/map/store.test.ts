import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAP_PLACE_SCHEMA_SQL, MemoryMapPlaceStore, placeProblems } from '@/lib/map/store';
import type { MapPlaceInput, ShopType } from '@/lib/map/place';

const DESCRIPTION =
  'SPAR supermarket in Triesen. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';

const OTHER_DESCRIPTION =
  'Neighbourhood grocery in Zürich. Customers can pay with Bitcoin and other crypto assets through OpenCryptoPay at the checkout.';

const input: MapPlaceInput = {
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
  supports: [],
};

describe('MAP_PLACE_SCHEMA_SQL', () => {
  it('matches docs/schema/map-place.sql', () => {
    const docs = readFileSync(join(process.cwd(), 'docs/schema/map-place.sql'), 'utf8');
    const create = docs
      .split('\n')
      .filter((line) => !line.startsWith('--') && line.trim() !== '')
      .join('\n')
      .trim()
      .replace(/;\s*$/, '');
    expect(MAP_PLACE_SCHEMA_SQL.trim()).toBe(create);
  });
});

describe('MemoryMapPlaceStore', () => {
  it('inserts once and lists newest first without changing the first row', () => {
    let tick = 0;
    const store = new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    const first = store.insertIfNew(input);
    expect(first.created).toBe(true);
    expect(first.place.techProvider).toBe('DFX.swiss');
    expect(first.place.description).toBe(DESCRIPTION);
    expect(first.place.shopType).toBe('SPAR');
    expect(first.place.country).toBe('LI');
    expect(first.place.street).toBe('Maschlinastrasse');
    expect(first.place.houseNumber).toBe('4');
    expect(first.place.postalCode).toBe('9495');
    expect(first.place.city).toBe('Triesen');
    expect(first.place.supports).toEqual([]);
    expect(first.place.activity).toBe('none');
    expect(first.place.lastTransactionAt).toBeNull();
    const second = store.insertIfNew({ ...input, name: 'Other', lat: 1 });
    expect(second.created).toBe(false);
    expect(second.place.name).toBe('SPAR Triesen');
    expect(second.place.id).toBe(first.place.id);
    const later = store.insertIfNew({ ...input, externalId: 'store-2' });
    const listed = store.list(10);
    expect(listed.map((row) => row.externalId)).toEqual(['store-2', 'store-1']);
    expect(store.list(1)).toHaveLength(1);
    expect(store.list(10, {}).map((row) => row.externalId)).toEqual(['store-2', 'store-1']);
    expect(store.list(10, { blockchain: 'Ethereum' }).map((row) => row.externalId)).toEqual([
      'store-2',
      'store-1',
    ]);
    expect(store.list(10, { asset: 'ZCHF' }).map((row) => row.externalId)).toEqual([
      'store-2',
      'store-1',
    ]);
    store.close();
    expect(store.list(10)).toHaveLength(0);
    expect(later.created).toBe(true);
  });

  it('orders a later timestamp first and breaks a tie by id', () => {
    let tick = 0;
    const rising = new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    rising.insertIfNew({ ...input, externalId: 'older' });
    rising.insertIfNew({ ...input, externalId: 'newer' });
    expect(rising.list(10).map((row) => row.externalId)).toEqual(['newer', 'older']);

    const fixed = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    const a = fixed.insertIfNew({ ...input, externalId: 'a' });
    const b = fixed.insertIfNew({ ...input, externalId: 'b' });
    const expected = [a.place.id, b.place.id].sort((left, right) => right.localeCompare(left));
    expect(fixed.list(10).map((row) => row.id)).toEqual(expected);
  });

  it('defaults an omitted tech provider and stores an explicit value on insert', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    const omitted = store.insertIfNew(input);
    expect(omitted.place.techProvider).toBe('DFX.swiss');
    const labeled = store.insertIfNew({
      ...input,
      externalId: 'store-labeled',
      techProvider: '21.gifts',
    });
    expect(labeled.created).toBe(true);
    expect(labeled.place.techProvider).toBe('21.gifts');
  });

  it('does not change techProvider on a repeated insert', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.insertIfNew({ ...input, techProvider: '21.gifts' });
    const again = store.insertIfNew({ ...input, name: 'Other', techProvider: 'Other.lab' });
    expect(again.created).toBe(false);
    expect(again.place.name).toBe('SPAR Triesen');
    expect(again.place.techProvider).toBe('21.gifts');
  });

  it('upserts a new pair and replaces every field on an existing pair', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    const created = store.upsert(input);
    expect(created.created).toBe(true);
    expect(created.place.techProvider).toBe('DFX.swiss');
    const updated = store.upsert({
      ...input,
      name: 'Other Shop',
      description: OTHER_DESCRIPTION,
      lat: 1,
      lon: 2,
      category: 'cafe',
      paymentMethods: 'onchain',
      shopType: 'Others',
      street: 'Bahnhofstrasse',
      houseNumber: '12',
      postalCode: '8001',
      city: 'Zürich',
      country: 'CH',
    });
    expect(updated.created).toBe(false);
    expect(updated.place.id).toBe(created.place.id);
    expect(updated.place.createdAt).toBe(created.place.createdAt);
    expect(updated.place.name).toBe('Other Shop');
    expect(updated.place.description).toBe(OTHER_DESCRIPTION);
    expect(updated.place.lat).toBe(1);
    expect(updated.place.lon).toBe(2);
    expect(updated.place.category).toBe('cafe');
    expect(updated.place.paymentMethods).toBe('onchain');
    expect(updated.place.techProvider).toBe('DFX.swiss');
    expect(updated.place.shopType).toBe('Others');
    expect(updated.place.country).toBe('CH');
    expect(updated.place.street).toBe('Bahnhofstrasse');
    expect(updated.place.houseNumber).toBe('12');
    expect(updated.place.postalCode).toBe('8001');
    expect(updated.place.city).toBe('Zürich');
  });

  it('resets techProvider to DFX.swiss on upsert when omitted', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.upsert({ ...input, techProvider: '21.gifts' });
    const reset = store.upsert({ ...input, name: 'Reset Label' });
    expect(reset.place.name).toBe('Reset Label');
    expect(reset.place.techProvider).toBe('DFX.swiss');
    const changed = store.upsert({ ...input, name: 'Changed', techProvider: '21.gifts' });
    expect(changed.place.name).toBe('Changed');
    expect(changed.place.techProvider).toBe('21.gifts');
  });

  it('applies the limit after filtering by origin', () => {
    let tick = 0;
    const store = new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    store.insertIfNew({ ...input, origin: 'spar', externalId: 'spar-1' });
    store.insertIfNew({ ...input, origin: 'dfx', externalId: 'dfx-1' });
    const listed = store.list(1, { origin: 'spar' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.origin).toBe('spar');
    expect(listed[0]?.externalId).toBe('spar-1');
  });

  it('returns the older CH pin when a newer pin has another country', () => {
    let tick = 0;
    const store = new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    store.insertIfNew({ ...input, externalId: 'ch-old', country: 'CH', postalCode: '8001' });
    store.insertIfNew({ ...input, externalId: 'de-new', country: 'DE', postalCode: '10115' });
    expect(store.list(1).map((row) => row.externalId)).toEqual(['de-new']);
    const listed = store.list(1, { country: 'CH' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.externalId).toBe('ch-old');
    expect(listed[0]?.country).toBe('CH');
  });

  it('lists SPAR shop types and Others separately', () => {
    let tick = 0;
    const store = new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    store.insertIfNew({ ...input, externalId: 'spar-brand', shopType: 'SPAR' });
    store.insertIfNew({ ...input, externalId: 'other-brand', shopType: 'Others' });
    const spar = store.list(10, { shopType: 'SPAR' });
    expect(spar.map((row) => row.externalId)).toEqual(['spar-brand']);
    const others = store.list(10, { shopType: 'Others' });
    expect(others.map((row) => row.externalId)).toEqual(['other-brand']);
    expect(others.every((row) => row.shopType === 'Others')).toBe(true);
  });

  it('uses the payment-link catalog when a pin has no support rows', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.insertIfNew({ ...input, externalId: 'dfx-open' });
    store.insertIfNew({
      ...input,
      origin: '21gifts',
      externalId: 'gifts-open',
      techProvider: '21.gifts',
    });
    store.insertIfNew({
      ...input,
      origin: '21gifts',
      externalId: 'origin-only',
    });
    store.insertIfNew({
      ...input,
      externalId: 'label-only',
      techProvider: '21.gifts',
    });
    store.insertIfNew({
      ...input,
      externalId: 'stated',
      supports: [{ blockchain: 'Polygon', asset: 'ZCHF' }],
    });
    const ids = (filter: { blockchain?: string; asset?: string; shopType?: ShopType }): string[] =>
      store.list(10, filter).map((row) => row.externalId);

    expect(ids({ blockchain: 'Ethereum' }).sort()).toEqual(['dfx-open']);
    expect(ids({ blockchain: 'Lightning', asset: 'BTC' }).sort()).toEqual([
      'dfx-open',
      'gifts-open',
      'label-only',
      'origin-only',
    ]);
    expect(ids({ blockchain: 'Ethereum', asset: 'BTC' })).toEqual([]);
    expect(ids({ blockchain: 'Plasma' })).toEqual([]);
    expect(ids({ blockchain: 'BinancePay' }).sort()).toEqual(['dfx-open']);
    expect(ids({ asset: 'ckBTC' }).sort()).toEqual(['dfx-open']);
    expect(ids({ blockchain: 'Bitcoin' }).sort()).toEqual(['dfx-open']);
    expect(ids({ blockchain: 'Polygon', asset: 'ZCHF' }).sort()).toEqual(['dfx-open', 'stated']);
    expect(ids({ shopType: 'SPAR' }).sort()).toEqual([
      'dfx-open',
      'gifts-open',
      'label-only',
      'origin-only',
      'stated',
    ]);
    expect(ids({ shopType: 'Others' })).toEqual([]);
  });

  it('requires blockchain and asset to match the same support row', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.insertIfNew({
      ...input,
      supports: [
        { blockchain: 'Polygon', asset: 'ZCHF' },
        { blockchain: 'Ethereum', asset: 'ETH' },
      ],
    });
    expect(store.list(10, { blockchain: 'Ethereum', asset: 'ZCHF' })).toHaveLength(0);
    expect(store.list(10, { blockchain: 'Bitcoin' })).toHaveLength(0);
    expect(store.list(10, { asset: 'BTC' })).toHaveLength(0);
    expect(store.list(10, { blockchain: 'Ethereum' }).map((row) => row.externalId)).toEqual([
      'store-1',
    ]);
    expect(store.list(10, { asset: 'ZCHF' }).map((row) => row.externalId)).toEqual(['store-1']);
    expect(
      store.list(10, { blockchain: 'Polygon', asset: 'ZCHF' }).map((row) => row.externalId),
    ).toEqual(['store-1']);
    expect(
      store.list(10, { blockchain: 'Ethereum', asset: 'ETH' }).map((row) => row.externalId),
    ).toEqual(['store-1']);
  });

  it('sorts supports and copies them so a caller cannot mutate the store', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    const created = store.insertIfNew({
      ...input,
      supports: [
        { blockchain: 'Polygon', asset: 'USDT' },
        { blockchain: 'Ethereum', asset: 'ZCHF' },
        { blockchain: 'Ethereum', asset: 'ETH' },
        { blockchain: 'Ethereum', asset: 'ZCHF' },
      ],
    });
    expect(created.place.supports).toEqual([
      { blockchain: 'Ethereum', asset: 'ETH' },
      { blockchain: 'Ethereum', asset: 'ZCHF' },
      { blockchain: 'Polygon', asset: 'USDT' },
    ]);
    created.place.supports.push({ blockchain: 'Bitcoin', asset: 'BTC' });
    expect(store.list(1)[0]?.supports).toEqual([
      { blockchain: 'Ethereum', asset: 'ETH' },
      { blockchain: 'Ethereum', asset: 'ZCHF' },
      { blockchain: 'Polygon', asset: 'USDT' },
    ]);
  });

  it('keeps same-chain supports that arrive in ascending asset order', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    const created = store.insertIfNew({
      ...input,
      supports: [
        { blockchain: 'Ethereum', asset: 'ETH' },
        { blockchain: 'Ethereum', asset: 'ZCHF' },
      ],
    });
    expect(created.place.supports).toEqual([
      { blockchain: 'Ethereum', asset: 'ETH' },
      { blockchain: 'Ethereum', asset: 'ZCHF' },
    ]);
  });

  it('does not replace fields on a repeated insert', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.insertIfNew({
      ...input,
      country: 'CH',
      street: 'Bahnhofstrasse',
      houseNumber: '12',
      postalCode: '8001',
      city: 'Zürich',
      shopType: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const again = store.insertIfNew({
      ...input,
      name: 'Other',
      country: 'DE',
      street: 'Other Street',
      houseNumber: '99',
      postalCode: '10115',
      city: 'Berlin',
      shopType: 'Others',
      supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
    });
    expect(again.created).toBe(false);
    expect(again.place.name).toBe('SPAR Triesen');
    expect(again.place.country).toBe('CH');
    expect(again.place.street).toBe('Bahnhofstrasse');
    expect(again.place.houseNumber).toBe('12');
    expect(again.place.postalCode).toBe('8001');
    expect(again.place.city).toBe('Zürich');
    expect(again.place.shopType).toBe('SPAR');
    expect(again.place.supports).toEqual([{ blockchain: 'Ethereum', asset: 'ZCHF' }]);
  });

  it('replaces supports with an empty list on upsert when sent empty', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.upsert({
      ...input,
      country: 'CH',
      postalCode: '8001',
      shopType: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const emptied = store.upsert({
      ...input,
      name: 'Other Shop',
      description: OTHER_DESCRIPTION,
      country: 'DE',
      postalCode: '10115',
      shopType: 'Others',
      supports: [],
    });
    expect(emptied.place.country).toBe('DE');
    expect(emptied.place.shopType).toBe('Others');
    expect(emptied.place.supports).toEqual([]);
  });

  it('hides incomplete rows from list and countries', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.insertIfNew({ ...input, externalId: 'complete', country: 'LI' });
    const blanks: Array<Partial<MapPlaceInput> & { externalId: string }> = [
      { externalId: 'empty-name', name: '', country: 'CH' },
      { externalId: 'empty-description', description: '', country: 'DE' },
      { externalId: 'empty-street', street: '', country: 'AT' },
      { externalId: 'empty-house', houseNumber: '', country: 'FR' },
      { externalId: 'empty-postal', postalCode: '', country: 'IT' },
      { externalId: 'empty-city', city: '', country: 'ES' },
      { externalId: 'empty-country', country: '' },
      { externalId: 'bad-type', shopType: 'Migros' as ShopType, country: 'NL' },
    ];
    for (const row of blanks) {
      store.insertIfNew({ ...input, ...row });
    }
    expect(store.list(20).map((row) => row.externalId)).toEqual(['complete']);
    expect(store.filters().countries).toEqual(['LI']);
    expect(store.list(20, { country: 'CH' })).toHaveLength(0);
    expect(store.list(20, { shopType: 'SPAR' }).map((row) => row.externalId)).toEqual(['complete']);
  });

  it('returns distinct sorted filter values and restricts assets by blockchain', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    expect(store.filters()).toEqual({ countries: [], blockchains: [], assets: [] });
    store.insertIfNew({
      ...input,
      country: 'CH',
      postalCode: '8001',
      shopType: 'SPAR',
      supports: [
        { blockchain: 'Ethereum', asset: 'ZCHF' },
        { blockchain: 'Polygon', asset: 'USDT' },
      ],
    });
    store.insertIfNew({
      ...input,
      externalId: 'store-2',
      country: 'DE',
      postalCode: '10115',
      supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
    });
    store.insertIfNew({ ...input, externalId: 'none' });
    store.insertIfNew({ ...input, externalId: 'hidden', name: '', country: 'FR' });
    expect(store.filters()).toEqual({
      countries: ['CH', 'DE', 'LI'],
      blockchains: ['Bitcoin', 'Ethereum', 'Polygon'],
      assets: ['BTC', 'USDT', 'ZCHF'],
    });
    expect(store.filters('Ethereum')).toEqual({
      countries: ['CH', 'DE', 'LI'],
      blockchains: ['Bitcoin', 'Ethereum', 'Polygon'],
      assets: ['ZCHF'],
    });
    expect(store.filters('Sepolia')).toEqual({
      countries: ['CH', 'DE', 'LI'],
      blockchains: ['Bitcoin', 'Ethereum', 'Polygon'],
      assets: [],
    });
  });

  it('applies AND predicates before the limit', () => {
    let tick = 0;
    const store = new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    store.insertIfNew({
      ...input,
      origin: 'spar',
      externalId: 'match',
      country: 'CH',
      postalCode: '8001',
      shopType: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    store.insertIfNew({
      ...input,
      origin: 'spar',
      externalId: 'miss',
      country: 'DE',
      postalCode: '10115',
      shopType: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const listed = store.list(1, {
      origin: 'spar',
      country: 'CH',
      shopType: 'SPAR',
      blockchain: 'Ethereum',
      asset: 'ZCHF',
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.externalId).toBe('match');
  });

  it('deletes by key and reports a miss', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    expect(store.deleteByKey('dfx', 'store-1')).toBe(false);
    store.insertIfNew({
      ...input,
      country: 'CH',
      postalCode: '8001',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    expect(store.deleteByKey('dfx', 'store-1')).toBe(true);
    expect(store.list(10)).toHaveLength(0);
    expect(store.filters()).toEqual({ countries: [], blockchains: [], assets: [] });
    expect(store.deleteByKey('dfx', 'store-1')).toBe(false);
  });

  it('records a newer transaction instant and does not move backward', () => {
    const nowMs = Date.parse('2026-09-26T18:00:00.000Z');
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    expect(
      store.recordTransaction('dfx', 'store-1', '2026-09-26T00:00:00.000Z', nowMs),
    ).toBeUndefined();
    expect(store.list(10)).toHaveLength(0);
    const created = store.insertIfNew(input);
    expect(created.place.lastTransactionAt).toBeNull();
    expect(created.place.activity).toBe('none');
    const moved = store.recordTransaction('dfx', 'store-1', '2026-09-26T12:00:00Z', nowMs);
    expect(moved?.lastTransactionAt).toBe('2026-09-26T12:00:00.000Z');
    expect(moved?.activity).toBe('within7Days');
    const newer = '2026-09-26T18:00:00.000Z';
    const forwarded = store.recordTransaction('dfx', 'store-1', newer, nowMs);
    expect(forwarded?.lastTransactionAt).toBe(newer);
    const older = store.recordTransaction('dfx', 'store-1', '2026-09-26T06:00:00.000Z', nowMs);
    expect(older?.lastTransactionAt).toBe(newer);
    const equal = store.recordTransaction('dfx', 'store-1', '2026-09-26T18:00:00Z', nowMs);
    expect(equal?.lastTransactionAt).toBe(newer);
  });

  it('ignores an unparseable argument and keeps the timestamp on insert and upsert', () => {
    const nowMs = Date.parse('2026-09-26T00:00:00.000Z');
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.insertIfNew(input);
    const seeded = store.recordTransaction('dfx', 'store-1', 'not-a-date', nowMs);
    expect(seeded?.lastTransactionAt).toBeNull();
    expect(seeded?.activity).toBe('none');
    const iso = '2026-09-26T00:00:00.000Z';
    const replaced = store.recordTransaction('dfx', 'store-1', iso, nowMs);
    expect(replaced?.lastTransactionAt).toBe(iso);
    expect(replaced?.activity).toBe('within7Days');
    const ignored = store.recordTransaction('dfx', 'store-1', 'not-a-date', nowMs);
    expect(ignored?.lastTransactionAt).toBe(iso);
    expect(ignored?.activity).toBe('within7Days');
    const again = store.insertIfNew({ ...input, name: 'Other' });
    expect(again.created).toBe(false);
    expect(again.place.lastTransactionAt).toBe(iso);
    expect(again.place.activity).toBe('within7Days');
    const updated = store.upsert({ ...input, name: 'Renamed' });
    expect(updated.place.name).toBe('Renamed');
    expect(updated.place.lastTransactionAt).toBe(iso);
    expect(updated.place.activity).toBe('within7Days');
    if (replaced !== undefined) {
      replaced.lastTransactionAt = 'mutated';
      replaced.activity = 'none';
    }
    expect(store.list(1)[0]?.lastTransactionAt).toBe(iso);
    expect(store.list(1)[0]?.activity).toBe('within7Days');
  });

  it('stores in-window days, ignores an outside day, and becomes daily at five distinct UTC days', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    store.insertIfNew(input);
    const day = (value: string): string => `${value}T12:00:00.000Z`;
    expect(store.recordTransaction('dfx', 'store-1', day('2026-10-08'), nowMs)?.activity).toBe(
      'within7Days',
    );
    expect(store.recordTransaction('dfx', 'store-1', day('2026-10-07'), nowMs)?.activity).toBe(
      'within7Days',
    );
    expect(store.recordTransaction('dfx', 'store-1', day('2026-10-06'), nowMs)?.activity).toBe(
      'within7Days',
    );
    const four = store.recordTransaction('dfx', 'store-1', day('2026-10-05'), nowMs);
    expect(four?.activity).toBe('within7Days');
    expect(four?.lastTransactionAt).toBe(day('2026-10-08'));
    const twice = store.recordTransaction('dfx', 'store-1', '2026-10-05T18:00:00.000Z', nowMs);
    expect(twice?.activity).toBe('within7Days');
    expect(twice?.lastTransactionAt).toBe(day('2026-10-08'));
    const outside = store.recordTransaction('dfx', 'store-1', day('2026-10-01'), nowMs);
    expect(outside?.activity).toBe('within7Days');
    expect(outside?.lastTransactionAt).toBe(day('2026-10-08'));
    const future = store.recordTransaction('dfx', 'store-1', day('2026-10-09'), nowMs);
    expect(future?.activity).toBe('within7Days');
    expect(future?.lastTransactionAt).toBe(day('2026-10-09'));
    const daily = store.recordTransaction('dfx', 'store-1', day('2026-10-04'), nowMs);
    expect(daily?.activity).toBe('daily');
    expect(daily?.lastTransactionAt).toBe(day('2026-10-09'));
  });

  it('deletes payment days older than the window start on a later parseable write', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-10-01T12:00:00.000Z'));
    store.insertIfNew(input);
    const first = '2026-10-01T12:00:00.000Z';
    store.recordTransaction('dfx', 'store-1', first, Date.parse(first));
    const later = '2026-10-09T12:00:00.000Z';
    const recorded = store.recordTransaction('dfx', 'store-1', later, Date.parse(later));
    expect(recorded?.lastTransactionAt).toBe(later);
    expect(recorded?.activity).toBe('within7Days');
  });

  it('adds an older in-window day without moving lastTransactionAt backward', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    store.insertIfNew(input);
    const recent = '2026-10-08T12:00:00.000Z';
    store.recordTransaction('dfx', 'store-1', recent, nowMs);
    const older = store.recordTransaction('dfx', 'store-1', '2026-10-07T08:00:00.000Z', nowMs);
    expect(older?.lastTransactionAt).toBe(recent);
    expect(older?.activity).toBe('within7Days');
  });

  it('stores olderThan30Days for a parseable instant older than 30 days', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    store.insertIfNew(input);
    const oldIso = new Date(nowMs - (30 * 24 * 60 * 60 * 1000 + 1)).toISOString();
    const recorded = store.recordTransaction('dfx', 'store-1', oldIso, nowMs);
    expect(recorded?.lastTransactionAt).toBe(oldIso);
    expect(recorded?.activity).toBe('olderThan30Days');
    store.refreshActivity(nowMs);
    expect(store.list(1)[0]?.activity).toBe('olderThan30Days');
  });

  it('returns none after delete then insert and keeps activity on upsert', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    store.insertIfNew(input);
    store.recordTransaction('dfx', 'store-1', '2026-10-08T12:00:00.000Z', nowMs);
    const kept = store.upsert({ ...input, name: 'Renamed' });
    expect(kept.place.name).toBe('Renamed');
    expect(kept.place.activity).toBe('within7Days');
    expect(kept.place.lastTransactionAt).toBe('2026-10-08T12:00:00.000Z');
    expect(store.deleteByKey('dfx', 'store-1')).toBe(true);
    const created = store.insertIfNew(input);
    expect(created.created).toBe(true);
    expect(created.place.activity).toBe('none');
    expect(created.place.lastTransactionAt).toBeNull();
  });

  it('does not change GET-copied activity until refreshActivity at the due clock', () => {
    const nowMs = Date.parse('2026-10-08T00:00:00.000Z');
    const seven = 7 * 24 * 60 * 60 * 1000;
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    store.insertIfNew(input);
    const last = new Date(nowMs - seven).toISOString();
    const recorded = store.recordTransaction('dfx', 'store-1', last, nowMs);
    expect(recorded?.activity).toBe('within7Days');
    store.refreshActivity(nowMs);
    expect(store.list(1)[0]?.activity).toBe('within7Days');
    store.refreshActivity(nowMs + 1);
    expect(store.list(1)[0]?.activity).toBe('within30Days');
  });

  it('keeps daily before the pivot midnight and drops it at that instant', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    store.insertIfNew(input);
    const day = (value: string): string => `${value}T12:00:00.000Z`;
    store.recordTransaction('dfx', 'store-1', day('2026-10-04'), nowMs);
    store.recordTransaction('dfx', 'store-1', day('2026-10-05'), nowMs);
    store.recordTransaction('dfx', 'store-1', day('2026-10-06'), nowMs);
    store.recordTransaction('dfx', 'store-1', day('2026-10-07'), nowMs);
    const daily = store.recordTransaction('dfx', 'store-1', day('2026-10-08'), nowMs);
    expect(daily?.activity).toBe('daily');
    expect(daily?.lastTransactionAt).toBe(day('2026-10-08'));
    const pivotMidnight = Date.parse('2026-10-11T00:00:00.000Z');
    store.refreshActivity(pivotMidnight - 1);
    expect(store.list(1)[0]?.activity).toBe('daily');
    store.refreshActivity(pivotMidnight);
    expect(store.list(1)[0]?.activity).toBe('within7Days');
    expect(store.list(1)[0]?.lastTransactionAt).toBe(day('2026-10-08'));
  });

  it('refreshes a due within30Days row to olderThan30Days', () => {
    const nowMs = Date.parse('2026-10-08T00:00:00.000Z');
    const thirty = 30 * 24 * 60 * 60 * 1000;
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    store.insertIfNew(input);
    store.refreshActivity(nowMs);
    expect(store.list(1)[0]?.activity).toBe('none');
    const last = new Date(nowMs - thirty).toISOString();
    expect(store.recordTransaction('dfx', 'store-1', last, nowMs)?.activity).toBe('within30Days');
    store.refreshActivity(nowMs + 1);
    expect(store.list(1)[0]?.activity).toBe('olderThan30Days');
  });
});

describe('placeProblems', () => {
  const place = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')).insertIfNew(
    input,
  ).place;

  it('names each empty field on its own', () => {
    expect(placeProblems({ ...place, name: '' })).toEqual(['name is empty']);
    expect(placeProblems({ ...place, description: '' })).toEqual(['description is empty']);
    expect(placeProblems({ ...place, street: '' })).toEqual(['street is empty']);
    expect(placeProblems({ ...place, houseNumber: '' })).toEqual(['houseNumber is empty']);
    expect(placeProblems({ ...place, postalCode: '' })).toEqual(['postalCode is empty']);
    expect(placeProblems({ ...place, city: '' })).toEqual(['city is empty']);
    expect(placeProblems({ ...place, country: '' })).toEqual(['country is empty']);
  });

  it('names an invalid shop type and an invalid instant', () => {
    expect(placeProblems({ ...place, shopType: 'Migros' as ShopType })).toEqual([
      'shopType must be SPAR or Others',
    ]);
    expect(placeProblems({ ...place, lastTransactionAt: 'not-a-date' })).toEqual([
      'lastTransactionAt is not a valid instant',
    ]);
  });

  it('returns no problems for a complete pin', () => {
    expect(placeProblems(place)).toEqual([]);
  });

  it('lists every problem in check order', () => {
    expect(
      placeProblems({
        ...place,
        name: '',
        description: '',
        street: '',
        houseNumber: '',
        postalCode: '',
        city: '',
        country: '',
        shopType: 'Migros' as ShopType,
        lastTransactionAt: 'not-a-date',
      }),
    ).toEqual([
      'name is empty',
      'description is empty',
      'street is empty',
      'houseNumber is empty',
      'postalCode is empty',
      'city is empty',
      'country is empty',
      'shopType must be SPAR or Others',
      'lastTransactionAt is not a valid instant',
    ]);
  });
});

describe('MemoryMapPlaceStore.listAll', () => {
  it('lists incomplete rows newest first and returns copies', () => {
    let tick = 0;
    const store = new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    store.insertIfNew(input);
    store.insertIfNew({ ...input, externalId: 'blank', name: '' });
    store.insertIfNew({ ...input, externalId: 'newer' });
    expect(store.list(10).map((row) => row.externalId)).toEqual(['newer', 'store-1']);
    const all = store.listAll();
    expect(all.map((row) => row.externalId)).toEqual(['newer', 'blank', 'store-1']);
    const blank = all.find((row) => row.externalId === 'blank');
    expect(blank).toBeDefined();
    if (blank !== undefined) {
      blank.name = 'mutated';
      blank.supports.push({ blockchain: 'Bitcoin', asset: 'BTC' });
    }
    const again = store.listAll().find((row) => row.externalId === 'blank');
    expect(again?.name).toBe('');
    expect(again?.supports).toEqual([]);
  });
});
