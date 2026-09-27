import { Injectable, computed, inject, signal } from '@angular/core';
import { StrKey } from '@stellar/stellar-sdk';
import { WalletService } from '../../auth/wallet.service';
import { AuthService } from '../../auth/auth.service';
import { environment } from '../../../environments/environment';

export const ADMIN_ADDRESS_PLACEHOLDER = 'G...';

export function isValidAdminAddress(value: string | null | undefined): boolean {
  if (!value || value === ADMIN_ADDRESS_PLACEHOLDER) return false;
  try {
    return StrKey.isValidEd25519PublicKey(value);
  } catch {
    return false;
  }
}

@Injectable({ providedIn: 'root' })
export class AdminAccessService {
  private readonly walletService = inject(WalletService);
  private readonly authService = inject(AuthService);

  readonly adminAddress = signal<string | null>(
    isValidAdminAddress(environment.adminAddress) ? environment.adminAddress : null,
  );

  readonly isConfigured = computed(() => this.adminAddress() !== null);
  
  readonly isAdmin = computed(() => {
    return this.authService.hasRole('maintainer');
  });

  constructor() {}
}
