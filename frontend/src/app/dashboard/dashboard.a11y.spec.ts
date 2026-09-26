import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { DashboardComponent } from './dashboard.component';
import { ApiService } from '../shared/services/api.service';
import { AuthService } from '../auth/auth.service';
import { WalletService } from '../auth/wallet.service';
import { Bond, Project } from '../shared/interfaces/bond.interface';
import { axeViolations } from '../shared/testing/axe';

/** Automated WCAG 2.1 A/AA check of the dashboard page, run in CI by `npm run test` (#206). */

const META = { page: 1, limit: 5, total: 2, totalPages: 1 };

const BOND: Bond = {
  id: 1,
  projectId: 'p1',
  faceValue: '1000',
  couponSchedule: ['2026-01-01'],
  creditType: 'Carbon',
  maturityDate: 1800000000,
  maturityStatus: 'Active',
  totalSupply: '1000',
  totalSubscribed: '500',
  status: 'Active',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const project = (id: number, name: string, estimate: number): Project => ({
  id,
  name,
  status: 'Approved',
  methodology: 'VERRA-VCS',
  country: 'Brazil',
  metadataIpfsHash: 'QmHash',
  ownerAddress: 'GBOB',
  totalAreaHa: 5000,
  carbonSequestrationEstimate: estimate,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('Dashboard accessibility (#206)', () => {
  it('has no WCAG 2.1 A/AA violations with data, chart and data table', async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideRouter([]),
        {
          provide: ApiService,
          useValue: {
            getBonds: () => of({ data: [BOND], meta: META }),
            getProjects: () => of({ data: [project(1, 'Amazon Reforestation', 25000), project(2, 'Sundarbans Mangroves', 12000)], meta: META }),
          },
        },
        { provide: AuthService, useValue: { token: () => null } },
        { provide: WalletService, useValue: { address: () => null, isConnected: () => false } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    document.body.appendChild(element);

    try {
      expect(element.querySelector('app-accessible-chart')).not.toBeNull();
      expect(await axeViolations(element)).toEqual([]);

      element.querySelector<HTMLButtonElement>('.chart-toggle')!.click();
      fixture.detectChanges();
      expect(await axeViolations(element)).toEqual([]);
    } finally {
      element.remove();
    }
  });
});
