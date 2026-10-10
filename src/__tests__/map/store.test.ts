import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAP_PLACE_SCHEMA_SQL, MemoryMapPlaceStore } from '@/lib/map/store';
import type { MapPlaceInput } from '@/lib/map/place';

const input: MapPlaceInput = {
  origin: 'dfx',
  externalId: 'store-1',
  name: 'SPAR',
  lat: 47.37,
  lon: 8.54,
  category: 'groceries',
  paymentMethods: 'lightning',
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
    expect(first.place.country).toBeNull();
    expect(first.place.shopName).toBeNull();
    expect(first.place.supports).toEqual([]);
    const second = store.insertIfNew({ ...input, name: 'Other', lat: 1 });
    expect(second.created).toBe(false);
    expect(second.place.name).toBe('SPAR');
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
    expect(again.place.name).toBe('SPAR');
    expect(again.place.techProvider).toBe('21.gifts');
  });

  it('upserts a new pair and updates fields on an existing pair', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    const created = store.upsert(input);
    expect(created.created).toBe(true);
    expect(created.place.techProvider).toBe('DFX.swiss');
    const updated = store.upsert({
      ...input,
      name: 'Other',
      lat: 1,
      lon: 2,
      category: 'cafe',
      paymentMethods: 'onchain',
      country: 'DE',
      shopName: 'Migros',
    });
    expect(updated.created).toBe(false);
    expect(updated.place.id).toBe(created.place.id);
    expect(updated.place.createdAt).toBe(created.place.createdAt);
    expect(updated.place.name).toBe('Other');
    expect(updated.place.lat).toBe(1);
    expect(updated.place.lon).toBe(2);
    expect(updated.place.category).toBe('cafe');
    expect(updated.place.paymentMethods).toBe('onchain');
    expect(updated.place.techProvider).toBe('DFX.swiss');
    expect(updated.place.country).toBe('DE');
    expect(updated.place.shopName).toBe('Migros');
  });

  it('keeps techProvider on upsert when omitted and changes it when sent', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.upsert({ ...input, techProvider: '21.gifts' });
    const kept = store.upsert({ ...input, name: 'Kept' });
    expect(kept.place.name).toBe('Kept');
    expect(kept.place.techProvider).toBe('21.gifts');
    const changed = store.upsert({ ...input, name: 'Changed', techProvider: 'DFX.swiss' });
    expect(changed.place.name).toBe('Changed');
    expect(changed.place.techProvider).toBe('DFX.swiss');
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
    store.insertIfNew({ ...input, externalId: 'ch-old', country: 'CH' });
    store.insertIfNew({ ...input, externalId: 'de-new', country: 'DE' });
    expect(store.list(1).map((row) => row.externalId)).toEqual(['de-new']);
    const listed = store.list(1, { country: 'CH' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.externalId).toBe('ch-old');
    expect(listed[0]?.country).toBe('CH');
  });

  it('lists SPAR shop names and treats a missing brand as others', () => {
    let tick = 0;
    const store = new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    store.insertIfNew({ ...input, externalId: 'spar-brand', shopName: 'SPAR' });
    store.insertIfNew({ ...input, externalId: 'migros', shopName: 'Migros' });
    store.insertIfNew({ ...input, externalId: 'none' });
    const spar = store.list(10, { shopName: 'SPAR' });
    expect(spar.map((row) => row.externalId)).toEqual(['spar-brand']);
    const others = store.list(10, { shopName: 'others' });
    expect(others.map((row) => row.externalId)).toEqual(['none', 'migros']);
    expect(others.every((row) => row.shopName !== 'SPAR')).toBe(true);
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
    const ids = (filter: {
      blockchain?: string;
      asset?: string;
      shopName?: 'SPAR' | 'others';
    }): string[] => store.list(10, filter).map((row) => row.externalId);

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
    expect(ids({ shopName: 'SPAR' })).toEqual([]);
    expect(ids({ shopName: 'others' }).sort()).toEqual([
      'dfx-open',
      'gifts-open',
      'label-only',
      'origin-only',
      'stated',
    ]);
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

  it('does not replace country, shop name, or supports on a repeated insert', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.insertIfNew({
      ...input,
      country: 'CH',
      shopName: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const again = store.insertIfNew({
      ...input,
      name: 'Other',
      country: 'DE',
      shopName: 'Migros',
      supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
    });
    expect(again.created).toBe(false);
    expect(again.place.name).toBe('SPAR');
    expect(again.place.country).toBe('CH');
    expect(again.place.shopName).toBe('SPAR');
    expect(again.place.supports).toEqual([{ blockchain: 'Ethereum', asset: 'ZCHF' }]);
  });

  it('sets omitted country and shop name to null on upsert and leaves supports', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.upsert({
      ...input,
      country: 'CH',
      shopName: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const omitted = store.upsert({ ...input, name: 'Other' });
    expect(omitted.place.name).toBe('Other');
    expect(omitted.place.country).toBeNull();
    expect(omitted.place.shopName).toBeNull();
    expect(omitted.place.supports).toEqual([{ blockchain: 'Ethereum', asset: 'ZCHF' }]);
  });

  it('clears supports on upsert when the body sends an empty list', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.upsert({
      ...input,
      country: 'CH',
      shopName: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const emptied = store.upsert({
      ...input,
      country: 'DE',
      shopName: 'Migros',
      supports: [],
    });
    expect(emptied.place.country).toBe('DE');
    expect(emptied.place.shopName).toBe('Migros');
    expect(emptied.place.supports).toEqual([]);
  });

  it('returns distinct sorted filter values and restricts assets by blockchain', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    expect(store.filters()).toEqual({ countries: [], blockchains: [], assets: [] });
    store.insertIfNew({
      ...input,
      country: 'CH',
      shopName: 'SPAR',
      supports: [
        { blockchain: 'Ethereum', asset: 'ZCHF' },
        { blockchain: 'Polygon', asset: 'USDT' },
      ],
    });
    store.insertIfNew({
      ...input,
      externalId: 'store-2',
      country: 'DE',
      supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
    });
    store.insertIfNew({ ...input, externalId: 'none' });
    expect(store.filters()).toEqual({
      countries: ['CH', 'DE'],
      blockchains: ['Bitcoin', 'Ethereum', 'Polygon'],
      assets: ['BTC', 'USDT', 'ZCHF'],
    });
    expect(store.filters('Ethereum')).toEqual({
      countries: ['CH', 'DE'],
      blockchains: ['Bitcoin', 'Ethereum', 'Polygon'],
      assets: ['ZCHF'],
    });
    expect(store.filters('Sepolia')).toEqual({
      countries: ['CH', 'DE'],
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
      shopName: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    store.insertIfNew({
      ...input,
      origin: 'spar',
      externalId: 'miss',
      country: 'DE',
      shopName: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const listed = store.list(1, {
      origin: 'spar',
      country: 'CH',
      shopName: 'SPAR',
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
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    expect(store.deleteByKey('dfx', 'store-1')).toBe(true);
    expect(store.list(10)).toHaveLength(0);
    expect(store.filters()).toEqual({ countries: [], blockchains: [], assets: [] });
    expect(store.deleteByKey('dfx', 'store-1')).toBe(false);
  });

  it('records a newer transaction instant and does not move backward', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    expect(store.recordTransaction('dfx', 'store-1', '2026-09-26T00:00:00.000Z')).toBeUndefined();
    expect(store.list(10)).toHaveLength(0);
    const created = store.insertIfNew(input);
    expect(created.place.lastTransactionAt).toBeNull();
    const moved = store.recordTransaction('dfx', 'store-1', '2026-09-26T12:00:00Z');
    expect(moved?.lastTransactionAt).toBe('2026-09-26T12:00:00.000Z');
    const newer = '2026-09-26T18:00:00.000Z';
    const forwarded = store.recordTransaction('dfx', 'store-1', newer);
    expect(forwarded?.lastTransactionAt).toBe(newer);
    const older = store.recordTransaction('dfx', 'store-1', '2026-09-26T06:00:00.000Z');
    expect(older?.lastTransactionAt).toBe(newer);
    const equal = store.recordTransaction('dfx', 'store-1', '2026-09-26T18:00:00Z');
    expect(equal?.lastTransactionAt).toBe(newer);
  });

  it('ignores an unparseable argument and keeps the timestamp on insert and upsert', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    store.insertIfNew(input);
    const seeded = store.recordTransaction('dfx', 'store-1', 'not-a-date');
    expect(seeded?.lastTransactionAt).toBeNull();
    const iso = '2026-09-26T00:00:00.000Z';
    const replaced = store.recordTransaction('dfx', 'store-1', iso);
    expect(replaced?.lastTransactionAt).toBe(iso);
    const ignored = store.recordTransaction('dfx', 'store-1', 'not-a-date');
    expect(ignored?.lastTransactionAt).toBe(iso);
    const again = store.insertIfNew({ ...input, name: 'Other' });
    expect(again.created).toBe(false);
    expect(again.place.lastTransactionAt).toBe(iso);
    const updated = store.upsert({ ...input, name: 'Renamed' });
    expect(updated.place.name).toBe('Renamed');
    expect(updated.place.lastTransactionAt).toBe(iso);
    if (replaced !== undefined) {
      replaced.lastTransactionAt = 'mutated';
    }
    expect(store.list(1)[0]?.lastTransactionAt).toBe(iso);
  });
});
