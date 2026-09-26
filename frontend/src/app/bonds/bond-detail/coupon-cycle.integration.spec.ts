import { ComponentFixture, TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { Keypair } from '@stellar/stellar-sdk';
import { BondDetailComponent } from './bond-detail.component';
import { ApiService, BondDetailResponse } from '../../shared/services/api.service';
import { WalletService } from '../../auth/wallet.service';
import { AdminAccessService } from '../../shared/services/admin-access.service';
import { AdminIntentService } from '../../shared/services/admin-intent.service';
import { Bond } from '../../shared/interfaces/bond.interface';

describe('BondDetailComponent End-to-End Coupon Cycle Integration', () => {
  let fixture: ComponentFixture<BondDetailComponent>;
  let component: BondDetailComponent;
  let apiService: jasmine.SpyObj<ApiService>;
  let walletService: WalletService;
  let adminAccessService: AdminAccessService;

  const investorKeypair = Keypair.random();
  const INVESTOR_ADDRESS = investorKeypair.publicKey();
  const adminKeypair = Keypair.random();
  const ADMIN_ADDRESS = adminKeypair.publicKey();

  const mockBond: Bond = {
    id: 42,
    projectId: 'sundarbans-project-01',
    faceValue: '1000',
    couponSchedule: ['1700000000', '1800000000'],
    creditType: 'Carbon' as const,
    maturityDate: Math.floor(Date.now() / 1000) + 3600,
    maturityStatus: 'Active' as const,
    totalSupply: '10000',
    totalSubscribed: '8000',
    status: 'Active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const initialDetail: BondDetailResponse = {
    bond: mockBond,
    holders: [
      { address: INVESTOR_ADDRESS, balance: '4000' },
      { address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', balance: '4000' },
    ],
    coupon: { undistributedTotal: '0' },
    maturity: { reached: false, date: mockBond.maturityDate, secondsUntil: 3600 },
    loadedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    apiService = jasmine.createSpyObj<ApiService>('ApiService', [
      'getBondDetail',
      'getBond',
      'getBondHolders',
      'getCouponEligibility',
      'getClaimableCredits',
      'claimCredits',
      'distributeCoupon',
      'checkMaturity',
    ]);

    apiService.getBondDetail.and.returnValue(of(initialDetail));
    apiService.getBond.and.returnValue(of(mockBond));
    apiService.getBondHolders.and.returnValue(of(initialDetail.holders));
    apiService.getCouponEligibility.and.returnValue(of({ eligible: true, reasons: [] }));
    apiService.getClaimableCredits.and.returnValue(of({ claimable: '50000000' })); // 50 credits in minor units
    apiService.claimCredits.and.returnValue(of({ credits: '50000000', retirementId: 1 }));
    apiService.distributeCoupon.and.returnValue(of({ periodIndex: 0, totalCredits: '100000000', holderCount: 2 }));
    apiService.checkMaturity.and.returnValue(of({ reached: false, date: mockBond.maturityDate, secondsUntil: 3600 }));

    await TestBed.configureTestingModule({
      imports: [BondDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => '42' } } } },
        { provide: ApiService, useValue: apiService },
      ],
    }).compileComponents();

    walletService = TestBed.inject(WalletService);
    adminAccessService = TestBed.inject(AdminAccessService);

    // Connect wallet as investor
    walletService.account.set(INVESTOR_ADDRESS);
    walletService.connected.set(true);

    fixture = TestBed.createComponent(BondDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders bond metadata and verified coupon eligibility banner', fakeAsync(() => {
    tick();
    fixture.detectChanges();

    expect(component.bond()).toEqual(mockBond);
    expect(component.eligibleForCoupon()).toBeTrue();
    expect(apiService.getBondDetail).toHaveBeenCalledWith(42);
  }));

  it('displays claimable credit balance for connected investor', fakeAsync(() => {
    tick();
    fixture.detectChanges();

    const claimable = component.claimableCredits();
    expect(claimable).toBeDefined();
    expect(claimable?.claimable).toBe('50000000');
  }));

  it('executes full coupon claim flow for investor and updates state', fakeAsync(() => {
    tick();
    fixture.detectChanges();

    // Trigger claim
    component.claimCoupon();
    tick();
    fixture.detectChanges();

    expect(apiService.claimCredits).toHaveBeenCalledWith(42, INVESTOR_ADDRESS);
    expect(component.claimSuccess()).toBeTrue();
  }));

  it('displays blocked status warning when oracle report is disputed', fakeAsync(() => {
    apiService.getCouponEligibility.and.returnValue(
      of({ eligible: false, reasons: ['Active oracle challenge pending resolution on report #10'] })
    );

    component.loadCouponEligibility();
    tick();
    fixture.detectChanges();

    expect(component.eligibleForCoupon()).toBeFalse();
    expect(component.couponEligibility()?.reasons[0]).toContain('Active oracle challenge');
  }));
});
