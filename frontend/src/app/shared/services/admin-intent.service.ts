import { Injectable, computed, inject, signal } from '@angular/core';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { environment } from '../../../environments/environment';
import { AdminAccessService } from './admin-access.service';

export interface AdminIntentPayload {
  action: string;
  target: string;
  chain: string;
  expiry: number;
  nonce: string;
}

export interface SignedAdminIntent extends AdminIntentPayload {
  signature: string;
}

/** Raised when a high-risk request is attempted without an unlocked secret. */
export class AdminSecretMissingError extends Error {
  constructor(action: string) {
    super(
      `"${action}" requires a signed admin intent. Unlock the admin session with your Stellar secret key and try again.`,
    );
    this.name = 'AdminSecretMissingError';
  }
}

/**
 * Frontend/admin-tooling support for signed step-up intents (#115).
 *
 * High-risk admin actions must be accompanied by a fresh signed intent. The
 * admin signs a canonical message (`action|target|chain|expiry|nonce`) with
 * their Stellar ed25519 secret key. In a browser context this secret is
 * supplied by the admin console (never the end-user Freighter wallet).
 *
 * The secret is held in memory for the tab session only: it is never written to
 * `localStorage`, never sent to the API, and is dropped on reload or on
 * `clearAdminSecret()`. See `AdminSecretPromptComponent` for the entry point
 * that fills it (issue #166).
 */
@Injectable({ providedIn: 'root' })
export class AdminIntentService {
  private readonly adminAccess = inject(AdminAccessService);

  private readonly secret = signal<string | null>(null);

  /** True once an admin secret has been unlocked for this tab session. */
  readonly hasSecret = computed(() => this.secret() !== null);

  /** Public key derived from the unlocked secret, for display/confirmation. */
  readonly unlockedAddress = computed(() => {
    const secret = this.secret();
    if (!secret) return null;
    try {
      return Keypair.fromSecret(secret).publicKey();
    } catch {
      return null;
    }
  });

  /**
   * Unlock the admin session.
   *
   * Rejects anything that is not a valid `S…` seed, and — when the deployment
   * configures `adminAddress` — anything that does not derive to that account,
   * so a wrong key fails here instead of as an opaque 401 from `IntentGuard`.
   */
  setAdminSecret(secret: string | null): void {
    if (secret === null || secret === '') {
      this.secret.set(null);
      return;
    }

    const trimmed = secret.trim();
    if (!StrKey.isValidEd25519SecretSeed(trimmed)) {
      throw new Error('That is not a valid Stellar secret key (expected an S… seed).');
    }

    const derived = Keypair.fromSecret(trimmed).publicKey();
    const expected = this.adminAccess.adminAddress();
    if (expected && derived !== expected) {
      throw new Error(
        `That key belongs to ${derived}, which is not this deployment's admin account. The API will reject its intents.`,
      );
    }

    this.secret.set(trimmed);
  }

  /** Drop the in-memory secret. */
  clearAdminSecret(): void {
    this.secret.set(null);
  }

  build(action: string, target: string, chain: string = environment.networkPassphrase): AdminIntentPayload {
    return {
      action,
      target: String(target),
      chain,
      expiry: Date.now() + 5 * 60 * 1000,
      nonce: crypto.randomUUID(),
    };
  }

  sign(payload: AdminIntentPayload, secret: string | null = this.secret()): SignedAdminIntent {
    if (!secret) {
      throw new AdminSecretMissingError(payload.action);
    }
    const keypair = Keypair.fromSecret(secret);
    const message = `${payload.action}|${payload.target}|${payload.chain}|${payload.expiry}|${payload.nonce}`;
    // UTF-8 bytes of the canonical message; `Buffer` is not a browser global.
    const bytes = keypair.sign(new TextEncoder().encode(message) as Buffer);
    return { ...payload, signature: toBase64(bytes) };
  }

  /** Build and sign in one step. */
  create(action: string, target: string, chain?: string): SignedAdminIntent {
    return this.sign(this.build(action, target, chain));
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
