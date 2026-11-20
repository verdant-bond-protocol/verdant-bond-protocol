import { Controller, Get, Post, Body, Query, UseGuards, HttpStatus, HttpCode } from '@nestjs/common';
import { OpsService } from './ops.service';
import { OpsDashboardResponse } from './interfaces/ops-dashboard.interface';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { SyntheticJourneyMonitor, SyntheticJourneyConfig, JourneyReport, JourneyRuntime } from './synthetic-journey.monitor';

@Controller('ops')
export class OpsController {
  constructor(private readonly opsService: OpsService) {}

  /**
   * Admin dashboard: shows health of oracle, marketplace, and bonds systems.
   */
  @Get('dashboard')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getDashboard(): Promise<OpsDashboardResponse> {
    return this.opsService.getDashboard();
  }

  /**
   * Run synthetic investor subscription journey (#421).
   * Tests the full end-to-end journey: readiness → list bonds → detail → preview → subscribe (optional).
   *
   * Query parameters:
   *   baseUrl: API origin (default: http://localhost:3000)
   *   amount: token amount to test (default: 1)
   *   bondId: specific bond to test (default: first subscribable)
   *   stepTimeoutMs: per-request timeout (default: 10000)
   *   maxAttempts: attempts for transient step faults (default: 1)
   *   retryDelayMs: delay before a transient retry (default: 0)
   *   write: if present, submit real subscription (never on mainnet)
   *
   * Returns latency, failures, and dependency blame for each step.
   */
  @Post('synthetic-journey')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  async runSyntheticJourney(
    @Query('baseUrl') baseUrl?: string,
    @Query('amount') amountStr?: string,
    @Query('bondId') bondIdStr?: string,
    @Query('stepTimeoutMs') stepTimeoutMsStr?: string,
    @Query('maxAttempts') maxAttemptsStr?: string,
    @Query('retryDelayMs') retryDelayMsStr?: string,
    @Query('write') write?: string,
    @Body() writeConfig?: { token: string; investorAddress: string },
  ): Promise<JourneyReport> {
    const baseUrlFinal = (baseUrl ?? process.env.SYNTHETIC_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    const amount = amountStr ? parseInt(amountStr, 10) : 1;
    const bondId = bondIdStr ? parseInt(bondIdStr, 10) : undefined;
    const stepTimeoutMs = stepTimeoutMsStr ? parseInt(stepTimeoutMsStr, 10) : 10_000;

    const config: SyntheticJourneyConfig = {
      baseUrl: baseUrlFinal,
      amount,
      bondId,
      stepTimeoutMs,
      confirmTimeoutMs: 60_000,
      confirmPollMs: 5_000,
      maxAttempts: maxAttemptsStr ? parseInt(maxAttemptsStr, 10) : 1,
      retryDelayMs: retryDelayMsStr ? parseInt(retryDelayMsStr, 10) : 0,
      write: write && writeConfig ? writeConfig : undefined,
    };

    const runtime: JourneyRuntime = {
      fetch: fetch as unknown as typeof fetch,
      // `startedAt` is rendered with `new Date(...)`, so this must be epoch ms,
      // not the monotonic `performance.now()` clock.
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      idempotencyKey: () => {
        const now = Date.now();
        const randomPart = Math.random().toString(36).slice(2, 11);
        return `synthetic-${now}-${randomPart}`;
      },
    };

    const monitor = new SyntheticJourneyMonitor(config, runtime);
    return monitor.run();
  }
}
