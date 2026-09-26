import { TestBed, ComponentFixture, fakeAsync, tick } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError, Observable, Subject } from 'rxjs';
import { MarketplaceListComponent, ORDERS_RETRY_BASE_DELAY_MS, ORDERS_POLL_INTERVAL_MS } from './marketplace-list.component';
import { ApiService } from '../../shared/services/api.service';
import { AuthService } from '../../auth/auth.service';
import { WalletService } from '../../auth/wallet.service';
import { PendingTransactionsService } from '../../shared/services/pending-transactions.service';
import { Order, PaginatedResponse } from '../../shared/interfaces/bond.interface';

const ORDER: Order = {
  id: 1,
  seller: 'GBOB',
  bondId: 3,
  amount: '20',
  pricePerToken: '10',
  quoteAsset: 'USDC',
  status: 'Open',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
};

const META = { page: 1, limit: 20, total: 1, totalPages: 1 };

const FRESH_ORDER: Order = { ...ORDER, status: 'Filled', amount: '5' };

describe('MarketplaceListComponent', () => {
  let component: MarketplaceListComponent;
  let fixture: ComponentFixture<MarketplaceListComponent>;
  let apiService: {
    getBonds: jasmine.Spy;
    getOrders: jasmine.Spy;
    getOrder: jasmine.Spy;
    buyBondTokens: jasmine.Spy;
    cancelOrder: jasmine.Spy;
    getQuoteBalance: jasmine.Spy;
    getWalletBalance: jasmine.Spy;
  };
  let walletService: {
    isConnected: ReturnType<typeof signal<boolean>>;
    address: ReturnType<typeof signal<string | null>>;
  };
  let sessionReady: ReturnType<typeof signal<boolean>>;

  beforeEach(async () => {
    apiService = {
      getBonds: jasmine.createSpy('getBonds').and.returnValue(of({ data: [], meta: { page: 1, limit: 100, total: 0, totalPages: 1 } })),
      getOrders: jasmine.createSpy('getOrders').and.returnValue(of({ data: [ORDER], meta: { page: 1, limit: 20, total: 1, totalPages: 1 } })),
      getOrder: jasmine.createSpy('getOrder').and.returnValue(of(ORDER)),
      buyBondTokens: jasmine.createSpy('buyBondTokens').and.returnValue(of(undefined)),
      cancelOrder: jasmine.createSpy('cancelOrder').and.returnValue(of(undefined)),
      getQuoteBalance: jasmine
        .createSpy('getQuoteBalance')
        .and.callFake((asset: string) =>
          of({ address: 'GALICE', asset, balance: asset === 'USDC' ? 100 : 0 }),
        ),
      getWalletBalance: jasmine
        .createSpy('getWalletBalance')
        .and.callFake((asset: string) =>
          of({ address: 'GALICE', asset, balance: asset === 'USDC' ? 100 : 0 }),
        ),
    };

    walletService = {
      isConnected: signal(true),
      address: signal('GALICE'),
    };
    sessionReady = signal(true); // existing tests expect an authenticated session, matching prior behavior

    await TestBed.configureTestingModule({
      imports: [MarketplaceListComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiService },
        { provide: AuthService, useValue: { token: signal(null), sessionReady } },
        { provide: WalletService, useValue: walletService },
        { provide: PendingTransactionsService, useValue: jasmine.createSpyObj('PendingTransactionsService', ['register']) },
      ],
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(MarketplaceListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  // The background poll (#91) schedules a periodic RxJS timer for the life
  // of the component; fixture.destroy() runs ngOnDestroy, which unsubscribes
  // it via takeUntil(this.destroy$) -- required so fakeAsync tests don't
  // report a periodic timer still pending when the test ends.
  afterEach(() => {
    fixture.destroy();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('loads orders and bonds on init', () => {
    expect(apiService.getOrders).toHaveBeenCalled();
    expect(apiService.getBonds).toHaveBeenCalled();
  });

  it('loads the escrowed quote balance when connected', () => {
    expect(apiService.getQuoteBalance).toHaveBeenCalledWith('USDC');
    expect(apiService.getQuoteBalance).toHaveBeenCalledWith('XLM');
  });

  it('surfaces an insufficient escrow message and disables confirm', () => {
    component.openBuy(ORDER);
    component.buyAmount = 20;
    component.buyMaxPrice = 10;
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Insufficient escrow');

    const confirm = el.querySelector<HTMLButtonElement>('.buy-actions .btn-primary');
    expect(confirm?.disabled).toBe(true);
  });

  it('allows confirm when the escrowed balance covers the purchase', () => {
    component.openBuy(ORDER);
    component.buyAmount = 5;
    component.buyMaxPrice = 10;
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Escrow sufficient');

    const confirm = el.querySelector<HTMLButtonElement>('.buy-actions .btn-primary');
    expect(confirm?.disabled).toBe(false);
  });

  it('submits a buy order', () => {
    component.openBuy(ORDER);
    component.buyAmount = 5;
    component.buyMaxPrice = 10;
    component.onBuy(ORDER);

    expect(apiService.buyBondTokens).toHaveBeenCalledWith({
      orderId: 1,
      amount: 5,
      maxPrice: 10,
    });
  });

  it('revalidates price immediately before submission', () => {
    apiService.getOrder.and.returnValue(of({ ...ORDER, pricePerToken: '11' }));
    component.openBuy(ORDER);
    component.buyAmount = 5;
    component.buyMaxPrice = 10;
    component.onBuy(ORDER);

    expect(apiService.getOrder).toHaveBeenCalledWith(1);
    expect(apiService.buyBondTokens).not.toHaveBeenCalled();
    expect(component.buyError()).toContain('Stale price');
  });

  it('revalidates remaining depth immediately before submission', () => {
    apiService.getOrder.and.returnValue(of({ ...ORDER, amount: '4', status: 'PartiallyFilled' }));
    component.openBuy(ORDER);
    component.buyAmount = 5;
    component.buyMaxPrice = 10;
    component.onBuy(ORDER);

    expect(apiService.buyBondTokens).not.toHaveBeenCalled();
    expect(component.buyError()).toContain('only 4 tokens remain');
  });

  describe('order refresh', () => {
    it('forces a fresh fetch that bypasses client-side caching on refresh', () => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(of({ data: [ORDER], meta: META }));

      component.refreshOrders();

      expect(apiService.getOrders).toHaveBeenCalledWith(undefined, true);
    });

    it('replaces a stale response with fresh order data on refresh', () => {
      const stale = { ...ORDER, status: 'Open' as Order['status'] };
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValues(
        of({ data: [stale], meta: META }),
        of({ data: [FRESH_ORDER], meta: META }),
      );

      component.refreshOrders();
      expect(component.orders()[0].status).toBe('Open');

      component.refreshOrders();
      expect(component.orders()[0].status).toBe('Filled');
      expect(component.orders()[0].amount).toBe('5');
    });

    it('updates the UI with fresh order data after a refresh', () => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(of({ data: [FRESH_ORDER], meta: META }));

      component.refreshOrders();
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.textContent).toContain('Open Orders (1)');
      expect(el.textContent).toContain('Filled');
    });

    it('refreshes orders with cache bypass after a completed buy', () => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(of({ data: [ORDER], meta: META }));
      component.openBuy(ORDER);
      component.buyAmount = 5;
      component.buyMaxPrice = 10;

      component.onBuy(ORDER);

      expect(apiService.getOrders).toHaveBeenCalledWith(undefined, true);
    });
  });

  describe('stale order reconciliation (#91)', () => {
    it('polls for order status changes in the background without showing the loading spinner', fakeAsync(() => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(of({ data: [FRESH_ORDER], meta: META }));

      tick(ORDERS_POLL_INTERVAL_MS);

      expect(apiService.getOrders).toHaveBeenCalledTimes(1);
      expect(component.orders()[0].status).toBe('Filled');
      expect(component.loading()).toBe(false);

      tick(ORDERS_POLL_INTERVAL_MS);
      expect(apiService.getOrders).toHaveBeenCalledTimes(2);
    }));

    it('does not force cache bypass on a background poll (respects the server cache)', fakeAsync(() => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(of({ data: [ORDER], meta: META }));

      tick(ORDERS_POLL_INTERVAL_MS);

      expect(apiService.getOrders).toHaveBeenCalledWith(undefined, false);
    }));

    it('cancels an open order and refreshes the list on success', () => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(of({ data: [], meta: META }));

      component.onCancel(ORDER);

      expect(apiService.cancelOrder).toHaveBeenCalledWith(1);
      expect(component.cancellingOrderId()).toBeNull();
      expect(apiService.getOrders).toHaveBeenCalledWith(undefined, true);
    });

    it('surfaces a clear error and still refreshes the list when a cancel is rejected as stale', () => {
      apiService.cancelOrder.and.returnValue(
        throwError(() => new HttpErrorResponse({
          status: 409,
          error: { detail: 'Order 1 is no longer available (status: Filled).' },
        })),
      );
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(of({ data: [FRESH_ORDER], meta: META }));

      component.onCancel(ORDER);

      expect(component.cancelError()).toContain('no longer available');
      expect(component.cancellingOrderId()).toBeNull();
      expect(apiService.getOrders).toHaveBeenCalledWith(undefined, true);
    });

    it('closes the buy form and refreshes when a buy is rejected because the order state changed (409)', () => {
      apiService.buyBondTokens.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 409, error: { detail: 'Order state changed.' } })),
      );
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(of({ data: [FRESH_ORDER], meta: META }));
      component.openBuy(ORDER);
      component.buyAmount = 5;
      component.buyMaxPrice = 10;

      component.onBuy(ORDER);

      expect(component.buyOrderId()).toBeNull();
      expect(apiService.getOrders).toHaveBeenCalledWith(undefined, true);
    });

    it('keeps the buy form open on a non-conflict error (e.g. insufficient funds) so the user can adjust', () => {
      apiService.buyBondTokens.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 402, error: { detail: 'Insufficient escrowed funds.' } })),
      );
      component.openBuy(ORDER);
      component.buyAmount = 5;
      component.buyMaxPrice = 10;

      component.onBuy(ORDER);

      expect(component.buyOrderId()).toBe(ORDER.id);
      expect(component.buyError()).toContain('Insufficient escrowed funds');
    });

    it('prevents a buy while a cancel is pending for this wallet (shared nonce)', () => {
      apiService.cancelOrder.and.returnValue(new Subject()); // never resolves: cancel stays pending
      component.onCancel(ORDER);
      expect(component.actionPending()).toBe(true);

      component.openBuy(ORDER);
      component.buyAmount = 5;
      component.buyMaxPrice = 10;
      apiService.buyBondTokens.calls.reset();

      component.onBuy(ORDER);

      expect(apiService.buyBondTokens).not.toHaveBeenCalled();
    });

    it('prevents a cancel while a buy is pending for this wallet (shared nonce)', () => {
      apiService.buyBondTokens.and.returnValue(new Subject()); // never resolves: buy stays pending
      component.openBuy(ORDER);
      component.buyAmount = 5;
      component.buyMaxPrice = 10;
      component.onBuy(ORDER);
      expect(component.actionPending()).toBe(true);

      apiService.cancelOrder.calls.reset();
      component.onCancel(ORDER);

      expect(apiService.cancelOrder).not.toHaveBeenCalled();
    });
  });

  describe('order retry with backoff', () => {
    it('retries a transient failure only after the backoff delay', fakeAsync(() => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValues(
        throwError(() => new Error('network down')),
        of({ data: [ORDER], meta: META }),
      );

      component.refreshOrders();
      expect(apiService.getOrders).toHaveBeenCalledTimes(1);

      tick(ORDERS_RETRY_BASE_DELAY_MS - 1);
      expect(apiService.getOrders).toHaveBeenCalledTimes(1);

      tick(1);
      expect(apiService.getOrders).toHaveBeenCalledTimes(2);
      expect(component.orders()[0].id).toBe(ORDER.id);
      expect(component.loading()).toBe(false);
      expect(component.error()).toBe('');
    }));

    it('recovers when a retry eventually succeeds', fakeAsync(() => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValues(
        throwError(() => new Error('network down')),
        throwError(() => new Error('network down')),
        of({ data: [ORDER], meta: META }),
      );

      component.refreshOrders();
      tick(ORDERS_RETRY_BASE_DELAY_MS);
      tick(ORDERS_RETRY_BASE_DELAY_MS * 2);
      tick(ORDERS_RETRY_BASE_DELAY_MS * 4);

      expect(apiService.getOrders).toHaveBeenCalledTimes(3);
      expect(component.orders()[0].id).toBe(ORDER.id);
      expect(component.loading()).toBe(false);
      expect(component.error()).toBe('');
    }));

    it('handles persistent failures cleanly after retries are exhausted', fakeAsync(() => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(throwError(() => new Error('still down')));

      component.refreshOrders();
      expect(component.loading()).toBe(true);

      tick(ORDERS_RETRY_BASE_DELAY_MS);
      tick(ORDERS_RETRY_BASE_DELAY_MS * 2);
      tick(ORDERS_RETRY_BASE_DELAY_MS * 4);

      expect(apiService.getOrders).toHaveBeenCalledTimes(4);
      expect(component.loading()).toBe(false);
      expect(component.error()).toBe('Failed to load orders');
      expect(component.orders()).toEqual([ORDER]); // previously loaded data is preserved
    }));

    it('does not retry client errors (4xx)', fakeAsync(() => {
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Bad Request' })),
      );

      component.refreshOrders();
      tick(10000);

      expect(apiService.getOrders).toHaveBeenCalledTimes(1);
      expect(component.loading()).toBe(false);
      expect(component.error()).toBe('Failed to load orders');
    }));
  });

  describe('refresh concurrency', () => {
    it('does not stack duplicate subscriptions across repeated refreshes', () => {
      let active = 0;
      let maxActive = 0;
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.callFake(() => new Observable(() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return () => { active -= 1; };
      }));

      component.refreshOrders();
      component.refreshOrders();
      component.refreshOrders();

      expect(apiService.getOrders).toHaveBeenCalledTimes(3);
      expect(maxActive).toBe(1);
    });

    it('ignores a stale in-flight response superseded by a newer refresh', () => {
      const first = new Subject<PaginatedResponse<Order>>();
      const second = new Subject<PaginatedResponse<Order>>();
      apiService.getOrders.calls.reset();
      apiService.getOrders.and.returnValues(first, second);

      component.refreshOrders();
      component.refreshOrders();

      // The first request was cancelled by the second refresh; its late response must not land.
      first.next({ data: [{ ...ORDER, id: 99 }], meta: META });
      expect(component.orders().map(o => o.id)).toEqual([1]);

      second.next({ data: [FRESH_ORDER], meta: META });
      second.complete(); // a real HTTP response completes; finalize clears the loading state
      expect(component.orders()[0].status).toBe('Filled');
      expect(component.loading()).toBe(false);
    });
  });
});
