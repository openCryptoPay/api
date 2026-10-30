/**
 * One pin on the OpenCryptoPay map.
 * Coordinates are rounded to six decimal places.
 */

import { isCatalogAsset, isCatalogBlockchain, publicPlaceSupports } from '@/lib/map/filter-catalog';
import { isNostrPubkey, npubEncode } from '@/lib/map/nostr-key';
import { photoExtension, type PhotoType } from '@/lib/map/photo-strip';

/** Allowed shop type values. */
export const SHOP_TYPES = ['SPAR', 'Others'] as const;

export type ShopType = (typeof SHOP_TYPES)[number];

export type MapPlaceSupport = {
  blockchain: string;
  asset: string;
};

export type MapPlaceInput = {
  origin: string;
  externalId: string;
  name: string;
  description: string;
  lat: number;
  lon: number;
  category: string;
  paymentMethods: string | null;
  techProvider?: string;
  shopType: ShopType;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  country: string;
  supports: MapPlaceSupport[];
  /**
   * NIP-01 public key, the shop id (R7). `normalizeMapPlace` requires it
   * (step 1b); the type stays optional because stored rows from before step 1a
   * have none and the stores keep a stored key when a write leaves it out.
   */
  nostrPubkey?: string;
  /**
   * Google Maps https link. Absent when the JSON key is absent. Null when the
   * JSON value is null. Otherwise the trimmed link.
   */
  googleMapsUrl?: string | null;
};

export type PlaceActivity = 'daily' | 'within7Days' | 'within30Days' | 'olderThan30Days' | 'none';

/** One stored photo of a place, in display order. The file is stored once per hash. */
export type StoredPlacePhoto = {
  sha256: string;
  contentType: PhotoType;
  width: number;
  height: number;
  caption: string | null;
};

/** A photo as the public API shows it; `url` is absolute. */
export type PublicPhoto = {
  url: string;
  width: number;
  height: number;
  caption: string | null;
};

export type StoredMapPlace = Omit<MapPlaceInput, 'techProvider' | 'nostrPubkey'> & {
  id: string;
  /** Photos in display order; the first is the cover. */
  photos: StoredPlacePhoto[];
  /** Null for a row stored without a key; such a row is not complete. */
  nostrPubkey: string | null;
  createdAt: string;
  techProvider: string;
  lastTransactionAt: string | null;
  activity: PlaceActivity;
  /** Shown on the public map when true. Not part of completeness. */
  active: boolean;
  /** Stored https link, or null. Not part of completeness. */
  googleMapsUrl: string | null;
};

/** Fields the public map may show. The caller's own id stays off this list. */
export type PublicMapPlace = {
  /** The shop's npub, or null for a row without a key (only outside the public list). */
  id: string | null;
  origin: string;
  name: string;
  description: string;
  lat: number;
  lon: number;
  category: string;
  techProvider: string;
  shopType: ShopType;
  /** Deprecated, one release: 'SPAR' when shopType is 'SPAR', otherwise null. */
  shopName: 'SPAR' | null;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  country: string;
  supports: MapPlaceSupport[];
  activity: PlaceActivity;
  /** The first photo without its caption, or null. */
  coverPhoto: Omit<PublicPhoto, 'caption'> | null;
  /** Stored https link, or null. Not part of completeness. */
  googleMapsUrl: string | null;
};

/** One shop of `GET /map/places/{npub}`: the list entry plus every photo. */
export type PublicMapPlaceDetail = PublicMapPlace & { photos: PublicPhoto[] };

/** Query fields that restrict GET /map/places, all optional. */
export type MapPlaceQueryFilter = {
  country?: string;
  shopType?: ShopType;
  blockchain?: string;
  asset?: string;
};

const COORD_ERROR = 'Place must be a latitude and longitude';
const ORIGIN_ERROR = 'Place origin is invalid';
const EXTERNAL_ID_ERROR = 'Place external id is required';
const NAME_ERROR = 'Place name is required';
const NAME_ADDRESS_ERROR = 'Place name must not contain the address';
const CATEGORY_ERROR = 'Place category is required';
const TECH_PROVIDER_ERROR = 'Place tech provider is invalid';
const COUNTRY_ERROR = 'Place country is invalid';
const STREET_ERROR = 'Place street is invalid';
const HOUSE_NUMBER_ERROR = 'Place house number is invalid';
const POSTAL_CODE_ERROR = 'Place postal code is invalid';
const CITY_ERROR = 'Place city is invalid';
const SHOP_NAME_ERROR = 'Place shop name is invalid';
const SHOP_TYPE_ERROR = 'Place shop type is invalid';
const DESCRIPTION_ERROR = 'Place description is invalid';
const SUPPORT_ERROR = 'Place support is invalid';
const TRANSACTION_TIME_ERROR = 'Place transaction time is invalid';
const NOSTR_PUBKEY_ERROR = 'Place NOSTR public key is invalid';
const NOSTR_PUBKEY_REQUIRED_ERROR = 'Place NOSTR public key is required';
const REVISION_ERROR = 'Place revision is invalid';
const GOOGLE_MAPS_URL_ERROR = 'Place Google Maps link is invalid';
const GOOGLE_MAPS_HOSTS: ReadonlySet<string> = new Set([
  'www.google.com',
  'google.com',
  'maps.google.com',
]);
const FOUR_DIGIT_YEAR = /^\d{4}-/u;

const ALLOWED_PLACE_KEYS: ReadonlySet<string> = new Set([
  'origin',
  'externalId',
  'name',
  'description',
  'lat',
  'lon',
  'category',
  'paymentMethods',
  'techProvider',
  'shopType',
  'street',
  'houseNumber',
  'postalCode',
  'city',
  'country',
  'supports',
  'nostrPubkey',
  'googleMapsUrl',
  'revision',
]);

const ALLOWED_DELETE_KEYS: ReadonlySet<string> = new Set(['origin', 'externalId', 'revision']);

const PAYMENT_METHODS = /^(onchain|lightning|nfc)(,(onchain|lightning|nfc))*$/;
const TECH_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/;
const ASSET_TICKER = /^[A-Z][A-Z0-9]{1,31}$/;
const ASSET_PREFIXED = /^[a-z][A-Z][A-Z0-9]{1,30}$/;
const HOUSE_NUMBER = /^[0-9][0-9A-Za-z/ .&–-]{0,31}$/;
const POSTAL_CH_LI = /^[0-9]{4}$/;
const POSTAL_OTHER = /^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$/;
const CITY_LETTER = /\p{L}/u;

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
  'Arc',
  'Avalanche',
  'HyperCore',
  'HyperEVM',
  'Monad',
  'Sei',
  'Tempo',
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

function hasNoControlsExceptNewline(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 10) {
      continue;
    }
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsStandaloneToken(name: string, token: string): boolean {
  const escaped = escapeRegex(token);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
  return pattern.test(name);
}

function nameContainsPostalCode(name: string, postalCode: string): boolean {
  return containsStandaloneToken(name, postalCode);
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
 * Validate a caller id.
 *
 * @param raw - JSON value.
 * @returns The trimmed caller id, or a fixed error message.
 */
export function normalizeExternalId(
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

function normalizeStreet(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: STREET_ERROR };
  }
  const street = raw.trim();
  if (street.length < 1 || street.length > 120 || !hasNoControls(street)) {
    return { ok: false, error: STREET_ERROR };
  }
  return { ok: true, value: street };
}

function normalizeHouseNumber(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: HOUSE_NUMBER_ERROR };
  }
  if (!hasNoControls(raw)) {
    return { ok: false, error: HOUSE_NUMBER_ERROR };
  }
  const houseNumber = raw.trim();
  if (!HOUSE_NUMBER.test(houseNumber)) {
    return { ok: false, error: HOUSE_NUMBER_ERROR };
  }
  return { ok: true, value: houseNumber };
}

function normalizePostalCode(
  raw: unknown,
  country: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: POSTAL_CODE_ERROR };
  }
  if (!hasNoControls(raw)) {
    return { ok: false, error: POSTAL_CODE_ERROR };
  }
  const postalCode = raw.trim();
  const pattern = country === 'CH' || country === 'LI' ? POSTAL_CH_LI : POSTAL_OTHER;
  if (!pattern.test(postalCode)) {
    return { ok: false, error: POSTAL_CODE_ERROR };
  }
  return { ok: true, value: postalCode };
}

function normalizeCity(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: CITY_ERROR };
  }
  const city = raw.trim();
  if (city.length < 1 || city.length > 80 || !hasNoControls(city) || !CITY_LETTER.test(city)) {
    return { ok: false, error: CITY_ERROR };
  }
  return { ok: true, value: city };
}

function normalizeName(
  raw: unknown,
  postalCode: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: NAME_ERROR };
  }
  const name = raw.trim();
  if (name.length < 1 || name.length > 80 || !hasNoControls(name)) {
    return { ok: false, error: NAME_ERROR };
  }
  if (nameContainsPostalCode(name, postalCode)) {
    return { ok: false, error: NAME_ADDRESS_ERROR };
  }
  return { ok: true, value: name };
}

function normalizeDescription(
  raw: unknown,
  name: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: DESCRIPTION_ERROR };
  }
  const description = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (
    description.length < 20 ||
    description.length > 1000 ||
    !hasNoControlsExceptNewline(description) ||
    description.toLowerCase() === name.toLowerCase() ||
    description.length <= name.length
  ) {
    return { ok: false, error: DESCRIPTION_ERROR };
  }
  return { ok: true, value: description };
}

function normalizeShopType(
  raw: unknown,
): { ok: true; value: ShopType } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: SHOP_TYPE_ERROR };
  }
  const shopType = raw.trim();
  if (shopType !== 'SPAR' && shopType !== 'Others') {
    return { ok: false, error: SHOP_TYPE_ERROR };
  }
  return { ok: true, value: shopType };
}

function normalizeQueryShopType(
  raw: string,
): { ok: true; value: ShopType } | { ok: false; error: string } {
  return normalizeShopType(raw);
}

function normalizeQueryShopNameAlias(
  raw: string,
): { ok: true; value: ShopType } | { ok: false; error: string } {
  const shopName = raw.trim();
  if (shopName === 'SPAR') {
    return { ok: true, value: 'SPAR' };
  }
  if (shopName === 'others') {
    return { ok: true, value: 'Others' };
  }
  return { ok: false, error: SHOP_NAME_ERROR };
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

function normalizeRevision(
  raw: unknown,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
    return { ok: false, error: REVISION_ERROR };
  }
  return { ok: true, value: raw };
}

function normalizeNostrPubkey(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: false, error: NOSTR_PUBKEY_REQUIRED_ERROR };
  }
  if (!isNostrPubkey(raw)) {
    return { ok: false, error: NOSTR_PUBKEY_ERROR };
  }
  return { ok: true, value: raw };
}

/**
 * A Google Maps https link. The caller trims. No whitespace, no backslash, no
 * control or format character, no userinfo, no port, at most 2000 characters.
 * The host follows `https://` directly. The host is exactly `www.google.com`,
 * `google.com`, `maps.google.com`, or `maps.app.goo.gl`. The first three need the path
 * `/maps` or a path that starts with `/maps/`. `maps.app.goo.gl` needs a path
 * longer than `/`. Query and hash stay.
 *
 * @param value - Trimmed candidate.
 * @returns True when the link may be stored.
 */
export function isGoogleMapsUrl(value: string): boolean {
  if (/[\s\\\p{Cc}\p{Cf}]/u.test(value)) {
    return false;
  }
  if (value.length < 1 || value.length > 2000) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') {
    return false;
  }
  // The URL parser skips extra slashes before the host, so the host must follow
  // `https://` directly for the userinfo and port check below.
  if (!/^https:\/\/[^/]/iu.test(value)) {
    return false;
  }
  const rest = value.slice('https://'.length);
  const stop = rest.search(/[/?#]/u);
  const authority = stop < 0 ? rest : rest.slice(0, stop);
  if (authority.includes('@') || authority.includes(':')) {
    return false;
  }
  if (url.hostname === 'maps.app.goo.gl') {
    return url.pathname.length > 1;
  }
  if (!GOOGLE_MAPS_HOSTS.has(url.hostname)) {
    return false;
  }
  return url.pathname === '/maps' || url.pathname.startsWith('/maps/');
}

/**
 * Validate a JSON body for one map pin, including the required NOSTR key (R7),
 * the optional request revision (R8), and the optional Google Maps link.
 *
 * @param input - Request JSON.
 * @returns The pin and its revision, or a fixed error message.
 */
export function normalizeMapPlace(
  input: unknown,
):
  | { ok: true; value: MapPlaceInput & { nostrPubkey: string }; revision: number | undefined }
  | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: COORD_ERROR };
  }
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_PLACE_KEYS.has(key)) {
      return { ok: false, error: `Place field is not allowed: ${key.slice(0, 40)}` };
    }
  }

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

  let supports: MapPlaceSupport[] = [];
  if (rec['supports'] !== undefined) {
    const parsedSupports = normalizeSupports(rec['supports']);
    if (!parsedSupports.ok) {
      return parsedSupports;
    }
    supports = parsedSupports.value;
  }

  const country = normalizeCountry(rec['country']);
  if (!country.ok) {
    return country;
  }

  const street = normalizeStreet(rec['street']);
  if (!street.ok) {
    return street;
  }

  const houseNumber = normalizeHouseNumber(rec['houseNumber']);
  if (!houseNumber.ok) {
    return houseNumber;
  }

  const postalCode = normalizePostalCode(rec['postalCode'], country.value);
  if (!postalCode.ok) {
    return postalCode;
  }

  const city = normalizeCity(rec['city']);
  if (!city.ok) {
    return city;
  }

  const name = normalizeName(rec['name'], postalCode.value);
  if (!name.ok) {
    return name;
  }

  const description = normalizeDescription(rec['description'], name.value);
  if (!description.ok) {
    return description;
  }

  const shopType = normalizeShopType(rec['shopType']);
  if (!shopType.ok) {
    return shopType;
  }

  const nostrPubkey = normalizeNostrPubkey(rec['nostrPubkey']);
  if (!nostrPubkey.ok) {
    return nostrPubkey;
  }

  const revision = normalizeRevision(rec['revision']);
  if (!revision.ok) {
    return revision;
  }

  let googleMapsUrl: string | null | undefined = undefined;
  if (Object.hasOwn(rec, 'googleMapsUrl')) {
    const rawLink = rec['googleMapsUrl'];
    if (rawLink === null) {
      googleMapsUrl = null;
    } else if (typeof rawLink !== 'string') {
      return { ok: false, error: GOOGLE_MAPS_URL_ERROR };
    } else {
      const trimmed = rawLink.trim();
      if (!isGoogleMapsUrl(trimmed)) {
        return { ok: false, error: GOOGLE_MAPS_URL_ERROR };
      }
      googleMapsUrl = trimmed;
    }
  }

  const value: MapPlaceInput & { nostrPubkey: string } = {
    origin: origin.value,
    externalId: externalId.value,
    name: name.value,
    description: description.value,
    lat: roundCoord(lat),
    lon: roundCoord(lon),
    category,
    paymentMethods,
    shopType: shopType.value,
    street: street.value,
    houseNumber: houseNumber.value,
    postalCode: postalCode.value,
    city: city.value,
    country: country.value,
    supports,
    nostrPubkey: nostrPubkey.value,
  };
  if (techProvider.value !== undefined) {
    value.techProvider = techProvider.value;
  }
  if (googleMapsUrl !== undefined) {
    value.googleMapsUrl = googleMapsUrl;
  }
  return { ok: true, value, revision: revision.value };
}

/**
 * Validate origin and external id for a pin delete.
 * An own property `id` is rejected. Other extra fields are ignored.
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
  if (Object.hasOwn(rec, 'id')) {
    return { ok: false, error: 'Place field is not allowed: id' };
  }
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
 * Validate a `DELETE /map/places` body: exactly `origin`, `externalId` and an
 * optional `revision` (R8). `POST /map/places/transactions` keeps using
 * {@link normalizeMapPlaceKey}, which ignores other keys.
 *
 * @param input - Request JSON.
 * @returns The key and revision, or a fixed error message.
 */
export function normalizeMapPlaceDelete(
  input: unknown,
):
  | { ok: true; value: { origin: string; externalId: string }; revision: number | undefined }
  | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: ORIGIN_ERROR };
  }
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_DELETE_KEYS.has(key)) {
      return { ok: false, error: `Place field is not allowed: ${key.slice(0, 40)}` };
    }
  }
  const parsed = normalizeMapPlaceKey(rec);
  if (!parsed.ok) {
    return parsed;
  }
  const revision = normalizeRevision(rec['revision']);
  if (!revision.ok) {
    return revision;
  }
  return { ok: true, value: parsed.value, revision: revision.value };
}

const PAYMENT_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function utcDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function shiftUtcDay(day: string, deltaDays: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, date + deltaDays)).toISOString().slice(0, 10);
}

function utcMidnightPlusDays(day: string, deltaDays: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, date + deltaDays)).toISOString();
}

function countedPaymentDays(paymentDays: readonly string[], nowMs: number): string[] {
  const end = utcDayFromMs(nowMs);
  const start = shiftUtcDay(end, -6);
  const unique = new Set<string>();
  for (const day of paymentDays) {
    if (!PAYMENT_DAY.test(day)) {
      continue;
    }
    if (day < start || day > end) {
      continue;
    }
    unique.add(day);
  }
  return [...unique].sort();
}

/**
 * Classify a stored transaction instant and payment days relative to the maintenance clock.
 *
 * @param lastTransactionAt - Stored instant, or null when none.
 * @param paymentDays - Stored UTC date strings. Invalid and out-of-window values are ignored.
 * @param nowMs - Maintenance clock in milliseconds.
 * @returns The activity token and the instant when it next needs refresh, or null.
 */
export function placeActivity(
  lastTransactionAt: string | null,
  paymentDays: readonly string[],
  nowMs: number,
): { activity: PlaceActivity; until: string | null } {
  const counted = countedPaymentDays(paymentDays, nowMs);
  const pivot = counted.find((_, index) => index === counted.length - 5);
  if (pivot !== undefined) {
    return { activity: 'daily', until: utcMidnightPlusDays(pivot, 7) };
  }
  if (lastTransactionAt === null) {
    return { activity: 'none', until: null };
  }
  const lastMs = Date.parse(lastTransactionAt);
  if (!Number.isFinite(lastMs)) {
    return { activity: 'none', until: null };
  }
  const age = nowMs - lastMs;
  if (age <= SEVEN_DAYS_MS) {
    return {
      activity: 'within7Days',
      until: new Date(lastMs + SEVEN_DAYS_MS + 1).toISOString(),
    };
  }
  if (age <= THIRTY_DAYS_MS) {
    return {
      activity: 'within30Days',
      until: new Date(lastMs + THIRTY_DAYS_MS + 1).toISOString(),
    };
  }
  return { activity: 'olderThan30Days', until: null };
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
  const occurredAt = new Date(parsed).toISOString();
  // SQLite julianday() only reads four-digit years, so a negative year would hide the pin.
  if (!FOUR_DIGIT_YEAR.test(occurredAt)) {
    return { ok: false, error: TRANSACTION_TIME_ERROR };
  }
  return {
    ok: true,
    value: {
      origin: key.value.origin,
      externalId: key.value.externalId,
      occurredAt,
    },
  };
}

/**
 * Validate optional public map query fields.
 *
 * @param country - Optional ISO country query.
 * @param shopType - Optional SPAR or Others query.
 * @param legacyShopName - Deprecated SPAR or others query alias.
 * @param blockchain - Optional payment network query.
 * @param asset - Optional asset name query.
 * @returns The present filter fields, or a fixed error message.
 */
export function normalizeMapPlaceFilter(
  country?: string | undefined,
  shopType?: string | undefined,
  legacyShopName?: string | undefined,
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
  let mappedType: ShopType | undefined;
  if (shopType !== undefined) {
    const parsed = normalizeQueryShopType(shopType);
    if (!parsed.ok) {
      return parsed;
    }
    mappedType = parsed.value;
  }
  if (legacyShopName !== undefined) {
    const parsed = normalizeQueryShopNameAlias(legacyShopName);
    if (!parsed.ok) {
      return parsed;
    }
    if (mappedType !== undefined && mappedType !== parsed.value) {
      return { ok: false, error: SHOP_TYPE_ERROR };
    }
    mappedType = parsed.value;
  }
  if (mappedType !== undefined) {
    value.shopType = mappedType;
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
 * A stored photo as the public API shows it.
 *
 * @param photo - Stored photo reference.
 * @param baseUrl - `OCP_PUBLIC_BASE_URL`, the origin of the URL.
 * @returns `{ url, width, height, caption }` with
 * `url` = `<baseUrl>/map/photos/{sha256}.{jpg|png|webp}`.
 */
export function publicPhoto(photo: StoredPlacePhoto, baseUrl: string): PublicPhoto {
  return {
    url: `${baseUrl}/map/photos/${photo.sha256}.${photoExtension(photo.contentType)}`,
    width: photo.width,
    height: photo.height,
    caption: photo.caption,
  };
}

/**
 * Drop fields that only the ingest caller needs. The id is the shop's npub, or null without a
 * key; the internal UUID is not returned by this mapper or by public map responses.
 *
 * @param place - Stored pin.
 * @param baseUrl - `OCP_PUBLIC_BASE_URL`, the origin of every photo URL.
 * @returns The public map row, including the stored activity, the cover photo, and the Google Maps link.
 */
export function toPublicMapPlace(place: StoredMapPlace, baseUrl: string): PublicMapPlace {
  const cover = place.photos[0];
  return {
    id: place.nostrPubkey === null ? null : npubEncode(place.nostrPubkey),
    origin: place.origin,
    name: place.name,
    description: place.description,
    lat: place.lat,
    lon: place.lon,
    category: place.category,
    techProvider: place.techProvider,
    shopType: place.shopType,
    shopName: place.shopType === 'SPAR' ? 'SPAR' : null,
    street: place.street,
    houseNumber: place.houseNumber,
    postalCode: place.postalCode,
    city: place.city,
    country: place.country,
    supports: publicPlaceSupports(place.techProvider),
    activity: place.activity,
    coverPhoto:
      cover === undefined
        ? null
        : {
            url: publicPhoto(cover, baseUrl).url,
            width: cover.width,
            height: cover.height,
          },
    googleMapsUrl: place.googleMapsUrl,
  };
}

/**
 * One shop for `GET /map/places/{npub}`: the list entry plus every photo in
 * display order.
 *
 * @param place - Stored complete pin.
 * @param baseUrl - `OCP_PUBLIC_BASE_URL`, the origin of every photo URL.
 * @returns The public detail.
 */
export function toPublicMapPlaceDetail(
  place: StoredMapPlace,
  baseUrl: string,
): PublicMapPlaceDetail {
  return {
    ...toPublicMapPlace(place, baseUrl),
    photos: place.photos.map((photo) => publicPhoto(photo, baseUrl)),
  };
}
