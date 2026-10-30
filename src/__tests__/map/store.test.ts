import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAP_PLACE_SCHEMA_SQL,
  MemoryMapPlaceStore,
  placeNameConflict,
  placeProblems,
  placeWriteConflict,
} from '@/lib/map/store';
import type { MapPlaceInput, ShopType } from '@/lib/map/place';
import { keyFor, keyedStore } from './keys';
import { base64, simplePng } from './photo-fixtures';
import { preparePhoto, type PreparedPhoto } from '@/lib/map/photo';

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
    const store = keyedStore(
      new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))),
    );
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
    const later = store.insertIfNew({ ...input, externalId: 'store-2', name: 'SPAR Triesen 2' });
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
    const rising = keyedStore(
      new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))),
    );
    rising.insertIfNew({ ...input, externalId: 'older', name: 'Older' });
    rising.insertIfNew({ ...input, externalId: 'newer', name: 'Newer' });
    expect(rising.list(10).map((row) => row.externalId)).toEqual(['newer', 'older']);

    const fixed = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
    const a = fixed.insertIfNew({ ...input, externalId: 'a', name: 'Pin A' });
    const b = fixed.insertIfNew({ ...input, externalId: 'b', name: 'Pin B' });
    const expected = [a.place.id, b.place.id].sort((left, right) => right.localeCompare(left));
    expect(fixed.list(10).map((row) => row.id)).toEqual(expected);
  });

  it('defaults an omitted tech provider and stores an explicit value on insert', () => {
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
    const omitted = store.insertIfNew(input);
    expect(omitted.place.techProvider).toBe('DFX.swiss');
    const labeled = store.insertIfNew({
      ...input,
      externalId: 'store-labeled',
      name: 'Labeled Shop',
      techProvider: '21.gifts',
    });
    expect(labeled.created).toBe(true);
    expect(labeled.place.techProvider).toBe('21.gifts');
  });

  it('does not change techProvider on a repeated insert', () => {
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
    store.insertIfNew({ ...input, techProvider: '21.gifts' });
    const again = store.insertIfNew({ ...input, name: 'Other', techProvider: 'Other.lab' });
    expect(again.created).toBe(false);
    expect(again.place.name).toBe('SPAR Triesen');
    expect(again.place.techProvider).toBe('21.gifts');
  });

  it('upserts a new pair and replaces every field on an existing pair', () => {
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
    const store = keyedStore(
      new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))),
    );
    store.insertIfNew({ ...input, origin: 'spar', externalId: 'spar-1', name: 'Spar Origin' });
    store.insertIfNew({ ...input, origin: 'dfx', externalId: 'dfx-1', name: 'Dfx Origin' });
    const listed = store.list(1, { origin: 'spar' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.origin).toBe('spar');
    expect(listed[0]?.externalId).toBe('spar-1');
  });

  it('returns the older CH pin when a newer pin has another country', () => {
    let tick = 0;
    const store = keyedStore(
      new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))),
    );
    store.insertIfNew({
      ...input,
      externalId: 'ch-old',
      name: 'CH Old',
      country: 'CH',
      postalCode: '8001',
    });
    store.insertIfNew({
      ...input,
      externalId: 'de-new',
      name: 'DE New',
      country: 'DE',
      postalCode: '10115',
    });
    expect(store.list(1).map((row) => row.externalId)).toEqual(['de-new']);
    const listed = store.list(1, { country: 'CH' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.externalId).toBe('ch-old');
    expect(listed[0]?.country).toBe('CH');
  });

  it('lists SPAR shop types and Others separately', () => {
    let tick = 0;
    const store = keyedStore(
      new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))),
    );
    store.insertIfNew({ ...input, externalId: 'spar-brand', name: 'Spar Brand', shopType: 'SPAR' });
    store.insertIfNew({
      ...input,
      externalId: 'other-brand',
      name: 'Other Brand',
      shopType: 'Others',
    });
    const spar = store.list(10, { shopType: 'SPAR' });
    expect(spar.map((row) => row.externalId)).toEqual(['spar-brand']);
    const others = store.list(10, { shopType: 'Others' });
    expect(others.map((row) => row.externalId)).toEqual(['other-brand']);
    expect(others.every((row) => row.shopType === 'Others')).toBe(true);
  });

  it('uses the payment-link catalog when a pin has no support rows', () => {
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
    store.insertIfNew({ ...input, externalId: 'dfx-open', name: 'Dfx Open' });
    store.insertIfNew({
      ...input,
      origin: '21gifts',
      externalId: 'gifts-open',
      name: 'Gifts Open',
      techProvider: '21.gifts',
    });
    store.insertIfNew({
      ...input,
      origin: '21gifts',
      externalId: 'origin-only',
      name: 'Origin Only',
    });
    store.insertIfNew({
      ...input,
      externalId: 'label-only',
      name: 'Label Only',
      techProvider: '21.gifts',
    });
    store.insertIfNew({
      ...input,
      externalId: 'stated',
      name: 'Stated Supports',
      supports: [{ blockchain: 'Polygon', asset: 'ZCHF' }],
    });
    const ids = (filter: { blockchain?: string; asset?: string; shopType?: ShopType }): string[] =>
      store.list(10, filter).map((row) => row.externalId);

    const dfxIds = ['dfx-open', 'origin-only', 'stated'];
    const bothIds = ['dfx-open', 'gifts-open', 'label-only', 'origin-only', 'stated'];
    expect(ids({ blockchain: 'Ethereum' }).sort()).toEqual(bothIds);
    expect(ids({ blockchain: 'Lightning', asset: 'BTC' }).sort()).toEqual([
      'dfx-open',
      'gifts-open',
      'label-only',
      'origin-only',
      'stated',
    ]);
    expect(ids({ blockchain: 'Ethereum', asset: 'BTC' })).toEqual([]);
    expect(ids({ blockchain: 'Ethereum', asset: 'USDT' }).sort()).toEqual(bothIds);
    expect(ids({ blockchain: 'Plasma' }).sort()).toEqual(['gifts-open', 'label-only']);
    expect(ids({ blockchain: 'Arc', asset: 'USDC' }).sort()).toEqual(['gifts-open', 'label-only']);
    expect(ids({ blockchain: 'BinancePay' }).sort()).toEqual(dfxIds);
    expect(ids({ asset: 'ckBTC' }).sort()).toEqual(dfxIds);
    expect(ids({ blockchain: 'Bitcoin' }).sort()).toEqual(dfxIds);
    expect(ids({ blockchain: 'Polygon', asset: 'ZCHF' }).sort()).toEqual(dfxIds);
    expect(ids({ shopType: 'SPAR' }).sort()).toEqual([
      'dfx-open',
      'gifts-open',
      'label-only',
      'origin-only',
      'stated',
    ]);
    expect(ids({ shopType: 'Others' })).toEqual([]);
  });

  it('keeps the tech-provider offer when stored rows name other pairs', () => {
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
    store.insertIfNew({
      ...input,
      supports: [
        { blockchain: 'Polygon', asset: 'ZCHF' },
        { blockchain: 'Ethereum', asset: 'ETH' },
      ],
    });
    expect(store.list(10, { blockchain: 'Ethereum', asset: 'ZCHF' })).toHaveLength(1);
    expect(store.list(10, { blockchain: 'Bitcoin' })).toHaveLength(1);
    expect(store.list(10, { asset: 'BTC' })).toHaveLength(1);
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
    store.insertIfNew({ ...input, externalId: 'complete', country: 'LI' });
    const blanks: Array<Partial<MapPlaceInput> & { externalId: string }> = [
      { externalId: 'empty-name', name: '', country: 'CH' },
      {
        externalId: 'empty-description',
        name: 'Empty Description',
        description: '',
        country: 'DE',
      },
      { externalId: 'empty-street', name: 'Empty Street', street: '', country: 'AT' },
      { externalId: 'empty-house', name: 'Empty House', houseNumber: '', country: 'FR' },
      { externalId: 'empty-postal', name: 'Empty Postal', postalCode: '', country: 'IT' },
      { externalId: 'empty-city', name: 'Empty City', city: '', country: 'ES' },
      { externalId: 'empty-country', name: 'Empty Country', country: '' },
      { externalId: 'bad-type', name: 'Bad Type', shopType: 'Migros' as ShopType, country: 'NL' },
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
      name: 'Store Two',
      country: 'DE',
      postalCode: '10115',
      supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
    });
    store.insertIfNew({ ...input, externalId: 'none', name: 'No Supports' });
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
    const store = keyedStore(
      new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))),
    );
    store.insertIfNew({
      ...input,
      origin: 'spar',
      externalId: 'match',
      name: 'Match Pin',
      country: 'CH',
      postalCode: '8001',
      shopType: 'SPAR',
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    store.insertIfNew({
      ...input,
      origin: 'spar',
      externalId: 'miss',
      name: 'Miss Pin',
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date('2026-10-01T12:00:00.000Z')));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    store.insertIfNew(input);
    const recent = '2026-10-08T12:00:00.000Z';
    store.recordTransaction('dfx', 'store-1', recent, nowMs);
    const older = store.recordTransaction('dfx', 'store-1', '2026-10-07T08:00:00.000Z', nowMs);
    expect(older?.lastTransactionAt).toBe(recent);
    expect(older?.activity).toBe('within7Days');
  });

  it('stores olderThan30Days for a parseable instant older than 30 days', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
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
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    store.insertIfNew(input);
    store.refreshActivity(nowMs);
    expect(store.list(1)[0]?.activity).toBe('none');
    const last = new Date(nowMs - thirty).toISOString();
    expect(store.recordTransaction('dfx', 'store-1', last, nowMs)?.activity).toBe('within30Days');
    store.refreshActivity(nowMs + 1);
    expect(store.list(1)[0]?.activity).toBe('olderThan30Days');
  });

  it('reads a copy by id and deletes only that row', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    const created = store.insertIfNew({
      ...input,
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const other = store.insertIfNew({ ...input, externalId: 'store-2', name: 'Store Two' });
    store.recordTransaction('dfx', 'store-1', '2026-10-08T12:00:00.000Z', nowMs);
    store.recordTransaction('dfx', 'store-2', '2026-10-08T12:00:00.000Z', nowMs);
    expect(store.getById('store-1')).toBeUndefined();
    expect(store.getById('missing')).toBeUndefined();
    const found = store.getById(created.place.id);
    expect(found).toEqual(store.list(10).find((row) => row.id === created.place.id));
    if (found === undefined) {
      throw new Error('missing stored place');
    }
    found.name = 'mutated';
    found.supports.push({ blockchain: 'Bitcoin', asset: 'BTC' });
    expect(store.getById(created.place.id)?.name).toBe('SPAR Triesen');
    expect(store.getById(created.place.id)?.supports).toEqual([
      { blockchain: 'Ethereum', asset: 'ZCHF' },
    ]);
    expect(store.deleteById('missing')).toBe(false);
    expect(store.deleteById(created.place.id)).toBe(true);
    expect(store.getById(created.place.id)).toBeUndefined();
    expect(store.deleteByKey('dfx', 'store-1')).toBe(false);
    expect(store.getById(other.place.id)?.activity).toBe('within7Days');
    const again = store.insertIfNew(input);
    expect(again.created).toBe(true);
    expect(again.place.activity).toBe('none');
    expect(again.place.lastTransactionAt).toBeNull();
    expect(again.place.id).not.toBe(created.place.id);
  });

  it('returns missing and writes nothing when the id is unknown', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    const created = store.insertIfNew(input);
    const before = store.listAll();
    const result = store.replaceById({
      id: 'missing-id',
      content: { ...input, name: 'Should Not Insert', externalId: 'brand-new' },
      createdAt: '2020-01-01T00:00:00.000Z',
      lastTransactionAt: '2020-01-02T00:00:00.000Z',
      activity: { kind: 'set', activity: 'daily' },
      active: true,
      nowMs,
    });
    expect(result).toEqual({ status: 'missing' });
    expect(store.listAll()).toEqual(before);
    expect(store.getById(created.place.id)?.externalId).toBe('store-1');
    expect(store.listAll().some((row) => row.externalId === 'brand-new')).toBe(false);
  });

  it('returns conflict and leaves both rows unchanged', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    const first = store.insertIfNew({
      ...input,
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    const second = store.insertIfNew({
      ...input,
      origin: 'fremd',
      externalId: 'store-2',
      name: 'Second Shop',
    });
    const last = '2026-10-08T12:00:00.000Z';
    store.recordTransaction('dfx', 'store-1', last, nowMs);
    const beforeFirst = store.getById(first.place.id);
    const beforeSecond = store.getById(second.place.id);
    const result = store.replaceById({
      id: first.place.id,
      content: {
        ...input,
        origin: 'fremd',
        externalId: 'store-2',
        name: 'Hijack',
        supports: [{ blockchain: 'Bitcoin', asset: 'BTC' }],
      },
      createdAt: '2020-01-01T00:00:00.000Z',
      lastTransactionAt: null,
      activity: { kind: 'set', activity: 'daily' },
      active: true,
      nowMs,
    });
    expect(result).toEqual({ status: 'conflict' });
    expect(store.listAll()).toHaveLength(2);
    expect(store.getById(first.place.id)).toEqual(beforeFirst);
    expect(store.getById(second.place.id)).toEqual(beforeSecond);
    const until = Date.parse(last) + 7 * 24 * 60 * 60 * 1000 + 1;
    store.refreshActivity(until - 1);
    expect(store.getById(first.place.id)?.activity).toBe('within7Days');
    store.refreshActivity(until);
    expect(store.getById(first.place.id)?.activity).toBe('within30Days');
    expect(store.getById(first.place.id)?.lastTransactionAt).toBe(last);
    expect(store.getById(second.place.id)?.activity).toBe('none');
  });

  it('keeps activity and the refresh deadline while writing the other columns', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    const created = store.insertIfNew(input);
    const last = '2026-10-08T12:00:00.000Z';
    store.recordTransaction('dfx', 'store-1', last, nowMs);
    const sameOrigin = store.insertIfNew({ ...input, externalId: 'store-2', name: 'Same Origin' });
    const otherOrigin = store.insertIfNew({
      ...input,
      origin: 'fremd',
      externalId: 'store-3',
      name: 'Other Origin',
    });
    const until = Date.parse(last) + 7 * 24 * 60 * 60 * 1000 + 1;
    const updated = store.replaceById({
      id: created.place.id,
      content: {
        ...input,
        name: 'Kept Shop',
        techProvider: '21.gifts',
        supports: [
          { blockchain: 'Ethereum', asset: 'ZCHF' },
          { blockchain: 'Bitcoin', asset: 'BTC' },
          { blockchain: 'Bitcoin', asset: 'BTC' },
        ],
      },
      createdAt: '2024-01-01T00:00:00.000Z',
      lastTransactionAt: null,
      activity: { kind: 'keep' },
      active: true,
      nowMs,
    });
    expect(updated.status).toBe('updated');
    if (updated.status !== 'updated') {
      throw new Error('expected update');
    }
    expect(updated.place).toMatchObject({
      id: created.place.id,
      origin: 'dfx',
      externalId: 'store-1',
      name: 'Kept Shop',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastTransactionAt: null,
      activity: 'within7Days',
      techProvider: '21.gifts',
      supports: [
        { blockchain: 'Bitcoin', asset: 'BTC' },
        { blockchain: 'Ethereum', asset: 'ZCHF' },
      ],
    });
    updated.place.name = 'mutated';
    updated.place.supports.push({ blockchain: 'Polygon', asset: 'ZCHF' });
    expect(store.getById(created.place.id)?.name).toBe('Kept Shop');
    expect(store.getById(created.place.id)?.supports).toEqual([
      { blockchain: 'Bitcoin', asset: 'BTC' },
      { blockchain: 'Ethereum', asset: 'ZCHF' },
    ]);
    expect(store.listAll()).toHaveLength(3);
    expect(store.getById(sameOrigin.place.id)).toMatchObject({
      name: 'Same Origin',
      origin: 'dfx',
      externalId: 'store-2',
      activity: 'none',
      lastTransactionAt: null,
    });
    expect(store.getById(otherOrigin.place.id)).toMatchObject({
      name: 'Other Origin',
      origin: 'fremd',
      externalId: 'store-3',
      activity: 'none',
      lastTransactionAt: null,
    });
    store.refreshActivity(until - 1);
    expect(store.getById(created.place.id)?.activity).toBe('within7Days');
    store.refreshActivity(until);
    expect(store.getById(created.place.id)?.activity).toBe('none');
    expect(store.getById(created.place.id)?.lastTransactionAt).toBeNull();
  });

  it('sets an activity token, skips refresh, and keeps payment days', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    const created = store.insertIfNew(input);
    const day = (value: string): string => `${value}T12:00:00.000Z`;
    store.recordTransaction('dfx', 'store-1', day('2026-10-05'), nowMs);
    store.recordTransaction('dfx', 'store-1', day('2026-10-06'), nowMs);
    store.recordTransaction('dfx', 'store-1', day('2026-10-07'), nowMs);
    store.recordTransaction('dfx', 'store-1', day('2026-10-08'), nowMs);
    expect(store.getById(created.place.id)?.activity).toBe('within7Days');
    const updated = store.replaceById({
      id: created.place.id,
      content: input,
      createdAt: created.place.createdAt,
      lastTransactionAt: day('2026-10-08'),
      activity: { kind: 'set', activity: 'none' },
      active: true,
      nowMs,
    });
    expect(updated).toMatchObject({
      status: 'updated',
      place: { activity: 'none', lastTransactionAt: day('2026-10-08') },
    });
    store.refreshActivity(nowMs + 40 * 24 * 60 * 60 * 1000);
    expect(store.getById(created.place.id)?.activity).toBe('none');
    const fifth = store.recordTransaction('dfx', 'store-1', day('2026-10-04'), nowMs);
    expect(fifth?.activity).toBe('daily');
    expect(fifth?.lastTransactionAt).toBe(day('2026-10-08'));
  });

  it('recomputes daily from five payment days when the last transaction is null', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    const created = store.insertIfNew(input);
    const day = (value: string): string => `${value}T12:00:00.000Z`;
    for (const value of ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']) {
      store.recordTransaction('dfx', 'store-1', day(value), nowMs);
    }
    expect(store.getById(created.place.id)?.activity).toBe('daily');
    const cleared = store.replaceById({
      id: created.place.id,
      content: input,
      createdAt: created.place.createdAt,
      lastTransactionAt: day('2026-10-08'),
      activity: { kind: 'set', activity: 'none' },
      active: true,
      nowMs,
    });
    expect(cleared).toMatchObject({ status: 'updated', place: { activity: 'none' } });
    const updated = store.replaceById({
      id: created.place.id,
      content: { ...input, name: 'Daily Again' },
      createdAt: created.place.createdAt,
      lastTransactionAt: null,
      activity: { kind: 'recompute' },
      active: true,
      nowMs,
    });
    expect(updated).toMatchObject({
      status: 'updated',
      place: {
        id: created.place.id,
        name: 'Daily Again',
        lastTransactionAt: null,
        activity: 'daily',
      },
    });
    const until = Date.parse('2026-10-11T00:00:00.000Z');
    store.refreshActivity(until - 1);
    expect(store.getById(created.place.id)?.activity).toBe('daily');
    store.refreshActivity(until);
    expect(store.getById(created.place.id)?.activity).toBe('none');
    expect(store.getById(created.place.id)?.lastTransactionAt).toBeNull();
  });

  it('recomputes none when a null last transaction has no five payment days', () => {
    const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    const created = store.insertIfNew({ ...input, techProvider: '21.gifts' });
    store.recordTransaction('dfx', 'store-1', '2026-10-08T12:00:00.000Z', nowMs);
    const updated = store.replaceById({
      id: created.place.id,
      content: { ...input, name: 'No Days' },
      createdAt: '2024-02-02T00:00:00.000Z',
      lastTransactionAt: null,
      activity: { kind: 'recompute' },
      active: true,
      nowMs,
    });
    expect(updated).toMatchObject({
      status: 'updated',
      place: {
        name: 'No Days',
        techProvider: 'DFX.swiss',
        createdAt: '2024-02-02T00:00:00.000Z',
        lastTransactionAt: null,
        activity: 'none',
      },
    });
    store.refreshActivity(nowMs + 40 * 24 * 60 * 60 * 1000);
    expect(store.getById(created.place.id)?.activity).toBe('none');

    const fresh = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    const inserted = fresh.insertIfNew(input);
    const none = fresh.replaceById({
      id: inserted.place.id,
      content: input,
      createdAt: inserted.place.createdAt,
      lastTransactionAt: null,
      activity: { kind: 'recompute' },
      active: true,
      nowMs,
    });
    expect(none).toMatchObject({
      status: 'updated',
      place: { lastTransactionAt: null, activity: 'none', techProvider: 'DFX.swiss' },
    });
    fresh.refreshActivity(nowMs + 40 * 24 * 60 * 60 * 1000);
    expect(fresh.getById(inserted.place.id)?.activity).toBe('none');
  });
});

describe('placeProblems', () => {
  const place = keyedStore(
    new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z')),
  ).insertIfNew(input).place;

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
    expect(placeProblems({ ...place, lastTransactionAt: '-000001-01-01T00:00:00.000Z' })).toEqual([
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
    const store = keyedStore(
      new MemoryMapPlaceStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))),
    );
    store.insertIfNew(input);
    store.insertIfNew({ ...input, externalId: 'blank', name: '' });
    store.insertIfNew({ ...input, externalId: 'newer', name: 'Newer' });
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

describe('placeWriteConflict', () => {
  const free = {
    storedRevision: undefined,
    revision: undefined,
    rowExists: false,
    storedKey: null,
    key: undefined,
    reservedFor: undefined,
    origin: 'dfx',
    externalId: 'store-1',
  };

  it('lets a write without revision and key through when nothing is stored', () => {
    expect(placeWriteConflict(free)).toBeNull();
  });

  it('refuses a revision that is not higher, and a missing one once a revision is stored', () => {
    expect(placeWriteConflict({ ...free, storedRevision: 2, revision: 2 })).toBe('Stale revision');
    expect(placeWriteConflict({ ...free, storedRevision: 2, revision: 1 })).toBe('Stale revision');
    expect(placeWriteConflict({ ...free, storedRevision: 2 })).toBe('Stale revision');
    expect(placeWriteConflict({ ...free, storedRevision: 2, revision: 3 })).toBeNull();
  });

  it('checks the revision before the key', () => {
    expect(
      placeWriteConflict({
        ...free,
        storedRevision: 2,
        revision: 2,
        rowExists: true,
        storedKey: 'a',
        key: 'b',
      }),
    ).toBe('Stale revision');
  });

  it('keeps a stored key and lets the same key through', () => {
    expect(placeWriteConflict({ ...free, rowExists: true, storedKey: 'a', key: 'b' })).toBe(
      'nostrPubkey of a place cannot change',
    );
    expect(placeWriteConflict({ ...free, rowExists: true, storedKey: 'a', key: 'a' })).toBeNull();
  });

  it('lets the stored key decide when both rules break', () => {
    expect(
      placeWriteConflict({
        ...free,
        rowExists: true,
        storedKey: 'a',
        key: 'b',
        reservedFor: { origin: 'spar', externalId: 'other' },
      }),
    ).toBe('nostrPubkey of a place cannot change');
  });

  it('refuses a key reserved for another origin or external id and allows the own pair', () => {
    expect(
      placeWriteConflict({
        ...free,
        key: 'a',
        reservedFor: { origin: 'spar', externalId: 'store-1' },
      }),
    ).toBe('nostrPubkey belongs to another place');
    expect(
      placeWriteConflict({
        ...free,
        key: 'a',
        reservedFor: { origin: 'dfx', externalId: 'other' },
      }),
    ).toBe('nostrPubkey belongs to another place');
    expect(
      placeWriteConflict({
        ...free,
        rowExists: true,
        key: 'a',
        reservedFor: { origin: 'dfx', externalId: 'store-1' },
      }),
    ).toBeNull();
  });
});

describe('placeNameConflict', () => {
  it('allows a missing owner and the row being written', () => {
    expect(placeNameConflict(null, null)).toBeNull();
    expect(placeNameConflict(null, 'place-1')).toBeNull();
    expect(placeNameConflict('place-1', 'place-1')).toBeNull();
  });

  it('refuses another row, including when the write inserts', () => {
    expect(placeNameConflict('place-2', 'place-1')).toBe('Place name belongs to another place');
    expect(placeNameConflict('place-2', null)).toBe('Place name belongs to another place');
  });
});

describe('MemoryMapPlaceStore exact name', () => {
  const keyA = keyFor('exact-name-a');
  const keyB = keyFor('exact-name-b');
  const keyC = keyFor('exact-name-c');
  const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
  const nameError = 'Place name belongs to another place';

  function written(result: ReturnType<MemoryMapPlaceStore['insertIfNew']>) {
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.place;
  }

  function replace(store: MemoryMapPlaceStore, id: string, content: MapPlaceInput) {
    return store.replaceById({
      id,
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastTransactionAt: null,
      activity: { kind: 'keep' },
      active: true,
      nowMs,
    });
  }

  it('stores a different case and surrounding spaces as other names', () => {
    const store = new MemoryMapPlaceStore();
    written(store.insertIfNew({ ...input, name: 'Shop', nostrPubkey: keyA }));
    expect(
      store.insertIfNew({ ...input, externalId: 'store-2', name: 'shop', nostrPubkey: keyB }).ok,
    ).toBe(true);
    expect(
      store.insertIfNew({ ...input, externalId: 'store-3', name: 'Shop ', nostrPubkey: keyC }).ok,
    ).toBe(true);
    expect(store.listAll()).toHaveLength(3);
  });

  it('refuses a second new shop and stores no reservation or revision', () => {
    const store = new MemoryMapPlaceStore();
    written(store.insertIfNew({ ...input, name: 'Exact Shop', nostrPubkey: keyA }));
    expect(
      store.insertIfNew(
        { ...input, externalId: 'store-2', name: 'Exact Shop', nostrPubkey: keyB },
        4,
      ),
    ).toEqual({ ok: false, error: nameError });
    expect(store.listAll().map((row) => row.externalId)).toEqual(['store-1']);
    expect(
      store.insertIfNew(
        { ...input, externalId: 'store-3', name: 'Free Shop', nostrPubkey: keyB },
        1,
      ).ok,
    ).toBe(true);
    expect(store.listAll().some((row) => row.externalId === 'store-2')).toBe(false);
  });

  it('does not apply a foreign name when insertIfNew finds the pair', () => {
    const store = new MemoryMapPlaceStore();
    const first = written(store.insertIfNew({ ...input, name: 'Own Shop', nostrPubkey: keyA }));
    written(
      store.insertIfNew({
        ...input,
        externalId: 'store-2',
        name: 'Foreign Shop',
        nostrPubkey: keyB,
      }),
    );
    const again = store.insertIfNew({ ...input, name: 'Foreign Shop', nostrPubkey: keyA });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(again.ok && again.place.name).toBe('Own Shop');
    expect(store.getById(first.id)?.name).toBe('Own Shop');
  });

  it('rejects an upsert onto another name and allows the own name and a free name', () => {
    const store = new MemoryMapPlaceStore();
    const own = written(store.upsert({ ...input, name: 'Own Shop', nostrPubkey: keyA }));
    written(
      store.insertIfNew({
        ...input,
        externalId: 'store-2',
        name: 'Taken Shop',
        nostrPubkey: keyB,
      }),
    );
    const before = store.getById(own.id);
    expect(store.upsert({ ...input, name: 'Taken Shop', nostrPubkey: keyA })).toEqual({
      ok: false,
      error: nameError,
    });
    expect(store.getById(own.id)).toEqual(before);
    expect(store.upsert({ ...input, name: 'Own Shop', nostrPubkey: keyA })).toMatchObject({
      ok: true,
      created: false,
    });
    const renamed = store.upsert({ ...input, name: 'Free Shop', nostrPubkey: keyA });
    expect(renamed.ok && renamed.place.name).toBe('Free Shop');
    expect(
      store.upsert({ ...input, externalId: 'store-3', name: 'Free Shop', nostrPubkey: keyC }),
    ).toEqual({ ok: false, error: nameError });
    expect(store.listAll().some((row) => row.externalId === 'store-3')).toBe(false);
  });

  it('reports a stale revision and a changed key before the name', () => {
    const store = new MemoryMapPlaceStore();
    const own = written(store.insertIfNew({ ...input, name: 'Own Shop', nostrPubkey: keyA }, 2));
    written(
      store.insertIfNew({
        ...input,
        externalId: 'store-2',
        name: 'Taken Shop',
        nostrPubkey: keyB,
      }),
    );
    expect(store.upsert({ ...input, name: 'Taken Shop', nostrPubkey: keyA }, 2)).toEqual({
      ok: false,
      error: 'Stale revision',
    });
    expect(store.upsert({ ...input, name: 'Taken Shop', nostrPubkey: keyB }, 3)).toEqual({
      ok: false,
      error: 'nostrPubkey of a place cannot change',
    });
    expect(store.getById(own.id)?.name).toBe('Own Shop');
  });

  it('rejects replaceById onto another name and allows the own name and a free name', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const own = written(store.insertIfNew({ ...input, name: 'Own Shop', nostrPubkey: keyA }));
    written(
      store.insertIfNew({
        ...input,
        externalId: 'store-2',
        name: 'Taken Shop',
        nostrPubkey: keyB,
      }),
    );
    const before = store.getById(own.id);
    expect(replace(store, own.id, { ...input, name: 'Taken Shop', nostrPubkey: keyB })).toEqual({
      status: 'keyConflict',
      error: 'nostrPubkey of a place cannot change',
    });
    expect(replace(store, own.id, { ...input, name: 'Taken Shop', nostrPubkey: keyA })).toEqual({
      status: 'keyConflict',
      error: nameError,
    });
    expect(store.getById(own.id)).toEqual(before);
    expect(replace(store, own.id, { ...input, name: 'Own Shop', nostrPubkey: keyA })).toMatchObject(
      {
        status: 'updated',
        place: { name: 'Own Shop' },
      },
    );
    expect(
      replace(store, own.id, { ...input, name: 'Free Shop', nostrPubkey: keyA }),
    ).toMatchObject({
      status: 'updated',
      place: { name: 'Free Shop' },
    });
  });
});

describe('MemoryMapPlaceStore NOSTR key and revision', () => {
  const keyA = keyFor('memory-a');
  const keyB = keyFor('memory-b');
  const keyC = keyFor('memory-c');

  it('hides a row without a key and reports it as a problem', () => {
    const store = new MemoryMapPlaceStore();
    const written = store.insertIfNew(input);
    expect(written.ok && written.place.nostrPubkey).toBeNull();
    expect(store.list(10)).toEqual([]);
    expect(store.filters().countries).toEqual([]);
    const [row] = store.listAll();
    expect(row === undefined ? [] : placeProblems(row)).toEqual(['nostrPubkey is missing']);
  });

  it('adds a key with POST, keeps it on PUT, refuses a change and finds the public row', () => {
    const store = new MemoryMapPlaceStore();
    store.insertIfNew(input);
    const added = store.insertIfNew({ ...input, name: 'Ignored', nostrPubkey: keyA });
    expect(added).toMatchObject({ ok: true, created: false });
    expect(added.ok && added.place.nostrPubkey).toBe(keyA);
    expect(added.ok && added.place.name).toBe('SPAR Triesen');
    const same = store.insertIfNew({ ...input, nostrPubkey: keyA });
    expect(same.ok).toBe(true);
    const kept = store.upsert({ ...input, name: 'SPAR Triesen Nord' });
    expect(kept.ok && kept.place.nostrPubkey).toBe(keyA);
    expect(store.upsert({ ...input, nostrPubkey: keyB })).toEqual({
      ok: false,
      error: 'nostrPubkey of a place cannot change',
    });
    expect(store.insertIfNew({ ...input, nostrPubkey: keyB })).toEqual({
      ok: false,
      error: 'nostrPubkey of a place cannot change',
    });
    expect(store.findPublicByPubkey(keyA)?.name).toBe('SPAR Triesen Nord');
    expect(store.findPublicByPubkey(keyB)).toBeUndefined();
    expect(store.list(10).map((row) => row.nostrPubkey)).toEqual([keyA]);
  });

  it('does not find a row whose key is stored but which is incomplete', () => {
    const store = new MemoryMapPlaceStore();
    store.insertIfNew({ ...input, name: '', nostrPubkey: keyA });
    expect(store.findPublicByPubkey(keyA)).toBeUndefined();
  });

  it('reserves a key for its pair, also after delete', () => {
    const store = new MemoryMapPlaceStore();
    store.insertIfNew({ ...input, nostrPubkey: keyA });
    expect(store.insertIfNew({ ...input, externalId: 'store-2', nostrPubkey: keyA })).toEqual({
      ok: false,
      error: 'nostrPubkey belongs to another place',
    });
    expect(store.deleteByKey('dfx', 'store-1')).toEqual({ ok: true, deleted: true });
    expect(store.upsert({ ...input, externalId: 'store-2', nostrPubkey: keyA })).toEqual({
      ok: false,
      error: 'nostrPubkey belongs to another place',
    });
    const again = store.insertIfNew({ ...input, nostrPubkey: keyA });
    expect(again).toMatchObject({ ok: true, created: true });
    store.deleteByKey('dfx', 'store-1');
    const moved = store.insertIfNew({ ...input, nostrPubkey: keyC });
    expect(moved.ok && moved.place.nostrPubkey).toBe(keyC);
    expect(store.findPublicByPubkey(keyA)).toBeUndefined();
  });

  it('stores revisions, refuses stale and missing ones and keeps them across delete', () => {
    const store = new MemoryMapPlaceStore();
    expect(store.insertIfNew({ ...input, nostrPubkey: keyA }, 1).ok).toBe(true);
    expect(store.upsert({ ...input, nostrPubkey: keyA }, 1)).toEqual({
      ok: false,
      error: 'Stale revision',
    });
    expect(store.upsert({ ...input, nostrPubkey: keyA })).toEqual({
      ok: false,
      error: 'Stale revision',
    });
    expect(store.upsert({ ...input, nostrPubkey: keyB }, 2)).toEqual({
      ok: false,
      error: 'nostrPubkey of a place cannot change',
    });
    expect(store.upsert({ ...input, name: 'Renamed', nostrPubkey: keyA }, 2).ok).toBe(true);
    expect(store.insertIfNew({ ...input, nostrPubkey: keyA }, 3)).toMatchObject({
      ok: true,
      created: false,
    });
    expect(store.insertIfNew({ ...input, nostrPubkey: keyA }, 3)).toEqual({
      ok: false,
      error: 'Stale revision',
    });
    expect(store.deleteByKey('dfx', 'store-1', 3)).toEqual({ ok: false, error: 'Stale revision' });
    expect(store.deleteByKey('dfx', 'store-1')).toEqual({ ok: false, error: 'Stale revision' });
    expect(store.deleteByKey('dfx', 'store-1', 4)).toEqual({ ok: true, deleted: true });
    expect(store.deleteByKey('dfx', 'store-1', 5)).toEqual({ ok: true, deleted: false });
    expect(store.upsert({ ...input, nostrPubkey: keyA }, 5)).toEqual({
      ok: false,
      error: 'Stale revision',
    });
    expect(store.upsert({ ...input, nostrPubkey: keyA }, 6)).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it('forgets reservations and revisions on close', () => {
    const store = new MemoryMapPlaceStore();
    store.insertIfNew({ ...input, nostrPubkey: keyA }, 5);
    store.close();
    expect(store.insertIfNew({ ...input, externalId: 'store-2', nostrPubkey: keyA }, 1).ok).toBe(
      true,
    );
  });
});

describe('MemoryMapPlaceStore photos', () => {
  function photoOf(bytes: Uint8Array, caption?: string): PreparedPhoto {
    const result = preparePhoto(
      {
        contentType: 'image/png',
        data: base64(bytes),
        ...(caption === undefined ? {} : { caption }),
      },
      0,
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.photo;
  }
  const first = photoOf(simplePng(3, 2), 'Front');
  const second = photoOf(simplePng(5, 4));
  const keyA = keyFor('photos-a');
  const keyB = keyFor('photos-b');

  it('finds the place by key and origin, listed or not', () => {
    const store = new MemoryMapPlaceStore();
    store.insertIfNew({ ...input, name: '', nostrPubkey: keyA });
    expect(store.replacePhotos('spar', keyA, [first])).toEqual({
      ok: false,
      error: 'Place not found',
    });
    expect(store.replacePhotos('dfx', keyB, [first])).toEqual({
      ok: false,
      error: 'Place not found',
    });
    const stored = store.replacePhotos('dfx', keyA, [first, second]);
    expect(stored).toEqual({
      ok: true,
      photos: [
        { sha256: first.sha256, contentType: 'image/png', width: 3, height: 2, caption: 'Front' },
        { sha256: second.sha256, contentType: 'image/png', width: 5, height: 4, caption: null },
      ],
    });
    expect(store.listAll()[0]?.photos.map((photo) => photo.sha256)).toEqual([
      first.sha256,
      second.sha256,
    ]);
    expect(store.findPublicPhoto(first.sha256)).toBeUndefined();
  });

  it('serves a file only while a complete place uses it and drops unused files', () => {
    const store = new MemoryMapPlaceStore();
    store.insertIfNew({ ...input, nostrPubkey: keyA });
    store.insertIfNew({ ...input, externalId: 'store-2', name: 'Photo Two', nostrPubkey: keyB });
    store.replacePhotos('dfx', keyA, [first, second]);
    store.replacePhotos('dfx', keyB, [first]);
    expect(store.findPublicPhoto(first.sha256)?.contentType).toBe('image/png');
    expect(store.findPublicPhoto(second.sha256)?.data).toEqual(second.data);
    expect(store.findPublicPhoto('0'.repeat(64))).toBeUndefined();
    store.replacePhotos('dfx', keyA, []);
    expect(store.findPublicPhoto(second.sha256)).toBeUndefined();
    expect(store.findPublicPhoto(first.sha256)).toBeDefined();
    store.upsert({ ...input, externalId: 'store-2', name: 'Kept photos', nostrPubkey: keyB });
    expect(store.listAll().find((row) => row.externalId === 'store-2')?.photos).toHaveLength(1);
    expect(store.deleteByKey('dfx', 'store-2')).toEqual({ ok: true, deleted: true });
    expect(store.findPublicPhoto(first.sha256)).toBeUndefined();
    expect(store.list(10)[0]?.photos).toEqual([]);
  });

  it('shares the revision counter with place writes', () => {
    const store = new MemoryMapPlaceStore();
    store.insertIfNew({ ...input, nostrPubkey: keyA }, 2);
    expect(store.replacePhotos('dfx', keyA, [first], 2)).toEqual({
      ok: false,
      error: 'Stale revision',
    });
    expect(store.replacePhotos('dfx', keyA, [first])).toEqual({
      ok: false,
      error: 'Stale revision',
    });
    expect(store.replacePhotos('dfx', keyA, [first], 3).ok).toBe(true);
    expect(store.upsert({ ...input, nostrPubkey: keyA }, 3)).toEqual({
      ok: false,
      error: 'Stale revision',
    });
  });

  it('accepts photos without a revision while none is stored and forgets files on close', () => {
    const store = new MemoryMapPlaceStore();
    store.insertIfNew({ ...input, nostrPubkey: keyA });
    expect(store.replacePhotos('dfx', keyA, [first]).ok).toBe(true);
    store.close();
    expect(store.findPublicPhoto(first.sha256)).toBeUndefined();
  });
});

describe('MemoryMapPlaceStore admin writes by internal id', () => {
  const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
  const keyA = keyFor('admin-a');
  const keyB = keyFor('admin-b');
  const keyC = keyFor('admin-c');

  function replace(
    store: MemoryMapPlaceStore,
    id: string,
    content: MapPlaceInput,
    active: boolean = true,
  ) {
    return store.replaceById({
      id,
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastTransactionAt: null,
      activity: { kind: 'keep' },
      nowMs,
      active,
    });
  }

  function inserted(store: MemoryMapPlaceStore, content: MapPlaceInput, revision?: number) {
    const result = store.insertIfNew(content, revision);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.place;
  }

  it('keeps a stored key, moves its reservation with the row and ignores revisions', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const place = inserted(store, { ...input, nostrPubkey: keyA }, 5);
    const moved = replace(store, place.id, { ...input, origin: 'fremd', externalId: 'moved' });
    expect(moved).toMatchObject({
      status: 'updated',
      place: { id: place.id, origin: 'fremd', externalId: 'moved', nostrPubkey: keyA },
    });
    expect(store.insertIfNew({ ...input, nostrPubkey: keyA }, 6)).toEqual({
      ok: false,
      error: 'nostrPubkey belongs to another place',
    });
    expect(store.insertIfNew({ ...input, nostrPubkey: keyB }, 5)).toEqual({
      ok: false,
      error: 'Stale revision',
    });
    const source = store.upsert({
      ...input,
      origin: 'fremd',
      externalId: 'moved',
      nostrPubkey: keyA,
    });
    expect(source).toMatchObject({ ok: true, created: false, place: { id: place.id } });
  });

  it('stores a sent key on a row without one and refuses a change or a reserved key', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const keyless = inserted(store, input);
    inserted(store, { ...input, externalId: 'store-2', name: 'Reserved Shop', nostrPubkey: keyB });
    expect(replace(store, keyless.id, { ...input, nostrPubkey: keyB })).toEqual({
      status: 'keyConflict',
      error: 'nostrPubkey belongs to another place',
    });
    expect(store.getById(keyless.id)?.nostrPubkey).toBeNull();
    expect(replace(store, keyless.id, { ...input, nostrPubkey: keyA })).toMatchObject({
      status: 'updated',
      place: { nostrPubkey: keyA },
    });
    expect(replace(store, keyless.id, { ...input, nostrPubkey: keyC })).toEqual({
      status: 'keyConflict',
      error: 'nostrPubkey of a place cannot change',
    });
    expect(replace(store, keyless.id, input)).toMatchObject({
      status: 'updated',
      place: { nostrPubkey: keyA },
    });
    expect(store.insertIfNew({ ...input, externalId: 'other', nostrPubkey: keyA })).toEqual({
      ok: false,
      error: 'nostrPubkey belongs to another place',
    });
  });

  it('keeps a row from before step 1a without a key when the write sends none', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const keyless = inserted(store, input);
    expect(replace(store, keyless.id, { ...input, name: 'Still Keyless' })).toMatchObject({
      status: 'updated',
      place: { name: 'Still Keyless', nostrPubkey: null },
    });
  });

  it('deletes by id without a revision, keeps the reservation and drops unused photo files', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const place = inserted(store, { ...input, nostrPubkey: keyA }, 3);
    const photo = preparePhoto({ contentType: 'image/png', data: base64(simplePng(3, 2)) }, 0);
    if (!photo.ok) {
      throw new Error(photo.error);
    }
    expect(store.replacePhotos('dfx', keyA, [photo.photo], 4).ok).toBe(true);
    expect(store.findPublicPhoto(photo.photo.sha256)).toBeDefined();
    expect(store.deleteById(place.id)).toBe(true);
    expect(store.deleteById(place.id)).toBe(false);
    expect(store.findPublicPhoto(photo.photo.sha256)).toBeUndefined();
    expect(store.insertIfNew({ ...input, externalId: 'store-9', nostrPubkey: keyA })).toEqual({
      ok: false,
      error: 'nostrPubkey belongs to another place',
    });
    expect(store.insertIfNew({ ...input, nostrPubkey: keyA }, 4)).toEqual({
      ok: false,
      error: 'Stale revision',
    });
  });
});

describe('MemoryMapPlaceStore active', () => {
  const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
  const keyA = keyFor('active-a');
  const keyB = keyFor('active-b');

  function photoOf(bytes: Uint8Array): PreparedPhoto {
    const result = preparePhoto({ contentType: 'image/png', data: base64(bytes) }, 0);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.photo;
  }

  function replace(
    store: MemoryMapPlaceStore,
    id: string,
    content: MapPlaceInput,
    active: boolean,
  ) {
    return store.replaceById({
      id,
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastTransactionAt: null,
      activity: { kind: 'keep' },
      nowMs,
      active,
    });
  }

  it('stores a new row as active and lists it', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const created = store.insertIfNew({ ...input, nostrPubkey: keyA });
    expect(created.ok && created.place.active).toBe(true);
    expect(store.list(10).map((row) => row.externalId)).toEqual(['store-1']);
    expect(store.list(10)[0]?.active).toBe(true);
  });

  it('hides a complete row, drops its country, and leaves problems unchanged', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const created = store.insertIfNew({
      ...input,
      nostrPubkey: keyA,
      supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
    });
    if (!created.ok) {
      throw new Error(created.error);
    }
    const before = placeProblems(created.place);
    const hidden = replace(
      store,
      created.place.id,
      {
        ...input,
        nostrPubkey: keyA,
        supports: [{ blockchain: 'Ethereum', asset: 'ZCHF' }],
      },
      false,
    );
    expect(hidden).toMatchObject({ status: 'updated', place: { active: false } });
    expect(store.list(10)).toEqual([]);
    expect(store.filters().countries).toEqual([]);
    expect(store.filters()).toMatchObject({ blockchains: ['Ethereum'], assets: ['ZCHF'] });
    expect(store.findPublicByPubkey(keyA)).toBeUndefined();
    expect(store.listAll().map((row) => row.externalId)).toEqual(['store-1']);
    const stored = store.getById(created.place.id);
    expect(stored?.active).toBe(false);
    const problems = placeProblems(stored ?? created.place);
    expect(problems).toEqual(before);
    expect(problems.some((problem) => problem.includes('active'))).toBe(false);
  });

  it('keeps a country that still has another public shop', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const first = store.insertIfNew({
      ...input,
      nostrPubkey: keyA,
      country: 'CH',
      postalCode: '8001',
    });
    store.insertIfNew({
      ...input,
      externalId: 'store-2',
      name: 'Second Country Shop',
      nostrPubkey: keyB,
      country: 'CH',
      postalCode: '8001',
    });
    if (!first.ok) {
      throw new Error(first.error);
    }
    replace(
      store,
      first.place.id,
      { ...input, nostrPubkey: keyA, country: 'CH', postalCode: '8001' },
      false,
    );
    expect(store.filters().countries).toEqual(['CH']);
    expect(store.list(10).map((row) => row.externalId)).toEqual(['store-2']);
  });

  it('serves a photo hash only while a public shop uses it', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const photo = photoOf(simplePng(3, 2));
    const hiddenShop = store.insertIfNew({ ...input, nostrPubkey: keyA });
    const publicShop = store.insertIfNew({
      ...input,
      externalId: 'store-2',
      name: 'Public Photo Shop',
      nostrPubkey: keyB,
    });
    if (!hiddenShop.ok || !publicShop.ok) {
      throw new Error('seed failed');
    }
    expect(store.replacePhotos('dfx', keyA, [photo]).ok).toBe(true);
    replace(store, hiddenShop.place.id, { ...input, nostrPubkey: keyA }, false);
    expect(store.replacePhotos('dfx', keyA, [photo]).ok).toBe(true);
    expect(store.findPublicPhoto(photo.sha256)).toBeUndefined();
    expect(store.replacePhotos('dfx', keyB, [photo]).ok).toBe(true);
    expect(store.findPublicPhoto(photo.sha256)?.contentType).toBe('image/png');
    expect(store.findPublicPhoto(photo.sha256)?.data).toEqual(photo.data);
  });

  it('leaves active false on a later source write and lists the shop when set true', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const created = store.insertIfNew({ ...input, nostrPubkey: keyA });
    if (!created.ok) {
      throw new Error(created.error);
    }
    replace(store, created.place.id, { ...input, nostrPubkey: keyA }, false);
    const updated = store.upsert({ ...input, nostrPubkey: keyA, name: 'Renamed' });
    expect(updated.ok && updated.place.active).toBe(false);
    expect(updated.ok && updated.place.name).toBe('Renamed');
    const again = store.insertIfNew({ ...input, nostrPubkey: keyA, name: 'Ignored' });
    expect(again.ok && again.place.active).toBe(false);
    expect(store.getById(created.place.id)?.active).toBe(false);
    expect(store.list(10)).toEqual([]);
    const shown = replace(store, created.place.id, { ...input, nostrPubkey: keyA }, true);
    expect(shown).toMatchObject({ status: 'updated', place: { active: true } });
    expect(store.list(10).map((row) => row.externalId)).toEqual(['store-1']);
    expect(store.findPublicByPubkey(keyA)?.externalId).toBe('store-1');
  });

  it('does not reactivate a shop when a transaction is recorded', () => {
    const store = new MemoryMapPlaceStore(() => new Date(nowMs));
    const created = store.insertIfNew({ ...input, nostrPubkey: keyA });
    if (!created.ok) {
      throw new Error(created.error);
    }
    replace(store, created.place.id, { ...input, nostrPubkey: keyA }, false);
    const recorded = store.recordTransaction('dfx', 'store-1', '2026-10-08T12:00:00.000Z', nowMs);
    expect(recorded?.active).toBe(false);
    expect(recorded?.activity).toBe('within7Days');
    expect(store.getById(created.place.id)?.active).toBe(false);
    expect(store.list(10)).toEqual([]);
  });
});

describe('MemoryMapPlaceStore google maps link', () => {
  const link = 'https://www.google.com/maps/search/?api=1&query_place_id=ChIJtest';
  const other = 'https://maps.app.goo.gl/abc';
  const nowMs = Date.parse('2026-10-08T12:00:00.000Z');

  function replace(
    store: ReturnType<typeof keyedStore>,
    id: string,
    content: MapPlaceInput,
  ): ReturnType<MemoryMapPlaceStore['replaceById']> {
    return store.replaceById({
      id,
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastTransactionAt: null,
      activity: { kind: 'keep' },
      active: true,
      nowMs,
    });
  }

  it('stores null when the key is absent and keeps the first link on a second insert', () => {
    const absent = keyedStore(new MemoryMapPlaceStore());
    const created = absent.insertIfNew(input);
    expect(created.place.googleMapsUrl).toBeNull();

    const store = keyedStore(new MemoryMapPlaceStore());
    const first = store.insertIfNew({ ...input, googleMapsUrl: link });
    expect(first.place.googleMapsUrl).toBe(link);
    const second = store.insertIfNew({ ...input, googleMapsUrl: other });
    expect(second.created).toBe(false);
    expect(second.place.googleMapsUrl).toBe(link);
    expect(store.getById(first.place.id)?.googleMapsUrl).toBe(link);
  });

  it('keeps the link when upsert omits the key, replaces it, and deletes it with null', () => {
    const store = keyedStore(new MemoryMapPlaceStore());
    store.insertIfNew({ ...input, googleMapsUrl: link });
    const kept = store.upsert(input);
    expect(kept.place.googleMapsUrl).toBe(link);
    const replaced = store.upsert({ ...input, googleMapsUrl: other });
    expect(replaced.place.googleMapsUrl).toBe(other);
    const cleared = store.upsert({ ...input, googleMapsUrl: null });
    expect(cleared.place.googleMapsUrl).toBeNull();
    expect(store.getById(kept.place.id)?.googleMapsUrl).toBeNull();
  });

  it('keeps, sets, and clears the link on replaceById', () => {
    const store = keyedStore(new MemoryMapPlaceStore(() => new Date(nowMs)));
    const created = store.insertIfNew({ ...input, googleMapsUrl: link });
    expect(replace(store, created.place.id, input)).toMatchObject({
      status: 'updated',
      place: { googleMapsUrl: link },
    });
    expect(replace(store, created.place.id, { ...input, googleMapsUrl: other })).toMatchObject({
      status: 'updated',
      place: { googleMapsUrl: other },
    });
    expect(replace(store, created.place.id, { ...input, googleMapsUrl: null })).toMatchObject({
      status: 'updated',
      place: { googleMapsUrl: null },
    });
  });
});
