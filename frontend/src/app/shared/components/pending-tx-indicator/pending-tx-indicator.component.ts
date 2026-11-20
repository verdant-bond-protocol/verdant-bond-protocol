import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PendingTransactionsService } from '../../services/pending-transactions.service';
import { StatusBadgeComponent } from '../status-badge/status-badge.component';

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  failed: 'Failed',
};

@Component({
  selector: 'app-pending-tx-indicator',
  standalone: true,
  imports: [CommonModule, StatusBadgeComponent],
  template: `
    @if (entries().length > 0) {
      <div class="tx-indicator">
        <button class="tx-toggle" (click)="open.set(!open())">
          Transactions
          @if (pendingTx.pendingCount() > 0) {
            <span class="tx-count">{{ pendingTx.pendingCount() }}</span>
          }
        </button>
        @if (open()) {
          <div class="tx-panel">
            @for (entry of entries(); track entry.hash) {
              <div class="tx-row">
                <span class="tx-op">{{ entry.operation }}</span>
                <app-status-badge [status]="statusLabel(entry.status)" />
                <span class="tx-hash">{{ entry.hash.slice(0, 8) }}...</span>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .tx-indicator { position: relative; }
    .tx-toggle { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; font-size: 0.8125rem; cursor: pointer; }
    .tx-count { background: #eab308; color: #fff; border-radius: 10px; padding: 1px 7px; font-size: 0.6875rem; font-weight: 700; }
    .tx-panel { position: absolute; right: 0; top: calc(100% + 6px); background: #fff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.12); padding: 8px; width: 280px; z-index: 10; }
    .tx-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 4px; font-size: 0.8125rem; }
    .tx-op { text-transform: capitalize; }
    .tx-hash { font-family: monospace; color: #6b7280; font-size: 0.75rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PendingTxIndicatorComponent {
  readonly pendingTx = inject(PendingTransactionsService);
  readonly entries = this.pendingTx.entries;
  readonly open = signal(false);

  statusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status;
  }
}
