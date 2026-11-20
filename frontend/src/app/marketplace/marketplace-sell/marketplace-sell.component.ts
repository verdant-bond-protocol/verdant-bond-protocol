import { Component, inject, OnInit, ChangeDetectionStrategy, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import { AbstractControl, FormBuilder, FormGroup, ReactiveFormsModule, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';
import { ApiService } from '../../shared/services/api.service';
import { WalletService } from '../../auth/wallet.service';
import { QuoteBalanceComponent } from '../../shared/components/quote-balance/quote-balance.component';
import { HeldBond } from '../../shared/interfaces/bond.interface';
import { appErrorMessage } from '../../shared/errors/api-error';
import { PendingTransactionsService } from '../../shared/services/pending-transactions.service';

@Component({
  selector: 'app-marketplace-sell',
  standalone: true,
  imports: [CommonModule, RouterModule, ReactiveFormsModule, QuoteBalanceComponent],
  template: `
    <div class="sell-page">
      <a class="back-link" routerLink="/marketplace">← Back to Marketplace</a>
      <h1 class="page-title">List Tokens for Sale</h1>

      @if (error()) {
        <div class="error-banner" role="alert" aria-live="assertive">
          <span>{{ error() }}</span>
          <button type="button" class="error-dismiss" aria-label="Dismiss error" (click)="dismissError()">×</button>
        </div>
      }

      @if (walletService.isConnected()) {
        <div class="quote-section">
          <app-quote-balance />
        </div>
      }

      <form class="sell-form" [formGroup]="form" (ngSubmit)="onSubmit()">
        <div class="form-group">
          <label class="form-label" for="bondId">Bond</label>
          <select id="bondId" class="form-select" formControlName="bondId">
            <option [ngValue]="null" disabled>Select a bond</option>
            @for (bond of bonds(); track bond.id) {
              <option [ngValue]="bond.id">Bond #{{ bond.id }} — {{ bond.creditType }}</option>
            }
          </select>
          @if (bonds().length === 0) {
            <div class="empty-state">
              No bond tranches held — <a routerLink="/bonds">browse and subscribe</a>.
            </div>
          }
          @if (form.get('bondId')?.invalid && form.get('bondId')?.touched) {
            <span class="form-error">Select a bond</span>
          }
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="amount">Amount</label>
            <input id="amount" type="number" class="form-input" formControlName="amount" placeholder="100" />
            @if (form.get('amount')?.hasError('exceedsBalance')) {
              <span class="form-error">Amount exceeds your balance of {{ selectedBalance() }}</span>
            } @else if (form.get('amount')?.invalid && form.get('amount')?.touched) {
              <span class="form-error">Enter a positive amount</span>
            }
          </div>
          @if (selectedBalance() !== null) {
            <div class="balance-hint">Available balance: {{ selectedBalance() }}</div>
          }
          <div class="form-group">
            <label class="form-label" for="pricePerToken">Price per Token</label>
            <input id="pricePerToken" type="number" class="form-input" formControlName="pricePerToken" placeholder="10.50" step="0.01" />
            @if (form.get('pricePerToken')?.invalid && form.get('pricePerToken')?.touched) {
              <span class="form-error">Enter a positive price</span>
            }
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="quoteAsset">Quote Asset</label>
            <select id="quoteAsset" class="form-select" formControlName="quoteAsset">
              <option value="USDC">USDC</option>
              <option value="XLM">XLM</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="expiresAfterSeconds">Expires After (seconds)</label>
            <input id="expiresAfterSeconds" type="number" class="form-input" formControlName="expiresAfterSeconds" placeholder="604800 (7 days)" />
          </div>
        </div>

        <div class="form-actions">
          <a class="btn btn-outline" routerLink="/marketplace">Cancel</a>
          <button type="submit" class="btn btn-primary" [disabled]="form.invalid || submitting() || !hasSelectedBond()">
            {{ submitting() ? 'Listing...' : 'List for Sale' }}
          </button>
        </div>
      </form>
    </div>
  `,
  styles: [`
    .sell-page { max-width: 640px; }
    .back-link { display: inline-block; margin-bottom: 16px; color: #3b82f6; text-decoration: none; font-size: 0.875rem; }
    .back-link:hover { text-decoration: underline; }
    .page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 24px; }
    .error-banner { background: #fef2f2; color: #991b1b; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .error-dismiss { border: 0; background: transparent; color: inherit; font-size: 1.1rem; line-height: 1; cursor: pointer; }
    .empty-state { margin-top: 8px; padding: 12px; border: 1px dashed #d1d5db; border-radius: 8px; color: #4b5563; font-size: 0.875rem; }
    .empty-state a { color: #2563eb; font-weight: 600; }
    .quote-section { margin-bottom: 24px; }
    .sell-form { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .form-group { display: flex; flex-direction: column; margin-bottom: 20px; flex: 1; }
    .form-label { font-size: 0.8125rem; font-weight: 600; color: #1a1a2e; margin-bottom: 6px; }
    .form-input, .form-select { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; outline: none; transition: border-color 0.15s; background: #fff; }
    .form-input:focus, .form-select:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.15); }
    .form-error { font-size: 0.75rem; color: #ef4444; margin-top: 4px; }
    .form-row { display: flex; gap: 16px; }
    .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb; }
    .btn { padding: 10px 20px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; display: inline-block; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2a2a4e; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
    .btn-outline:hover { background: #f0f2f5; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarketplaceSellComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly apiService = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly pendingTx = inject(PendingTransactionsService);
  readonly walletService = inject(WalletService);

  readonly bonds = signal<HeldBond[]>([]);
  readonly selectedBalance = signal<number | null>(null);
  readonly submitting = signal(false);
  readonly error = signal('');
  readonly hasSelectedBond = computed(() =>
    this.bonds().some((bond) => bond.id === Number(this.form?.get('bondId')?.value)),
  );

  form: FormGroup = this.fb.group({
    bondId: [null, Validators.required],
    amount: [null, [Validators.required, Validators.min(1), this.amountWithinBalanceValidator()]],
    pricePerToken: [null, [Validators.required, Validators.min(0.01)]],
    quoteAsset: ['USDC', Validators.required],
    expiresAfterSeconds: [604800],
  });

  ngOnInit(): void {
    this.form.get('bondId')?.valueChanges.subscribe((bondId) => {
      this.updateSelectedBalance(bondId);
      this.form.get('amount')?.updateValueAndValidity();
    });

    const bondIdParam = this.route.snapshot.queryParamMap.get('bondId');
    if (bondIdParam) {
      this.form.patchValue({ bondId: Number(bondIdParam) });
    }
    const walletAddress = this.walletService.address();
    if (!walletAddress) return;
    this.apiService.getHeldBonds(walletAddress).subscribe({
      next: (bonds) => {
        this.bonds.set(bonds);
        this.updateSelectedBalance(this.form.get('bondId')?.value);
        this.form.get('bondId')?.updateValueAndValidity();
        this.form.get('amount')?.updateValueAndValidity();
      },
      error: (err) => {
        this.bonds.set([]);
        this.selectedBalance.set(null);
        this.error.set(appErrorMessage(err, 'Failed to load held bonds'));
      },
    });
  }

  private amountWithinBalanceValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const balance = this.selectedBalance();
      return balance !== null && Number(control.value) > balance
        ? { exceedsBalance: true }
        : null;
    };
  }

  private updateSelectedBalance(bondId: unknown): void {
    const heldBond = this.bonds().find((bond) => bond.id === Number(bondId));
    this.selectedBalance.set(heldBond?.balance != null ? Number(heldBond.balance) : null);
  }

  onSubmit(): void {
    // Guards against a duplicate listing being submitted while one is
    // already in flight (#91): the submit button's [disabled] binding covers
    // a click, but a native form submit (e.g. pressing Enter) fires
    // (ngSubmit) regardless of a button's disabled attribute.
    if (this.form.invalid || this.submitting() || !this.hasSelectedBond()) return;
    this.submitting.set(true);
    this.error.set('');

    const formValue = { ...this.form.value };
    if (!formValue.expiresAfterSeconds) delete formValue.expiresAfterSeconds;

    this.apiService.listBondTokens(formValue).subscribe({
      next: (res) => {
        this.pendingTx.register(res.transactionHash, 'list');
        this.router.navigate(['/marketplace']);
      },
      error: (err) => {
        this.error.set(appErrorMessage(err, 'Failed to list tokens'));
        this.submitting.set(false);
      },
    });
  }

  dismissError(): void {
    this.error.set('');
  }
}
