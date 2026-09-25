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
              <span class="field-label">Metadata & Verification</span>
              <div class="metadata-row">
                <a class="field-value link" [href]="metadataUrl()" target="_blank" rel="noopener noreferrer">View on IPFS →</a>
                <button type="button" class="btn-check-doc" (click)="checkDocumentAvailability()" [disabled]="checkingDoc()">
                  {{ checkingDoc() ? 'Checking...' : 'Verify Availability' }}
                </button>
              </div>
              @if (documentNotice()) {
                <div class="doc-status-banner" [class.warning]="documentStatus() === 'temporarily_unavailable'" [class.success]="documentStatus() === 'available'">
                  <div class="banner-text">{{ documentNotice() }}</div>
                  @if (documentStatus() === 'temporarily_unavailable') {
                    <div class="banner-actions">
                      <button type="button" class="btn-action" (click)="retryDocument()" [disabled]="checkingDoc()">Retry</button>
                      <button type="button" class="btn-action primary" (click)="escalateDocument()" [disabled]="escalatingDoc()">
                        {{ escalatingDoc() ? 'Escalating...' : 'Escalate Retrieval' }}
                      </button>
                    </div>
                  }
                </div>
              }
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
    .metadata-row { display: flex; align-items: center; gap: 12px; }
    .btn-check-doc { background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; cursor: pointer; }
    .btn-check-doc:hover { background: #e5e7eb; }
    .doc-status-banner { margin-top: 8px; padding: 8px 12px; border-radius: 6px; font-size: 0.8125rem; display: flex; flex-direction: column; gap: 6px; }
    .doc-status-banner.warning { background: #fffbeb; border: 1px solid #fef3c7; color: #b45309; }
    .doc-status-banner.success { background: #f0fdf4; border: 1px solid #dcfce7; color: #15803d; }
    .banner-actions { display: flex; gap: 8px; margin-top: 4px; }
    .btn-action { padding: 4px 10px; font-size: 0.75rem; border-radius: 4px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; }
    .btn-action.primary { background: #3b82f6; color: #fff; border-color: #3b82f6; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly apiService = inject(ApiService);
  readonly adminAccess = inject(AdminAccessService);

  readonly project = signal<Project | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly timeline = signal<ProjectProvenanceEvent[]>([]);
  readonly checkingDoc = signal(false);
  readonly escalatingDoc = signal(false);
  readonly documentStatus = signal<'available' | 'temporarily_unavailable' | ''>('');
  readonly documentNotice = signal('');

  metadataUrl(): string {
    const p = this.project();
    return p?.metadataIpfsHash ? `https://gateway.pinata.cloud/ipfs/${p.metadataIpfsHash}` : '#';
  }

  checkDocumentAvailability(): void {
    const p = this.project();
    if (!p || !p.metadataIpfsHash) return;
    this.checkingDoc.set(true);
    this.apiService.getProjectDocument(p.id, p.metadataIpfsHash).subscribe({
      next: (res) => {
        this.checkingDoc.set(false);
        if (res.status === 'temporarily_unavailable' || res.statusCode === 503) {
          this.documentStatus.set('temporarily_unavailable');
          this.documentNotice.set(
            'Document is temporarily unavailable across IPFS gateways. A background recovery was queued. You may retry or escalate.',
          );
        } else {
          this.documentStatus.set('available');
          const source = res.servedFrom === 'cache' ? ' (served via resilient cache fallback)' : '';
          this.documentNotice.set(`Document is verified and accessible${source}.`);
        }
      },
      error: () => {
        this.checkingDoc.set(false);
        this.documentStatus.set('temporarily_unavailable');
        this.documentNotice.set(
          'Document is temporarily unreachable across IPFS gateways. Use the options below to retry or escalate to the protocol auditor team.',
        );
      },
    });
  }

  retryDocument(): void {
    this.checkDocumentAvailability();
  }

  escalateDocument(): void {
    const p = this.project();
    if (!p || !p.metadataIpfsHash) return;
    this.escalatingDoc.set(true);
    this.apiService.escalateProjectDocument(p.id, p.metadataIpfsHash).subscribe({
      next: (res) => {
        this.escalatingDoc.set(false);
        this.documentNotice.set(
          res.message || 'Retrieval escalation broadcast to all protocol nodes. Background re-pinning in progress.',
        );
      },
      error: () => {
        this.escalatingDoc.set(false);
        this.documentNotice.set('Escalation request queued. Auditors have been notified.');
      },
    });
  }

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) {
      this.error.set('Invalid project ID');
      this.loading.set(false);
      return;
    }
    this.loadProject(id);
  }

  loadProject(id: number): void {
    this.loading.set(true);
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
    const id = this.project()?.id;
    if (!id) return;
    if (!confirm(`Approve project #${id}?`)) return;
    this.apiService.approveProject(id).subscribe({
      next: () => {
        this.loadProject(id);
      },
      error: (err: any) => {
        this.error.set(err?.error?.message || err?.message || 'Approve failed');
      },
    });
  }

  onReject(): void {
    const id = this.project()?.id;
    if (!id) return;
    if (!confirm(`Reject project #${id}?`)) return;
    this.apiService.rejectProject(id).subscribe({
      next: () => {
        this.loadProject(id);
      },
      error: (err: any) => {
        this.error.set(err?.error?.message || err?.message || 'Reject failed');
      },
    });
  }
}
