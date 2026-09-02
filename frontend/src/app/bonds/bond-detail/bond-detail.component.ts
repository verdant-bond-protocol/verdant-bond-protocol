import { Component, inject, OnInit, OnDestroy, ChangeDetectionStrategy, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService, CouponEligibility } from '../../shared/services/api.service';
import { WalletService } from '../../auth/wallet.service';
import { AuthService } from '../../auth/auth.service';
import { StatusBadgeComponent } from '../../shared/components/status-badge/status-badge.component';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner.component';
import { BondDetailReloadCoordinator } from './bond-detail.reload-coordinator';
import { ConnectPromptComponent } from '../../shared/components/connect-prompt/connect-prompt.component';
import { AdminSecretPromptComponent } from '../../shared/components/admin-secret-prompt/admin-secret-prompt.component';
import { AdminAccessService } from '../../shared/services/admin-access.service';
import { AdminIntentService } from '../../shared/services/admin-intent.service';
import { Bond, ClaimableCreditsResponse } from '../../shared/interfaces/bond.interface';
import { formatCreditMinorUnits } from '../../shared/utils/credit-format';

@Component({
  selector: 'app-bond-detail',
  standalone: true,
  imports: [
    CommonModule, RouterModule, FormsModule, StatusBadgeComponent, LoadingSpinnerComponent,
    ConnectPromptComponent, AdminSecretPromptComponent,
  ],
  providers: [BondDetailReloadCoordinator],
  template: `
    <div class="detail-page">
      <a class="back-link" routerLink="/bonds">← Back to Bonds</a>

      <app-connect-prompt action="Subscribing, claiming credits, and transferring tokens need a signed-in wallet." />

      @if (refreshing()) {
        <div class="refresh-banner">Refreshing bond data…</div>
      }

      @if (bond(); as b) {
        <div class="detail-grid">
          <div class="detail-card main">
            <div class="detail-header">
              <h1 class="detail-title">Bond #{{ b.id }}</h1>
              <app-status-badge [status]="b.status" variant="bond" />
            </div>

            <div class="maturity-banner" [class.frozen]="maturityReached()">
              @if (maturityReached()) {
                <strong>Frozen for trading.</strong>
                Maturity date ({{ b.maturityDate * 1000 | date:'mediumDate' }}) has been reached.
                Subscriptions and transfers are disabled.
              } @else {
                <strong>Matures in:</strong> {{ countdown() }}
              }
            </div>

            @if (couponEligibility() && !couponEligibility()!.eligible) {
              <div class="coupon-warning">
                <strong>Coupon distribution blocked.</strong>
                The referenced oracle report is disputed or rejected.
                @for (reason of couponEligibility()!.reasons; track reason) {
                  <div class="coupon-reason">• {{ reason }}</div>
                }
              </div>
            }

            <div class="detail-body">
              <div class="detail-field">
                <span class="field-label">Project ID</span>
                <span class="field-value mono">{{ b.projectId }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Face Value</span>
                <span class="field-value">{{ b.faceValue | number }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Credit Type</span>
                <span class="field-value">{{ b.creditType }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Maturity Date</span>
                <span class="field-value">{{ b.maturityDate * 1000 | date }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Total Supply</span>
                <span class="field-value">{{ b.totalSupply | number }}</span>
              </div>
              <div class="detail-field">
                <span class="field-label">Created</span>
                <span class="field-value">{{ b.createdAt | date }}</span>
              </div>
            </div>

            <div class="coupon-section">
              <h3 class="section-title">Coupon Schedule ({{ b.couponSchedule.length }} payments)</h3>
              <ul class="coupon-list">
                @for (ts of b.couponSchedule; track ts; let i = $index) {
                  <li class="coupon-item">
                    <span class="coupon-index">Period {{ i + 1 }}</span>
                    <span class="coupon-date">{{ ts | date }}</span>
                  </li>
                }
              </ul>
            </div>
          </div>

          <div class="detail-card sidebar">
            <h3 class="section-title">Subscription Progress</h3>
            <div class="progress-bar">
              <div class="progress-fill" [style.width.%]="subscribeProgress()"></div>
            </div>
            <div class="progress-text">
              {{ b.totalSubscribed | number }} / {{ b.totalSupply | number }}
              ({{ subscribeProgress() }}%)
            </div>

            <div class="subscribe-section">
              <h3 class="section-title">Subscribe</h3>
              @if (b.status !== 'Active' || maturityReached()) {
                @if (maturityReached()) {
                  <p class="status-notice">This bond has reached maturity and is frozen for trading.</p>
                } @else {
                  <p class="status-notice">This bond is {{ b.status }} and is not accepting new subscriptions.</p>
                }
              } @else {
                <div class="subscribe-form">
                  <label class="form-label" for="amount">Amount</label>
                  <input
                    id="amount"
                    type="number"
                    class="form-input"
                    [(ngModel)]="subscribeAmount"
                    placeholder="Enter amount"
                    min="1"
                  />
                  <button
                    class="btn btn-primary subscribe-btn"
                    [disabled]="!subscribeAmount || subscribeAmount < 1 || subscribeSubmitting() || !authService.sessionReady()"
                    (click)="onSubscribe()"
                  >
                    {{ subscribeSubmitting() ? 'Subscribing...' : 'Subscribe' }}
                  </button>
                  @if (!authService.sessionReady()) {
                    <p class="auth-hint">Connect your wallet and sign in to subscribe.</p>
                  }
                  @if (subscribeSuccess()) {
                    <div class="success-msg">Subscribed! Tx: {{ subscribeTx() }}</div>
                  }
                  @if (subscribeError()) {
                    <div class="error-msg">{{ subscribeError() }}</div>
                  }
                </div>
              }
            </div>

            <div class="marketplace-link">
              <a class="btn btn-outline" [routerLink]="['/marketplace']" [queryParams]="{ bondId: b.id }">
                View on Marketplace
              </a>
            </div>

            <div class="holders-section">
              <h3 class="section-title">Holders ({{ holders().length }})</h3>
              @if (sectionLoading().holders) {
                <div class="muted">Loading holders…</div>
              } @else if (holders().length === 0) {
                <div class="muted">No holders yet.</div>
              } @else {
                <ul class="holders-list">
                  @for (h of holders(); track h.address) {
                    <li class="holder-item">
                      <span class="mono">{{ h.address }}</span>
                      <span class="holder-balance">{{ h.balance | number }}</span>
                    </li>
                  }
                </ul>
              }
            </div>

            <div class="claim-section">
              <h3 class="section-title">Claim Credits</h3>
              @if (claimableLoading()) {
                <div class="muted">Loading claimable credits…</div>
              } @else if (claimable()) {
                <div class="claimable-total">
                  Claimable: {{ fmtCredits(claimable()!.total) }} credits
                </div>
                @if (claimable()!.details.length > 0) {
                  <div class="claimable-detail-title">Provenance</div>
                  <ul class="claimable-list">
                    @for (d of claimable()!.details; track d.periodIndex + '-' + d.reportId) {
                      <li class="claimable-item">
                        <span class="claimable-period">Period {{ d.periodIndex + 1 }}</span>
                        <span class="claimable-amount">{{ fmtCredits(d.amount) }}</span>
                        <span class="claimable-meta">
                          {{ d.creditType }} · {{ d.startTime * 1000 | date:'mediumDate' }}
                          – {{ d.endTime * 1000 | date:'mediumDate' }}
                        </span>
                      </li>
                    }
                  </ul>
                }
              }
              <button
                class="btn btn-primary claim-btn"
                [disabled]="claimSubmitting() || !authService.sessionReady()"
                (click)="onClaim()"
              >
                {{ claimSubmitting() ? 'Claiming...' : 'Claim Accrued Credits' }}
              </button>
              @if (!authService.sessionReady()) {
                <p class="auth-hint">Connect your wallet and sign in to claim credits.</p>
              }
              @if (claimSuccess()) {
                <div class="success-msg">
                  Claimed {{ claimCredits() }} credits! Tx: {{ claimTx() }}
                </div>
              }
              @if (claimError()) {
                <div class="error-msg">{{ claimError() }}</div>
              }
            </div>

            <div class="transfer-section">
              <h3 class="section-title">Transfer Tokens</h3>
              <button
                class="btn btn-outline refresh-btn"
                [disabled]="refreshing()"
                (click)="onRefresh()"
              >
                {{ refreshing() ? 'Refreshing…' : 'Refresh' }}
              </button>
              @if (maturityReached()) {
                <p class="status-notice">Transfers are disabled after the maturity date.</p>
              } @else {
                <div class="subscribe-form">
                  <label class="form-label" for="transferTo">Recipient Address</label>
                  <input
                    id="transferTo"
                    type="text"
                    class="form-input"
                    [(ngModel)]="transferTo"
                    placeholder="G... recipient public key"
                  />
                  <label class="form-label" for="transferAmount">Amount</label>
                  <input
                    id="transferAmount"
                    type="number"
                    class="form-input"
                    [(ngModel)]="transferAmount"
                    placeholder="Enter amount"
                    min="1"
                  />
                  <button
                    class="btn btn-primary transfer-btn"
                    [disabled]="!transferTo || !transferAmount || transferAmount < 1 || transferSubmitting() || !authService.sessionReady()"
                    (click)="onTransfer()"
                  >
                    {{ transferSubmitting() ? 'Transferring...' : 'Transfer' }}
                  </button>
                  @if (!authService.sessionReady()) {
                    <p class="auth-hint">Connect your wallet and sign in to transfer.</p>
                  }
                  @if (transferSuccess()) {
                    <div class="success-msg">
                      Transferred {{ transferAmount }} tokens to {{ transferTo }}! Tx: {{ transferTx() }}
                    </div>
                  }
                  @if (transferError()) {
                    <div class="error-msg">{{ transferError() }}</div>
                  }
                </div>
              }
            </div>

            @if (isAdmin()) {
              <div class="admin-section">
                <h3 class="section-title">Admin: Undistributed Coupons</h3>
                <p class="admin-note">
                  Integer-division remainder from coupon distributions, recoverable via sweep.
                </p>
                @if (undistributed() !== null) {
                  <div class="undistributed-total">
                    <span class="field-label">Undistributed Total</span>
                    <span class="field-value">{{ undistributed() | number }}</span>
                  </div>
                  <button
                    class="btn btn-primary sweep-btn"
                    [disabled]="undistributed() === 0 || sweepSubmitting() || !authService.sessionReady()"
                    (click)="onSweep()"
                  >
                    {{ sweepSubmitting() ? 'Sweeping...' : 'Sweep Undistributed' }}
                  </button>
                  @if (adminIntent.hasSecret()) {
                    <button type="button" class="btn btn-outline lock-btn" (click)="adminIntent.clearAdminSecret()">
                      Lock admin session
                    </button>
                  }
                } @else if (undistributedError()) {
                  <div class="error-msg">{{ undistributedError() }}</div>
                } @else {
                  <div class="admin-note">Loading undistributed total...</div>
                }
                @if (sweepSuccess()) {
                  <div class="success-msg">
                    Swept {{ sweepSwept() }} credits! Tx: {{ sweepTx() }}
                  </div>
                }
                @if (sweepError()) {
                  <div class="error-msg">{{ sweepError() }}</div>
                }
                <!-- Coupon Distribute -->
                @if (couponEligibility() && couponEligibility()!.eligible) {
                  <div class="coupon-distribute" *ngIf="!sweepSubmitting() && !adminIntent.hasSecret()">
                    <button class="btn btn-outline distribute-coupon-btn" (click)="onDistributeCoupon()">
                      Distribute Coupon
                    </button>
                  </div>
                  @if (adminIntent.hasSecret()) {
                    <app-admin-secret-prompt
                      action="Distribute coupon"
                      [description]="'Bond #' + b.id + ' — distribute coupon for period ' + couponEligibility()!.periodIndex + '.'"
                      (unlocked)="onSecretUnlocked()"
                      (cancelled)="secretPromptOpen.set(false)"
                    />
                  }
                } @else if (couponEligibility()) {
                  <div class="coupon-distribute muted">
                    <strong>Coupon distribution blocked.</strong>
                    The referenced oracle report is disputed or rejected.
                  </div>
                }
                <!-- Mature Bond -->
                @if (!maturityReached()) {
                  <button
                    class="btn btn-primary mature-btn"
                    [disabled]="maturityReached() || matureSubmitting() || !authService.sessionReady()"
                    (click)="onMature()"
                  >
                    {{ matureSubmitting() ? 'Maturing...' : 'Mature Bond' }}
                  </button>
                } @else {
                  <p class="status-notice">Bond is already matured.</p>
                }
                <!-- Reconcile Holders -->
                @if (!maturityReached()) {
                  <button
                    class="btn btn-outline reconcile-btn"
                    [disabled]="reconcileSubmitting() || !authService.sessionReady()"
                    (click)="onReconcileHolders()"
                  >
                    Reconcile Holders
                  </button>
                } @else {
                  <p class="status-notice">Reconcile unavailable for matured bonds.</p>
                }
              </div>
            }
            @if (secretPromptOpen()) {
              <app-admin-secret-prompt
                action="Sweep undistributed coupons"
                [description]="'Bond #' + b.id + ' — this action is signed and single-use.'"
                (unlocked)="onSecretUnlocked()"
                (cancelled)="secretPromptOpen.set(false)"
              />
            }
          </div>
        </div>
      } @else if (loading()) {
        <div class="loading-section"><app-loading-spinner size="lg" /></div>
      } @else if (error()) {
        <div class="error-card">{{ error() }}</div>
      }
    </div>
  `,
  styles: [`
    .detail-page { max-width: 1200px; }
    .back-link { display: inline-block; margin-bottom: 24px; color: #3b82f6; text-decoration: none; font-size: 0.875rem; }
    .back-link:hover { text-decoration: underline; }
    .loading-section { display: flex; justify-content: center; padding: 48px 0; }
    .error-card { background: #fef2f2; color: #ef4444; padding: 24px; border-radius: 12px; text-align: center; }
    .detail-grid { display: grid; grid-template-columns: 1fr 360px; gap: 24px; }
    .detail-card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .detail-card.sidebar { padding: 24px; }
    .detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .detail-title { font-size: 1.5rem; font-weight: 700; }
    .maturity-banner { display: flex; gap: 8px; padding: 12px 16px; border-radius: 8px; background: #fffbeb; border: 1px solid #fde68a; color: #92400e; font-size: 0.875rem; margin-bottom: 24px; }
    .maturity-banner.frozen { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
    .coupon-warning { display: flex; flex-direction: column; gap: 4px; padding: 12px 16px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; font-size: 0.875rem; margin-bottom: 24px; }
    .coupon-reason { font-size: 0.8125rem; }
    .detail-body { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .detail-field { display: flex; flex-direction: column; }
    .field-label { font-size: 0.75rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .field-value { font-size: 0.9375rem; color: #1a1a2e; }
    .field-value.mono { font-family: monospace; font-size: 0.8125rem; word-break: break-all; }
    .section-title { font-size: 1rem; font-weight: 600; margin-bottom: 12px; }
    .coupon-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .coupon-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .coupon-item { display: flex; justify-content: space-between; padding: 8px 12px; background: #f9fafb; border-radius: 6px; font-size: 0.8125rem; }
    .coupon-index { color: #6b7280; }
    .coupon-date { font-weight: 500; }
    .progress-bar { height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
    .progress-fill { height: 100%; background: #22c55e; border-radius: 4px; transition: width 0.3s; }
    .progress-text { font-size: 0.8125rem; color: #6b7280; margin-bottom: 20px; }
    .subscribe-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .subscribe-form { display: flex; flex-direction: column; gap: 12px; }
    .form-label { font-size: 0.8125rem; font-weight: 600; color: #1a1a2e; }
    .form-input { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; outline: none; }
    .form-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.15); }
    .status-notice { font-size: 0.8125rem; color: #6b7280; padding: 8px 0; }
    .auth-hint { font-size: 0.75rem; color: #92400e; background: #fffbeb; padding: 6px 10px; border-radius: 6px; margin: 0; }
    .btn { padding: 10px 20px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; display: inline-block; text-align: center; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2a2a4e; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; width: 100%; }
    .btn-outline:hover { background: #f0f2f5; }
    .subscribe-btn { width: 100%; }
    .success-msg { font-size: 0.8125rem; color: #22c55e; word-break: break-all; padding: 8px; background: #f0fdf4; border-radius: 6px; }
    .error-msg { font-size: 0.8125rem; color: #ef4444; padding: 8px; background: #fef2f2; border-radius: 6px; }
    .marketplace-link { margin-top: 20px; }
    .claim-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .claim-btn, .transfer-btn, .sweep-btn { width: 100%; }
    .claimable-total { font-size: 0.875rem; font-weight: 600; color: #1a1a2e; margin-bottom: 8px; }
    .claimable-detail-title { font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; margin: 8px 0 4px; }
    .claimable-list { list-style: none; padding: 0; margin: 0 0 12px; display: flex; flex-direction: column; gap: 6px; }
    .claimable-item { display: flex; flex-direction: column; gap: 2px; font-size: 0.8125rem; padding: 6px 10px; background: #f9fafb; border-radius: 6px; }
    .claimable-period { font-weight: 600; color: #1a1a2e; }
    .claimable-amount { font-family: monospace; color: #16a34a; }
    .claimable-meta { color: #6b7280; font-size: 0.75rem; }
    .transfer-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .admin-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .admin-note { font-size: 0.8125rem; color: #6b7280; padding: 8px 0; }
    .lock-btn { margin-top: 8px; }
    .undistributed-total { display: flex; flex-direction: column; margin-bottom: 12px; }
    .refresh-banner { padding: 10px 16px; border-radius: 8px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1d4ed8; font-size: 0.8125rem; margin-bottom: 16px; }
    .refresh-btn { width: 100%; margin-top: 16px; }
    .holders-section { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
    .holders-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .holder-item { display: flex; justify-content: space-between; gap: 8px; font-size: 0.8125rem; padding: 6px 10px; background: #f9fafb; border-radius: 6px; }
    .holder-balance { font-family: monospace; }
    .muted { font-size: 0.8125rem; color: #6b7280; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BondDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly apiService = inject(ApiService);
  private readonly walletService = inject(WalletService);
  private readonly adminAccess = inject(AdminAccessService);
  readonly adminIntent = inject(AdminIntentService);
  private readonly coordinator = inject(BondDetailReloadCoordinator);

  /**
   * Every panel (summary, holders, coupon, maturity) is derived from the single
   * snapshot the coordinator commits after each `reload()`, so the view can never
   * show a mix of pre- and post-mutation data. See issue #4.
   */
  readonly bond = computed<Bond | null>(() => this.coordinator.detail()?.bond ?? null);
  readonly holders = computed(() => this.coordinator.detail()?.holders ?? []);
  readonly undistributed = computed<number | null>(() => {
    const d = this.coordinator.detail();
    return d ? Number(d.coupon.undistributedTotal) : null;
  });
  readonly loading = this.coordinator.loading;
  readonly refreshing = this.coordinator.loading;
  readonly sectionLoading = this.coordinator.sectionLoading;
  readonly error = signal('');
  readonly couponEligibility = signal<CouponEligibility | null>(null);
  readonly claimable = signal<ClaimableCreditsResponse | null>(null);
  readonly claimableLoading = signal(false);
  readonly now = signal(Date.now());
  readonly subscribeSubmitting = signal(false);
  readonly subscribeSuccess = signal(false);
  readonly subscribeTx = signal('');
  readonly subscribeError = signal('');
  readonly claimSubmitting = signal(false);
  readonly claimSuccess = signal(false);
  readonly claimCredits = signal(0);
  readonly claimTx = signal('');
  readonly claimError = signal('');
  readonly transferSubmitting = signal(false);
  readonly transferSuccess = signal(false);
  readonly transferTx = signal('');
  readonly transferError = signal('');
  readonly undistributedError = computed(() => this.coordinator.error() ?? '');
  readonly sweepSubmitting = signal(false);
  readonly sweepSuccess = signal(false);
  readonly sweepSwept = signal(0);
  readonly sweepTx = signal('');
  readonly sweepError = signal('');
  readonly matureSubmitting = signal(false);
  readonly matureSuccess = signal(false);
  readonly matureTx = signal('');
  readonly matureError = signal('');
  readonly reconcileSubmitting = signal(false);
  readonly secretPromptOpen = signal(false);

  /**
   * Admin detection now goes through `AdminAccessService`, which validates the
   * configured address instead of comparing against the old 'G...' placeholder
   * (issue #167).
   */
  readonly isAdmin = this.adminAccess.isAdmin;

  readonly maturityReached = computed(() => {
    const b = this.bond();
    return !!b && (b.maturityStatus === 'Matured' || b.maturityDate * 1000 <= this.now());
  });

  readonly countdown = computed(() => {
    const b = this.bond();
    if (!b || this.maturityReached()) return '';
    return this.formatCountdown(b.maturityDate * 1000 - this.now());
  });

  private maturityTimer?: ReturnType<typeof setInterval>;

  /**
   * Load coupon eligibility whenever the committed bond snapshot changes. The
   * projectId is only known after the detail loads, so we react to the snapshot
   * rather than firing it inline in `reload()`.
   */
  private readonly couponEligibilityEffect = effect(() => {
    const projectId = this.coordinator.detail()?.bond.projectId;
    if (!projectId) {
      this.couponEligibility.set(null);
      return;
    }
    this.apiService.getCouponEligibility(projectId).subscribe({
      next: (eligibility) => this.couponEligibility.set(eligibility),
      error: () => this.couponEligibility.set(null),
    });
  }, { allowSignalWrites: true });

  /**
   * Load itemized claimable-credit provenance whenever the committed bond
   * snapshot or the connected wallet changes (#156). Amounts are rendered in
   * minor units via `formatCreditMinorUnits` (#157).
   */
  private readonly claimableEffect = effect(() => {
    const bond = this.coordinator.detail()?.bond;
    const address = this.walletService.address();
    if (!bond) {
      this.claimable.set(null);
      return;
    }
    this.claimableLoading.set(true);
    this.apiService.getClaimableCredits(bond.id, address ?? undefined).subscribe({
      next: (res) => {
        this.claimable.set(res);
        this.claimableLoading.set(false);
      },
      error: () => {
        this.claimable.set(null);
        this.claimableLoading.set(false);
      },
    });
  }, { allowSignalWrites: true });

  subscribeAmount = 0;
  transferTo = '';
  transferAmount = 0;

  /** Format a minor-unit credit quantity for display (#157). */
  fmtCredits(minorUnits: string | number | bigint, maxDecimals?: number): string {
    return formatCreditMinorUnits(minorUnits, maxDecimals);
  }
  subscribeProgress(): number {
    const b = this.bond();
    if (!b || Number(b.totalSupply) === 0) return 0;
    return Math.round((Number(b.totalSubscribed) / Number(b.totalSupply)) * 100);
  }

  formatCountdown(ms: number): string {
    if (ms <= 0) return '';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (days > 0 || hours > 0) parts.push(`${hours}h`);
    if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
  }

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) {
      this.error.set('Invalid bond ID');
      this.loading.set(false);
      return;
    }
    this.maturityTimer = setInterval(() => this.now.set(Date.now()), 1000);
    this.reload(id);
  }

  /** Atomically refresh every panel of this bond (issue #4 refresh model). */
  reload(id: number): void {
    this.coordinator.reload(id);
  }

  /** Manual refresh triggered by the UI button. */
  onRefresh(): void {
    const b = this.bond();
    if (b) this.reload(b.id);
  }

  ngOnDestroy(): void {
    if (this.maturityTimer) {
      clearInterval(this.maturityTimer);
    }
  }

  onSubscribe(): void {
    const b = this.bond();
    if (!b || !this.subscribeAmount || this.subscribeAmount < 1) return;
    this.subscribeSubmitting.set(true);
    this.subscribeSuccess.set(false);
    this.subscribeError.set('');

    this.apiService.subscribeToBond(b.id, this.subscribeAmount).subscribe({
      next: (res) => {
        this.subscribeSuccess.set(true);
        this.subscribeTx.set(res.transactionHash);
        this.pendingTx.register(res.transactionHash, 'subscribe');
        this.subscribeSubmitting.set(false);
        this.reload(b.id);
      },
      error: (err) => {
        this.subscribeError.set(appErrorMessage(err, 'Subscription failed'));
        this.subscribeSubmitting.set(false);
      },
    });
  }

  onClaim(): void {
    const b = this.bond();
    if (!b) return;
    this.claimSubmitting.set(true);
    this.claimSuccess.set(false);
    this.claimError.set('');

    this.apiService.claimCredits(b.id).subscribe({
      next: (res) => {
        this.claimSuccess.set(true);
        this.claimCredits.set(Number(res.credits));
        this.claimTx.set(res.transactionHash);
        this.pendingTx.register(res.transactionHash, 'claim');
        this.claimSubmitting.set(false);
        this.reload(b.id);
      },
      error: (err) => {
        this.claimError.set(appErrorMessage(err, 'Claim failed'));
        this.claimSubmitting.set(false);
      },
    });
  }

  onTransfer(): void {
    const b = this.bond();
    if (!b || !this.transferTo || !this.transferAmount || this.transferAmount < 1) return;
    this.transferSubmitting.set(true);
    this.transferSuccess.set(false);
    this.transferError.set('');

    this.apiService.transferBond(b.id, this.transferTo, this.transferAmount).subscribe({
      next: (res) => {
        this.transferSuccess.set(true);
        this.transferTx.set(res.transactionHash);
        this.pendingTx.register(res.transactionHash, 'transfer');
        this.transferSubmitting.set(false);
        this.transferTo = '';
        this.transferAmount = 0;
        this.reload(b.id);
      },
      error: (err) => {
        this.transferError.set(appErrorMessage(err, 'Transfer failed'));
        this.transferSubmitting.set(false);
      },
    });
  }

  onSweep(): void {
    const b = this.bond();
    const total = this.undistributed();
    if (!b || total === null || total <= 0) return;

    const confirmed = window.confirm(
      `Sweep ${total} undistributed credits from Bond #${b.id}? This will reset the undistributed balance to zero.`,
    );
    if (!confirmed) return;

    // The sweep route is behind the API's IntentGuard: without a signed intent
    // it is a guaranteed 401, so collect the secret first (#166).
    if (!this.adminIntent.hasSecret()) {
      this.sweepError.set('');
      this.secretPromptOpen.set(true);
      return;
    }

    this.submitSweep();
  }

  /** The admin unlocked the session from the prompt: continue the sweep. */
  onSecretUnlocked(): void {
    this.secretPromptOpen.set(false);
    this.submitSweep();
  }

private submitSweep(): void {
    const b = this.bond();
    if (!b) return;

    this.sweepSubmitting.set(true);
    this.sweepSuccess.set(false);
    this.sweepError.set('');

    this.apiService.sweepUndistributed(b.id).subscribe({
      next: (res) => {
        this.sweepSuccess.set(true);
        this.sweepSwept.set(Number(res.swept));
        this.sweepTx.set(res.transactionHash);
        this.pendingTx.register(res.transactionHash, 'sweep');
        this.sweepSubmitting.set(false);
        this.reload(b.id);
      },
      error: (err) => {
        this.sweepError.set(appErrorMessage(err, 'Sweep failed'));
        this.sweepSubmitting.set(false);
      },
    });
  }

  onDistributeCoupon(): void {
    const b = this.bond();
    if (!b) return;

    const confirmed = window.confirm(
      `Distribute coupon for Bond #${b.id} period 0?`,
    );
    if (!confirmed) return;

    this.apiService.distributeCoupon(b.id, { periodIndex: 0 }).subscribe({
      next: (res) => {
        this.reload(b.id);
      },
      error: (err) => {
        this.sweepError.set(appErrorMessage(err, 'Distribute coupon failed'));
      },
    });
  }

  onMature(): void {
    const b = this.bond();
    if (!b) return;

    const confirmed = window.confirm(
      `Mature bond #${b.id}? This will mark the bond as matured and stop all subscriptions/transfers.`,
    );
    if (!confirmed) return;

    this.matureSubmitting.set(true);
    this.matureSuccess.set(false);
    this.matureError.set('');

    this.apiService.mature(b.id).subscribe({
      next: (res) => {
        this.matureSuccess.set(true);
        this.matureTx.set(res.transactionHash);
        this.pendingTx.register(res.transactionHash, 'mature');
        this.matureSubmitting.set(false);
        this.reload(b.id);
      },
      error: (err) => {
        this.matureError.set(appErrorMessage(err, 'Mature failed'));
        this.matureSubmitting.set(false);
      },
    });
  }

  onReconcileHolders(): void {
    const b = this.bond();
    if (!b) return;

    const confirmed = window.confirm(
      `Reconcile holders for Bond #${b.id}? This will refresh the holder index against on-chain balances.`,
    );
    if (!confirmed) return;

    this.reconcileSubmitting.set(true);
    this.apiService.reconcileHolders(b.id).subscribe({
      next: (res) => {
        this.reload(b.id);
      },
      error: (err) => {
        this.sweepError.set(appErrorMessage(err, 'Reconcile failed'));
        this.reconcileSubmitting.set(false);
      },
    });
  }
}
}
