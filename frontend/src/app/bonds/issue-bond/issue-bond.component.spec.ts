import { TestBed, ComponentFixture } from '@angular/core/testing';
import { AdminIntentService } from '../../shared/services/admin-intent.service';
import { Keypair } from '@stellar/stellar-sdk';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { IssueBondComponent } from './issue-bond.component';
import { ApiService } from '../../shared/services/api.service';
import { PendingTransactionsService } from '../../shared/services/pending-transactions.service';

describe('IssueBondComponent', () => {
  let component: IssueBondComponent;
  let fixture: ComponentFixture<IssueBondComponent>;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const maturityDate = new Date((nowSeconds + 365 * 24 * 60 * 60) * 1000).toISOString().slice(0, 10);
  const inFuture = (offsetSeconds: number) => nowSeconds + offsetSeconds;

  const baseValue = {
    projectId: 'p1',
    faceValue: 100000,
    creditType: 'Carbon',
    totalSupply: 1000,
    maturityDate,
  };

  beforeEach(async () => {
    const apiService = {
      issueBond: jasmine.createSpy('issueBond').and.returnValue(of({ id: 'b1' })),
    };

    await TestBed.configureTestingModule({
      imports: [IssueBondComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: apiService },
        { provide: PendingTransactionsService, useValue: jasmine.createSpyObj('PendingTransactionsService', ['register']) },
      ],
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(IssueBondComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('accepts a valid ascending schedule before maturity', () => {
    component.form.patchValue({
      ...baseValue,
      couponSchedule: `${inFuture(1000)}, ${inFuture(2000)}, ${inFuture(3000)}`,
    });
    expect(component.form.valid).toBe(true);
  });

  it('rejects an unordered schedule', () => {
    component.form.patchValue({
      ...baseValue,
      couponSchedule: `${inFuture(3000)}, ${inFuture(1000)}`,
    });
    expect(component.form.errors?.['couponUnordered']).toBeTrue();
  });

  it('rejects a duplicate coupon date', () => {
    component.form.patchValue({
      ...baseValue,
      couponSchedule: `${inFuture(1000)}, ${inFuture(1000)}`,
    });
    expect(component.form.errors?.['couponUnordered']).toBeTrue();
  });

  it('rejects a coupon date in the past', () => {
    component.form.patchValue({
      ...baseValue,
      couponSchedule: `${nowSeconds - 1000}`,
    });
    expect(component.form.errors?.['couponPast']).toBeTrue();
  });

  it('rejects a coupon date at or after maturity', () => {
    const maturitySeconds = Math.floor(new Date(maturityDate).getTime() / 1000);
    component.form.patchValue({
      ...baseValue,
      couponSchedule: `${maturitySeconds}`,
    });
    expect(component.form.errors?.['couponAfterMaturity']).toBeTrue();
  });

  it('parses maturityDate to epoch seconds (not milliseconds) on submit', () => {
    component.form.patchValue({
      ...baseValue,
      couponSchedule: `${inFuture(1000)}`,
    });
    // Issuance needs a signed admin intent (#166): unlock the admin session.
    TestBed.inject(AdminIntentService).setAdminSecret(Keypair.random().secret());
    component.onSubmit();
    const apiService = TestBed.inject(ApiService) as unknown as { issueBond: jasmine.Spy };
    const submitted = apiService.issueBond.calls.mostRecent().args[0];
    expect(submitted.maturityDate).toBe(Math.floor(new Date(maturityDate).getTime() / 1000));
  });
});
