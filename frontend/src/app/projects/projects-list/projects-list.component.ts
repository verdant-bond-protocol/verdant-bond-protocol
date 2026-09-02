import { Component, inject, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ApiService } from '../../shared/services/api.service';
import { ProjectCardComponent } from '../../shared/components/project-card/project-card.component';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner.component';
import { Project } from '../../shared/interfaces/bond.interface';
import { AdminAccessService } from '../../shared/services/admin-access.service';

@Component({
  selector: 'app-projects-list',
  standalone: true,
  imports: [CommonModule, RouterModule, ProjectCardComponent, LoadingSpinnerComponent],
  template: `
    <div class="projects-page">
      <div class="page-header">
        <h1 class="page-title">Projects</h1>
        @if (adminAccess.isAdmin()) {
          <button class="btn btn-primary" (click)="onApproveAll()">Approve All Pending</button>
          <button class="btn btn-outline" (click)="onRejectAll()">Reject All Pending</button>
        }
      </div>

      @if (error()) {
        <div class="error-banner">{{ error() }}</div>
      }

      @if (loading()) {
        <div class="loading-section"><app-loading-spinner size="lg" /></div>
      } @else if (projects().length === 0) {
        <div class="empty-section">
          <p>No projects registered yet. Register your first project.</p>
        </div>
      } @else {
        <div class="card-grid">
          @for (project of projects(); track project.id) {
            <a class="card-link" [routerLink]="['/projects', project.id]">
              <app-project-card [project]="project" />
            </a>
          }
        </div>

        <div class="pagination">
          <button class="btn btn-outline" [disabled]="page() <= 1" (click)="prevPage()">Previous</button>
          <span class="page-info">Page {{ page() }} of {{ totalPages() }}</span>
          <button class="btn btn-outline" [disabled]="page() >= totalPages()" (click)="nextPage()">Next</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .projects-page { max-width: 1200px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .page-title { font-size: 1.5rem; font-weight: 700; }
    .error-banner { background: #fef2f2; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.875rem; }
    .loading-section { display: flex; justify-content: center; padding: 48px 0; }
    .empty-section { text-align: center; padding: 48px 0; color: #6b7280; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .card-link { text-decoration: none; color: inherit; display: block; }
    .card-link:hover .project-card { box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
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
export class ProjectsListComponent implements OnInit {
  private readonly apiService = inject(ApiService);
  private readonly adminAccess = inject(AdminAccessService);

  readonly projects = signal<Project[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly page = signal(1);
  readonly totalPages = signal(1);
  private readonly limit = 12;

  ngOnInit(): void {
    this.loadProjects();
  }

  private loadProjects(): void {
    this.loading.set(true);
    this.error.set('');
    this.apiService.getProjects(this.page(), this.limit).subscribe({
      next: (res) => {
        this.projects.set(res.data);
        this.totalPages.set(res.meta.totalPages);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load projects');
        this.loading.set(false);
      },
    });
  }

  prevPage(): void {
    if (this.page() > 1) {
      this.page.update(p => p - 1);
      this.loadProjects();
    }
  }

  nextPage(): void {
    if (this.page() < this.totalPages()) {
      this.page.update(p => p + 1);
      this.loadProjects();
    }
  }

  onApproveAll(): void {
    if (!confirm('Approve all pending projects?')) return;
    alert('Approve all pending projects functionality would iterate through projects and call approve on each.');
  }

  onRejectAll(): void {
    if (!confirm('Reject all pending projects?')) return;
    alert('Reject all pending projects functionality would iterate through projects and call reject on each.');
  }
}
