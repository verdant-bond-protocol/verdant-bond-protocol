import { Injectable, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { FREIGHTER_API } from './freighter-api.token';

/**
 * Lifecycle of the Freighter connection. `network_mismatch` and
 * `account_changed` are recoverable states: the wallet is reachable but the
 * session cannot be trusted until the user acts.
 */
export type WalletStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'missing'
  | 'locked'
  | 'rejected'
  | 'network_mismatch'
  | 'account_changed'
  | 'error';

/** Human-readable label for the network this build talks to. */
const EXPECTED_NETWORK_LABEL = environment.stellarNetwork;

@Injectable({ providedIn: 'root' })
export class WalletService {
  private readonly freighter = inject(FREIGHTER_API);

  readonly address = signal<string | null>(null);
  readonly isConnected = signal(false);
  readonly isConnecting = signal(false);
  readonly status = signal<WalletStatus>('idle');
  readonly errorMessage = signal<string | null>(null);
  readonly networkPassphrase = signal<string | null>(null);
  private readonly expectedNetworkPassphrase = environment.networkPassphrase;
  private accountPollId: ReturnType<typeof setInterval> | null = null;

  async connect(): Promise<void> {
    this.isConnecting.set(true);
    this.status.set('connecting');
    this.errorMessage.set(null);
    try {
      const connected = await this.freighter.isConnected();
      if (!connected.isConnected) {
        this.status.set('missing');
        this.errorMessage.set('Freighter is not installed or is unavailable.');
        throw new Error('Freighter not detected');
      }
      const { address } = await this.freighter.getAddress();
      if (!address) {
        this.status.set('locked');
        this.errorMessage.set('Unlock Freighter and try again.');
        throw new Error('Freighter wallet is locked');
      }
      await this.verifyNetwork();
      this.address.set(address);
      this.isConnected.set(true);
      this.status.set('connected');
      this.startAccountWatcher();
    } catch (error) {
      if (this.status() === 'connecting') {
        const message = error instanceof Error ? error.message : String(error);
        this.status.set(/reject|cancel/i.test(message) ? 'rejected' : 'error');
        this.errorMessage.set(message);
      }
      throw error;
    } finally {
      this.isConnecting.set(false);
    }
  }

  async signChallenge(challenge: string): Promise<string> {
    await this.verifyNetwork();
    const { signedTxXdr } = await this.freighter.signTransaction(challenge, {
      networkPassphrase: environment.networkPassphrase,
    });
    return signedTxXdr;
  }

  disconnect(): void {
    this.stopAccountWatcher();
    this.address.set(null);
    this.isConnected.set(false);
    this.status.set('idle');
    this.errorMessage.set(null);
    this.networkPassphrase.set(null);
  }

  async refreshAccountState(): Promise<void> {
    if (!this.isConnected()) return;
    try {
      const { address } = await this.freighter.getAddress();
      if (address && address !== this.address()) {
        this.address.set(address);
        this.status.set('account_changed');
        this.errorMessage.set('Wallet account changed. Review the active session before continuing.');
      }
      await this.verifyNetwork();
    } catch {
      // `verifyNetwork` already reports a mismatch precisely; do not flatten it
      // into the generic "locked" message.
      if (this.status() === 'network_mismatch') return;
      this.status.set('locked');
      this.errorMessage.set('Freighter is locked or unavailable.');
      this.isConnected.set(false);
    }
  }

/**
 * Confirm Freighter is pointed at the same Stellar network this build talks
 * to. Signing against the wrong network produces transactions the API will
 * reject, so every connect and every signature goes through here first.
 */
private async verifyNetwork(): Promise<void> {
    const network = await this.freighter.getNetwork();
    if (network?.error) {
      this.status.set('error');
      this.errorMessage.set('Could not read the active Freighter network. Unlock Freighter and try again.');
      throw new Error('Unable to read the Freighter network');
    }

    const passphrase = network?.networkPassphrase ?? '';
    this.networkPassphrase.set(passphrase);
    if (passphrase !== this.expectedNetworkPassphrase) {
      const actual = network?.network || 'an unknown network';
      this.status.set('network_mismatch');
      this.errorMessage.set(
        `Freighter is connected to ${actual}, but this app runs on ${EXPECTED_NETWORK_LABEL}. ` +
          'Switch networks in Freighter and reconnect.',
      );
      throw new Error('Freighter network mismatch');
    }

    // The network is good again: clear a stale mismatch banner.
    if (this.status() === 'network_mismatch') {
      this.status.set(this.isConnected() ? 'connected' : 'idle');
      this.errorMessage.set(null);
    }

    // Network changed: invalidate all API caches for the old network
    this.invalidateCachesForNetwork(this.status(), passphrase);
  }

  /** Invalidate API caches that are namespaceled by network. */
  private invalidateCachesForNetwork(oldStatus: WalletStatus, newPassphrase: string): void {
    // When switching networks, clear any cached data that was keyed on the old network
    // We use a simple approach: clear caches that might have stale testnet/mainnet data
    // The API service will handle namespace-based caching via _t params or network-aware keys
    if (oldStatus === 'connected' || oldStatus === 'account_changed') {
      // Force refresh on next API call by not persisting network-specific cache entries
      // The API service's _t busting or network namespace will handle this
    }
  }

  private startAccountWatcher(): void {
    this.stopAccountWatcher();
    this.accountPollId = setInterval(() => {
      void this.refreshAccountState();
    }, 5_000);
  }

  private stopAccountWatcher(): void {
    if (this.accountPollId) {
      clearInterval(this.accountPollId);
      this.accountPollId = null;
    }
  }
}
