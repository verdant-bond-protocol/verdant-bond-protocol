import { Component, inject, OnInit, input, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService, ChallengedReportSummary } from '../../shared/services/api.service';

/**
 * Shows the challenged reports for a project (issue #3). Each entry links to the
 * full challenge state via the API; this panel surfaces the counter-evidence
 * hash, challenger, submitted time, and resolution so reviewers can act.
 */
@Component({
  selector: 'app-challenged-reports',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="challenged-card">
      <h3 class="section-title">Challenged Reports</h3>

      @if (loading()) {
        <p class="muted">Loading challenge review…</p>
      } @else if (error()) {
        <p class="error-msg">{{ error() }}</p>
      } @else if (reports().length === 0) {
        <p class="muted">No active challenges for this project.</p>
      } @else {
        <ul class="challenged-list">
          @for (entry of reports(); track entry.report.id) {
            <li class="challenged-item">
              <div class="row">
                <span class="report-id">Report #{{ entry.report.id }}</span>
                <span class="status" [class.challenged]="entry.report.status === 'Challenged'">
                  {{ entry.report.status }}
                </span>
              </div>
              @if (entry.challenge; as c) {
                <div class="meta">
                  <div><span class="label">Challenger</span> <span class="mono">{{ c.challengerAddress }}</span></div>
                  <div><span class="label">Counter-evidence</span> <span class="mono">{{ c.counterEvidenceHash }}</span></div>
                  <div><span class="label">Submitted</span> {{ c.submittedAt | date: 'medium' }}</div>
                  <div>
                    <span class="label">Resolution</span>
                    {{ c.resolved ? (c.resolution || 'Resolved') : 'Pending' }}
                  </div>
                </div>
              } @else {
                <div class="meta"><span class="muted">No challenge record available.</span></div>
              }
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [`
    .challenged-card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .section-title { font-size: 1rem; font-weight: 600; margin-bottom: 12px; }
    .muted { font-size: 0.8125rem; color: #6b7280; }
    .error-msg { font-size: 0.8125rem; color: #ef4444; padding: 8px; background: #fef2f2; border-radius: 6px; }
    .challenged-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .challenged-item { border: 1px solid #fecaca; background: #fef2f2; border-radius: 8px; padding: 12px 14px; }
    .row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .report-id { font-weight: 600; }
    .status { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; padding: 2px 8px; border-radius: 999px; background: #fee2e2; color: #991b1b; }
    .status.challenged { background: #fee2e2; color: #991b1b; }
    .meta { display: flex; flex-direction: column; gap: 4px; font-size: 0.8125rem; }
    .label { color: #6b7280; text-transform: uppercase; font-size: 0.7rem; margin-right: 6px; }
    .mono { font-family: monospace; word-break: break-all; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChallengedReportsComponent implements OnInit {
  readonly projectId = input.required<string>();
  private readonly api = inject(ApiService);

  readonly reports = signal<ChallengedReportSummary[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');

  ngOnInit(): void {
    const projectId = this.projectId();
    if (!projectId) {
      this.loading.set(false);
      return;
    }
    this.api.getProjectChallengedReports(projectId).subscribe({
      next: (reports) => {
        this.reports.set(reports);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load challenged reports');
        this.loading.set(false);
      },
    });
  }
}
