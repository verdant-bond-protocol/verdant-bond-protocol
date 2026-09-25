import { Injectable, signal, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { ApiService, BondDetailResponse } from '../../shared/services/api.service';

export type BondDetailSection = 'bond' | 'holders' | 'coupon' | 'maturity';

export interface SectionLoading {
  bond: boolean;
  holders: boolean;
  coupon: boolean;
  maturity: boolean;
}

const IDLE_SECTIONS: SectionLoading = { bond: false, holders: false, coupon: false, maturity: false };

/**
 * Reload coordinator for the bond detail view (issue #4). Every mutation
 * (subscribe, transfer, claim, mature, sweep) and the initial load go through
 * `reload()`, which fetches the consolidated `bond/:id/detail` payload once and
 * commits the bond summary, holders, coupon, and maturity together. Because the
 * component derives every panel from this single committed snapshot, the UI
 * never renders a mix of pre- and post-mutation data. Per-section loading flags
 * let each panel show its own spinner, and `lastLoadedAt` (the server timestamp)
 * supports staleness checks.
 */
@Injectable()
export class BondDetailReloadCoordinator implements OnDestroy {
  readonly detail = signal<BondDetailResponse | null>(null);
  readonly loading = signal(false);
  readonly sectionLoading = signal<SectionLoading>(IDLE_SECTIONS);
  readonly lastLoadedAt = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  private active: Subscription | null = null;

  constructor(private readonly api: ApiService) {}

  reload(id: number): void {
    if (this.active) {
      this.active.unsubscribe();
    }
    this.loading.set(true);
    this.sectionLoading.set({ bond: true, holders: true, coupon: true, maturity: true });
    this.error.set(null);

    this.active = this.api.getBondDetail(id, { bustCache: true }).subscribe({
      next: (detail) => {
        this.detail.set(detail);
        this.lastLoadedAt.set(detail.loadedAt);
        this.commitIdle();
      },
      error: (err: { error?: { detail?: string }; message?: string }) => {
        this.error.set(err?.error?.detail || err?.message || 'Failed to refresh bond data');
        this.commitIdle();
      },
    });
  }

  private commitIdle(): void {
    this.loading.set(false);
    this.sectionLoading.set(IDLE_SECTIONS);
  }

  /** True if a newer server snapshot is known than the given client timestamp. */
  isNewerThan(clientLoadedAt: string | null): boolean {
    const server = this.lastLoadedAt();
    if (!clientLoadedAt || !server) return false;
    return Date.parse(server) > Date.parse(clientLoadedAt);
  }

  ngOnDestroy(): void {
    this.active?.unsubscribe();
  }
}
