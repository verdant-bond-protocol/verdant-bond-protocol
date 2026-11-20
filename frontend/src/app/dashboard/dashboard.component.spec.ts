import { TestBed, ComponentFixture, fakeAsync, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError, Subject, Observable } from 'rxjs';
import {
  DashboardComponent,
  DASHBOARD_RETRY_BASE_DELAY_MS,
} from './dashboard.component';
import { ApiService } from '../shared/services/api.service';
import { AuthService } from '../auth/auth.service';
import { WalletService } from '../auth/wallet.service';
import { Bond, Project, PaginatedResponse } from '../shared/interfaces/bond.interface';

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
  createdAt: new Date().toISOString(),
};

const PROJECT: Project = {
  id: 1,
  name: 'Amazon Reforestation',
  status: 'Approved',
  methodology: 'VERRA-VCS',
  country: 'Brazil',
  metadataIpfsHash: 'QmHash',
  ownerAddress: 'GBOB',
  totalAreaHa: 5000,
  carbonSequestrationEstimate: 25000,
  createdAt: new Date().toISOString(),
};

const BONDS_META = { page: 1, limit: 5, total: 1, totalPages: 1 };
const EMPTY_BONDS: PaginatedResponse<Bond> = { data: [], meta: { ...BONDS_META, total: 0 } };
const FULL_BONDS: PaginatedResponse<Bond> = { data: [BOND], meta: BONDS_META };
const EMPTY_PROJECTS: PaginatedResponse<Project> = { data: [], meta: { ...BONDS_META, total: 0 } };
const FULL_PROJECTS: PaginatedResponse<Project> = { data: [PROJECT], meta: BONDS_META };

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let fixture: ComponentFixture<DashboardComponent>;
  let apiService: {
    getBonds: jasmine.Spy;
    getProjects: jasmine.Spy;
  };

  beforeEach(async () => {
    apiService = {
      getBonds: jasmine.createSpy('getBonds').and.returnValue(of(FULL_BONDS)),
      getProjects: jasmine.createSpy('getProjects').and.returnValue(of(FULL_PROJECTS)),
    };

    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiService },
        { provide: AuthService, useValue: { token: () => null } },
        { provide: WalletService, useValue: { address: () => null, isConnected: () => false } },
      ],
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('loads bonds and projects on init', () => {
    expect(apiService.getBonds).toHaveBeenCalledWith(1, 5);
    expect(apiService.getProjects).toHaveBeenCalledWith(1, 5);
  });

  it('renders data when both sections load successfully', () => {
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Recent Bonds');
    expect(el.textContent).toContain('Recent Projects');
    expect(el.textContent).toContain('Amazon Reforestation');
    expect(el.textContent).toContain('Total Bonds');
    expect(component.bondsState()).toBe('ready');
    expect(component.projectsState()).toBe('ready');
    expect(component.overviewState()).toBe('ready');
  });

  describe('all-loading state', () => {
    it('shows skeletons before any response arrives', () => {
      apiService.getBonds.calls.reset();
      apiService.getProjects.calls.reset();
      apiService.getBonds.and.returnValue(new Subject<PaginatedResponse<Bond>>());
      apiService.getProjects.and.returnValue(new Subject<PaginatedResponse<Project>>());

      component.retryBonds();
      component.retryProjects();
      fixture.detectChanges();

      expect(component.bondsState()).toBe('loading');
      expect(component.projectsState()).toBe('loading');
      expect(component.overviewState()).toBe('loading');
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    });
  });

  describe('all-empty state', () => {
    it('renders empty state when no data exists', () => {
      apiService.getBonds.calls.reset();
      apiService.getProjects.calls.reset();
      apiService.getBonds.and.returnValue(of(EMPTY_BONDS));
      apiService.getProjects.and.returnValue(of(EMPTY_PROJECTS));

      component.retryBonds();
      component.retryProjects();
      fixture.detectChanges();

      expect(component.bondsState()).toBe('empty');
      expect(component.projectsState()).toBe('empty');
      expect(component.overviewState()).toBe('empty');
      const el: HTMLElement = fixture.nativeElement;
      expect(el.textContent).toContain('No bonds found.');
      expect(el.textContent).toContain('No projects found.');
    });
  });

  describe('partial-failure state', () => {
    it('preserves a successful section when the other request fails', () => {
      apiService.getBonds.calls.reset();
      apiService.getProjects.calls.reset();
      component.projects.set([]); // no prior projects so the error state is reachable
      apiService.getBonds.and.returnValue(of(FULL_BONDS));
      apiService.getProjects.and.returnValue(throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Bad Request' })));

      component.retryBonds();
      component.retryProjects();
      fixture.detectChanges();

      // Bonds succeed; projects fail (400 = non-transient, resolves synchronously to error).
      expect(apiService.getBonds).toHaveBeenCalled();
      expect(component.bonds().length).toBe(1);
      expect(component.projectsState()).toBe('error');
      expect(component.bondsState()).toBe('ready');
    });

    it('does not blank the entire dashboard when one of two requests fails', () => {
      apiService.getBonds.calls.reset();
      apiService.getProjects.calls.reset();
      component.projects.set([]);
      apiService.getBonds.and.returnValue(of(FULL_BONDS));
      apiService.getProjects.and.returnValue(throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Bad Request' })));

      component.retryBonds();
      component.retryProjects();
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      // The successful bonds section is still rendered.
      expect(el.textContent).toContain('Recent Bonds');
      expect(el.textContent).toContain('Recent Projects'); // section header still present
      expect(component.projectsState()).toBe('error');
      expect(component.overviewState()).not.toBe('error');
    });

    it('targets retry controls at the failed section only', () => {
      apiService.getBonds.calls.reset();
      apiService.getProjects.calls.reset();
      component.projects.set([]);
      apiService.getBonds.and.returnValue(of(FULL_BONDS));
      apiService.getProjects.and.returnValue(throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Bad Request' })));

      component.retryBonds();
      component.retryProjects();
      fixture.detectChanges();

      const buttons: Element[] = Array.from(fixture.nativeElement.querySelectorAll('button'));
      const projectRetry = buttons.find((b) => b.textContent?.trim() === 'Try Again');
      expect(projectRetry).toBeTruthy();
    });

    it('recovers the failed section via its retry button', () => {
      apiService.getBonds.calls.reset();
      apiService.getProjects.calls.reset();
      component.projects.set([]);
      apiService.getBonds.and.returnValue(of(FULL_BONDS));
      apiService.getProjects.and.returnValues(
        throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Bad Request' })),
        of(FULL_PROJECTS),
      );

      component.retryBonds();
      component.retryProjects();
      fixture.detectChanges();
      expect(component.projectsState()).toBe('error');

      component.retryProjects();
      fixture.detectChanges();
      expect(component.projectsState()).toBe('ready');
      expect(component.projects().length).toBe(1);
    });
  });

  describe('retry with backoff', () => {
    it('retries a transient failure only after the backoff delay', fakeAsync(() => {
      apiService.getBonds.calls.reset();
      apiService.getBonds.and.returnValues(
        throwError(() => new Error('network down')),
        of(FULL_BONDS),
      );

      component.retryBonds();
      expect(apiService.getBonds).toHaveBeenCalledTimes(1);

      tick(DASHBOARD_RETRY_BASE_DELAY_MS - 1);
      expect(apiService.getBonds).toHaveBeenCalledTimes(1);

      tick(1);
      expect(apiService.getBonds).toHaveBeenCalledTimes(2);
      expect(component.bonds()[0].id).toBe(BOND.id);
      expect(component.bondsState()).toBe('ready');
    }));

    it('does not retry client errors (4xx)', fakeAsync(() => {
      apiService.getBonds.calls.reset();
      apiService.getProjects.calls.reset();
      // Start with no prior data so the error path is exercised.
      component.bonds.set([]);
      component.totalBonds.set(0);
      apiService.getBonds.and.returnValue(
        throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Bad Request' })),
      );

      component.retryBonds();
      tick(10000);

      expect(apiService.getBonds).toHaveBeenCalledTimes(1);
      expect(component.bondsState()).toBe('error');
    }));

    it('recovers when a retry eventually succeeds', fakeAsync(() => {
      apiService.getBonds.calls.reset();
      apiService.getBonds.and.returnValues(
        throwError(() => new Error('network down')),
        throwError(() => new Error('network down')),
        throwError(() => new Error('network down')),
        of(FULL_BONDS),
      );

      component.retryBonds();
      tick(DASHBOARD_RETRY_BASE_DELAY_MS);
      tick(DASHBOARD_RETRY_BASE_DELAY_MS * 2);
      tick(DASHBOARD_RETRY_BASE_DELAY_MS * 4);

      expect(apiService.getBonds).toHaveBeenCalledTimes(4);
      expect(component.bonds()[0].id).toBe(BOND.id);
      expect(component.bondsState()).toBe('ready');
    }));

    it('handles persistent failures cleanly after retries are exhausted', fakeAsync(() => {
      apiService.getBonds.calls.reset();
      component.bonds.set([]);
      component.totalBonds.set(0);
      apiService.getBonds.and.returnValue(throwError(() => new Error('still down')));

      component.retryBonds();
      expect(component.bondsState()).toBe('loading');

      tick(DASHBOARD_RETRY_BASE_DELAY_MS);
      tick(DASHBOARD_RETRY_BASE_DELAY_MS * 2);
      tick(DASHBOARD_RETRY_BASE_DELAY_MS * 4);
      tick(DASHBOARD_RETRY_BASE_DELAY_MS * 8);

      expect(apiService.getBonds).toHaveBeenCalledTimes(4);
      expect(component.bondsState()).toBe('error');
      expect(component.bondsError()).toBeTruthy();
      expect(component.bonds()).toEqual([]);
    }));
  });

  describe('refresh concurrency', () => {
    it('does not stack duplicate subscriptions across repeated refreshes', () => {
      let active = 0;
      let maxActive = 0;
      apiService.getBonds.calls.reset();
      apiService.getBonds.and.callFake(() => new Observable(() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return () => { active -= 1; };
      }));

      component.retryBonds();
      component.retryBonds();
      component.retryBonds();

      expect(apiService.getBonds).toHaveBeenCalledTimes(3);
      expect(maxActive).toBe(1);
    });

    it('ignores a stale in-flight response superseded by a newer refresh', () => {
      const first = new Subject<PaginatedResponse<Bond>>();
      const second = new Subject<PaginatedResponse<Bond>>();
      apiService.getBonds.calls.reset();
      apiService.getBonds.and.returnValues(first, second);

      component.retryBonds();
      component.retryBonds();

      first.next({ data: [{ ...BOND, id: 99 }], meta: BONDS_META });
      expect(component.bonds().map(b => b.id)).toEqual([1]);

      second.next(FULL_BONDS);
      second.complete();
      expect(component.bonds()[0].id).toBe(1);
      expect(component.bondsState()).toBe('ready');
    });
  });

  describe('metrics', () => {
    it('computes total, active, and carbon totals from loaded data', () => {
      fixture.detectChanges();
      expect(component.totalBonds()).toBe(1);
      expect(component.activeBonds()).toBe(1);
      expect(component.totalProjects()).toBe(1);
      expect(component.carbonTotal()).toBe(25000);
    });
  });
});
