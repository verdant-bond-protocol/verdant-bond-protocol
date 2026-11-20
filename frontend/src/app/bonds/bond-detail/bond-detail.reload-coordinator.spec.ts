import { BondDetailReloadCoordinator } from './bond-detail.reload-coordinator';
import { delay } from 'rxjs';
import { ApiService, BondDetailResponse } from '../../shared/services/api.service';
import { of, Subject } from 'rxjs';
import { fakeAsync, tick } from '@angular/core/testing';

describe('BondDetailReloadCoordinator (issue #4 refresh model)', () => {
  let coordinator: BondDetailReloadCoordinator;
  let apiService: jasmine.SpyObj<ApiService>;

  const detail = (overrides: Partial<BondDetailResponse> = {}): BondDetailResponse => ({
    bond: { id: 1 } as any,
    holders: [{ address: 'G', balance: '1' }],
    coupon: { undistributedTotal: '0' },
    maturity: { reached: false, date: 0, secondsUntil: 0 },
    loadedAt: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    apiService = jasmine.createSpyObj('ApiService', ['getBondDetail']);
    // Respond asynchronously so the in-flight loading state is observable.
    apiService.getBondDetail.and.returnValue(of(detail()).pipe(delay(0)));
    coordinator = new BondDetailReloadCoordinator(apiService);
  });

  it('toggles per-section loading flags together and commits one atomic snapshot', fakeAsync(() => {
    coordinator.reload(1);
    expect(coordinator.loading()).toBe(true);
    expect(coordinator.sectionLoading().bond).toBe(true);
    expect(coordinator.sectionLoading().holders).toBe(true);
    expect(coordinator.sectionLoading().coupon).toBe(true);
    expect(coordinator.sectionLoading().maturity).toBe(true);

    tick();
    expect(coordinator.loading()).toBe(false);
    expect(coordinator.sectionLoading().bond).toBe(false);
    expect(coordinator.detail()?.bond.id).toBe(1);
    expect(coordinator.detail()?.holders.length).toBe(1);
  }));

  it('records the server timestamp for staleness detection', fakeAsync(() => {
    coordinator.reload(1);
    tick();
    expect(typeof coordinator.lastLoadedAt()).toBe('string');
    expect(Number.isNaN(Date.parse(coordinator.lastLoadedAt()!))).toBe(false);
  }));

  it('reports a newer server snapshot via isNewerThan', fakeAsync(() => {
    const older = new Date(Date.now() - 1000).toISOString();
    const newer = new Date(Date.now() + 1000).toISOString();

    apiService.getBondDetail.and.returnValue(of(detail({ loadedAt: newer })));
    coordinator.reload(1);
    tick();

    expect(coordinator.isNewerThan(older)).toBe(true);
    expect(coordinator.isNewerThan(newer)).toBe(false);
  }));

  it('cancels an in-flight reload when a new one starts', fakeAsync(() => {
    const first = new Subject<BondDetailResponse>();
    const second = new Subject<BondDetailResponse>();
    apiService.getBondDetail.and.returnValues(first.asObservable(), second.asObservable());

    coordinator.reload(1);
    coordinator.reload(1);

    expect(apiService.getBondDetail).toHaveBeenCalledTimes(2);
    // Only the second (latest) emission commits.
    second.next(detail({ bond: { id: 99 } as any }));
    tick();
    expect(coordinator.detail()?.bond.id).toBe(99);
  }));
});
