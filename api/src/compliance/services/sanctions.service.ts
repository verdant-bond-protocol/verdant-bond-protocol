import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { SanctionsStatus } from '../interfaces/compliance.interface';

// Default initial sanctioned entities (SDN list sample for testing and dev)
const SEED_SANCTIONED_ADDRESSES = new Set<string>([
  'GBANXSANCTIONEDADDRESS00000000000000000000000000000000000',
  'GSANCTIONEDWALLETOFAC0000000000000000000000000000000000000',
]);

const SEED_SANCTIONED_COUNTRIES = new Set<string>(['KP', 'IR', 'CU', 'SY', 'RU-DNR', 'RU-LNR']);

@Injectable()
export class SanctionsService implements OnModuleInit {
  private readonly logger = new Logger(SanctionsService.name);

  private sanctionedAddresses: Set<string> = new Set(SEED_SANCTIONED_ADDRESSES);
  private sanctionedCountries: Set<string> = new Set(SEED_SANCTIONED_COUNTRIES);
  private lastRefreshedAt: number = Date.now();
  private maxStalenessHours: number = 24;
  private refreshCadence: string = '0 0 * * *';
  private alertRaised: boolean = false;

  constructor() {
    const configuredHours = Number(process.env.SANCTIONS_MAX_STALENESS_HOURS);
    if (!Number.isNaN(configuredHours) && configuredHours > 0) {
      this.maxStalenessHours = configuredHours;
    }
  }

  onModuleInit(): void {
    this.logger.log(
      `SanctionsService initialized. Cadence: ${this.refreshCadence}, Max Staleness: ${this.maxStalenessHours}h. Tracking ${this.sanctionedAddresses.size} addresses and ${this.sanctionedCountries.size} embargoed regions.`,
    );
  }

  /**
   * Check whether an address or jurisdiction country is on active sanctions lists.
   */
  checkSanctions(
    address: string,
    country?: string,
  ): { sanctioned: boolean; list?: string; reason?: string } {
    this.checkAndAlertStaleness();

    // 1. Check address
    if (this.sanctionedAddresses.has(address)) {
      return {
        sanctioned: true,
        list: 'OFAC_SDN_ADDRESS',
        reason: `Wallet address ${address} is listed on active sanctions lists.`,
      };
    }

    // 2. Check country / jurisdiction
    if (country && this.sanctionedCountries.has(country.toUpperCase())) {
      return {
        sanctioned: true,
        list: 'OFAC_COMPREHENSIVE_SANCTIONS',
        reason: `Jurisdiction ${country.toUpperCase()} is subject to comprehensive international sanctions/embargo.`,
      };
    }

    return { sanctioned: false };
  }

  /**
   * Quick boolean check if an address is in the sanctioned address set.
   */
  isSanctioned(address: string): boolean {
    return this.sanctionedAddresses.has(address);
  }

  /**
   * Add a single sanctioned address (e.g. for testing or dynamic sanctions updates).
   */
  addSanctionedAddress(address: string, reason?: string): void {
    this.sanctionedAddresses.add(address);
  }

  /**
   * Checks staleness of sanctions list and triggers alert if stale.
   */
  isStale(): boolean {
    const ageHours = (Date.now() - this.lastRefreshedAt) / (1000 * 60 * 60);
    return ageHours >= this.maxStalenessHours;
  }

  checkAndAlertStaleness(): boolean {
    const stale = this.isStale();
    if (stale && !this.alertRaised) {
      this.alertRaised = true;
      this.logger.error(
        `[SECURITY ALERT] Sanctions list data is STALE! Last refreshed at ${new Date(this.lastRefreshedAt).toISOString()} (exceeds ${this.maxStalenessHours}h threshold). High-risk transactions require manual review.`,
      );
    } else if (!stale) {
      this.alertRaised = false;
    }
    return stale;
  }

  /**
   * Refresh sanctions list dataset and reset staleness state.
   */
  async refreshSanctionsList(opts?: {
    additionalAddresses?: string[];
    additionalCountries?: string[];
    resetLastRefreshedAt?: number;
  }): Promise<SanctionsStatus> {
    if (opts?.additionalAddresses) {
      for (const addr of opts.additionalAddresses) {
        this.sanctionedAddresses.add(addr);
      }
    }
    if (opts?.additionalCountries) {
      for (const c of opts.additionalCountries) {
        this.sanctionedCountries.add(c.toUpperCase());
      }
    }

    this.lastRefreshedAt = opts?.resetLastRefreshedAt ?? Date.now();
    this.alertRaised = false;

    this.logger.log(
      `Sanctions list refreshed at ${new Date(this.lastRefreshedAt).toISOString()}. Total addresses: ${this.sanctionedAddresses.size}, countries: ${this.sanctionedCountries.size}`,
    );

    return this.getStatus();
  }

  /**
   * Simulate list aging for testing or operational verification.
   */
  simulateStaleness(hoursAgo: number): void {
    this.lastRefreshedAt = Date.now() - hoursAgo * 3600 * 1000;
    this.checkAndAlertStaleness();
  }

  getStatus(): SanctionsStatus {
    return {
      isStale: this.isStale(),
      lastRefreshedAt: new Date(this.lastRefreshedAt).toISOString(),
      entryCount: this.sanctionedAddresses.size + this.sanctionedCountries.size,
      refreshCadence: this.refreshCadence,
      maxStalenessHours: this.maxStalenessHours,
      alertRaised: this.alertRaised || this.isStale(),
    };
  }
}
