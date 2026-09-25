import { ComponentFixture, TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { Keypair } from '@stellar/stellar-sdk';
import { BondDetailComponent } from './bond-detail.component';
import { ApiService, BondDetailResponse } from '../../shared/services/api.service';
import { WalletService } from '../../auth/wallet.service';
import { AuthService } from '../../auth/auth.service';
import { AdminAccessService } from '../../shared/services/admin-access.service';
import { AdminIntentService } from '../../shared/services/admin-intent.service';
import { PendingTransactionsService } from '../../shared/services/pending-transactions.service';
import { Bond } from '../../shared/interfaces/bond.interface';

// `environment.adminAddress` now defaults to empty (#167), so the admin account
// under test is configured explicitly rather than read from the environment.
const adminKeypair = Keypair.random();
const ADMIN_ADDRESS = adminKeypair.publicKey();

describe('BondDetailComponent (issue #4 refresh model)', () => {
  let fixture: ComponentFixture<BondDetailComponent>;
  let apiService: jasmine.SpyObj<ApiService>;
  let walletService: WalletService;
  let sessionReady: ReturnType<typeof signal<boolean>>;

  const bond: Bond = {
    id: 1,
    projectId: 'a1b2',
    faceValue: '1000',
    couponSchedule: ['1000000', '2000000'],
    creditType: 'Carbon' as const,
    maturityDate: 3000000,
    maturityStatus: 'Active' as const,
    totalSupply: '10000',
    totalSubscribed: '5000',
    status: 'Active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const detailFor = (overrides: Partial<Bond> = {}): BondDetailResponse => ({
    bond: { ...bond, ...overrides },
    holders: [
      { address: 'GAAAA', balance: '100' },
      { address: 'GBBBB', balance: '200' },
    ],
    coupon: { undistributedTotal: '7' },
    maturity: { reached: overrides.maturityStatus === 'Matured', date: (overrides.maturityDate ?? bond.maturityDate), secondsUntil: 0 },
    loadedAt: new Date().toISOString(),
  });

  const futureBond = (overrides: Partial<Bond> = {}): Bond => ({
    ...bond,
    maturityDate: Math.floor(Date.now() / 1000) + 3 * 86400,
    maturityStatus: 'Active',
    ...overrides,
  });

  beforeEach(async () => {
    apiService = jasmine.createSpyObj('ApiService', [
      'getBondDetail', 'subscribeToBond', 'claimCredits', 'transferBond',
      'sweepUndistributed', 'getCouponEligibility', 'getClaimableCredits',
    ]);
    apiService.getBondDetail.and.returnValue(of(detailFor()));
    apiService.getClaimableCredits.and.returnValue(of({
      bondId: 1,
      address: 'GAAAA',
      total: '1500000',
      details: [
        { periodIndex: 0, reportId: 1, startTime: 1000, endTime: 2000, creditType: 'Carbon', amount: '1000000' },
        { periodIndex: 1, reportId: 2, startTime: 2000, endTime: 3000, creditType: 'BlueCarbon', amount: '500000' },
      ],
    }));
    apiService.subscribeToBond.and.returnValue(of({ bondId: 1, subscriber: 'GAAAA', amount: '1', transactionHash: '0xsub' }));
    apiService.claimCredits.and.returnValue(of({ bondId: 1, investorAddress: 'GAAAA', credits: '5', transactionHash: '0xclaim' }));
    apiService.transferBond.and.returnValue(of({ bondId: 1, fromAddress: 'GAAAA', toAddress: 'GBBBB', amount: '1', transactionHash: '0xtransfer' }));
    apiService.sweepUndistributed.and.returnValue(of({ bondId: 1, swept: '7', transactionHash: '0xabc' }));
    apiService.getCouponEligibility.and.returnValue(of({ projectId: 'a1b2', eligible: true, reasons: [], blockedByReportIds: [] }));

    sessionReady = signal(true); // existing tests expect an authenticated session, matching prior behavior

    await TestBed.configureTestingModule({
      imports: [BondDetailComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => '1' } } },
        },
        { provide: ApiService, useValue: apiService },
        { provide: AuthService, useValue: { sessionReady } },
        { provide: PendingTransactionsService, useValue: jasmine.createSpyObj('PendingTransactionsService', ['register']) },
        WalletService,
      ],
    }).compileComponents();

    walletService = TestBed.inject(WalletService);

    TestBed.inject(AdminAccessService).adminAddress.set(ADMIN_ADDRESS);
    // The sweep route requires a signed step-up intent (#166); unlock the admin
    // session so the existing sweep expectations still exercise the request.
    TestBed.inject(AdminIntentService).setAdminSecret(adminKeypair.secret());
  });

  afterEach(() => {
    fixture?.destroy();
  });

  const createFixture = (): void => {
    fixture = TestBed.createComponent(BondDetailComponent);
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
  };

  const adminSection = (): HTMLElement | null =>
    fixture.nativeElement.querySelector('.admin-section');

  it('loads the full detail snapshot through the coordinator on init', fakeAsync(() => {
    createFixture();
    expect(apiService.getBondDetail).toHaveBeenCalledWith(1, { bustCache: true });
    discardPeriodicTasks();
  }));

  it('shows the undistributed total to the admin wallet', fakeAsync(() => {
    walletService.address.set(ADMIN_ADDRESS);
    createFixture();

    const section = adminSection();
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('7');
    expect(section?.textContent).toContain('Sweep Undistributed');
    discardPeriodicTasks();
  }));

  it('hides the admin panel from non-admin wallets', fakeAsync(() => {
    walletService.address.set('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    createFixture();

    expect(adminSection()).toBeNull();
    discardPeriodicTasks();
  }));

  it('renders the holders panel from the committed snapshot', fakeAsync(() => {
    createFixture();
    const items = fixture.nativeElement.querySelectorAll('.holder-item');
    expect(items.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('GAAAA');
    discardPeriodicTasks();
  }));

  it('renders itemized claimable-credit provenance with minor-unit formatting (#156/#157)', fakeAsync(() => {
    createFixture();

    expect(apiService.getClaimableCredits).toHaveBeenCalled();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Claimable: 1.5 credits');
    expect(text).toContain('Period 1');
    expect(text).toContain('Period 2');
    expect(text).toContain('BlueCarbon');
    discardPeriodicTasks();
  }));

  it('sweeps undistributed credits only after confirmation', fakeAsync(() => {
    walletService.address.set(ADMIN_ADDRESS);
    createFixture();

    const confirmSpy = spyOn(window, 'confirm').and.returnValue(true);
    const sweepBtn = fixture.nativeElement.querySelector('.sweep-btn') as HTMLButtonElement;
    sweepBtn.click();
    tick();
    fixture.detectChanges();

    expect(confirmSpy).toHaveBeenCalled();
    expect(apiService.sweepUndistributed).toHaveBeenCalledWith(1);
    expect(fixture.nativeElement.textContent).toContain('0xabc');
    discardPeriodicTasks();
  }));

  it('does not sweep when confirmation is declined', fakeAsync(() => {
    walletService.address.set(ADMIN_ADDRESS);
    createFixture();

    spyOn(window, 'confirm').and.returnValue(false);
    const sweepBtn = fixture.nativeElement.querySelector('.sweep-btn') as HTMLButtonElement;
    sweepBtn.click();

    expect(apiService.sweepUndistributed).not.toHaveBeenCalled();
    discardPeriodicTasks();
  }));

  it('shows a live countdown for a bond that has not reached maturity', fakeAsync(() => {
    apiService.getBondDetail.and.returnValue(of(detailFor(futureBond())));
    createFixture();

    const banner = fixture.nativeElement.querySelector('.maturity-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Matures in');
    expect(banner.textContent).toContain('d');
    discardPeriodicTasks();
  }));

  it('shows the frozen-for-trading state and hides subscribe/transfer after maturity', fakeAsync(() => {
    apiService.getBondDetail.and.returnValue(of(detailFor({ maturityStatus: 'Matured' })));
    createFixture();

    const banner = fixture.nativeElement.querySelector('.maturity-banner.frozen') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Frozen for trading');

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('frozen for trading');
    expect(text).toContain('Transfers are disabled');
    expect(fixture.nativeElement.querySelector('.subscribe-btn')).toBeNull();
    expect(fixture.nativeElement.querySelector('.transfer-btn')).toBeNull();
    discardPeriodicTasks();
  }));

  it('disables subscribe/transfer once the maturity date has elapsed', fakeAsync(() => {
    apiService.getBondDetail.and.returnValue(
      of(detailFor({ maturityDate: Math.floor(Date.now() / 1000) - 10 })),
    );
    createFixture();

    expect(fixture.nativeElement.textContent).toContain('frozen for trading');
    expect(fixture.nativeElement.querySelector('.subscribe-btn')).toBeNull();
    expect(fixture.nativeElement.querySelector('.transfer-btn')).toBeNull();
    discardPeriodicTasks();
  }));

  it('reloads the full snapshot after a subscribe mutation', fakeAsync(() => {
    createFixture();
    expect(apiService.getBondDetail).toHaveBeenCalledTimes(1);

    fixture.componentInstance.subscribeAmount = 10;
    fixture.componentInstance.onSubscribe();
    tick();
    fixture.detectChanges();

    expect(apiService.subscribeToBond).toHaveBeenCalledWith(1, 10);
    expect(apiService.getBondDetail).toHaveBeenCalledTimes(2);
    discardPeriodicTasks();
  }));

  it('reloads the full snapshot after a transfer mutation', fakeAsync(() => {
    createFixture();
    expect(apiService.getBondDetail).toHaveBeenCalledTimes(1);

    fixture.componentInstance.transferTo = 'GDEST';
    fixture.componentInstance.transferAmount = 5;
    fixture.componentInstance.onTransfer();
    tick();
    fixture.detectChanges();

    expect(apiService.transferBond).toHaveBeenCalledWith(1, 'GDEST', 5);
    expect(apiService.getBondDetail).toHaveBeenCalledTimes(2);
    discardPeriodicTasks();
  }));

  it('reloads the full snapshot after a claim mutation', fakeAsync(() => {
    createFixture();
    expect(apiService.getBondDetail).toHaveBeenCalledTimes(1);

    fixture.componentInstance.onClaim();
    tick();
    fixture.detectChanges();

    expect(apiService.claimCredits).toHaveBeenCalledWith(1);
    expect(apiService.getBondDetail).toHaveBeenCalledTimes(2);
    discardPeriodicTasks();
  }));

  it('reloads via the manual refresh button (maturity/refresh path)', fakeAsync(() => {
    createFixture();
    expect(apiService.getBondDetail).toHaveBeenCalledTimes(1);

    const refreshBtn = fixture.nativeElement.querySelector('.refresh-btn') as HTMLButtonElement;
    refreshBtn.click();
    tick();
    fixture.detectChanges();

    expect(apiService.getBondDetail).toHaveBeenCalledTimes(2);
    discardPeriodicTasks();
  }));

  it('formats the countdown in days, hours, minutes and seconds', () => {
    const component = TestBed.createComponent(BondDetailComponent).componentInstance;
    expect(component.formatCountdown(2 * 86400000 + 3 * 3600000 + 4 * 60000 + 5000)).toBe('2d 3h 4m 5s');
    expect(component.formatCountdown(5 * 1000)).toBe('5s');
    expect(component.formatCountdown(0)).toBe('');
  });
});
