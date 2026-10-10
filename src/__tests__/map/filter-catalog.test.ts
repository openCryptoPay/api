import { describe, expect, it } from 'vitest';
import {
  isCatalogAsset,
  isCatalogBlockchain,
  matchesUnstatedPayment,
  publicFilterResponse,
  unstatedPaymentSql,
} from '@/lib/map/filter-catalog';

describe('payment-link filter catalog', () => {
  it('names the payment-link networks and assets, not test or inactive ones', () => {
    expect(isCatalogBlockchain('Ethereum')).toBe(true);
    expect(isCatalogBlockchain('BinancePay')).toBe(true);
    expect(isCatalogBlockchain('KucoinPay')).toBe(true);
    expect(isCatalogBlockchain('Zano')).toBe(true);
    expect(isCatalogBlockchain('Lightning')).toBe(true);
    expect(isCatalogBlockchain('Plasma')).toBe(false);
    expect(isCatalogBlockchain('Sepolia')).toBe(false);
    expect(isCatalogBlockchain('Arkade')).toBe(false);
    expect(isCatalogBlockchain('Kraken')).toBe(false);

    expect(isCatalogAsset('ZCHF')).toBe(true);
    expect(isCatalogAsset('ckBTC')).toBe(true);
    expect(isCatalogAsset('dEURO')).toBe(true);
    expect(isCatalogAsset('USDC.e')).toBe(false);
    expect(isCatalogAsset('USDbC')).toBe(false);
    expect(isCatalogAsset('AAVE')).toBe(false);
    expect(isCatalogAsset('XPL')).toBe(false);
    expect(isCatalogAsset('ckbtc')).toBe(false);
  });

  it('matches an unstated pin from the catalog for its tech provider', () => {
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', undefined, undefined)).toBe(true);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', 'Ethereum', undefined)).toBe(true);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', 'Ethereum', 'ZCHF')).toBe(true);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', 'Ethereum', 'BTC')).toBe(false);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', 'Polygon', 'ZCHF')).toBe(true);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', 'Arbitrum', 'AAVE')).toBe(false);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', 'Gnosis', 'xDAI')).toBe(false);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', 'Plasma', undefined)).toBe(false);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', 'BinancePay', undefined)).toBe(true);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', undefined, 'ckBTC')).toBe(true);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', undefined, 'AAAA')).toBe(false);
    expect(matchesUnstatedPayment('dfx', 'DFX.swiss', 'Lightning', 'BTC')).toBe(true);

    expect(matchesUnstatedPayment('21gifts', 'DFX.swiss', 'Ethereum', undefined)).toBe(false);
    expect(matchesUnstatedPayment('dfx', '21.gifts', 'Ethereum', undefined)).toBe(false);
    expect(matchesUnstatedPayment('21gifts', '21.gifts', 'Lightning', undefined)).toBe(true);
    expect(matchesUnstatedPayment('21gifts', '21.gifts', undefined, 'BTC')).toBe(true);
    expect(matchesUnstatedPayment('21gifts', '21.gifts', 'Lightning', 'BTC')).toBe(true);
    expect(matchesUnstatedPayment('21gifts', '21.gifts', 'Lightning', 'ZCHF')).toBe(false);
    expect(matchesUnstatedPayment('21gifts', '21.gifts', undefined, 'ZCHF')).toBe(false);
    expect(matchesUnstatedPayment('21gifts', '21.gifts', undefined, 'ckBTC')).toBe(false);
  });

  it('builds a stored-row predicate only when the catalog cannot match', () => {
    expect(unstatedPaymentSql()).toBeNull();
    expect(unstatedPaymentSql('Plasma')).toBeNull();
    expect(unstatedPaymentSql('Ethereum', 'BTC')).toBeNull();
    expect(unstatedPaymentSql(undefined, 'AAAA')).toBeNull();

    const chain = unstatedPaymentSql('Ethereum');
    expect(chain?.params).toEqual(['Ethereum', '0', '1']);
    expect(chain?.sql).toContain('NOT EXISTS');
    expect(chain?.sql).toContain("tech_provider = '21.gifts'");
    expect(chain?.sql).toContain("origin = '21gifts'");

    expect(unstatedPaymentSql('Lightning', 'BTC')?.params).toEqual(['Lightning', 'BTC', '1', '1']);
    expect(unstatedPaymentSql(undefined, 'ckBTC')?.params).toEqual(['ckBTC', '0', '1']);
    expect(unstatedPaymentSql(undefined, 'BTC')?.params).toEqual(['BTC', '1', '1']);
    expect(unstatedPaymentSql('BinancePay')?.params).toEqual(['BinancePay', '0', '1']);
    expect(unstatedPaymentSql('Ethereum', 'ZCHF')?.params).toEqual(['Ethereum', 'ZCHF', '0', '1']);
  });

  it('unions stored filter values with the catalog and keeps provider offers whole', () => {
    const merged = publicFilterResponse({
      countries: ['CH'],
      blockchains: ['Plasma'],
      assets: ['ONDO', 'ZCHF'],
    });
    expect(merged.shopNames).toEqual(['SPAR', 'others']);
    expect(merged.countries).toEqual(['CH']);
    expect(merged.blockchains).toContain('Plasma');
    expect(merged.blockchains).toContain('Lightning');
    expect(merged.blockchains).not.toContain('Sepolia');
    expect(merged.blockchains[0]).toBe('Arbitrum');
    expect(merged.assets.filter((asset) => asset === 'ZCHF')).toHaveLength(1);
    expect(merged.assets).toContain('ONDO');
    expect(merged.assets).toContain('BTC');
    expect(merged.assets).toContain('ckBTC');

    const ethereum = publicFilterResponse(
      { countries: [], blockchains: ['Plasma', 'Ethereum'], assets: ['AAAA'] },
      'Ethereum',
    );
    expect(ethereum.assets).toContain('AAAA');
    expect(ethereum.assets).toContain('ZCHF');
    expect(ethereum.assets).not.toContain('ONDO');
    expect(ethereum.assets).not.toContain('BTC');
    expect(ethereum.blockchains).toContain('Plasma');

    const plasma = publicFilterResponse(
      { countries: [], blockchains: ['Plasma'], assets: ['ONDO'] },
      'Plasma',
    );
    expect(plasma.assets).toEqual(['ONDO']);

    const dfx = merged.techProviders.find((provider) => provider.name === 'DFX.swiss');
    const gifts = merged.techProviders.find((provider) => provider.name === '21.gifts');
    expect(dfx?.blockchains).not.toContain('Plasma');
    expect(dfx?.blockchains).not.toContain('Sepolia');
    expect(dfx?.blockchains).toContain('BinancePay');
    expect(dfx?.blockchains).toContain('Zano');
    expect(dfx?.assets).not.toContain('XPL');
    expect(dfx?.pairs).toContainEqual({ blockchain: 'Ethereum', asset: 'ZCHF' });
    expect(dfx?.pairs).toContainEqual({ blockchain: 'Polygon', asset: 'ZCHF' });
    expect(dfx?.pairs).not.toContainEqual({ blockchain: 'Ethereum', asset: 'BTC' });
    expect(dfx?.pairs).not.toContainEqual({ blockchain: 'Arbitrum', asset: 'AAVE' });
    expect(dfx?.pairs).not.toContainEqual({ blockchain: 'Gnosis', asset: 'xDAI' });
    expect(dfx?.pairs).not.toContainEqual({ blockchain: 'Arkade', asset: 'BTC' });
    expect(gifts).toEqual({
      name: '21.gifts',
      blockchains: ['Lightning'],
      assets: ['BTC'],
      pairs: [{ blockchain: 'Lightning', asset: 'BTC' }],
    });
  });
});
