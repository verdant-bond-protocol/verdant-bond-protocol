import { Component, ChangeDetectionStrategy, Input, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { WalletService } from '../../../auth/wallet.service';
import { AuthService } from '../../../auth/auth.service';

/**
 * Contextual "connect your wallet" banner for read-only routes (issue #168).
 *
 * Public pages (bond list/detail, marketplace listings) stay browsable while
 * anonymous, but their write affordances need a wallet and a verified session.
 * This banner says so up front instead of letting the user discover it through
 * a 401. It renders nothing once the session is ready.
 */
@Component({
  selector: 'app-connect-prompt',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    @if (state() !== 'ready') {
      <div class="connect-prompt" role="status">
        <div class="prompt-copy">
          <strong class="prompt-title">{{ title() }}</strong>
          <span class="prompt-body">{{ action }}</span>
        </div>

        <div class="prompt-actions">
          @if (state() === 'disconnected') {
            <button type="button" class="btn btn-primary" [disabled]="walletService.isConnecting()" (click)="connect()">
              {{ walletService.isConnecting() ? 'Connecting…' : 'Connect Wallet' }}
            </button>
          } @else {
            <a class="btn btn-primary" routerLink="/auth">Sign In</a>
          }
        </div>
      </div>

      @if (walletService.errorMessage(); as message) {
        <p class="prompt-error" role="alert">{{ message }}</p>
      }
      @if (connectError(); as message) {
        <p class="prompt-error" role="alert">{{ message }}</p>
      }
    }
  `,
  styles: [`
    .connect-prompt { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; padding: 14px 18px; margin-bottom: 20px; border: 1px solid #bfdbfe; background: #eff6ff; border-radius: 10px; }
    .prompt-copy { display: flex; flex-direction: column; gap: 2px; }
    .prompt-title { font-size: 0.875rem; color: #1d4ed8; }
    .prompt-body { font-size: 0.8125rem; color: #1e40af; }
    .prompt-actions { display: flex; gap: 8px; }
    .btn { padding: 8px 16px; border-radius: 8px; font-size: 0.8125rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; display: inline-block; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2a2a4e; }
    .btn-primary:disabled { opacity: 0.5; cursor: wait; }
    .prompt-error { margin: -12px 0 20px; font-size: 0.8125rem; color: #b45309; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectPromptComponent {
  /** What the visitor is being asked to unlock, e.g. "to subscribe to this bond". */
  @Input() action = 'to use the actions on this page.';

  readonly walletService = inject(WalletService);
  private readonly authService = inject(AuthService);

  readonly connectError = signal<string | null>(null);

  readonly state = computed<'disconnected' | 'unauthenticated' | 'ready'>(() => {
    if (!this.walletService.isConnected()) return 'disconnected';
    return this.authService.isAuthenticated() ? 'ready' : 'unauthenticated';
  });

  readonly title = computed(() =>
    this.state() === 'disconnected' ? 'Connect your wallet' : 'Finish signing in',
  );

  async connect(): Promise<void> {
    this.connectError.set(null);
    try {
      await this.walletService.connect();
    } catch (error) {
      // `WalletService` already publishes a user-facing `errorMessage` for the
      // states it understands; only surface anything it did not classify.
      if (!this.walletService.errorMessage()) {
        this.connectError.set(error instanceof Error ? error.message : String(error));
      }
    }
  }
}
