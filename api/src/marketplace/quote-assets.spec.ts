import {
  getQuoteAsset,
  isSupportedQuoteAssetSymbol,
  normalizeQuoteAssetSymbol,
  listSupportedQuoteAssets,
} from './quote-assets';

describe('quote-assets registry', () => {
  it('recognizes known symbols case-insensitively', () => {
    expect(isSupportedQuoteAssetSymbol('USDC')).toBe(true);
    expect(isSupportedQuoteAssetSymbol('usdc')).toBe(true);
    expect(isSupportedQuoteAssetSymbol('XLM')).toBe(true);
  });

  it('rejects an unsupported asset symbol', () => {
    expect(isSupportedQuoteAssetSymbol('DOGE')).toBe(false);
    expect(isSupportedQuoteAssetSymbol('')).toBe(false);
  });

  it('normalizes casing to the registry canonical symbol', () => {
    expect(normalizeQuoteAssetSymbol('usdc')).toBe('USDC');
    expect(normalizeQuoteAssetSymbol(' xlm ')).toBe('XLM');
  });

  it('throws for an unsupported symbol instead of silently passing it through', () => {
    expect(() => normalizeQuoteAssetSymbol('DOGE')).toThrow(/Unsupported quote asset/);
  });

  it('returns decimals/displayLabel for a known asset', () => {
    const usdc = getQuoteAsset('USDC');
    expect(usdc).toMatchObject({ symbol: 'USDC', decimals: 6, enabled: true });
  });

  it('lists only enabled assets', () => {
    const symbols = listSupportedQuoteAssets().map((a) => a.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['USDC', 'XLM']));
    expect(symbols.length).toBe(2);
  });
});
