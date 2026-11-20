import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WalletService } from '../../../auth/wallet.service';

@Component({
  selector: 'app-wallet-button',
  standalone: true,
  imports: [CommonModule],
  template: `
    <button
      *ngIf="!walletService.isConnected()"
      type="button"
      (click)="connect()"
      class="wallet-btn"
      [disabled]="walletService.isConnecting()"
      [attr.aria-busy]="walletService.isConnecting()"
      [attr.aria-describedby]="walletService.errorMessage() ? 'wallet-status' : null"
    >
      Connect Wallet
    </button>
    <button
      *ngIf="walletService.isConnected()"
      type="button"
      class="wallet-btn connected"
      (click)="walletService.refreshAccountState()"
      [attr.aria-label]="'Connected wallet ' + walletService.address() + '. Activate to refresh wallet state.'"
    >
      {{ walletService.address()?.slice(0, 6) }}...{{ walletService.address()?.slice(-4) }}
    </button>
    <p
      *ngIf="walletService.errorMessage()"
      id="wallet-status"
      class="wallet-status"
      role="status"
      aria-live="polite"
    >
      {{ walletService.errorMessage() }}
    </p>
  `,
  styles: [`
    .wallet-btn { padding: 8px 16px; border: 1px solid #1a1a2e; border-radius: 8px; background: transparent; color: #1a1a2e; cursor: pointer; font-size: 0.875rem; font-weight: 500; }
    .wallet-btn:focus-visible { outline: 3px solid #2f80ed; outline-offset: 2px; }
    .wallet-btn:disabled { opacity: 0.65; cursor: wait; }
    .wallet-btn:hover { background: #1a1a2e; color: #fff; }
    .wallet-btn.connected { background: #1a1a2e; color: #fff; font-family: monospace; }
    .wallet-status { margin: 0.25rem 0 0; font-size: 0.75rem; color: #8a4b00; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WalletButtonComponent {
  readonly walletService = inject(WalletService);

  async connect(): Promise<void> {
    await this.walletService.connect();
  }
}
