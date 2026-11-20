import { InjectionToken } from '@angular/core';
import { isConnected, getAddress, getNetwork, signTransaction } from '@stellar/freighter-api';

/**
 * The slice of `@stellar/freighter-api` the app actually uses.
 *
 * Every call resolves to an object that may carry an `error` field instead of a
 * result (Freighter locked, extension missing, user rejected), so callers must
 * check `error` before trusting the payload.
 */
export interface FreighterApi {
  isConnected(): Promise<{ isConnected: boolean; error?: unknown }>;
  getAddress(): Promise<{ address: string; error?: unknown }>;
  getNetwork(): Promise<{ network: string; networkPassphrase: string; error?: unknown }>;
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string },
  ): Promise<{ signedTxXdr: string; error?: unknown }>;
}

/**
 * Injectable boundary around the Freighter browser extension.
 *
 * The library exports plain module-level functions, which cannot be spied on
 * once bundled. Routing them through a token keeps `WalletService` unit
 * testable — see `wallet.service.spec.ts`, which covers the missing-import
 * regression from issue #165.
 */
export const FREIGHTER_API = new InjectionToken<FreighterApi>('FREIGHTER_API', {
  providedIn: 'root',
  factory: () =>
    ({ isConnected, getAddress, getNetwork, signTransaction }) as unknown as FreighterApi,
});
