import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { WalletService } from './wallet.service';
import { AuthService } from './auth.service';
import { AUTH_REASON_PARAM, AuthDenialReason, RETURN_URL_PARAM } from './guards/auth.guard';

/** Why the guard sent the visitor here (issue #168). */
const DENIAL_MESSAGES: Record<AuthDenialReason, string> = {
  wallet: 'Connect your Stellar wallet to continue to that page.',
  session: 'Sign in with your wallet to continue to that page.',
  admin: 'That page is restricted to the protocol admin wallet.',
};

/**
 * Only ever return to an in-app path. `//host` and `/\host` are browser-legal
 * protocol-relative URLs, so they are rejected along with absolute ones.
 */
function sanitizeReturnUrl(candidate: string | null): string {
  if (!candidate || !candidate.startsWith('/')) return '/dashboard';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/dashboard';
  return candidate;
}

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <h1>Verdant Bond Protocol</h1>
        <p class="subtitle">Sign in with your Stellar wallet</p>

        <p *ngIf="denialMessage()" class="notice" role="status">{{ denialMessage() }}</p>

        <ng-container *ngIf="!walletService.isConnected()">
          <button class="btn btn-primary" (click)="walletService.connect()" [disabled]="walletService.isConnecting()">
            {{ walletService.isConnecting() ? 'Connecting...' : 'Connect Wallet' }}
          </button>
        </ng-container>

        <ng-container *ngIf="walletService.isConnected()">
          <div class="wallet-address">
            Connected: {{ walletService.address()?.slice(0, 6) }}...{{ walletService.address()?.slice(-4) }}
          </div>
          <button class="btn btn-primary" (click)="signIn()">
            Sign In with Stellar
          </button>
        </ng-container>

        <p *ngIf="error" class="error">{{ error }}</p>
        <p *ngIf="!error && walletService.errorMessage()" class="error">{{ walletService.errorMessage() }}</p>
      </div>
    </div>
  `,
  styles: [`
    .auth-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .auth-card { background: #fff; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; width: 100%; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 24px; }
    .notice { background: #eff6ff; border: 1px solid #bfdbfe; color: #1d4ed8; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 0.8125rem; }
    .wallet-address { background: #f0f2f5; padding: 8px 16px; border-radius: 8px; margin-bottom: 16px; font-family: monospace; font-size: 0.875rem; }
    .btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; width: 100%; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #ef4444; margin-top: 12px; font-size: 0.875rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly walletService = inject(WalletService);
  readonly authService = inject(AuthService);

  error = '';
  /** True when this page was reached via walletAuthGuard's redirect
   *  (i.e. there's a returnUrl other than the default). */
  readonly redirected = this.route.snapshot.queryParamMap.has('returnUrl');

  /** Route the guard bounced the visitor away from, if any (issue #168). */
  private readonly returnUrl = signal(
    sanitizeReturnUrl(this.route.snapshot.queryParamMap.get(RETURN_URL_PARAM)),
  );

  readonly denialMessage = signal<string | null>(
    DENIAL_MESSAGES[this.route.snapshot.queryParamMap.get(AUTH_REASON_PARAM) as AuthDenialReason] ?? null,
  );

  async signIn(): Promise<void> {
    this.error = '';
    try {
      await this.authService.login();
      // Send the visitor back to what they originally asked for.
      await this.router.navigateByUrl(this.returnUrl());
    } catch (e: any) {
      this.error = e.message || 'Sign in failed';
    }
  }
}
