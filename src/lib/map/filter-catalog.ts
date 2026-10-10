/**
 * Temporary payment-link filter catalog.
 * Networks are those offered for payment links, without test networks and
 * without Plasma. Assets are the payment-enabled names on those networks,
 * not the sellable names.
 * 21.gifts is Lightning and BTC only. Replace this module when the offer
 * is read from the payment service.
 */

const GIFTS_ORIGIN = '21gifts';
const GIFTS_TECH_PROVIDER = '21.gifts';
const GIFTS_BLOCKCHAIN = 'Lightning';
const GIFTS_ASSET = 'BTC';

const DFX_BLOCKCHAINS: readonly string[] = [
  'Arbitrum',
  'Base',
  'BinancePay',
  'BinanceSmartChain',
  'Bitcoin',
  'Cardano',
  'Ethereum',
  'Firo',
  'Gnosis',
  'InternetComputer',
  'KucoinPay',
  'Lightning',
  'Monero',
  'Optimism',
  'Polygon',
  'Solana',
  'Spark',
  'Tron',
  'Zano',
];

const DFX_PAIRS: readonly { blockchain: string; asset: string }[] = [
  { blockchain: 'Arbitrum', asset: 'ETH' },
  { blockchain: 'Arbitrum', asset: 'USDC' },
  { blockchain: 'Arbitrum', asset: 'USDT' },
  { blockchain: 'Arbitrum', asset: 'WBTC' },
  { blockchain: 'Arbitrum', asset: 'dEURO' },
  { blockchain: 'Base', asset: 'ETH' },
  { blockchain: 'Base', asset: 'USDC' },
  { blockchain: 'Base', asset: 'dEURO' },
  { blockchain: 'BinancePay', asset: 'USDT' },
  { blockchain: 'BinanceSmartChain', asset: 'BNB' },
  { blockchain: 'BinanceSmartChain', asset: 'USDC' },
  { blockchain: 'BinanceSmartChain', asset: 'USDT' },
  { blockchain: 'Bitcoin', asset: 'BTC' },
  { blockchain: 'Cardano', asset: 'ADA' },
  { blockchain: 'Ethereum', asset: 'ETH' },
  { blockchain: 'Ethereum', asset: 'USDC' },
  { blockchain: 'Ethereum', asset: 'USDT' },
  { blockchain: 'Ethereum', asset: 'WBTC' },
  { blockchain: 'Ethereum', asset: 'ZCHF' },
  { blockchain: 'Ethereum', asset: 'dEURO' },
  { blockchain: 'Firo', asset: 'FIRO' },
  { blockchain: 'InternetComputer', asset: 'ICP' },
  { blockchain: 'InternetComputer', asset: 'VCHF' },
  { blockchain: 'InternetComputer', asset: 'VEUR' },
  { blockchain: 'InternetComputer', asset: 'ckBTC' },
  { blockchain: 'KucoinPay', asset: 'USDT' },
  { blockchain: 'Lightning', asset: 'BTC' },
  { blockchain: 'Monero', asset: 'XMR' },
  { blockchain: 'Optimism', asset: 'ETH' },
  { blockchain: 'Optimism', asset: 'USDC' },
  { blockchain: 'Optimism', asset: 'USDT' },
  { blockchain: 'Optimism', asset: 'WBTC' },
  { blockchain: 'Optimism', asset: 'dEURO' },
  { blockchain: 'Polygon', asset: 'POL' },
  { blockchain: 'Polygon', asset: 'USDC' },
  { blockchain: 'Polygon', asset: 'USDT' },
  { blockchain: 'Polygon', asset: 'WBTC' },
  { blockchain: 'Polygon', asset: 'ZCHF' },
  { blockchain: 'Polygon', asset: 'dEURO' },
  { blockchain: 'Solana', asset: 'SOL' },
  { blockchain: 'Solana', asset: 'USDC' },
  { blockchain: 'Solana', asset: 'USDT' },
  { blockchain: 'Spark', asset: 'BTC' },
  { blockchain: 'Tron', asset: 'TRX' },
  { blockchain: 'Tron', asset: 'USDT' },
];

const CHAIN_SET: ReadonlySet<string> = new Set(DFX_BLOCKCHAINS);
const ASSET_SET: ReadonlySet<string> = new Set(DFX_PAIRS.map((pair) => pair.asset));
const PAIR_KEYS: ReadonlySet<string> = new Set(
  DFX_PAIRS.map((pair) => `${pair.blockchain}\0${pair.asset}`),
);

export type MapFilterTechProvider = {
  name: string;
  blockchains: string[];
  assets: string[];
  pairs: { blockchain: string; asset: string }[];
};

export type PublicMapFilters = {
  shopNames: ['SPAR', 'others'];
  countries: string[];
  blockchains: string[];
  assets: string[];
  techProviders: MapFilterTechProvider[];
};

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function offerFlags(
  blockchain: string | undefined,
  asset: string | undefined,
): { gifts: boolean; dfx: boolean } {
  const gifts =
    (blockchain === undefined || blockchain === GIFTS_BLOCKCHAIN) &&
    (asset === undefined || asset === GIFTS_ASSET) &&
    (blockchain !== undefined || asset !== undefined);
  let dfx = false;
  if (blockchain !== undefined && asset !== undefined) {
    dfx = PAIR_KEYS.has(`${blockchain}\0${asset}`);
  } else if (blockchain !== undefined) {
    dfx = CHAIN_SET.has(blockchain);
  } else if (asset !== undefined) {
    dfx = ASSET_SET.has(asset);
  }
  return { gifts, dfx };
}

function supportSql(
  blockchain: string | undefined,
  asset: string | undefined,
): { sql: string; params: string[] } {
  if (blockchain !== undefined && asset !== undefined) {
    return {
      sql: 'id IN (SELECT place_id FROM map_place_support WHERE blockchain = ? AND asset = ?)',
      params: [blockchain, asset],
    };
  }
  if (blockchain !== undefined) {
    return {
      sql: 'id IN (SELECT place_id FROM map_place_support WHERE blockchain = ?)',
      params: [blockchain],
    };
  }
  /* v8 ignore start -- @preserve a matching offer always names a blockchain or an asset */
  if (asset === undefined) {
    return { sql: '0', params: [] };
  }
  /* v8 ignore stop -- @preserve */
  return {
    sql: 'id IN (SELECT place_id FROM map_place_support WHERE asset = ?)',
    params: [asset],
  };
}

function assetsFor(blockchain: string | undefined): string[] {
  if (blockchain === undefined) {
    return [...ASSET_SET];
  }
  const values: string[] = [];
  for (const pair of DFX_PAIRS) {
    if (pair.blockchain === blockchain) {
      values.push(pair.asset);
    }
  }
  return values;
}

/**
 * Whether a query network is in the hardcoded payment-link catalog.
 *
 * @param value - Trimmed blockchain query.
 * @returns True for a catalog network, including BinancePay and KucoinPay.
 */
export function isCatalogBlockchain(value: string): boolean {
  return CHAIN_SET.has(value);
}

/**
 * Whether a query asset is in the hardcoded payment-link catalog.
 *
 * @param value - Trimmed asset query.
 * @returns True for a catalog asset, including ckBTC and dEURO.
 */
export function isCatalogAsset(value: string): boolean {
  return ASSET_SET.has(value);
}

/**
 * Whether a pin with no support rows matches a payment filter.
 *
 * @param origin - Stored origin.
 * @param techProvider - Stored tech provider.
 * @param blockchain - Requested network, if any.
 * @param asset - Requested asset, if any.
 * @returns True when the hardcoded offer for that pin includes the request.
 */
export function matchesUnstatedPayment(
  origin: string,
  techProvider: string,
  blockchain: string | undefined,
  asset: string | undefined,
): boolean {
  if (blockchain === undefined && asset === undefined) {
    return true;
  }
  const offer = offerFlags(blockchain, asset);
  if (origin === GIFTS_ORIGIN || techProvider === GIFTS_TECH_PROVIDER) {
    return offer.gifts;
  }
  return offer.dfx;
}

/**
 * SQL for a blockchain or asset filter, including pins with no support rows.
 *
 * @param blockchain - Requested network, if any.
 * @param asset - Requested asset, if any.
 * @returns A parenthesised predicate and its bound parameters, or null when
 *   only stored support rows can match.
 */
export function unstatedPaymentSql(
  blockchain?: string | undefined,
  asset?: string | undefined,
): { sql: string; params: string[] } | null {
  const offer = offerFlags(blockchain, asset);
  if (!offer.gifts && !offer.dfx) {
    return null;
  }
  const support = supportSql(blockchain, asset);
  const giftsFlag = offer.gifts ? '1' : '0';
  let dfxFlag = '1';
  /* v8 ignore next 3 -- @preserve gifts offers are a subset of the DFX catalog */
  if (!offer.dfx) {
    dfxFlag = '0';
  }
  return {
    sql: `(${support.sql} OR (NOT EXISTS (SELECT 1 FROM map_place_support WHERE place_id = map_place.id) AND (((tech_provider = '21.gifts' OR origin = '21gifts') AND ? = '1') OR (NOT (tech_provider = '21.gifts' OR origin = '21gifts') AND ? = '1'))))`,
    params: [...support.params, giftsFlag, dfxFlag],
  };
}

/**
 * Public filter payload: stored values plus the hardcoded payment-link offer.
 *
 * @param stored - Distinct countries, blockchains, and assets already stored.
 * @param blockchain - When set, top-level assets are limited to that network.
 * @returns Shop-name tokens, countries, networks, assets, and per-provider offers.
 */
export function publicFilterResponse(
  stored: { countries: string[]; blockchains: string[]; assets: string[] },
  blockchain?: string | undefined,
): PublicMapFilters {
  return {
    shopNames: ['SPAR', 'others'],
    countries: stored.countries,
    blockchains: uniqueSorted([...DFX_BLOCKCHAINS, ...stored.blockchains]),
    assets: uniqueSorted([...assetsFor(blockchain), ...stored.assets]),
    techProviders: [
      {
        name: 'DFX.swiss',
        blockchains: [...DFX_BLOCKCHAINS],
        assets: [...ASSET_SET].sort(),
        pairs: DFX_PAIRS.map((pair) => ({ blockchain: pair.blockchain, asset: pair.asset })),
      },
      {
        name: GIFTS_TECH_PROVIDER,
        blockchains: [GIFTS_BLOCKCHAIN],
        assets: [GIFTS_ASSET],
        pairs: [{ blockchain: GIFTS_BLOCKCHAIN, asset: GIFTS_ASSET }],
      },
    ],
  };
}
