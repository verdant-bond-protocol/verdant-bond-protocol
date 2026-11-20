import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';

// Every background keeps white badge text at ≥ 4.5:1 (WCAG 1.4.3, #206).
const STATUS_COLORS: Record<string, string> = {
  Active: '#15803d',
  Pending: '#a16207',
  Matured: '#1d4ed8',
  Defaulted: '#b91c1c',
  Rejected: '#b91c1c',
  Verified: '#15803d',
  Approved: '#15803d',
  Inactive: '#4b5563',
  Open: '#15803d',
  PartiallyFilled: '#b45309',
  Filled: '#1d4ed8',
  Cancelled: '#4b5563',
  Expired: '#b91c1c',
  Confirmed: '#15803d',
  Failed: '#b91c1c',
};

@Component({
  selector: 'app-status-badge',
  standalone: true,
  imports: [CommonModule],
  template: `
    <span class="status-badge" [style.background]="color()" [style.color]="'#fff'">
      {{ status() }}
    </span>
  `,
  styles: [`
    .status-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusBadgeComponent {
  readonly status = input.required<string>();
  readonly variant = input<'bond' | 'project' | 'report'>('bond');

  color(): string {
    return STATUS_COLORS[this.status()] || '#4b5563';
  }
}
