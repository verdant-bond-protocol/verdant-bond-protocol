import { Component, OnInit, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppError, normalizeApiError } from '../../errors/api-error';

/** Phases of an async operation that can fail and be recovered. */
export type AsyncRecoveryPhase = 'idle' | 'loading' | 'error' | 'recovering' | 'recovered';

let nextInstanceId = 0;

/**
 * Accessible async error-recovery banner.
 *
 * Accessibility contract (WCAG 2.1 A/AA):
 *  - a persistent `role="status"` / `aria-live="polite"` region exists from the
 *    first render, so later state changes are announced (4.1.3);
 *  - failures are also announced assertively via `role="alert"`;
 *  - the retry control has a real accessible name, is keyboard operable, is
 *    disabled while a retry is in flight, and is described by the error text;
 *  - an authorization failure offers a named sign-in link instead of implying
 *    that "try again" alone can fix the problem;
 *  - `aria-busy` is set while work is in flight.
 */
@Component({
  selector: 'app-async-error-recovery',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="recovery" [attr.data-phase]="phase()" [attr.aria-busy]="busy()">
      <p class="live-region" role="status" aria-live="polite" aria-atomic="true">{{ liveMessage() }}</p>

      <p *ngIf="phase() === 'error' || phase() === 'recovering'" class="error-banner" role="alert" aria-live="assertive">
        <strong>{{ errorMessage() }}</strong>
        <span [id]="messageId">{{ detail() }}</span>
      </p>

      <p *ngIf="phase() === 'recovered'" class="success-banner" role="status" aria-live="polite">
        Request completed successfully.
      </p>

      <div class="recovery-actions" *ngIf="phase() === 'error' || phase() === 'recovering'">
        <button
          type="button"
          class="retry-button"
          [disabled]="phase() === 'recovering'"
          [attr.aria-describedby]="messageId"
          (click)="retryNow()"
        >{{ requiresAuthorization() ? 'Try again after signing in' : 'Try again' }}</button>
        <a *ngIf="requiresAuthorization()" class="sign-in-link" href="/auth">Sign in to continue</a>
      </div>
    </div>
  `,
  styles: [`
    .recovery { font: inherit; }
    .live-region { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .error-banner { color: #b91c1c; border: 1px solid #b91c1c; padding: 8px 12px; }
    .success-banner { color: #166534; }
    .recovery-actions { display: flex; gap: 12px; align-items: center; }
  `],
})
export class AsyncErrorRecoveryComponent implements OnInit {
  readonly operation = input.required<() => Promise<unknown>>();
  readonly errorMessage = input<string>('We could not complete that request.');

  readonly phase = signal<AsyncRecoveryPhase>('idle');
  readonly liveMessage = signal('');
  readonly attempts = signal(0);
  readonly failure = signal<AppError | null>(null);
  readonly requiresAuthorization = signal(false);

  readonly recovered = output<void>();
  readonly failed = output<AppError>();

  readonly messageId = `async-recovery-message-${++nextInstanceId}`;

  busy(): boolean {
    return this.phase() === 'loading' || this.phase() === 'recovering';
  }

  /** A blank API detail is still announced, never an empty alert. */
  detail(): string {
    return this.failure()?.detail?.trim() || 'Request failed';
  }

  ngOnInit(): void {
    void this.run();
  }

  /** Initial load of the operation. */
  async run(): Promise<void> {
    this.phase.set('loading');
    this.liveMessage.set('Loading…');
    await this.execute('Request completed.');
  }

  /** Retry after a failure. Guarded against a second concurrent retry. */
  async retryNow(): Promise<void> {
    if (this.phase() === 'recovering' || this.phase() === 'loading') return;
    const attempt = this.attempts() + 1;
    this.attempts.set(attempt);
    this.phase.set('recovering');
    this.liveMessage.set(`Retry attempt ${attempt} in progress.`);
    await this.execute(`Recovered on attempt ${attempt}.`);
  }

  private async execute(successMessage: string): Promise<void> {
    try {
      await this.operation()();
      this.failure.set(null);
      this.requiresAuthorization.set(false);
      this.phase.set('recovered');
      this.liveMessage.set(successMessage);
      this.recovered.emit();
    } catch (error) {
      const normalized = normalizeApiError(error);
      const authFailure = normalized.status === 401 || normalized.status === 403;
      this.failure.set(normalized);
      this.requiresAuthorization.set(authFailure);
      this.phase.set('error');
      this.liveMessage.set(
        `${authFailure ? 'You do not have permission.' : 'Request failed.'} ${this.detail()}`,
      );
      this.failed.emit(normalized);
    }
  }
}
