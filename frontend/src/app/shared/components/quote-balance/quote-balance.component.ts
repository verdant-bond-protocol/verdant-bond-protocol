import { Component, inject, OnInit, ChangeDetectionStrategy, signal, output, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import { WalletService } from '../../../auth/wallet.service';
import { QuoteAsset } from '../../interfaces/bond.interface';
import { appErrorMessage } from '../../errors/api-error';

export interface QuoteBalances {
  USDC: number;
  XLM: number;
}

export const QUOTE_ASSETS: QuoteAsset[] = ['USDC', 'XLM'];

const EMPTY_BALANCES: QuoteBalances = { USDC: 0, XLM: 0 };

@Component({
  selector: 'app-quote-balance',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="quote-panel" id="quote-balance">
      <div class="panel-header">
        <h3 class="panel-title">Escrowed Quote Balance</h3>
        <button class="btn btn-sm btn-outline refresh-btn" (click)="loadBalances()" [disabled]="loading()">
          {{ loading() ? 'Refreshing...' : 'Refresh' }}
        </button>
      </div>

      @if (loadError()) {
        <div class="error-msg">{{ loadError() }}</div>
      }

      <div class="balance-grid">
        @for (qa of quoteAssets; track qa) {
          <div class="balance-card" [class.active]="selectedAsset === qa" (click)="selectAsset(qa)">
            <span class="balance-asset">{{ qa }}</span>
            <div class="balance-values">
              <div class="balance-row"><span class="balance-label">Escrowed:</span> <span class="balance-value">{{ balances()[qa] | number }}</span></div>
              <div class="balance-row"><span class="balance-label">Wallet:</span> <span class="balance-value wallet-val">{{ walletBalances()[qa] | number }}</span></div>
            </div>
          </div>
        }
      </div>

      <div class="action-tabs">
        <button class="tab-btn" [class.active]="mode() === 'deposit'" (click)="mode.set('deposit')">Deposit</button>
        <button class="tab-btn" [class.active]="mode() === 'withdraw'" (click)="mode.set('withdraw')">Withdraw</button>
      </div>

      <div class="action-form">
        <div class="action-row">
          <select class="asset-select" [(ngModel)]="selectedAsset">
            @for (qa of quoteAssets; track qa) {
              <option [value]="qa">{{ qa }}</option>
            }
          </select>
          <input
            type="number"
            class="amount-input"
            [(ngModel)]="amount"
            placeholder="Amount"
            min="1"
          />
        </div>
        <button
          class="btn btn-primary action-btn"
          [disabled]="submitting() || !amount || amount < 1"
          (click)="onSubmit()"
        >
          {{ submitting() ? (mode() === 'deposit' ? 'Depositing...' : 'Withdrawing...') : (mode() === 'deposit' ? 'Deposit' : 'Withdraw') }}
        </button>
        @if (actionError()) {
          <div class="error-msg">{{ actionError() }}</div>
        }
        @if (actionSuccess()) {
          <div class="success-msg">{{ actionSuccess() }}</div>
        }
      </div>
    </div>
  `,
  styles: [`
    .quote-panel { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .panel-title { font-size: 1rem; font-weight: 600; margin: 0; }
    .refresh-btn { font-size: 0.75rem; padding: 4px 10px; }
    .balance-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 16px; }
    .balance-card { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border: 1px solid #e5e7eb; border-radius: 10px; cursor: pointer; transition: border-color 0.15s; }
    .balance-card.active { border-color: #3b82f6; background: #f8fafc; }
    .balance-asset { font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
    .balance-values { display: flex; flex-direction: column; gap: 4px; }
    .balance-row { display: flex; justify-content: space-between; align-items: center; }
    .balance-label { font-size: 0.75rem; color: #6b7280; }
    .balance-value { font-size: 1.125rem; font-weight: 700; color: #1a1a2e; }
    .wallet-val { font-size: 1rem; color: #4b5563; }
    .action-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
    .tab-btn { padding: 6px 14px; border-radius: 8px; font-size: 0.8125rem; font-weight: 500; cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #6b7280; }
    .tab-btn.active { background: #1a1a2e; color: #fff; border-color: #1a1a2e; }
    .action-form { display: flex; flex-direction: column; gap: 10px; }
    .action-row { display: flex; gap: 8px; }
    .asset-select, .amount-input { padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; outline: none; }
    .asset-select:focus, .amount-input:focus { border-color: #3b82f6; }
    .asset-select { width: 110px; background: #fff; }
    .amount-input { flex: 1; }
    .action-btn { align-self: flex-end; }
    .btn { padding: 8px 16px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; display: inline-block; }
    .btn-sm { padding: 6px 12px; font-size: 0.8125rem; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2a2a4e; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
    .btn-outline:hover:not(:disabled) { background: #f0f2f5; }
    .error-msg { font-size: 0.8125rem; color: #ef4444; padding: 8px; background: #fef2f2; border-radius: 6px; }
    .success-msg { font-size: 0.8125rem; color: #22c55e; padding: 8px; background: #f0fdf4; border-radius: 6px; word-break: break-all; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuoteBalanceComponent implements OnInit {
  readonly apiService = inject(ApiService);
  readonly walletService = inject(WalletService);

  readonly quoteAssets: QuoteAsset[] = QUOTE_ASSETS;

  readonly balances = signal<QuoteBalances>(EMPTY_BALANCES);
  readonly walletBalances = signal<QuoteBalances>(EMPTY_BALANCES);
  readonly loading = signal(false);
  readonly loadError = signal('');

  readonly mode = signal<'deposit' | 'withdraw'>('deposit');
  readonly submitting = signal(false);
  readonly actionError = signal('');
  readonly actionSuccess = signal('');

  readonly balanceChange = output<QuoteBalances>();

  selectedAsset: QuoteAsset = 'USDC';
  amount = 0;

  constructor() {
    // Re-load when the wallet connects. loadBalances writes signals, so it runs
    // untracked: the effect depends only on isConnected (NG0600 otherwise).
    effect(() => {
      if (this.walletService.isConnected()) {
        untracked(() => this.loadBalances());
      }
    });
  }

  ngOnInit(): void {
    this.loadBalances();
  }

  selectAsset(asset: QuoteAsset): void {
    this.selectedAsset = asset;
  }

  loadBalances(): void {
    if (!this.walletService.isConnected()) {
      this.balances.set(EMPTY_BALANCES);
      this.walletBalances.set(EMPTY_BALANCES);
      this.balanceChange.emit(this.balances());
      return;
    }

    this.loading.set(true);
    this.loadError.set('');

    forkJoin({
      usdcEscrow: this.apiService.getQuoteBalance('USDC').pipe(catchError(() => of({ balance: 0 }))),
      xlmEscrow: this.apiService.getQuoteBalance('XLM').pipe(catchError(() => of({ balance: 0 }))),
      usdcWallet: this.apiService.getWalletBalance('USDC').pipe(catchError(() => of({ balance: 0 }))),
      xlmWallet: this.apiService.getWalletBalance('XLM').pipe(catchError(() => of({ balance: 0 }))),
    }).subscribe({
      next: (res) => {
        this.balances.set({ USDC: Number(res.usdcEscrow.balance), XLM: Number(res.xlmEscrow.balance) });
        this.walletBalances.set({ USDC: Number(res.usdcWallet.balance), XLM: Number(res.xlmWallet.balance) });
        this.loading.set(false);
        this.balanceChange.emit(this.balances());
      },
      error: () => {
        this.loadError.set('Failed to load balances');
        this.loading.set(false);
      },
    });
  }

  onSubmit(): void {
    if (!this.amount || this.amount < 1) return;
    this.submitting.set(true);
    this.actionError.set('');
    this.actionSuccess.set('');

    const data = { asset: this.selectedAsset, amount: this.amount };
    const stream$ = this.mode() === 'deposit'
      ? this.apiService.depositQuote(data)
      : this.apiService.withdrawQuote(data);

    stream$.subscribe({
      next: (res) => {
        const verb = this.mode() === 'deposit' ? 'Deposited' : 'Withdrew';
        this.actionSuccess.set(
          `${verb} ${this.amount} ${res.asset}${res.transactionHash ? '. Tx: ' + res.transactionHash : ''}`,
        );
        this.amount = 0;
        this.submitting.set(false);
        this.loadBalances();
      },
      error: (err) => {
        this.actionError.set(appErrorMessage(
          err,
          this.mode() === 'deposit' ? 'Deposit failed' : 'Withdraw failed',
        ));
        this.submitting.set(false);
      },
    });
  }
}
