import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import {
  OrderBookDepthComponent,
  aggregateDepth,
} from './order-book-depth.component';
import { ApiService } from '../../shared/services/api.service';
import { Order, PaginatedResponse } from '../../shared/interfaces/bond.interface';

const META = { page: 1, limit: 20, total: 2, totalPages: 1 };

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 1,
    seller: 'GALICE',
    bondId: 3,
    amount: '20',
    pricePerToken: '10',
    quoteAsset: 'USDC',
    status: 'Open',
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('OrderBookDepthComponent (#208)', () => {
  let fixture: ComponentFixture<OrderBookDepthComponent>;
  let component: OrderBookDepthComponent;
  let getOrders: jasmine.Spy;

  beforeEach(async () => {
    getOrders = jasmine
      .createSpy('getOrders')
      .and.returnValue(of({ data: [], meta: META } as PaginatedResponse<Order>));
    await TestBed.configureTestingModule({
      imports: [OrderBookDepthComponent],
      providers: [{ provide: ApiService, useValue: { getOrders } }],
    }).compileComponents();
    fixture = TestBed.createComponent(OrderBookDepthComponent);
    component = fixture.componentInstance;
  });

  it('creates', () => {
    expect(component).toBeTruthy();
  });

  describe('aggregateDepth', () => {
    it('groups by price, sorts ascending, and accumulates totals', () => {
      const levels = aggregateDepth([
        makeOrder({ pricePerToken: '12', amount: '5' }),
        makeOrder({ pricePerToken: '10', amount: '20' }),
        makeOrder({ pricePerToken: '10', amount: '7' }),
        makeOrder({ pricePerToken: '11', amount: '3', status: 'Filled' }),
        makeOrder({ pricePerToken: '11', amount: '3', status: 'Cancelled' }),
      ]);
      expect(levels).toEqual([
        { price: 10, size: 27, total: 27 },
        { price: 12, size: 5, total: 32 },
      ]);
    });
  });

  it('batches a rapid burst into a single render (one flush per frame)', fakeAsync(() => {
    fixture.detectChanges();
    tick(0);
    const base = component.flushCount();
    for (let i = 0; i < 50; i += 1) {
      component.ingest([makeOrder({ id: i, amount: String(i + 1) })]);
    }
    expect(component.flushCount()).toBe(base);
    tick(16);
    fixture.detectChanges();
    expect(component.flushCount()).toBe(base + 1);
    // Latest snapshot wins: single level at price 10 with the last size.
    expect(component.asks()).toEqual([{ price: 10, size: 50, total: 50 }]);
  }));

  it('shows a stale/reconnecting indicator after consecutive stream failures and backfills on recovery', fakeAsync(() => {
    getOrders.and.returnValue(throwError(() => new Error('stream down')));
    fixture.detectChanges();
    tick(0);
    tick(5000);
    tick(5000);
    fixture.detectChanges();
    expect(component.stale()).toBe(true);
    expect(component.reconnecting()).toBe(true);

    getOrders.and.returnValue(
      of({ data: [makeOrder({ amount: '9' })], meta: META } as PaginatedResponse<Order>),
    );
    component.reconnect();
    tick(16);
    fixture.detectChanges();
    expect(component.stale()).toBe(false);
    expect(component.reconnecting()).toBe(false);
    expect(component.asks()).toEqual([{ price: 10, size: 9, total: 9 }]);
  }));

  it('uses a stable trackBy identity per price level', () => {
    expect(component.trackByPrice(0, { price: 10, size: 1, total: 1 })).toBe(10);
    expect(component.trackByPrice(3, { price: 12, size: 1, total: 2 })).toBe(12);
  });
});
