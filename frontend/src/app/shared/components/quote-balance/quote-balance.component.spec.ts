import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { QuoteBalanceComponent } from './quote-balance.component';
import { ApiService } from '../../services/api.service';
import { WalletService } from '../../../auth/wallet.service';

describe('QuoteBalanceComponent', () => {
  let component: QuoteBalanceComponent;
  let fixture: ComponentFixture<QuoteBalanceComponent>;
  let apiService: {
    getQuoteBalance: jasmine.Spy;
    getWalletBalance: jasmine.Spy;
    depositQuote: jasmine.Spy;
    withdrawQuote: jasmine.Spy;
  };
  let walletService: { isConnected: ReturnType<typeof signal<boolean>> };

  beforeEach(async () => {
    apiService = {
      getQuoteBalance: jasmine
        .createSpy('getQuoteBalance')
        .and.callFake((asset: 'USDC' | 'XLM') =>
          of({ address: 'GALICE', asset, balance: asset === 'USDC' ? 25000 : 5000 }),
        ),
      getWalletBalance: jasmine
        .createSpy('getWalletBalance')
        .and.callFake((asset: 'USDC' | 'XLM') =>
          of({ address: 'GALICE', asset, balance: asset === 'USDC' ? 500 : 100 }),
        ),
      depositQuote: jasmine
        .createSpy('depositQuote')
        .and.returnValue(of({ address: 'GALICE', asset: 'USDC', amount: 1000, transactionHash: 'tx1' })),
      withdrawQuote: jasmine
        .createSpy('withdrawQuote')
        .and.returnValue(of({ address: 'GALICE', asset: 'USDC', amount: 500, transactionHash: 'tx2' })),
    };

    walletService = { isConnected: signal(true) };

    await TestBed.configureTestingModule({
      imports: [QuoteBalanceComponent],
      providers: [
        { provide: ApiService, useValue: apiService },
        { provide: WalletService, useValue: walletService },
      ],
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(QuoteBalanceComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('loads escrowed balances for both quote assets', () => {
    expect(apiService.getQuoteBalance).toHaveBeenCalledWith('USDC');
    expect(apiService.getQuoteBalance).toHaveBeenCalledWith('XLM');
    expect(apiService.getWalletBalance).toHaveBeenCalledWith('USDC');
    expect(apiService.getWalletBalance).toHaveBeenCalledWith('XLM');
    expect(component.balances()).toEqual({ USDC: 25000, XLM: 5000 });
    expect(component.walletBalances()).toEqual({ USDC: 500, XLM: 100 });
  });

  it('emits balance changes to the parent', () => {
    let emitted: any;
    component.balanceChange.subscribe((value) => (emitted = value));
    component.loadBalances();
    expect(emitted).toEqual({ USDC: 25000, XLM: 5000 });
  });

  it('deposits quote asset and refreshes the balance', () => {
    component.selectedAsset = 'USDC';
    component.amount = 1000;
    component.onSubmit();

    expect(apiService.depositQuote).toHaveBeenCalledWith({ asset: 'USDC', amount: 1000 });
    expect(component.actionSuccess()).toContain('Deposited 1000 USDC');
    expect(apiService.getQuoteBalance).toHaveBeenCalled();
  });

  it('withdraws escrowed quote and refreshes the balance', () => {
    component.mode.set('withdraw');
    component.selectedAsset = 'USDC';
    component.amount = 500;
    component.onSubmit();

    expect(apiService.withdrawQuote).toHaveBeenCalledWith({ asset: 'USDC', amount: 500 });
    expect(component.actionSuccess()).toContain('Withdrew 500 USDC');
  });

  it('surfaces an actionable error when a quote action fails', () => {
    apiService.depositQuote.and.returnValue(throwError(() => new Error('InsufficientFunds')));

    component.amount = 1000;
    component.onSubmit();

    expect(component.actionError()).toBe('InsufficientFunds');
    expect(component.submitting()).toBe(false);
  });
});
