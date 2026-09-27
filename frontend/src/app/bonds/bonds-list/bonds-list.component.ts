import { Component, inject, OnInit, ChangeDetectionStrategy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { ApiService } from '../../shared/services/api.service';
import { BondCardComponent } from '../../shared/components/bond-card/bond-card.component';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner.component';
import { ConnectPromptComponent } from '../../shared/components/connect-prompt/connect-prompt.component';
import { AdminAccessService } from '../../shared/services/admin-access.service';
import { Bond } from '../../shared/interfaces/bond.interface';

@Component({
  selector: 'app-bonds-list',
  standalone: true,
  imports: [CommonModule, RouterModule, BondCardComponent, LoadingSpinnerComponent, ConnectPromptComponent],
  template: `
    <div class="bonds-page" aria-label="Bonds List Page">
      <div class="page-header">
        <h1 class="page-title">Bonds</h1>
        @if (adminAccess.isAdmin()) {
          <a class="btn btn-primary" routerLink="/bonds/issue" aria-label="Issue a new bond">Issue Bond</a>
        }
      </div>

      <app-connect-prompt action="Browsing is open to everyone; subscribing to a bond needs a signed-in wallet." />

      @if (error()) {
        <div class="error-banner" role="alert" aria-live="assertive">{{ error() }}</div>
      }

      @if (loading()) {
        <div class="loading-section" aria-busy="true" aria-label="Loading bonds"><app-loading-spinner size="lg" /></div>
      } @else {
        <div class="filter-bar" role="group" aria-label="Filter bonds">
          <button
            class="filter-btn"
            [class.active]="filter() === 'all'"
            [attr.aria-pressed]="filter() === 'all'"
            (click)="filter.set('all')"
          >All</button>
          <button
            class="filter-btn"
            [class.active]="filter() === 'Active'"
            [attr.aria-pressed]="filter() === 'Active'"
            (click)="filter.set('Active')"
          >Active</button>
          <button
            class="filter-btn"
            [class.active]="filter() === 'Matured'"
            [attr.aria-pressed]="filter() === 'Matured'"
            (click)="filter.set('Matured')"
          >Matured</button>
        </div>

        @if (filteredBonds().length === 0) {
          <div class="empty-section" role="status">
            <p>No {{ filter() === 'all' ? '' : filter() }} bonds found.</p>
          </div>
        } @else {
          <div class="card-grid" role="list">
            @for (bond of filteredBonds(); track bond.id) {
              <div role="listitem">
                <app-bond-card [bond]="bond" (subscribe)="onSubscribe(bond.id)" />
              </div>
            }
          </div>

          <nav class="pagination" aria-label="Bonds pagination">
            <button class="btn btn-outline" [disabled]="page() <= 1" aria-label="Previous page" (click)="prevPage()">Previous</button>
            <span class="page-info" aria-live="polite">Page {{ page() }} of {{ totalPages() }}</span>
            <button class="btn btn-outline" [disabled]="page() >= totalPages()" aria-label="Next page" (click)="nextPage()">Next</button>
          </nav>
        }
      }
    </div>
  `,
  styles: [`
    .bonds-page { max-width: 1200px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .page-title { font-size: 1.5rem; font-weight: 700; }
    .error-banner { background: #fef2f2; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; }
    .filter-bar { display: flex; gap: 8px; margin-bottom: 20px; }
    .filter-btn { padding: 8px 20px; border-radius: 20px; font-size: 0.8125rem; font-weight: 500; cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #1a1a2e; transition: all 0.15s; }
    .filter-btn.active { background: #1a1a2e; color: #fff; border-color: #1a1a2e; }
    .filter-btn:hover:not(.active) { background: #f0f2f5; }
    .loading-section { display: flex; justify-content: center; padding: 48px 0; }
    .empty-section { text-align: center; padding: 48px 0; color: #6b7280; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .pagination { display: flex; justify-content: center; align-items: center; gap: 16px; margin-top: 32px; }
    .page-info { font-size: 0.875rem; color: #6b7280; }
    .btn { padding: 8px 16px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; text-decoration: none; display: inline-block; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:hover { background: #2a2a4e; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
    .btn-outline:hover:not(:disabled) { background: #f0f2f5; }
    .btn-outline:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BondsListComponent implements OnInit {
  private readonly apiService = inject(ApiService);
  private readonly router = inject(Router);
  /** Issuance is admin-only on the API, so only show the link to an admin (#168). */
  readonly adminAccess = inject(AdminAccessService);

  readonly bonds = signal<Bond[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly page = signal(1);
  readonly totalPages = signal(1);
  readonly filter = signal<'all' | 'Active' | 'Matured'>('all');
  private readonly limit = 12;

  readonly filteredBonds = computed(() => {
    const f = this.filter();
    if (f === 'all') return this.bonds();
    return this.bonds().filter(b => b.status === f);
  });

  ngOnInit(): void {
    this.loadBonds();
  }

  private loadBonds(): void {
    this.loading.set(true);
    this.error.set('');
    this.apiService.getBonds(this.page(), this.limit).subscribe({
      next: (res) => {
        this.bonds.set(res.data);
        this.totalPages.set(res.meta.totalPages);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load bonds');
        this.loading.set(false);
      },
    });
  }

  onSubscribe(bondId: number): void {
    this.router.navigate(['/bonds', bondId]);
  }

  prevPage(): void {
    if (this.page() > 1) {
      this.page.update(p => p - 1);
      this.loadBonds();
    }
  }

  nextPage(): void {
    if (this.page() < this.totalPages()) {
      this.page.update(p => p + 1);
      this.loadBonds();
    }
  }
}
