import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { outcomeText, parseSimulationReport, SimulationOutcome, SimulationReport } from './simulation-report';

@Component({
  selector: 'app-governance-simulation',
  standalone: true,
  imports: [CommonModule],
  template: `
    <main>
      <h1>Governance impact preview</h1>
      <p>Compare what happens today with what would happen if a proposal passes.</p>
      <p>Run the offline governance sandbox with a recent protocol snapshot, then open its JSON report here.
        The snapshot ledger is shown so you can judge how current the preview is.</p>
      <label for="simulation-report">Open simulation report</label>
      <input id="simulation-report" type="file" accept=".json,application/json" (change)="openReport($event)" />
      @if (error) { <p role="alert">{{ error }}</p> }
      @if (report; as preview) {
        <h2>Proposal {{ preview.proposal_id }}</h2>
        <p>Ledger {{ preview.ledger_sequence }} · {{ preview.ledger_timestamp * 1000 | date:'medium' }}</p>
        <p>Network: {{ preview.network_passphrase }}</p>
        <p>Proposed action: {{ preview.proposal.method }} on {{ preview.proposal.contract }}</p>
        <p>Snapshot fingerprint: <code>{{ preview.snapshot_sha256 }}</code></p>
        <p>{{ preview.authorization }}. This report covers the listed scenarios; it is not a guarantee of future results.</p>
        <p>Proposal execution: {{ describe(preview.proposal_result) }}</p>
        @if (preview.proposal_result.status === 'failure') {
          <p role="alert">The proposal could not be applied. Its proposed outcomes are unavailable; do not interpret them as a successful preview.</p>
        }
        <table>
          <caption>Parameters and downstream effects at the same ledger</caption>
          <thead><tr><th scope="col">Effect</th><th scope="col">Today</th><th scope="col">If passed</th><th scope="col">Change</th></tr></thead>
          <tbody>
            @for (diff of preview.diffs; track $index) {
              <tr>
                <th scope="row">{{ diff.label }} <small>{{ categoryLabel(diff.category) }} · {{ diff.unit }}</small><p>{{ diff.explanation }}</p></th>
                <td>{{ describe(diff.before) }}</td><td>{{ describe(diff.after) }}</td>
                <td>{{ diff.changed ? 'Changed' : 'Unchanged' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </main>
  `,
  styles: [`main { max-width: 70rem; margin: 2rem auto; padding: 1rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
    th, td { padding: .8rem; text-align: left; border-bottom: 1px solid #aaa; overflow-wrap: anywhere; }
    small { display: block; font-weight: normal; } code { overflow-wrap: anywhere; }
    [role=alert] { color: #a12520; }`],
})
export class GovernanceSimulationComponent {
  report?: SimulationReport;
  error = '';
  private readVersion = 0;
  describe(value: SimulationOutcome): string { return outcomeText(value); }
  categoryLabel(category: string): string {
    return ({ fees: 'Fees', covenants: 'Bond protections', oracle_config: 'Oracle configuration' } as Record<string, string>)[category] ?? category;
  }
  async openReport(event: Event): Promise<void> {
    const version = ++this.readVersion;
    this.report = undefined;
    this.error = '';
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('Choose a report smaller than 2 MB.');
      const report = parseSimulationReport(await file.text());
      if (version === this.readVersion) this.report = report;
    } catch (error) {
      if (version === this.readVersion) this.error = error instanceof Error ? error.message : 'Could not open report.';
    }
  }
}
