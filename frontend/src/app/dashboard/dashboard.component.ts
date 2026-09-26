import { Component, inject, OnInit, OnDestroy, ChangeDetectionStrategy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, EMPTY, defer, timer, Subject, switchMap, takeUntil, retry, tap, finalize, catchError, throwError } from 'rxjs';
import { ApiService } from '../shared/services/api.service';
import { WalletService } from '../auth/wallet.service';
import { BondCardComponent } from '../shared/components/bond-card/bond-card.component';
import { ProjectCardComponent } from '../shared/components/project-card/project-card.component';
import { LoadingSpinnerComponent } from '../shared/components/loading-spinner/loading-spinner.component';
import { AccessibleChartComponent, ChartDatum } from '../shared/components/accessible-chart/accessible-chart.component';
import { Bond, Project, PaginatedResponse } from '../shared/interfaces/bond.interface';
import { appErrorMessage } from '../shared/errors/api-error';

export const DASHBOARD_RETRY_COUNT = 3;
export const DASHBOARD_RETRY_BASE_DELAY_MS = 1000;
export const DASHBOARD_RETRY_MAX_DELAY_MS = 8000;

type SectionState = 'loading' | 'error' | 'empty' | 'ready';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule, BondCardComponent, ProjectCardComponent, LoadingSpinnerComponent, AccessibleChartComponent],
  template: `
    <div class="dashboard">
      <h1 class="page-title">Dashboard</h1>

      @if (overallError()) {
        <div class="error-banner">
          <span>{{ overallError() }}</span>
          <button class="btn btn-sm btn-outline" (click)="retryAll()">Retry All</button>
        </div>
      }

      <section class="section">
        <div class="section-header">
          <h2>Overview</h2>
          @if (overviewState() === 'error') {
            <button class="btn btn-sm btn-outline" (click)="retryOverview()">Retry</button>
          }
        </div>

        @switch (overviewState()) {
          @case ('loading') {
            <div class="stats-grid stats-skeleton" aria-busy="true" aria-label="Loading overview">
              @for (s of [1, 2, 3, 4]; track s) {
                <div class="stat-card skeleton"><span class="skeleton-block"></span><span class="skeleton-block short"></span></div>
              }
            </div>
          }
          @case ('error') {
            <div class="section-error">
              <p>{{ overviewError() }}</p>
              <button class="btn btn-sm btn-outline" (click)="retryOverview()">Try Again</button>
            </div>
          }
          @case ('empty') {
            <div class="empty-section">
              <p>No data available yet. The dashboard is waiting for on-chain activity.</p>
            </div>
          }
          @case ('ready') {
            <div class="stats-grid">
              <div class="stat-card">
                <span class="stat-label">Total Bonds</span>
                <span class="stat-value">{{ totalBonds() }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-label">Active Bonds</span>
                <span class="stat-value">{{ activeBonds() }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-label">Total Projects</span>
                <span class="stat-value">{{ totalProjects() }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-label">Carbon Sequestration</span>
                <span class="stat-value">{{ carbonTotal() | number }} tCO₂e</span>
              </div>
            </div>
          }
        }
      </section>

      @if (projectsState() === 'ready') {
        <section class="section chart-section">
          <app-accessible-chart
            title="Estimated carbon sequestration by project"
            labelHeader="Project"
            unit="tCO₂e"
            unitSpoken="tonnes of CO₂ equivalent"
            [data]="sequestrationChart()"
          />
        </section>
      }

      <section class="section">
        <div class="section-header">
          <h2>My Portfolio</h2>
          <div class="header-actions">
            @if (portfolioState() === 'error') {
              <button class="btn btn-sm btn-outline" (click)="retryPortfolio()">Retry</button>
            }
            @if (walletService.address()) {
              <button class="btn btn-sm btn-outline" (click)="refreshPortfolio()">Refresh</button>
            }
          </div>
        </div>

        @switch (portfolioState()) {
          @case ('loading') {
            <div class="stats-grid stats-skeleton" aria-busy="true" aria-label="Loading portfolio">
              @for (s of [1, 2, 3, 4]; track s) {
                <div class="stat-card skeleton"><span class="skeleton-block"></span><span class="skeleton-block short"></span></div>
              }
            </div>
          }
          @case ('error') {
            <div class="section-error">
              <p>{{ portfolioError() }}</p>
              <button class="btn btn-sm btn-outline" (click)="retryPortfolio()">Try Again</button>
            </div>
          }
          @case ('empty') {
            <div class="empty-section">
              <p>Connect your wallet to see your aggregated bond, marketplace, and credit positions.</p>
            </div>
          }
          @case ('ready') {
            <div class="stats-grid">
              <div class="stat-card">
                <span class="stat-label">Bonds Held</span>
                <span class="stat-value">{{ portfolio()?.bondsHeld?.length ?? 0 }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-label">Open Listings</span>
                <span class="stat-value">{{ portfolio()?.openListings?.length ?? 0 }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-label">Claimable Credits</span>
                <span class="stat-value">{{ portfolio()?.claimableCredits?.length ?? 0 }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-label">Retired Credits</span>
                <span class="stat-value">{{ portfolio()?.retiredCredits?.length ?? 0 }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-label">Pending Actions</span>
                <span class="stat-value">{{ portfolio()?.pendingActions?.length ?? 0 }}</span>
              </div>
            </div>
          }
        }
      </section>

      <section class="section">
        <div class="section-header">
          <h2>Recent Bonds</h2>
          <div class="header-actions">
            @if (bondsState() === 'error') {
              <button class="btn btn-sm btn-outline" (click)="retryBonds()">Retry</button>
            }
            <a class="section-link" routerLink="/bonds">View All</a>
          </div>
        </div>

        @switch (bondsState()) {
          @case ('loading') {
            <div class="card-grid cards-skeleton" aria-busy="true" aria-label="Loading recent bonds">
              @for (s of [1, 2, 3]; track s) {
                <div class="card skeleton"><span class="skeleton-block"></span><span class="skeleton-block short"></span></div>
              }
            </div>
          }
          @case ('error') {
            <div class="section-error">
              <p>{{ bondsError() }}</p>
              <button class="btn btn-sm btn-outline" (click)="retryBonds()">Try Again</button>
            </div>
          }
          @case ('empty') {
            <p class="section-empty">No bonds found.</p>
          }
          @case ('ready') {
            <div class="card-grid">
              @for (bond of bonds(); track bond.id) {
                <app-bond-card [bond]="bond" (subscribe)="onSubscribe($event)" />
              }
            </div>
          }
        }
      </section>

      <section class="section">
        <div class="section-header">
          <h2>Recent Projects</h2>
          <div class="header-actions">
            @if (projectsState() === 'error') {
              <button class="btn btn-sm btn-outline" (click)="retryProjects()">Retry</button>
            }
            <a class="section-link" routerLink="/projects">View All</a>
          </div>
        </div>

        @switch (projectsState()) {
          @case ('loading') {
            <div class="card-grid cards-skeleton" aria-busy="true" aria-label="Loading recent projects">
              @for (s of [1, 2, 3]; track s) {
                <div class="card skeleton"><span class="skeleton-block"></span><span class="skeleton-block short"></span></div>
              }
            </div>
          }
          @case ('error') {
            <div class="section-error">
              <p>{{ projectsError() }}</p>
              <button class="btn btn-sm btn-outline" (click)="retryProjects()">Try Again</button>
            </div>
          }
          @case ('empty') {
            <p class="section-empty">No projects found.</p>
          }
          @case ('ready') {
            <div class="card-grid">
              @for (project of projects(); track project.id) {
                <app-project-card [project]="project" />
              }
            </div>
          }
        }
      </section>
    </div>
  `,
  styles: [`
    .dashboard { max-width: 1200px; }
    .page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 24px; }
    .error-banner { background: #fef2f2; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .stat-label { display: block; font-size: 0.75rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .stat-value { display: block; font-size: 1.75rem; font-weight: 700; color: #1a1a2e; }
    .section { margin-bottom: 32px; }
    .chart-section { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .section-header h2 { font-size: 1.125rem; font-weight: 600; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .section-link { font-size: 0.875rem; color: #1d4ed8; text-decoration: none; }
    .section-link:hover { text-decoration: underline; }
    .section-empty { color: #6b7280; font-size: 0.875rem; padding: 16px 0; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .cards-skeleton { margin-bottom: 32px; }
    .skeleton { min-height: 120px; display: flex; flex-direction: column; gap: 12px; }
    .skeleton-block { background: #e5e7eb; border-radius: 6px; height: 18px; width: 100%; }
    .skeleton-block.short { width: 55%; }
    .stats-skeleton { }
    .section-error { background: #fef2f2; color: #ef4444; padding: 16px; border-radius: 8px; font-size: 0.875rem; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
    .empty-section { text-align: center; padding: 48px 0; color: #4b5563; }
    .btn { display: inline-block; padding: 10px 20px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; text-decoration: none; cursor: pointer; border: none; }
    .btn-sm { padding: 6px 12px; font-size: 0.8125rem; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover { background: #2a2a4e; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
    .btn-outline:hover { background: #f0f2f5; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent implements OnInit, OnDestroy {
  private readonly apiService = inject(ApiService);
  private readonly router = inject(Router);
  readonly walletService = inject(WalletService);

  readonly bonds = signal<Bond[]>([]);
  readonly projects = signal<Project[]>([]);

  // Wallet-scoped aggregate portfolio (#116).
  readonly portfolio = signal<any | null>(null);
  readonly portfolioState = signal<SectionState>('loading');
  readonly portfolioError = signal('');

  readonly totalBonds = signal(0);
  readonly activeBonds = signal(0);
  readonly totalProjects = signal(0);
  readonly carbonTotal = signal(0);

  readonly bondsState = signal<SectionState>('loading');
  readonly projectsState = signal<SectionState>('loading');
  readonly overviewState = signal<SectionState>('loading');

  readonly bondsError = signal('');
  readonly projectsError = signal('');
  readonly overviewError = signal('');

  private readonly bondsRefresh$ = new Subject<void>();
  private readonly projectsRefresh$ = new Subject<void>();
  private readonly destroy$ = new Subject<void>();

  /** Chart and its data table share this one model (#206). */
  readonly sequestrationChart = computed<ChartDatum[]>(() =>
    this.projects().map((p) => ({ label: p.name, value: p.carbonSequestrationEstimate })),
  );

  readonly overallError = computed(() => {
    if (this.bondsState() === 'error' && this.projectsState() === 'error') {
      return 'Failed to load dashboard data.';
    }
    return '';
  });

  ngOnInit(): void {
    this.bondsRefresh$
      .pipe(takeUntil(this.destroy$), switchMap(() => this.fetchBonds()))
      .subscribe();
    this.projectsRefresh$
      .pipe(takeUntil(this.destroy$), switchMap(() => this.fetchProjects()))
      .subscribe();
    this.loadBonds();
    this.loadProjects();
    this.loadPortfolio();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  retryBonds(): void {
    this.loadBonds();
  }

  retryProjects(): void {
    this.loadProjects();
  }

  retryOverview(): void {
    // Overview derives from both feeds; retrying both restores it.
    this.loadBonds();
    this.loadProjects();
  }

  retryAll(): void {
    this.retryOverview();
    this.loadPortfolio();
  }

  retryPortfolio(): void {
    this.loadPortfolio();
  }

  refreshPortfolio(): void {
    if (!this.walletService.address()) return;
    this.portfolioState.set('loading');
    this.apiService.getPortfolio(undefined, true).subscribe({
      next: (p) => {
        this.portfolio.set(p);
        this.portfolioState.set('ready');
      },
      error: () => {
        this.portfolioError.set('Failed to refresh portfolio');
        this.portfolioState.set('error');
      },
    });
  }

  private loadBonds(): void {
    this.bondsRefresh$.next();
  }

  private loadProjects(): void {
    this.projectsRefresh$.next();
  }

  private loadPortfolio(): void {
    if (!this.walletService.address()) {
      this.portfolioState.set('empty');
      return;
    }
    this.portfolioState.set('loading');
    this.portfolioError.set('');
    defer(() => this.apiService.getPortfolio())
      .pipe(
        tap({
          next: (p) => {
            this.portfolio.set(p);
            this.portfolioState.set('ready');
          },
          error: () => {
            this.portfolioError.set(appErrorMessage(this.lastError, 'Failed to load portfolio'));
            this.portfolioState.set('error');
          },
        }),
        catchError(() => EMPTY),
      )
      .subscribe();
  }

  private fetchBonds(): Observable<PaginatedResponse<Bond>> {
    this.bondsState.set('loading');
    this.overviewState.set('loading');
    this.bondsError.set('');
    return defer(() => this.apiService.getBonds(1, 5)).pipe(
      this.withRetry(),
      tap({
        next: (res) => {
          this.bonds.set(res.data);
          this.totalBonds.set(res.meta.total);
          this.activeBonds.set(res.data.filter((b: Bond) => b.status === 'Active').length);
          this.overviewState.update((st) => (st === 'error' ? 'loading' : st));
          this.bondsState.set(res.data.length > 0 ? 'ready' : 'empty');
        },
        error: () => {
          this.bondsError.set(appErrorMessage(this.lastError, 'Failed to load bonds'));
          this.bondsState.set(this.bonds().length > 0 ? 'ready' : 'error');
        },
      }),
      finalize(() => {
        if (this.bondsState() !== 'error') {
          this.computeOverview();
        }
      }),
      catchError(() => EMPTY),
    );
  }

  private fetchProjects(): Observable<PaginatedResponse<Project>> {
    this.projectsState.set('loading');
    this.overviewState.set('loading');
    this.projectsError.set('');
    return defer(() => this.apiService.getProjects(1, 5)).pipe(
      this.withRetry(),
      tap({
        next: (res) => {
          this.projects.set(res.data);
          this.totalProjects.set(res.meta.total);
          this.carbonTotal.set(res.data.reduce((sum: number, p: Project) => sum + p.carbonSequestrationEstimate, 0));
          this.projectsState.set(res.data.length > 0 ? 'ready' : 'empty');
        },
        error: () => {
          this.projectsError.set(appErrorMessage(this.lastError, 'Failed to load projects'));
          this.projectsState.set(this.projects().length > 0 ? 'ready' : 'error');
        },
      }),
      finalize(() => {
        if (this.projectsState() !== 'error') {
          this.computeOverview();
        }
      }),
      catchError(() => EMPTY),
    );
  }

  private computeOverview(): void {
    const bondsOk = this.bondsState() === 'ready' || this.bondsState() === 'empty';
    const projectsOk = this.projectsState() === 'ready' || this.projectsState() === 'empty';
    if (bondsOk && projectsOk) {
      this.overviewState.set(this.bonds().length === 0 && this.projects().length === 0 ? 'empty' : 'ready');
    } else if (this.bondsState() === 'error' && this.projectsState() === 'error') {
      this.overviewState.set('error');
    } else if (this.bondsState() === 'loading' || this.projectsState() === 'loading') {
      this.overviewState.set('loading');
    } else if (bondsOk) {
      this.overviewState.set(this.bonds().length === 0 && this.projects().length === 0 ? 'empty' : 'ready');
    } else if (projectsOk) {
      this.overviewState.set(this.bonds().length === 0 && this.projects().length === 0 ? 'empty' : 'ready');
    } else {
      this.overviewState.set('error');
    }
  }

  private lastError: unknown = undefined;

  private withRetry<T>() {
    return retry<T>({
      count: DASHBOARD_RETRY_COUNT,
      delay: (error, attempt) => {
        this.lastError = error;
        return this.isTransientError(error) ? timer(this.retryDelayMs(attempt)) : throwError(() => error);
      },
    });
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(DASHBOARD_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), DASHBOARD_RETRY_MAX_DELAY_MS);
  }

  private isTransientError(error: unknown): boolean {
    if (error instanceof HttpErrorResponse) {
      return error.status === 0 || error.status >= 500;
    }
    return true;
  }

  onSubscribe(bondId: string): void {
    this.router.navigate(['/bonds', bondId]);
  }
}
