/**
 * One pin on the OpenCryptoPay map.
 * Coordinates are rounded to six decimal places.
 */

import { isCatalogAsset, isCatalogBlockchain } from '@/lib/map/filter-catalog';

export type MapPlaceSupport = {
  blockchain: string;
  asset: string;
};

export type MapPlaceInput = {
  origin: string;
  externalId: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  paymentMethods: string | null;
  techProvider?: string;
  country?: string;
  shopName?: string;
  supports?: MapPlaceSupport[];
};

export type StoredMapPlace = Omit<
  MapPlaceInput,
  'techProvider' | 'country' | 'shopName' | 'supports'
> & {
  id: string;
  createdAt: string;
  techProvider: string;
  country: string | null;
  shopName: string | null;
  supports: MapPlaceSupport[];
  lastTransactionAt: string | null;
};

/** Fields the public map may show. The caller's own id stays off this list. */
export type PublicMapPlace = {
  id: string;
  origin: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  techProvider: string;
  country: string | null;
  shopName: string | null;
  supports: MapPlaceSupport[];
  activity: 'within7Days' | 'within30Days' | 'none';
};

/** Query fields that restrict GET /map/places, all optional. */
export type MapPlaceQueryFilter = {
  country?: string;
  shopName?: 'SPAR' | 'others';
  blockchain?: string;
  asset?: string;
};

const COORD_ERROR = 'Place must be a latitude and longitude';
const ORIGIN_ERROR = 'Place origin is invalid';
const EXTERNAL_ID_ERROR = 'Place external id is required';
const NAME_ERROR = 'Place name is required';
const CATEGORY_ERROR = 'Place category is required';
const TECH_PROVIDER_ERROR = 'Place tech provider is invalid';
const COUNTRY_ERROR = 'Place country is invalid';
const SHOP_NAME_ERROR = 'Place shop name is invalid';
const SUPPORT_ERROR = 'Place support is invalid';
const TRANSACTION_TIME_ERROR = 'Place transaction time is invalid';

const PAYMENT_METHODS = /^(onchain|lightning|nfc)(,(onchain|lightning|nfc))*$/;
const TECH_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/;
const ASSET_TICKER = /^[A-Z][A-Z0-9]{1,31}$/;
const ASSET_PREFIXED = /^[a-z][A-Z][A-Z0-9]{1,30}$/;

const ISO_COUNTRIES: ReadonlySet<string> = new Set([
  'AD',
  'AE',
  'AF',
  'AG',
  'AI',
  'AL',
  'AM',
  'AO',
  'AQ',
  'AR',
  'AS',
  'AT',
  'AU',
  'AW',
  'AX',
  'AZ',
  'BA',
  'BB',
  'BD',
  'BE',
  'BF',
  'BG',
  'BH',
  'BI',
  'BJ',
  'BL',
  'BM',
  'BN',
  'BO',
  'BQ',
  'BR',
  'BS',
  'BT',
  'BV',
  'BW',
  'BY',
  'BZ',
  'CA',
  'CC',
  'CD',
  'CF',
  'CG',
  'CH',
  'CI',
  'CK',
  'CL',
  'CM',
  'CN',
  'CO',
  'CR',
  'CU',
  'CV',
  'CW',
  'CX',
  'CY',
  'CZ',
  'DE',
  'DJ',
  'DK',
  'DM',
  'DO',
  'DZ',
  'EC',
  'EE',
  'EG',
  'EH',
  'ER',
  'ES',
  'ET',
  'FI',
  'FJ',
  'FK',
  'FM',
  'FO',
  'FR',
  'GA',
  'GB',
  'GD',
  'GE',
  'GF',
  'GG',
  'GH',
  'GI',
  'GL',
  'GM',
  'GN',
  'GP',
  'GQ',
  'GR',
  'GS',
  'GT',
  'GU',
  'GW',
  'GY',
  'HK',
  'HM',
  'HN',
  'HR',
  'HT',
  'HU',
  'ID',
  'IE',
  'IL',
  'IM',
  'IN',
  'IO',
  'IQ',
  'IR',
  'IS',
  'IT',
  'JE',
  'JM',
  'JO',
  'JP',
  'KE',
  'KG',
  'KH',
  'KI',
  'KM',
  'KN',
  'KP',
  'KR',
  'KW',
  'KY',
  'KZ',
  'LA',
  'LB',
  'LC',
  'LI',
  'LK',
  'LR',
  'LS',
  'LT',
  'LU',
  'LV',
  'LY',
  'MA',
  'MC',
  'MD',
  'ME',
  'MF',
  'MG',
  'MH',
  'MK',
  'ML',
  'MM',
  'MN',
  'MO',
  'MP',
  'MQ',
  'MR',
  'MS',
  'MT',
  'MU',
  'MV',
  'MW',
  'MX',
  'MY',
  'MZ',
  'NA',
  'NC',
  'NE',
  'NF',
  'NG',
  'NI',
  'NL',
  'NO',
  'NP',
  'NR',
  'NU',
  'NZ',
  'OM',
  'PA',
  'PE',
  'PF',
  'PG',
  'PH',
  'PK',
  'PL',
  'PM',
  'PN',
  'PR',
  'PS',
  'PT',
  'PW',
  'PY',
  'QA',
  'RE',
  'RO',
  'RS',
  'RU',
  'RW',
  'SA',
  'SB',
  'SC',
  'SD',
  'SE',
  'SG',
  'SH',
  'SI',
  'SJ',
  'SK',
  'SL',
  'SM',
  'SN',
  'SO',
  'SR',
  'SS',
  'ST',
  'SV',
  'SX',
  'SY',
  'SZ',
  'TC',
  'TD',
  'TF',
  'TG',
  'TH',
  'TJ',
  'TK',
  'TL',
  'TM',
  'TN',
  'TO',
  'TR',
  'TT',
  'TV',
  'TW',
  'TZ',
  'UA',
  'UG',
  'UM',
  'US',
  'UY',
  'UZ',
  'VA',
  'VC',
  'VE',
  'VG',
  'VI',
  'VN',
  'VU',
  'WF',
  'WS',
  'YE',
  'YT',
  'ZA',
  'ZM',
  'ZW',
]);

const PAYMENT_BLOCKCHAINS: ReadonlySet<string> = new Set([
  'Bitcoin',
  'Lightning',
  'Spark',
  'Arkade',
  'Firo',
  'Monero',
  'Zano',
  'Ethereum',
  'Sepolia',
  'BinanceSmartChain',
  'Optimism',
  'Arbitrum',
  'Polygon',
  'Base',
  'Haqq',
  'Liquid',
  'Arweave',
  'Cardano',
  'InternetComputer',
  'DeFiChain',
  'Railgun',
  'Solana',
  'Gnosis',
  'Plasma',
  'Tron',
  'Citrea',
  'CitreaTestnet',
  'BitcoinTestnet4',
]);

function roundCoord(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function hasNoControls(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

function compareSupport(a: MapPlaceSupport, b: MapPlaceSupport): number {
  if (a.blockchain < b.blockchain) {
    return -1;
  }
  if (a.blockchain > b.blockchain) {
    return 1;
  }
  if (a.asset < b.asset) {
    return -1;
  }
  if (a.asset > b.asset) {
    return 1;
  }
  return 0;
}

function uniqueSortedSupports(items: MapPlaceSupport[]): MapPlaceSupport[] {
  const sorted = [...items]
    .map((item) => ({ blockchain: item.blockchain, asset: item.asset }))
    .sort(compareSupport);
  const unique: MapPlaceSupport[] = [];
  for (const item of sorted) {
    const prev = unique[unique.length - 1];
    if (prev !== undefined && prev.blockchain === item.blockchain && prev.asset === item.asset) {
      continue;
    }
    unique.push(item);
  }
  return unique;
}

/**
 * Validate a pin origin.
 *
 * @param raw - Query string or JSON value.
 * @returns The trimmed origin, or a fixed error message.
 */
export function normalizePlaceOrigin(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(raw.trim())) {
    return { ok: false, error: ORIGIN_ERROR };
  }
  return { ok: true, value: raw.trim() };
}

function normalizeExternalId(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: EXTERNAL_ID_ERROR };
  }
  const externalId = raw.trim();
  if (externalId.length < 1 || externalId.length > 80 || !hasNoControls(externalId)) {
    return { ok: false, error: EXTERNAL_ID_ERROR };
  }
  return { ok: true, value: externalId };
}

function normalizeTechProvider(
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: TECH_PROVIDER_ERROR };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: undefined };
  }
  if (!TECH_PROVIDER.test(trimmed)) {
    return { ok: false, error: TECH_PROVIDER_ERROR };
  }
  return { ok: true, value: trimmed };
}

function normalizeCountry(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: COUNTRY_ERROR };
  }
  const country = raw.trim().toUpperCase();
  if (!ISO_COUNTRIES.has(country)) {
    return { ok: false, error: COUNTRY_ERROR };
  }
  return { ok: true, value: country };
}

function normalizeShopName(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: SHOP_NAME_ERROR };
  }
  const shopName = raw.trim();
  if (shopName.length < 1 || shopName.length > 40 || !hasNoControls(shopName)) {
    return { ok: false, error: SHOP_NAME_ERROR };
  }
  return { ok: true, value: shopName };
}

function normalizeQueryShopName(
  raw: string,
): { ok: true; value: 'SPAR' | 'others' } | { ok: false; error: string } {
  const shopName = raw.trim();
  if (shopName !== 'SPAR' && shopName !== 'others') {
    return { ok: false, error: SHOP_NAME_ERROR };
  }
  return { ok: true, value: shopName };
}

function normalizeBlockchain(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: SUPPORT_ERROR };
  }
  const blockchain = raw.trim();
  if (!PAYMENT_BLOCKCHAINS.has(blockchain)) {
    return { ok: false, error: SUPPORT_ERROR };
  }
  return { ok: true, value: blockchain };
}

function normalizeAsset(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: SUPPORT_ERROR };
  }
  const asset = raw.trim();
  if (!ASSET_TICKER.test(asset) && !ASSET_PREFIXED.test(asset)) {
    return { ok: false, error: SUPPORT_ERROR };
  }
  return { ok: true, value: asset };
}

function normalizeQueryBlockchain(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const blockchain = raw.trim();
  if (!PAYMENT_BLOCKCHAINS.has(blockchain) && !isCatalogBlockchain(blockchain)) {
    return { ok: false, error: SUPPORT_ERROR };
  }
  return { ok: true, value: blockchain };
}

function normalizeQueryAsset(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const asset = raw.trim();
  if (!ASSET_TICKER.test(asset) && !ASSET_PREFIXED.test(asset) && !isCatalogAsset(asset)) {
    return { ok: false, error: SUPPORT_ERROR };
  }
  return { ok: true, value: asset };
}

function normalizeSupports(
  raw: unknown,
): { ok: true; value: MapPlaceSupport[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: SUPPORT_ERROR };
  }
  if (raw.length > 32) {
    return { ok: false, error: SUPPORT_ERROR };
  }
  const items: MapPlaceSupport[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, error: SUPPORT_ERROR };
    }
    const rec = item as Record<string, unknown>;
    const blockchain = normalizeBlockchain(rec['blockchain']);
    if (!blockchain.ok) {
      return blockchain;
    }
    const asset = normalizeAsset(rec['asset']);
    if (!asset.ok) {
      return asset;
    }
    items.push({ blockchain: blockchain.value, asset: asset.value });
  }
  return { ok: true, value: uniqueSortedSupports(items) };
}

/**
 * Validate a JSON body for one map pin.
 *
 * @param input - Request JSON.
 * @returns The pin, or a fixed error message.
 */
export function normalizeMapPlace(
  input: unknown,
): { ok: true; value: MapPlaceInput } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: COORD_ERROR };
  }
  const rec = input as Record<string, unknown>;
  const lat = rec['lat'];
  const lon = rec['lon'];
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return { ok: false, error: COORD_ERROR };
  }

  const origin = normalizePlaceOrigin(rec['origin']);
  if (!origin.ok) {
    return origin;
  }

  const externalId = normalizeExternalId(rec['externalId']);
  if (!externalId.ok) {
    return externalId;
  }

  const rawName = rec['name'];
  if (typeof rawName !== 'string') {
    return { ok: false, error: NAME_ERROR };
  }
  const name = rawName.trim();
  if (name.length < 1 || name.length > 80 || !hasNoControls(name)) {
    return { ok: false, error: NAME_ERROR };
  }

  const rawCategory = rec['category'];
  if (typeof rawCategory !== 'string') {
    return { ok: false, error: CATEGORY_ERROR };
  }
  const category = rawCategory.trim();
  if (category.length < 1 || category.length > 40 || !/^[a-z0-9_-]+$/.test(category)) {
    return { ok: false, error: CATEGORY_ERROR };
  }

  let paymentMethods: string | null = null;
  const rawPayment = rec['paymentMethods'];
  if (typeof rawPayment === 'string') {
    const trimmed = rawPayment.trim();
    if (PAYMENT_METHODS.test(trimmed)) {
      paymentMethods = trimmed;
    }
  }

  const techProvider = normalizeTechProvider(rec['techProvider']);
  if (!techProvider.ok) {
    return techProvider;
  }

  const rawCountry = rec['country'];
  let country: string | undefined;
  if (rawCountry !== undefined && rawCountry !== null) {
    const parsedCountry = normalizeCountry(rawCountry);
    if (!parsedCountry.ok) {
      return parsedCountry;
    }
    country = parsedCountry.value;
  }

  const rawShopName = rec['shopName'];
  let shopName: string | undefined;
  if (rawShopName !== undefined && rawShopName !== null) {
    const parsedShopName = normalizeShopName(rawShopName);
    if (!parsedShopName.ok) {
      return parsedShopName;
    }
    shopName = parsedShopName.value;
  }

  const rawSupports = rec['supports'];
  let supports: MapPlaceSupport[] | undefined;
  if (rawSupports !== undefined) {
    const parsedSupports = normalizeSupports(rawSupports);
    if (!parsedSupports.ok) {
      return parsedSupports;
    }
    supports = parsedSupports.value;
  }

  const value: MapPlaceInput = {
    origin: origin.value,
    externalId: externalId.value,
    name,
    lat: roundCoord(lat),
    lon: roundCoord(lon),
    category,
    paymentMethods,
  };
  if (techProvider.value !== undefined) {
    value.techProvider = techProvider.value;
  }
  if (country !== undefined) {
    value.country = country;
  }
  if (shopName !== undefined) {
    value.shopName = shopName;
  }
  if (supports !== undefined) {
    value.supports = supports;
  }
  return { ok: true, value };
}

/**
 * Validate origin and external id for a pin delete.
 *
 * @param input - Request JSON.
 * @returns The key, or a fixed error message.
 */
export function normalizeMapPlaceKey(
  input: unknown,
): { ok: true; value: { origin: string; externalId: string } } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: ORIGIN_ERROR };
  }
  const rec = input as Record<string, unknown>;
  const origin = normalizePlaceOrigin(rec['origin']);
  if (!origin.ok) {
    return origin;
  }
  const externalId = normalizeExternalId(rec['externalId']);
  if (!externalId.ok) {
    return externalId;
  }
  return { ok: true, value: { origin: origin.value, externalId: externalId.value } };
}

/**
 * Classify a stored transaction instant relative to the request clock.
 *
 * @param lastTransactionAt - Stored instant, or null when none.
 * @param nowMs - Request clock in milliseconds.
 * @returns One of the three mutually exclusive activity buckets.
 */
export function placeActivity(
  lastTransactionAt: string | null,
  nowMs: number,
): 'within7Days' | 'within30Days' | 'none' {
  if (lastTransactionAt === null) {
    return 'none';
  }
  const parsed = Date.parse(lastTransactionAt);
  if (!Number.isFinite(parsed)) {
    return 'none';
  }
  const age = nowMs - parsed;
  if (age <= 7 * 24 * 60 * 60 * 1000) {
    return 'within7Days';
  }
  if (age <= 30 * 24 * 60 * 60 * 1000) {
    return 'within30Days';
  }
  return 'none';
}

/**
 * Validate a JSON body that records a shop transaction.
 *
 * @param input - Request JSON.
 * @param nowMs - Request clock in milliseconds.
 * @returns The key and a canonical instant, or a fixed error message.
 */
export function normalizePlaceTransaction(
  input: unknown,
  nowMs: number,
):
  | { ok: true; value: { origin: string; externalId: string; occurredAt: string } }
  | { ok: false; error: string } {
  const key = normalizeMapPlaceKey(input);
  if (!key.ok) {
    return key;
  }
  const rec = input as Record<string, unknown>;
  const rawOccurredAt = rec['occurredAt'];
  if (rawOccurredAt === undefined) {
    return {
      ok: true,
      value: {
        origin: key.value.origin,
        externalId: key.value.externalId,
        occurredAt: new Date(nowMs).toISOString(),
      },
    };
  }
  if (typeof rawOccurredAt !== 'string' || rawOccurredAt.trim() === '') {
    return { ok: false, error: TRANSACTION_TIME_ERROR };
  }
  const parsed = Date.parse(rawOccurredAt);
  if (!Number.isFinite(parsed) || parsed > nowMs + 120_000) {
    return { ok: false, error: TRANSACTION_TIME_ERROR };
  }
  return {
    ok: true,
    value: {
      origin: key.value.origin,
      externalId: key.value.externalId,
      occurredAt: new Date(parsed).toISOString(),
    },
  };
}

/**
 * Validate optional public map query fields.
 *
 * @param country - Optional ISO country query.
 * @param shopName - Optional SPAR or others query.
 * @param blockchain - Optional payment network query.
 * @param asset - Optional asset name query.
 * @returns The present filter fields, or a fixed error message.
 */
export function normalizeMapPlaceFilter(
  country?: string | undefined,
  shopName?: string | undefined,
  blockchain?: string | undefined,
  asset?: string | undefined,
): { ok: true; value: MapPlaceQueryFilter } | { ok: false; error: string } {
  const value: MapPlaceQueryFilter = {};
  if (country !== undefined) {
    const parsed = normalizeCountry(country);
    if (!parsed.ok) {
      return parsed;
    }
    value.country = parsed.value;
  }
  if (shopName !== undefined) {
    const parsed = normalizeQueryShopName(shopName);
    if (!parsed.ok) {
      return parsed;
    }
    value.shopName = parsed.value;
  }
  if (blockchain !== undefined) {
    const parsed = normalizeQueryBlockchain(blockchain);
    if (!parsed.ok) {
      return parsed;
    }
    value.blockchain = parsed.value;
  }
  if (asset !== undefined) {
    const parsed = normalizeQueryAsset(asset);
    if (!parsed.ok) {
      return parsed;
    }
    value.asset = parsed.value;
  }
  return { ok: true, value };
}

/**
 * Drop fields that only the ingest caller needs.
 *
 * @param place - Stored pin.
 * @param nowMs - Request clock in milliseconds.
 * @returns The public map row, including activity.
 */
export function toPublicMapPlace(place: StoredMapPlace, nowMs: number): PublicMapPlace {
  return {
    id: place.id,
    origin: place.origin,
    name: place.name,
    lat: place.lat,
    lon: place.lon,
    category: place.category,
    techProvider: place.techProvider,
    country: place.country,
    shopName: place.shopName,
    supports: place.supports.map((item) => ({
      blockchain: item.blockchain,
      asset: item.asset,
    })),
    activity: placeActivity(place.lastTransactionAt, nowMs),
  };
}
