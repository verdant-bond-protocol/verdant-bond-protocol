/**
 * Canonical quote asset registry (issue #92).
 *
 * The dex-router contract itself treats `quote_asset` as an opaque Soroban
 * Symbol with no allowlist (see contracts/dex-router/src/lib.rs) — every
 * safety check for "is this a real, supported quote asset" has to live here,
 * at the API boundary, before a request ever reaches the contract.
 *
 * This is the single source of truth on the API side. DTOs validate against
 * it (via `isSupportedQuoteAssetSymbol` / `IsQuoteAssetSymbol`), and
 * `dex.service.ts` normalizes incoming symbols through
 * `normalizeQuoteAssetSymbol` before building any contract call.
 *
 * The Angular frontend cannot import this file directly (it's a separate
 * npm project with no shared package) — its mirror lives at
 * frontend/src/app/marketplace/quote-assets.ts. See "Adding a new quote
 * asset" in docs/architecture.md for the checklist to keep both in sync.
 */

export interface QuoteAssetConfig {
  /** Canonical Soroban symbol sent to the dex-router contract. */
  readonly symbol: string;
  /** Decimal places used for display/precision formatting. */
  readonly decimals: number;
  /** Human-readable label for UI display. */
  readonly displayLabel: string;
  /** Whether this asset currently accepts new deposits/orders. */
  readonly enabled: boolean;
}

export const QUOTE_ASSET_REGISTRY: readonly QuoteAssetConfig[] = [
  { symbol: 'USDC', decimals: 6, displayLabel: 'USD Coin', enabled: true },
  { symbol: 'XLM', decimals: 7, displayLabel: 'Stellar Lumens', enabled: true },
];

export type QuoteAssetSymbol = (typeof QUOTE_ASSET_REGISTRY)[number]['symbol'];

const BY_SYMBOL = new Map<string, QuoteAssetConfig>(
  QUOTE_ASSET_REGISTRY.map((asset) => [asset.symbol, asset]),
);

/**
 * Looks up a quote asset by symbol, case-insensitively. Returns undefined
 * for unknown symbols; callers decide whether "unknown" and "disabled" are
 * both treated as rejection.
 */
export function getQuoteAsset(symbol: string): QuoteAssetConfig | undefined {
  if (typeof symbol !== 'string') return undefined;
  return BY_SYMBOL.get(symbol.trim().toUpperCase());
}

/** True only for a known, currently enabled quote asset. */
export function isSupportedQuoteAssetSymbol(symbol: string): boolean {
  const asset = getQuoteAsset(symbol);
  return asset !== undefined && asset.enabled;
}

/**
 * Returns the registry's canonical-cased symbol for a known asset (e.g.
 * "usdc" -> "USDC"), so contract calls always encode the same Symbol
 * regardless of how the client cased the request.
 */
export function normalizeQuoteAssetSymbol(symbol: string): QuoteAssetSymbol {
  const asset = getQuoteAsset(symbol);
  if (!asset || !asset.enabled) {
    throw new Error(`Unsupported quote asset: ${symbol}`);
  }
  return asset.symbol;
}

export function listSupportedQuoteAssets(): readonly QuoteAssetConfig[] {
  return QUOTE_ASSET_REGISTRY.filter((asset) => asset.enabled);
}
