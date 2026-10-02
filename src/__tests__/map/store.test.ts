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
    const second = store.insertIfNew({ ...input, name: 'Other', lat: 1 });
    expect(second.created).toBe(false);
    expect(second.place.name).toBe('SPAR');
    expect(second.place.id).toBe(first.place.id);
    const later = store.insertIfNew({ ...input, externalId: 'store-2' });
    const listed = store.list(10);
    expect(listed.map((row) => row.externalId)).toEqual(['store-2', 'store-1']);
    expect(store.list(1)).toHaveLength(1);
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

  it('deletes by key and reports a miss', () => {
    const store = new MemoryMapPlaceStore(() => new Date('2026-09-26T00:00:00.000Z'));
    expect(store.deleteByKey('dfx', 'store-1')).toBe(false);
    store.insertIfNew(input);
    expect(store.deleteByKey('dfx', 'store-1')).toBe(true);
    expect(store.list(10)).toHaveLength(0);
    expect(store.deleteByKey('dfx', 'store-1')).toBe(false);
  });
});
