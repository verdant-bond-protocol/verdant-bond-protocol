import { Component, inject, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { ApiService } from '../../shared/services/api.service';
import { StatusBadgeComponent } from '../../shared/components/status-badge/status-badge.component';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner.component';
import { ChallengedReportsComponent } from '../challenged-reports/challenged-reports.component';
import { Project, ProjectProvenanceEvent } from '../../shared/interfaces/bond.interface';
import { forkJoin } from 'rxjs';
import { AdminAccessService } from '../../shared/services/admin-access.service';

@Component({
  selector: 'app-project-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, StatusBadgeComponent, LoadingSpinnerComponent, ChallengedReportsComponent],
  template: `
    <div class="detail-page">
      <a class="back-link" routerLink="/projects">← Back to Projects</a>

      @if (project(); as p) {
        <div class="detail-card">
          <div class="detail-header">
            <h1 class="detail-title">{{ p.name }}</h1>
            <app-status-badge [status]="p.status" variant="project" />
          </div>

          <div class="detail-body">
            <div class="detail-field">
              <span class="field-label">Project ID</span>
              <span class="field-value">{{ p.id }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Methodology</span>
              <span class="field-value mono">{{ p.methodology }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Country</span>
              <span class="field-value">{{ p.country }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Total Area</span>
              <span class="field-value">{{ p.totalAreaHa | number }} ha</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Carbon Estimate</span>
              <span class="field-value">{{ p.carbonSequestrationEstimate | number }} tCO₂e</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Owner Address</span>
              <span class="field-value mono">{{ p.ownerAddress }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Created</span>
              <span class="field-value">{{ p.createdAt | date }}</span>
            </div>
            <div class="detail-field">
              <span class="field-label">Metadata</span>
              <a class="field-value link" [href]="metadataUrl()" target="_blank" rel="noopener noreferrer">View on IPFS →</a>
            </div>
          </div>
        </div>

        <section class="timeline-card" aria-labelledby="provenance-heading">
          <h2 id="provenance-heading">Provenance</h2>
          @if (timeline().length === 0) {
            <p class="timeline-empty">No provenance events are available yet.</p>
          } @else {
            <ol class="timeline">
              @for (event of timeline(); track $index) {
                <li>
                  <span class="timeline-dot" [class.pending]="event.status !== 'complete'"></span>
                  <div><strong>{{ event.title }}</strong>
                    <div class="timeline-meta">{{ event.occurredAt ? (event.occurredAt | date:'medium') : event.status }}</div>
                    @if (event.evidenceUrl) { <a [href]="event.evidenceUrl" target="_blank" rel="noopener noreferrer">View evidence →</a> }
                  </div>
                </li>
              }
            </ol>
          }
        </section>

        @if (adminAccess.isAdmin()) {
          <div class="admin-section" style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
            <h3 class="section-title">Admin: Project Approval</h3>
            @if (project()?.status === 'Pending') {
              <button class="btn btn-primary" (click)="onApprove()">Approve Project</button>
              <button class="btn btn-outline" (click)="onReject()">Reject Project</button>
            } @else {
              <p class="status-notice">Project is already {{ project()?.status | lowercase }}.</p>
            }
          </div>
        }

        <app-challenged-reports [projectId]="'' + p.id" />
      } @else if (loading()) {
        <div class="loading-section"><app-loading-spinner size="lg" /></div>
      } @else if (error()) {
        <div class="error-card">{{ error() }}</div>
      }
    </div>
  `,
  styles: [`
    .detail-page { max-width: 800px; }
    .back-link { display: inline-block; margin-bottom: 24px; color: #3b82f6; text-decoration: none; font-size: 0.875rem; }
    .back-link:hover { text-decoration: underline; }
    .loading-section { display: flex; justify-content: center; padding: 48px 0; }
    .error-card { background: #fef2f2; color: #ef4444; padding: 24px; border-radius: 12px; text-align: center; }
    .detail-card { background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .timeline-card { margin-top: 24px; background: #fff; border-radius: 12px; padding: 24px 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .timeline { list-style: none; padding: 0; margin: 20px 0 0; }
    .timeline li { position: relative; display: grid; grid-template-columns: 18px 1fr; gap: 12px; padding-bottom: 20px; }
    .timeline-dot { width: 10px; height: 10px; margin-top: 5px; border-radius: 50%; background: #22c55e; }
    .timeline-dot.pending { background: #f59e0b; }
    .timeline-meta, .timeline-empty { color: #6b7280; font-size: 0.8125rem; }
    .timeline a { color: #3b82f6; font-size: 0.8125rem; }
    .detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .detail-title { font-size: 1.5rem; font-weight: 700; }
    .detail-body { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .detail-field { display: flex; flex-direction: column; }
    .field-label { font-size: 0.75rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .field-value { font-size: 0.9375rem; color: #1a1a2e; }
    .field-value.mono { font-family: monospace; font-size: 0.8125rem; word-break: break-all; }
    .field-value.link { color: #3b82f6; text-decoration: none; }
    .field-value.link:hover { text-decoration: underline; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly apiService = inject(ApiService);

  readonly project = signal<Project | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly timeline = signal<ProjectProvenanceEvent[]>([]);

  metadataUrl(): string {
    const p = this.project();
    return p?.metadataIpfsHash ? `https://gateway.pinata.cloud/ipfs/${p.metadataIpfsHash}` : '#';
  }

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) {
      this.error.set('Invalid project ID');
      this.loading.set(false);
      return;
    }
    forkJoin({ project: this.apiService.getProject(id), provenance: this.apiService.getProjectProvenance(id) }).subscribe({
      next: ({ project, provenance }) => {
        this.project.set(project);
        this.timeline.set(provenance.events);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.status === 404 ? 'Project not found' : 'Failed to load project');
        this.loading.set(false);
      },
    });
  }

  onApprove(): void {
    if (!confirm('Approve project #'' + this.project()?.id + '?')) return;
    this.apiService.approveProject(this.project()!.id).subscribe({
      next: () => {
        this.loadProjects();
      },
      error: (err) => {
        this.error.set(appErrorMessage(err, 'Approve failed'));
      },
    });
  }

  onReject(): void {
    if (!confirm('Reject project #'' + this.project()?.id + '?')) return;
    this.apiService.rejectProject(this.project()!.id).subscribe({
      next: () => {
        this.loadProjects();
      },
      error: (err) => {
        this.error.set(appErrorMessage(err, 'Reject failed'));
      },
    });
  }
}
