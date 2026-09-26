import { Component, inject, OnInit, OnDestroy, ChangeDetectionStrategy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, EMPTY, Observable, defer, timer, switchMap, takeUntil, retry, tap, finalize, catchError, throwError } from 'rxjs';
import { ApiService } from '../../shared/services/api.service';
import { AuthService } from '../../auth/auth.service';
import { WalletService } from '../../auth/wallet.service';
import { StatusBadgeComponent } from '../../shared/components/status-badge/status-badge.component';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner.component';
import { QuoteBalanceComponent, QuoteBalances } from '../../shared/components/quote-balance/quote-balance.component';
import { ConnectPromptComponent } from '../../shared/components/connect-prompt/connect-prompt.component';
import { OrderBookDepthComponent } from '../order-book-depth/order-book-depth.component';
import { Order, Bond, QuoteAsset, PaginatedResponse } from '../../shared/interfaces/bond.interface';
import { appErrorMessage, normalizeApiError } from '../../shared/errors/api-error';

export const ORDERS_RETRY_COUNT = 3;
export const ORDERS_RETRY_BASE_DELAY_MS = 500;
export const ORDERS_RETRY_MAX_DELAY_MS = 4000;
// Reconciliation (#91): background polling interval for the open-orders list,
// so an order filled/cancelled/expired elsewhere is reflected here without
// requiring a manual refresh.
export const ORDERS_POLL_INTERVAL_MS = 15000;

@Component({
  selector: 'app-marketplace-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, StatusBadgeComponent, LoadingSpinnerComponent, QuoteBalanceComponent, ConnectPromptComponent, OrderBookDepthComponent],
  template: `
    <div class="marketplace-page">
      <div class="page-header">
        <h1 class="page-title">Marketplace</h1>
        <a class="btn btn-primary" [routerLink]="['/marketplace/sell']" [queryParams]="{ bondId: filterBondId() }">
          List Tokens for Sale
        </a>
      </div>

      <app-connect-prompt action="Listings are public; buying, selling, and cancelling need a signed-in wallet." />

      @if (error()) {
        <div class="error-banner">{{ error() }}</div>
      }

      @if (walletService.isConnected()) {
        <div class="quote-section">
          <app-quote-balance #quotePanel (balanceChange)="onBalancesChange($event)" />
        </div>
      }

      <div class="filters">
        <label class="filter-label">
          Bond Filter
          <select class="filter-select" [ngModel]="filterBondId()" (ngModelChange)="onFilterChange($event)">
            <option [ngValue]="null">All Bonds</option>
            @for (bond of bonds(); track bond.id) {
              <option [ngValue]="bond.id">Bond #{{ bond.id }}</option>
            }
          </select>
        </label>
        <label class="filter-label">
          Status Filter
          <select class="filter-select" [ngModel]="filterStatus()" (ngModelChange)="onStatusFilterChange($event)">
            <option value="All">All Statuses</option>
            <option value="Open">Open</option>
            <option value="PartiallyFilled">Partially Filled</option>
            <option value="Filled">Filled</option>
            <option value="Cancelled">Cancelled</option>
            <option value="Expired">Expired</option>
          </select>
        </label>
      </div>

      @if (loading()) {
        <div class="loading-section"><app-loading-spinner size="lg" /></div>
      } @else {
        @if (priceKeys().length > 0) {
          <div class="price-overview">
            <h3 class="section-title">Price Overview</h3>
            <div class="price-grid">
              @for (bondId of priceKeys(); track bondId) {
                <div class="price-card">
                  <span class="price-bond">Bond #{{ bondId }}</span>
                  <span class="price-best">Best: {{ bestPrices()[bondId].best }}</span>
                  <span class="price-avg">Avg: {{ bestPrices()[bondId].average | number:'1.1-1' }} USDC</span>
                </div>
              }
            </div>
          </div>
        }

        <div class="orders-section">
          <div class="section-header">
            <h3 class="section-title">Open Orders ({{ orders().length }})</h3>
            <button class="btn btn-sm btn-outline" (click)="refreshOrders()">Refresh</button>
          </div>

          <app-order-book-depth [bondId]="filterBondId()" />

          @if (orders().length === 0) {
            <div class="empty-section">
              <p>No active orders. List your bond tokens for sale.</p>
            </div>
          } @else {
            <div class="orders-table-wrapper">
              <table class="orders-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Bond</th>
                    <th>Seller</th>
                    <th>Amount</th>
                    <th>Price</th>
                    <th>Asset</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  @for (order of filteredOrders(); track order.id) {
                    <tr>
                      <td>{{ order.id }}</td>
                      <td>{{ order.bondId }}</td>
                      <td class="mono">{{ order.seller.slice(0, 8) }}...</td>
                      <td>{{ order.amount }}</td>
                      <td>{{ order.pricePerToken }}</td>
                      <td>{{ order.quoteAsset }}</td>
                      <td><app-status-badge [status]="order.status" variant="bond" /></td>
                      <td>{{ order.createdAt | date }}</td>
                      <td>
                          @if (order.status === 'Open' || order.status === 'PartiallyFilled') {
                            @if (buyOrderId() === order.id) {
                              <div class="buy-form">
                                <input type="number" class="buy-input" placeholder="Amount" [(ngModel)]="buyAmount" min="1" />
                                <input type="number" class="buy-input" placeholder="Max price" [(ngModel)]="buyMaxPrice" min="0.01" />
                                <div class="quote-summary">
                                  Current quote: {{ order.pricePerToken }} {{ order.quoteAsset }} / token ·
                                  max slippage: {{ maxSlippagePercent(order) | number:'1.0-2' }}%
                                </div>
                                @if (buyRequirement(order); as req) {
                                  <div class="buy-requirement">
                                    @if (req.sufficient) {
                                      <span class="sufficient-msg">
                                        Escrow sufficient: {{ req.required }} {{ order.quoteAsset }} needed, {{ req.available }} available.
                                      </span>
                                    } @else {
                                      <span class="insufficient-msg">
                                        Insufficient escrow: need {{ req.required }} {{ order.quoteAsset }}, have {{ req.available }}.
                                      </span>
                                      <button class="btn btn-sm btn-outline" (click)="focusQuotePanel()">
                                        Deposit {{ req.shortfall }} {{ order.quoteAsset }} to buy
                                      </button>
                                    }
                                  </div>
                                }
                                <div class="buy-actions">
                                  <button class="btn btn-sm btn-primary" (click)="onBuy(order)" [disabled]="actionPending() || !canConfirm(order)">Confirm</button>
                                  <button class="btn btn-sm btn-outline" (click)="cancelBuy()">Cancel</button>
                                </div>
                                @if (!authService.sessionReady()) {
                                  <span class="auth-hint">Connect your wallet and sign in to buy.</span>
                                }
                                @if (buyError()) {
                                  <div class="error-msg">{{ buyError() }}</div>
                                }
                              </div>
                            } @else {
                              <button class="btn btn-sm btn-primary" (click)="openBuy(order)">Buy</button>
                            }
                          }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>

        @if (walletService.isConnected() && myOrders().length > 0) {
          <div class="orders-section my-orders">
            <h3 class="section-title">My Orders</h3>
            @if (cancelError()) {
              <div class="error-banner">{{ cancelError() }}</div>
            }
            <div class="orders-table-wrapper">
              <table class="orders-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Bond</th>
                    <th>Amount</th>
                    <th>Price</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  @for (order of myOrders(); track order.id) {
                    <tr>
                      <td>{{ order.id }}</td>
                      <td>{{ order.bondId }}</td>
                      <td>{{ order.amount }}</td>
                      <td>{{ order.pricePerToken }}</td>
                      <td><app-status-badge [status]="order.status" variant="bond" /></td>
                      <td>{{ order.createdAt | date }}</td>
                      <td>
                        @if (order.status === 'Open' || order.status === 'PartiallyFilled') {
                          <button
                            class="btn btn-sm btn-outline"
                            [disabled]="actionPending()"
                            (click)="onCancel(order)"
                          >
                            {{ cancellingOrderId() === order.id ? 'Cancelling…' : 'Cancel' }}
                          </button>
                        } @else {
                          —
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .marketplace-page { max-width: 1200px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .page-title { font-size: 1.5rem; font-weight: 700; }
    .error-banner { background: #fef2f2; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; }
    .quote-section { margin-bottom: 24px; }
    .filters { margin-bottom: 20px; }
    .filter-label { font-size: 0.8125rem; font-weight: 600; color: #1a1a2e; display: flex; align-items: center; gap: 8px; }
    .filter-select { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; outline: none; background: #fff; }
    .filter-select:focus { border-color: #3b82f6; }
    .section-title { font-size: 1rem; font-weight: 600; margin-bottom: 12px; }
    .price-overview { margin-bottom: 24px; }
    .price-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .price-card { background: #fff; border-radius: 10px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); display: flex; flex-direction: column; gap: 4px; }
    .price-bond { font-weight: 600; font-size: 0.875rem; }
    .price-best { font-size: 0.8125rem; color: #22c55e; }
    .price-avg { font-size: 0.75rem; color: #6b7280; }
    .loading-section { display: flex; justify-content: center; padding: 48px 0; }
    .empty-section { text-align: center; padding: 48px 0; color: #6b7280; }
    .orders-section { margin-bottom: 32px; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .my-orders { margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; }
    .orders-table-wrapper { overflow-x: auto; background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .orders-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .orders-table th { text-align: left; padding: 12px 16px; font-weight: 600; color: #6b7280; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e5e7eb; background: #f9fafb; }
    .orders-table td { padding: 12px 16px; border-bottom: 1px solid #f0f2f5; }
    .orders-table tr:last-child td { border-bottom: none; }
    .mono { font-family: monospace; font-size: 0.8125rem; }
    .btn { padding: 8px 16px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; display: inline-block; }
    .btn-sm { padding: 6px 12px; font-size: 0.8125rem; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2a2a4e; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
    .btn-outline:hover { background: #f0f2f5; }
    .buy-form { display: flex; flex-direction: column; gap: 6px; min-width: 180px; }
    .buy-input { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.8125rem; outline: none; width: 100%; }
    .buy-input:focus { border-color: #3b82f6; }
    .buy-actions { display: flex; gap: 4px; }
    .quote-summary { color: #4b5563; font-size: 0.75rem; }
    .buy-requirement { display: flex; flex-direction: column; gap: 6px; font-size: 0.75rem; padding: 8px; border-radius: 6px; }
    .sufficient-msg { color: #22c55e; }
    .insufficient-msg { color: #ef4444; }
    .error-msg { font-size: 0.75rem; color: #ef4444; }
    .auth-hint { font-size: 0.75rem; color: #92400e; background: #fffbeb; padding: 4px 8px; border-radius: 6px; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarketplaceListComponent implements OnInit, OnDestroy {
  private readonly apiService = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly authService = inject(AuthService);
  readonly walletService = inject(WalletService);
  private readonly pendingTx = inject(PendingTransactionsService);

  readonly orders = signal<Order[]>([]);
  readonly bonds = signal<Bond[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly filterBondId = signal<number | null>(null);
  readonly filterStatus = signal<Order['status'] | 'All'>('All');

  readonly buyOrderId = signal<number | null>(null);
  readonly buySubmitting = signal(false);
  readonly buyError = signal('');
  buyAmount = 0;
  buyMaxPrice = 0;

  readonly cancellingOrderId = signal<number | null>(null);
  readonly cancelError = signal('');

  /**
   * Reconciliation (#91): a single wallet address shares one sequential
   * nonce per contract (see `NonceService.next`), so a buy and a cancel from
   * the same connected wallet cannot safely be submitted concurrently.
   * `actionPending` gates every action button (Confirm, Cancel) so at most
   * one nonce-consuming marketplace action is in flight at a time.
   */
  readonly actionPending = computed(() => this.buySubmitting() || this.cancellingOrderId() !== null);

  private readonly ordersRefresh$ = new Subject<{ forceRefresh: boolean; background: boolean }>();
  private readonly destroy$ = new Subject<void>();

  readonly balances = signal<QuoteBalances>({ USDC: 0, XLM: 0 });
  readonly balancesLoaded = signal(false);
  quotePanel?: QuoteBalanceComponent;

  readonly bestPrices = computed(() => {
    const orders = this.orders();
    const grouped = new Map<number, Order[]>();
    orders.filter(o => o.status === 'Open').forEach(o => {
      const list = grouped.get(o.bondId) || [];
      list.push(o);
      grouped.set(o.bondId, list);
    });
    const result: Record<number, { best: number; average: number }> = {};
    grouped.forEach((list, bondId) => {
      const prices = list.map(o => Number(o.pricePerToken));
      result[bondId] = {
        best: Math.min(...prices),
        average: prices.reduce((a, b) => a + b, 0) / prices.length,
      };
    });
    return result;
  });

  readonly priceKeys = computed(() => Object.keys(this.bestPrices()).map(Number));

  readonly filteredOrders = computed(() => {
    const selectedBond = this.filterBondId();
    const selectedStatus = this.filterStatus();
    let result = this.orders();
    if (selectedBond) {
      result = result.filter(o => o.bondId === selectedBond);
    }
    if (selectedStatus !== 'All') {
      result = result.filter(o => o.status === selectedStatus);
    }
    return result;
  });

  readonly myOrders = computed(() => {
    const address = this.walletService.address();
    if (!address) return [];
    return this.orders().filter(o => o.seller === address);
  });

  ngOnInit(): void {
    const bondIdParam = this.route.snapshot.queryParamMap.get('bondId');
    if (bondIdParam) {
      this.filterBondId.set(Number(bondIdParam));
    }
    const statusParam = this.route.snapshot.queryParamMap.get('status') as Order['status'] | null;
    if (statusParam) {
      this.filterStatus.set(statusParam);
    }
    this.ordersRefresh$
      .pipe(
        takeUntil(this.destroy$),
        switchMap((opts) => this.fetchOrders(opts.forceRefresh, opts.background)),
      )
      .subscribe();
    this.loadBonds();
    this.loadOrders();

    // Reconciliation (#91): periodic background refresh so a stale open
    // order (filled/cancelled/expired elsewhere) is caught without the user
    // having to click Refresh. Funnelled through the same ordersRefresh$
    // pipeline as manual refreshes, so switchMap still guarantees only one
    // in-flight request at a time.
    timer(ORDERS_POLL_INTERVAL_MS, ORDERS_POLL_INTERVAL_MS)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadOrders(false, true));
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  refreshOrders(): void {
    this.loadOrders(true);
  }

  private loadBonds(): void {
    this.apiService.getBonds(1, 100).subscribe({
      next: (res) => this.bonds.set(res.data),
    });
  }

  private loadOrders(forceRefresh = false, background = false): void {
    this.ordersRefresh$.next({ forceRefresh, background });
  }

  private fetchOrders(forceRefresh: boolean, background = false): Observable<PaginatedResponse<Order>> {
    // Background polling ticks (#91) skip the loading spinner so the list
    // doesn't flicker every poll interval; manual refreshes and the initial
    // load still show it.
    if (!background) this.loading.set(true);
    this.error.set('');
    // defer re-invokes the API call on every (re)subscription, so retries issue a
    // fresh request with a fresh cache-busting param instead of reusing a stale one.
    return defer(() => this.apiService.getOrders({ bondId: this.filterBondId() ?? undefined, status: this.filterStatus() === 'All' ? undefined : this.filterStatus() }, forceRefresh)).pipe(
      retry({
        count: ORDERS_RETRY_COUNT,
        delay: (error, attempt) =>
          this.isTransientError(error) ? timer(this.retryDelayMs(attempt)) : throwError(() => error),
      }),
      tap({
        next: (res) => this.orders.set(res.data),
        error: () => this.error.set('Failed to load orders'),
      }),
      finalize(() => this.loading.set(false)),
      catchError(() => EMPTY),
    );
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(ORDERS_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), ORDERS_RETRY_MAX_DELAY_MS);
  }

  private isTransientError(error: unknown): boolean {
    if (error instanceof HttpErrorResponse) {
      return error.status === 0 || error.status >= 500;
    }
    return true;
  }

  onFilterChange(bondId: number | null): void {
    this.filterBondId.set(bondId);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: bondId ? { bondId } : { bondId: null },
      queryParamsHandling: 'merge',
    });
    this.loadOrders();
  }

  onStatusFilterChange(status: Order['status'] | 'All'): void {
    this.filterStatus.set(status);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: status !== 'All' ? { status } : { status: null },
      queryParamsHandling: 'merge',
    });
    this.loadOrders();
  }

  openBuy(order: Order): void {
    this.buyOrderId.set(order.id);
    this.buyAmount = 0;
    this.buyMaxPrice = 0;
    this.buyError.set('');
    this.quotePanel?.loadBalances();
  }

  cancelBuy(): void {
    this.buyOrderId.set(null);
  }

  onBalancesChange(balances: QuoteBalances): void {
    this.balances.set(balances);
    this.balancesLoaded.set(true);
  }

  buyRequirement(order: Order): {
    required: number;
    available: number;
    shortfall: number;
    asset: QuoteAsset;
    sufficient: boolean;
  } | null {
    if (this.buyOrderId() !== order.id || !this.balancesLoaded()) return null;
    if (!this.buyAmount || this.buyAmount < 1 || !this.buyMaxPrice || this.buyMaxPrice <= 0) return null;

    const asset = order.quoteAsset;
    const required = this.buyAmount * Number(order.pricePerToken);
    const available = this.balances()[asset] ?? 0;
    return {
      required,
      available,
      shortfall: Math.max(0, required - available),
      asset,
      sufficient: available >= required,
    };
  }

  canConfirm(order: Order): boolean {
    if (!this.balancesLoaded()) return true;
    return this.buyRequirement(order)?.sufficient ?? false;
  }

  maxSlippagePercent(order: Order): number {
    const current = Number(order.pricePerToken);
    return current > 0 && this.buyMaxPrice >= current
      ? ((this.buyMaxPrice - current) / current) * 100
      : 0;
  }

  focusQuotePanel(): void {
    document.getElementById('quote-balance')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  onBuy(order: Order): void {
    if (this.actionPending()) return;
    if (!this.buyAmount || this.buyAmount < 1 || !this.buyMaxPrice || this.buyMaxPrice <= 0) return;
    this.buySubmitting.set(true);
    this.buyError.set('');

    const requestedAmount = this.buyAmount;
    const approvedMaxPrice = this.buyMaxPrice;
    this.apiService.getOrder(order.id).pipe(
      switchMap((current) => {
        this.orders.update((orders) => orders.map((item) => item.id === current.id ? current : item));
        if (current.status !== 'Open' && current.status !== 'PartiallyFilled') {
          throw new Error(`Order is no longer available (${current.status}).`);
        }
        if (requestedAmount > Number(current.amount)) {
          throw new Error(`Stale quote: only ${current.amount} tokens remain.`);
        }
        if (Number(current.pricePerToken) > approvedMaxPrice) {
          throw new Error(`Stale price: current price ${current.pricePerToken} exceeds your maximum ${approvedMaxPrice}.`);
        }
        return this.apiService.buyBondTokens({
          orderId: current.id,
          amount: requestedAmount,
          maxPrice: approvedMaxPrice,
        });
      }),
    ).subscribe({
      next: () => {
        this.buyOrderId.set(null);
        this.buySubmitting.set(false);
        this.quotePanel?.loadBalances();
        this.loadOrders(true);
      },
      error: (err) => {
        // Reconciliation (#91): the backend now revalidates the order
        // immediately before buying and rejects a no-longer-open order with
        // 409 Conflict. Always refresh so the row's true status replaces
        // whatever was shown when the user opened this form, and close the
        // form for a 409 specifically since that order is confirmed dead --
        // for other errors (e.g. insufficient funds) leave it open so the
        // user can act (e.g. deposit more) without losing their inputs.
        this.buyError.set(appErrorMessage(err, 'Buy failed'));
        this.buySubmitting.set(false);
        if (normalizeApiError(err).status === 409) {
          this.buyOrderId.set(null);
        }
        this.loadOrders(true);
      },
    });
  }

  onCancel(order: Order): void {
    if (this.actionPending()) return;
    this.cancellingOrderId.set(order.id);
    this.cancelError.set('');

    this.apiService.cancelOrder(order.id).subscribe({
      next: () => {
        this.cancellingOrderId.set(null);
        this.loadOrders(true);
      },
      error: (err) => {
        // A cancel rejection (e.g. the order was just filled) is itself a
        // stale-state signal, so always refresh (#91) to show the real status.
        this.cancelError.set(appErrorMessage(err, 'Cancel failed'));
        this.cancellingOrderId.set(null);
        this.loadOrders(true);
      },
    });
  }
}
