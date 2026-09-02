import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { catchError, defer, Observable, throwError } from 'rxjs';
import { AuthService } from '../../auth/auth.service';
import { WalletService } from '../../auth/wallet.service';
import { AdminIntentService, SignedAdminIntent } from './admin-intent.service';
import {
  Bond, HeldBond, Project, ProjectProvenance, Order, PaginatedResponse,
  SubscriptionResponse, CreateProjectDto, CreateBondDto, OrderQueryParams, ListBondDto, BuyBondDto,
  ClaimCreditsResponse, TransferResponse,
  UndistributedTotalResponse, SweepUndistributedResponse,
  QuoteBalanceResponse, QuoteTransactionResponse,
  QuoteAsset, DepositQuoteDto, WithdrawQuoteDto, HolderResponse,
  ClaimableCreditDetail, ClaimableCreditsResponse,
} from '../interfaces/bond.interface';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance?: string;
  correlationId?: string;
  errors?: Array<{ field: string; message: string }>;
  contract?: { address?: string; method?: string; rawErrorCode?: number };
}

export class ApiProblemError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail || problem.title);
  }
}

/** Lifecycle status of an oracle report (see docs/oracle-challenge-lifecycle.md). */
export type OracleReportStatus = 'Pending' | 'Verified' | 'Challenged' | 'Rejected';

export interface ChallengeRecord {
  reportId: number;
  challengerAddress: string;
  counterEvidenceHash: string;
  submittedAt: string;
  resolved: boolean;
  resolution: OracleReportStatus | null;
}

export interface ChallengeStateResponse {
  reportId: number;
  status: OracleReportStatus;
  challenged: boolean;
  challenges: ChallengeRecord[];
}

export interface ChallengedReportSummary {
  report: {
    id: number;
    projectId: string;
    status: OracleReportStatus;
    providerAddress: string;
    createdAt: string;
  };
  challenge: ChallengeRecord | null;
}

export interface CouponEligibility {
  projectId: string;
  eligible: boolean;
  reasons: string[];
  blockedByReportIds: number[];
}

/**
 * Consolidated, atomically-fetched bond detail (issue #4). A single call returns
 * the bond summary, holders, coupon undistributed total, and maturity status so
 * the frontend can refresh every panel together and never render a mix of
 * pre- and post-mutation data. `loadedAt` is the server timestamp used by the
 * client refresh model to detect staleness.
 */
export interface BondDetailResponse {
  bond: Bond;
  holders: HolderResponse[];
  coupon: { undistributedTotal: string };
  maturity: { reached: boolean; date: number; secondsUntil: number };
  loadedAt: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly walletService = inject(WalletService);
  private readonly adminIntent = inject(AdminIntentService);

  private headers(extra?: Record<string, string>): HttpHeaders {
    const token = this.authService.token();
    const walletAddress = this.walletService.address();
    let headers = new HttpHeaders(
      token ? { Authorization: `Bearer ${token}` } : {},
    );
    if (walletAddress) {
      headers = headers.set('x-wallet-address', walletAddress);
    }
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        headers = headers.set(k, v);
      }
    }
    return headers;
  }

  /**
   * Produce the `x-admin-intent` header for a high-risk admin action (#115).
   *
   * The API's `IntentGuard` rejects these routes outright without it, so a
   * missing or unsignable secret throws here (#166). Previously the header was
   * silently dropped and the caller saw an unexplained 401.
   */
  private adminIntentHeader(action: string, target: string): Record<string, string> {
    const intent: SignedAdminIntent = this.adminIntent.create(action, target);
    return { 'x-admin-intent': JSON.stringify(intent) };
  }

  /** Generate a stable idempotency key for a user action (#114). */
  generateIdempotencyKey(prefix: string): string {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  private withProblemDetails<T>(source: Observable<T>): Observable<T> {
    return source.pipe(
      catchError((error: HttpErrorResponse) => {
        const body = error.error;
        if (body && typeof body === 'object' && 'type' in body && 'status' in body && 'code' in body) {
          return throwError(() => new ApiProblemError(body as ProblemDetails));
        }
        return throwError(() => error);
      }),
    );
  }

  getBonds(page = 1, limit = 20): Observable<PaginatedResponse<Bond>> {
    return this.withProblemDetails(this.http.get<PaginatedResponse<Bond>>('/api/bonds', {
      params: { page, limit },
      headers: this.headers(),
    }));
  }

  getBond(id: number): Observable<Bond> {
    return this.withProblemDetails(this.http.get<Bond>(`/api/bonds/${id}`, { headers: this.headers() }));
  }

  getHeldBonds(address: string): Observable<HeldBond[]> {
    return this.withProblemDetails(this.http.get<HeldBond[]>(`/api/bonds/held/${address}`, {
      headers: this.headers(),
    }));
  }

  issueBond(data: CreateBondDto): Observable<Bond> {
    // `defer` keeps a missing-admin-secret failure on the observable's error
    // path rather than throwing synchronously at call time (#166).
    return this.withProblemDetails(defer(() => {
      const headers = this.headers(this.adminIntentHeader('issue_bond', 'global'));
      return this.http.post<Bond>('/api/bonds', data, { headers });
    }));
  }

  subscribeToBond(id: number, amount: number, idempotencyKey?: string): Observable<SubscriptionResponse> {
    const investorAddress = this.walletService.address();
    const headers = this.headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined);
    return this.withProblemDetails(this.http.post<SubscriptionResponse>(
      `/api/bonds/${id}/subscribe`,
      { amount, investorAddress },
      { headers },
    ));
  }

  claimCredits(id: number, idempotencyKey?: string): Observable<ClaimCreditsResponse> {
    const investorAddress = this.walletService.address();
    const headers = this.headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined);
    return this.withProblemDetails(this.http.post<ClaimCreditsResponse>(
      `/api/bonds/${id}/claim`,
      { investorAddress },
      { headers },
    ));
  }

  transferBond(id: number, toAddress: string, amount: number, idempotencyKey?: string): Observable<TransferResponse> {
    const fromAddress = this.walletService.address();
    const headers = this.headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined);
    return this.withProblemDetails(this.http.post<TransferResponse>(
      `/api/bonds/${id}/transfer`,
      { fromAddress, toAddress, amount },
      { headers },
    ));
  }

  getUndistributedTotal(id: number): Observable<UndistributedTotalResponse> {
    return this.withProblemDetails(this.http.get<UndistributedTotalResponse>(
      `/api/bonds/${id}/undistributed`,
      { headers: this.headers() },
    ));
  }

  /**
   * Itemized claimable-credit provenance for a holder (#156). `address` is
   * optional: when omitted the API resolves the caller's wallet address, so the
   * connected wallet gets its own itemized breakdown. Amounts are raw minor-unit
   * strings (#157) and should be rendered with `formatCreditMinorUnits`.
   */
  getClaimableCredits(
    id: number,
    address?: string,
  ): Observable<ClaimableCreditsResponse> {
    const params = address ? new HttpParams().set('address', address) : undefined;
    return this.withProblemDetails(
      this.http.get<ClaimableCreditsResponse>(`/api/bonds/${id}/claimable-credits`, {
        params,
        headers: this.headers(),
      }),
    );
  }

  sweepUndistributed(id: number): Observable<SweepUndistributedResponse> {
    return this.withProblemDetails(defer(() => {
      const headers = this.headers(this.adminIntentHeader('sweep_undistributed', String(id)));
      return this.http.post<SweepUndistributedResponse>(
        `/api/bonds/${id}/sweep-undistributed`,
        {},
        { headers },
      );
    }));
  }

  distributeCoupon(id: number, dto: { periodIndex: number }): Observable<CouponDistributionResponse> {
    return this.withProblemDetails(defer(() => {
      const headers = this.headers(this.adminIntentHeader('distribute_coupon', String(id)));
      return this.http.post<CouponDistributionResponse>(
        `/api/bonds/${id}/coupon`,
        dto,
        { headers },
      );
    }));
  }

  mature(id: number): Observable<BondResponse> {
    return this.withProblemDetails(defer(() => {
      const headers = this.headers(this.adminIntentHeader('mature_bond', String(id)));
      return this.http.post<BondResponse>(
        `/api/bonds/${id}/mature`,
        {},
        { headers },
      );
    }));
  }

  reconcileHolders(id: number): Observable<HolderListResponse> {
    return this.withProblemDetails(defer(() => {
      const headers = this.headers(this.adminIntentHeader('reconcile_holders', String(id)));
      return this.http.post<HolderListResponse>(
        `/api/bonds/${id}/reconcile-holders`,
        {},
        { headers },
      );
    }));
  }

  previewSubscribe(id: number, amount: number): Observable<{remaining_supply: number; requested_amount: number; expected_failure: string | null}> {
    return this.withProblemDetails(this.http.get<{
      remaining_supply: number;
      requested_amount: number;
      expected_failure: string | null;
    }>(`/api/bonds/${id}/preview-subscribe?amount=${amount}`, {
      headers: this.headers(),
    }));
  }

  approveProject(id: number): Observable<Project> {
    return this.withProblemDetails(defer(() => {
      const headers = this.headers(this.adminIntentHeader('approve_project', String(id)));
      return this.http.post<Project>(
        `/api/projects/${id}/approve`,
        {},
        { headers },
      );
    }));
  }

  rejectProject(id: number): Observable<Project> {
    return this.withProblemDetails(defer(() => {
      const headers = this.headers(this.adminIntentHeader('reject_project', String(id)));
      return this.http.post<Project>(
        `/api/projects/${id}/reject`,
        {},
        { headers },
      );
    }));
  }

  getProjects(page = 1, limit = 20): Observable<PaginatedResponse<Project>> {
    return this.withProblemDetails(this.http.get<PaginatedResponse<Project>>('/api/projects', {
      params: { page, limit },
    }));
  }

  getProject(id: number): Observable<Project> {
    return this.withProblemDetails(this.http.get<Project>(`/api/projects/${id}`));
  }

  getProjectProvenance(id: number): Observable<ProjectProvenance> {
    return this.withProblemDetails(this.http.get<ProjectProvenance>(`/api/projects/${id}/provenance`));
  }

  registerProject(data: CreateProjectDto): Observable<Project> {
    return this.withProblemDetails(this.http.post<Project>('/api/projects', data, { headers: this.headers() }));
  }

  getOrders(params: OrderQueryParams = {}, refresh = false): Observable<PaginatedResponse<Order>> {
    let queryParams = new HttpParams();
    if (params.bondId !== undefined) queryParams = queryParams.set('bondId', params.bondId);
    if (params.status !== undefined) queryParams = queryParams.set('status', params.status);
    if (params.page !== undefined) queryParams = queryParams.set('page', params.page);
    if (params.limit !== undefined) queryParams = queryParams.set('limit', params.limit);
    // Bypass any client-side/proxy HTTP caching so a refresh always hits the server.
    if (refresh) queryParams = queryParams.set('_t', Date.now());
    return this.withProblemDetails(this.http.get<PaginatedResponse<Order>>('/api/marketplace/orders', {
      params: queryParams, headers: this.headers(),
    }));
  }

  getOrder(id: number): Observable<Order> {
    return this.withProblemDetails(this.http.get<Order>(`/api/marketplace/orders/${id}`, {
      params: new HttpParams().set('_t', Date.now()),
    }));
  }

  listBondTokens(data: ListBondDto, idempotencyKey?: string): Observable<Order> {
    const headers = this.headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined);
    return this.withProblemDetails(this.http.post<Order>('/api/marketplace/list', data, { headers }));
  }

  buyBondTokens(data: BuyBondDto, idempotencyKey?: string): Observable<void> {
    const headers = this.headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined);
    return this.withProblemDetails(this.http.post<void>('/api/marketplace/buy', data, { headers }));
  }

  cancelOrder(orderId: number): Observable<void> {
    return this.http.delete<void>(`/api/marketplace/orders/${orderId}`, { headers: this.headers() });
  }

  getQuoteBalance(asset: QuoteAsset = 'USDC'): Observable<QuoteBalanceResponse> {
    return this.withProblemDetails(this.http.get<QuoteBalanceResponse>('/api/marketplace/quote-balance', {
      params: { asset },
      headers: this.headers(),
    }));
  }

  getWalletBalance(asset: QuoteAsset = 'USDC'): Observable<QuoteBalanceResponse> {
    return this.withProblemDetails(this.http.get<QuoteBalanceResponse>('/api/marketplace/wallet-balance', {
      params: { asset },
      headers: this.headers(),
    }));
  }

  depositQuote(data: DepositQuoteDto, idempotencyKey?: string): Observable<QuoteTransactionResponse> {
    const headers = this.headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined);
    return this.withProblemDetails(this.http.post<QuoteTransactionResponse>('/api/marketplace/deposit', data, { headers }));
  }

  withdrawQuote(data: WithdrawQuoteDto, idempotencyKey?: string): Observable<QuoteTransactionResponse> {
    const headers = this.headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined);
    return this.withProblemDetails(this.http.post<QuoteTransactionResponse>('/api/marketplace/withdraw', data, { headers }));
  }

  getPortfolio(address?: string, force = false): Observable<any> {
    let params = new HttpParams();
    if (address) params = params.set('address', address);
    if (force) params = params.set('force', 'true');
    return this.withProblemDetails(this.http.get<any>('/api/portfolio', {
      params,
      headers: this.headers(),
    }));
  }

  /** Challenge review (#oracle-challenge): challenged reports for a project. */
  getProjectChallengedReports(projectId: string): Observable<ChallengedReportSummary[]> {
    return this.withProblemDetails(
      this.http.get<ChallengedReportSummary[]>(`/api/oracle/reports/${projectId}/challenges`),
    );
  }

  /** Challenge review (#oracle-challenge): full challenge state + history for a report. */
  getReportChallengeState(reportId: number): Observable<ChallengeStateResponse> {
    return this.withProblemDetails(
      this.http.get<ChallengeStateResponse>(`/api/oracle/challenges/${reportId}`),
    );
  }

  /** Coupon-distribution eligibility for a project, gated by challenge state. */
  getCouponEligibility(projectId: string): Observable<CouponEligibility> {
    return this.withProblemDetails(
      this.http.get<CouponEligibility>(`/api/oracle/projects/${projectId}/coupon-eligibility`),
    );
  }

  /**
   * Atomically refresh every panel of a bond's detail (issue #4). `_t` busts any
   * HTTP cache so the client sees fresh post-mutation data; the response carries
   * a server `loadedAt` timestamp the client uses for staleness detection.
   */
  getBondDetail(id: number, opts?: { bustCache?: boolean }): Observable<BondDetailResponse> {
    const params = opts?.bustCache === false ? undefined : new HttpParams().set('_t', Date.now().toString());
    return this.withProblemDetails(
      this.http.get<BondDetailResponse>(`/api/bonds/${id}/detail`, { params }),
    );
  }
}
