import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { WalletButtonComponent } from './shared/components/wallet-button/wallet-button.component';
import { PendingTxIndicatorComponent } from './shared/components/pending-tx-indicator/pending-tx-indicator.component';
import { AuthService } from './auth/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterModule, WalletButtonComponent, PendingTxIndicatorComponent],
  template: `
    <div class="app-shell">
      <header class="app-header">
        <nav class="nav">
          <a class="nav-link" routerLink="/dashboard">Dashboard</a>
          <a class="nav-link" routerLink="/projects">Projects</a>
          <a class="nav-link" routerLink="/bonds">Bonds</a>
          <a class="nav-link" routerLink="/marketplace">Marketplace</a>
          @if (!authService.sessionReady()) {
            <a class="nav-link" routerLink="/auth">Sign In</a>
          }
        </nav>
        <div class="header-actions">
          <app-pending-tx-indicator />
          <app-wallet-button />
        </div>
      </header>
      <main class="app-main"><router-outlet /></main>
    </div>
  `,
  styles: [`
    .app-shell { min-height: 100vh; display: flex; flex-direction: column; }
    .app-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; }
    .nav { display: flex; gap: 16px; }
    .nav-link { text-decoration: none; color: #1a1a2e; font-size: 0.875rem; font-weight: 500; padding: 4px 12px; border-radius: 6px; }
    .nav-link:hover { background: #f0f2f5; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .app-main { flex: 1; padding: 24px; max-width: 1200px; width: 100%; margin: 0 auto; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  readonly authService = inject(AuthService);
}
