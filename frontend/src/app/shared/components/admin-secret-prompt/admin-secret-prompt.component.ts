import { Component, ChangeDetectionStrategy, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminIntentService } from '../../services/admin-intent.service';
import { AdminAccessService } from '../../services/admin-access.service';

/**
 * Step-up prompt for high-risk admin actions (issue #166).
 *
 * `POST /bonds`, `/bonds/:id/sweep-undistributed`, `/coupon` and `/mature` are
 * all behind the API's `IntentGuard`, which demands a freshly signed, single-use
 * intent. Nothing in the UI ever called `setAdminSecret`, so the
 * `x-admin-intent` header was silently omitted and every submit died on a 401.
 *
 * This component is that missing entry point. It collects the admin's Stellar
 * secret, validates it locally, and hands it to `AdminIntentService`, which
 * keeps it in memory for the tab session only.
 */
@Component({
  selector: 'app-admin-secret-prompt',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="backdrop" (click)="onCancel()"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="admin-secret-title">
      <h2 id="admin-secret-title" class="dialog-title">Confirm: {{ action }}</h2>
      @if (description) {
        <p class="dialog-description">{{ description }}</p>
      }

      <p class="dialog-note">
        This action requires a signed admin intent. Your secret key is used in this
        browser tab only to sign the request — it is never stored or sent to the API.
      </p>

      @if (adminAccess.adminAddress(); as expected) {
        <p class="dialog-note mono">Expected admin account: {{ expected }}</p>
      } @else {
        <p class="dialog-warning">
          This build has no <code>adminAddress</code> configured, so the key cannot be
          checked here. The API will still reject a key that is not the protocol admin.
        </p>
      }

      <label class="field-label" for="adminSecret">Admin secret key</label>
      <input
        id="adminSecret"
        class="field-input"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="S…"
        [(ngModel)]="secret"
        (keyup.enter)="onUnlock()"
      />

      @if (error(); as message) {
        <p class="dialog-error" role="alert">{{ message }}</p>
      }

      <div class="dialog-actions">
        <button type="button" class="btn btn-outline" (click)="onCancel()">Cancel</button>
        <button type="button" class="btn btn-primary" [disabled]="!secret" (click)="onUnlock()">
          Unlock &amp; Continue
        </button>
      </div>
    </div>
  `,
  styles: [`
    .backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); z-index: 40; }
    .dialog { position: fixed; z-index: 41; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px)); background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 12px 32px rgba(0,0,0,0.22); display: flex; flex-direction: column; gap: 10px; }
    .dialog-title { font-size: 1.0625rem; font-weight: 700; margin: 0; }
    .dialog-description { font-size: 0.8125rem; color: #374151; margin: 0; }
    .dialog-note { font-size: 0.75rem; color: #6b7280; margin: 0; }
    .dialog-note.mono { font-family: monospace; word-break: break-all; }
    .dialog-warning { font-size: 0.75rem; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 8px 10px; margin: 0; }
    .field-label { font-size: 0.8125rem; font-weight: 600; color: #1a1a2e; margin-top: 6px; }
    .field-input { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 0.875rem; outline: none; font-family: monospace; }
    .field-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.15); }
    .dialog-error { font-size: 0.8125rem; color: #ef4444; background: #fef2f2; border-radius: 6px; padding: 8px 10px; margin: 0; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
    .btn { padding: 9px 18px; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-outline { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminSecretPromptComponent {
  /** Human-readable name of the action being authorised. */
  @Input({ required: true }) action = '';

  /** Optional detail line, e.g. the target bond. */
  @Input() description = '';

  @Output() readonly unlocked = new EventEmitter<void>();
  @Output() readonly cancelled = new EventEmitter<void>();

  readonly adminAccess = inject(AdminAccessService);
  private readonly adminIntent = inject(AdminIntentService);

  secret = '';
  readonly error = signal<string | null>(null);

  onUnlock(): void {
    this.error.set(null);
    try {
      this.adminIntent.setAdminSecret(this.secret);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
      return;
    }
    this.secret = '';
    this.unlocked.emit();
  }

  onCancel(): void {
    this.secret = '';
    this.error.set(null);
    this.cancelled.emit();
  }
}
