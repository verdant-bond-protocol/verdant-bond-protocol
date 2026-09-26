import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  OnDestroy,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subject, timer, EMPTY } from 'rxjs';
import { takeUntil, switchMap, catchError } from 'rxjs/operators';
import { ApiService } from '../../shared/services/api.service';
import { Order } from '../../shared/interfaces/bond.interface';

export interface DepthLevel {
  price: number;
  size: number;
  total: number;
}

export const DEPTH_POLL_INTERVAL_MS = 5000;
export const DEPTH_MAX_LEVELS = 20;
export const DEPTH_STALE_AFTER_FAILURES = 2;

/**
 * Aggregate open orders into ask-side depth levels (issue #208).
 * Pure: groups by price, sorts ascending, caps levels, accumulates depth.
 */
export function aggregateDepth(orders: Order[], maxLevels = DEPTH_MAX_LEVELS): DepthLevel[] {
  const byPrice = new Map<number, number>();
  for (const order of orders) {
    if (order.status !== 'Open' && order.status !== 'PartiallyFilled') continue;
    const price = Number(order.pricePerToken);
    const size = Number(order.amount);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    byPrice.set(price, (byPrice.get(price) ?? 0) + size);
  }
  const levels = [...byPrice.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, maxLevels)
    .map(([price, size]) => ({ price, size, total: 0 }));
  let running = 0;
  for (const level of levels) {
    running += level.size;
    level.total = running;
  }
  return levels;
}

/**
 * Real-time secondary-market order-book depth (issue #208).
 *
 * - `OnPush` + immutable snapshots: state only changes via `asks.set()`.
 * - Burst batching: every inbound update (poll or `ingest` push) is coalesced
 *   to the latest snapshot and applied once per animation frame, so a burst
 *   of N updates costs exactly one change-detection pass.
 * - Stale handling: consecutive stream failures flip a visible
 *   stale/reconnecting indicator; the next successful snapshot backfills the
 *   full book (snapshots are authoritative, never deltas).
 */
@Component({
  selector: 'app-order-book-depth',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="depth-panel">
      <div class="depth-header">
        <h3 class="section-title">Order Book Depth{{ bondTitle() }}</h3>
        @if (reconnecting()) {
          <span class="stale-badge">Reconnecting… showing last known depth</span>
        } @else if (stale()) {
          <span class="stale-badge">Stale — stream disconnected</span>
        }
      </div>
      @if (error()) {
        <div class="error-banner">{{ error() }}</div>
      }
      @if (asks().length === 0) {
        <div class="empty-section"><p>No open orders at this depth.</p></div>
      } @else {
        <table class="depth-table">
          <thead>
            <tr><th>Price</th><th>Size</th><th>Total</th><th class="bar-col">Depth</th></tr>
          </thead>
          <tbody>
            @for (level of asks(); track level.price) {
              <tr>
                <td>{{ level.price }}</td>
                <td>{{ level.size }}</td>
                <td>{{ level.total }}</td>
                <td class="bar-col">
                  <div class="depth-bar" [style.width.%]="barWidth(level)"></div>
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: [`
    .depth-panel { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); padding: 16px; margin-bottom: 24px; }
    .depth-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .section-title { font-size: 1rem; font-weight: 600; }
    .stale-badge { font-size: 0.75rem; font-weight: 600; color: #92400e; background: #fef3c7; padding: 4px 10px; border-radius: 999px; }
    .error-banner { background: #fef2f2; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; }
    .empty-section { text-align: center; padding: 24px 0; color: #6b7280; }
    .depth-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .depth-table th { text-align: left; padding: 8px 12px; font-weight: 600; color: #6b7280; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e5e7eb; }
    .depth-table td { padding: 8px 12px; border-bottom: 1px solid #f0f2f5; }
    .bar-col { width: 30%; }
    .depth-bar { height: 10px; background: #22c55e; border-radius: 4px; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderBookDepthComponent implements OnInit, OnDestroy {
  readonly bondId = input<number | null>(null);

  private readonly apiService = inject(ApiService);
  private readonly destroy$ = new Subject<void>();

  readonly asks = signal<DepthLevel[]>([]);
  readonly stale = signal(false);
  readonly reconnecting = signal(false);
  readonly error = signal('');
  /** Number of applied snapshots (= change-detection passes for this view). */
  readonly flushCount = signal(0);

  readonly bondTitle = () => {
    const id = this.bondId();
    return id ? ` — Bond #${id}` : '';
  };

  private pending: Order[] | null = null;
  private frameScheduled = false;
  private failures = 0;

  ngOnInit(): void {
    timer(0, DEPTH_POLL_INTERVAL_MS)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() =>
          this.apiService
            .getOrders(
              { bondId: this.bondId() ?? undefined, status: 'Open' },
              true,
            )
            .pipe(
              catchError(() => {
                this.onStreamError();
                return EMPTY;
              }),
            ),
        ),
      )
      .subscribe((res) => this.enqueue(res.data));
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /** Push path for a websocket/SSE transport; batched exactly like polls. */
  ingest(orders: Order[]): void {
    this.enqueue(orders);
  }

  /** Backfill after a disconnect: a full snapshot replaces missed deltas. */
  reconnect(): void {
    this.reconnecting.set(true);
    this.apiService
      .getOrders({ bondId: this.bondId() ?? undefined, status: 'Open' }, true)
      .subscribe({
        next: (res) => this.enqueue(res.data),
        error: () => this.onStreamError(),
      });
  }

  trackByPrice = (_index: number, level: DepthLevel): number => level.price;

  barWidth(level: DepthLevel): number {
    const levels = this.asks();
    const max = levels.length > 0 ? levels[levels.length - 1].total : 0;
    return max > 0 ? (level.total / max) * 100 : 0;
  }

  private enqueue(orders: Order[]): void {
    // Keep only the latest snapshot: bursts coalesce to one frame update.
    this.pending = orders;
    if (this.frameScheduled) return;
    this.frameScheduled = true;
    const flush = () => {
      this.frameScheduled = false;
      const latest = this.pending;
      this.pending = null;
      if (latest) this.applySnapshot(latest);
    };
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  }

  private applySnapshot(orders: Order[]): void {
    this.asks.set(aggregateDepth(orders));
    this.flushCount.update((n) => n + 1);
    this.failures = 0;
    this.stale.set(false);
    this.reconnecting.set(false);
    this.error.set('');
  }

  private onStreamError(): void {
    this.failures += 1;
    if (this.failures >= DEPTH_STALE_AFTER_FAILURES) {
      this.stale.set(true);
      this.reconnecting.set(true);
    }
  }
}
