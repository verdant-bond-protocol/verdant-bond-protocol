import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ContractService } from '../stellar/contract.service';
import { ContractException } from '../stellar/contract-errors';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ListBondDto } from './dto/list-bond.dto';
import { BuyBondDto } from './dto/buy-bond.dto';
import { DepositQuoteDto } from './dto/deposit-quote.dto';
import { WithdrawQuoteDto } from './dto/withdraw-quote.dto';
import {
  OrderResponse,
  OrderStatus,
  QuoteAsset,
  QuoteBalanceResponse,
  QuoteTransactionResponse,
} from './interfaces/marketplace.interface';
import { nativeToScVal, scValToNative, Address } from '@stellar/stellar-sdk';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import { toBigIntString } from '../common/utils';
import { ConfigService } from '../config/config.service';
import { normalizeQuoteAssetSymbol } from './quote-assets';



const DEX_ERROR_CODE = {
  NotInitialized: 1,
  Unauthorized: 2,
  InvalidNonce: 3,
  OrderNotFound: 4,
  OrderAlreadyFilled: 5,
  InsufficientBalance: 6,
  SelfBuyNotAllowed: 7,
  OrderExpired: 8,
  ZeroAmount: 9,
  InsufficientFunds: 10,
  Overflow: 11,
} as const;

@Injectable()
export class DexService {
  constructor(
    private readonly contractService: ContractService,
    private readonly stellarService: StellarService,
    private readonly nonceService: NonceService,
    private readonly redis: RedisService,
    private readonly signingKeys: SigningKeyProvider,
    private readonly configService: ConfigService,
  ) {}

  async listOrders(
    bondId?: number,
    status?: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<OrderResponse>> {
    const cacheKey = `orders:${bondId || 'all'}:${status || 'all'}:${page}:${limit}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const total = await this.getOrderCount();
    const ids = Array.from({ length: total }, (_unused, idx) => idx + 1);
    const matchingOrders = (await Promise.all(ids.map((id) => this.tryGetOrder(id))))
      .filter((order): order is OrderResponse => Boolean(order))
      .filter((order) => !bondId || order.bondId === bondId)
      .filter((order) => !status || order.status === status);
    const start = (page - 1) * limit;
    const paged = matchingOrders.slice(start, start + limit);

    const result = {
      data: paged,
      meta: {
        page,
        limit,
        total: matchingOrders.length,
        totalPages: Math.ceil(matchingOrders.length / limit) || 1,
      },
    };

    await this.redis.cacheSet(cacheKey, 30, JSON.stringify(result), ['orders']);
    return result;
  }

  async listBondTokens(dto: ListBondDto, sellerAddress: string): Promise<OrderResponse> {
    const adminSecret = this.getAdminSecret();

    const { result, transactionHash } = await this.contractService.invokeContractMethod(
      this.configService.getDexRouterAddress(), 'list_bond_tokens', adminSecret,
      [
        Address.fromString(sellerAddress).toScVal(),
        nativeToScVal(BigInt(dto.bondId), { type: 'u64' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
        nativeToScVal(BigInt(dto.pricePerToken), { type: 'i128' }),
        nativeToScVal(dto.quoteAsset, { type: 'symbol' }),
        nativeToScVal(BigInt(dto.expiresAfterSeconds || 604800), { type: 'u64' }),
      ],
      sellerAddress,
    );

    const orderId = Number(scValToNative(result));
    await this.redis.invalidateTag('orders');
    await this.redis.invalidateTag('prices');
    await this.redis.delPattern(`orders:*`);
    await this.redis.del(`order:${orderId}`);
    await this.redis.del(`portfolio:${sellerAddress}`).catch(() => undefined);
    return { ...(await this.getOrder(orderId)), transactionHash };
  }

  /**
   * Reconciliation (#91): the order is re-fetched directly from the ledger
   * (bypassing the read cache in `getOrder`) immediately before computing
   * proceeds, so a buy is evaluated against the order's true current state
   * rather than a copy that may be up to 60s stale. `assertOrderIsActionable`
   * then rejects a no-longer-open order with a clear, typed error before any
   * contract call is attempted.
   */
  async buyBondTokens(dto: BuyBondDto, buyerAddress: string): Promise<OrderResponse> {
    const order = await this.fetchOrderFromLedger(dto.orderId);
    this.assertOrderIsActionable(order);
    if (BigInt(dto.amount) > BigInt(order.amount)) {
      throw new ConflictException(
        `Stale quote: requested ${dto.amount} tokens but only ${order.amount} remain. Refresh and review the updated quote.`,
      );
    }
    if (BigInt(dto.maxPrice) < BigInt(order.pricePerToken)) {
      throw new ConflictException(
        `Stale price: current price ${order.pricePerToken} exceeds your maximum ${dto.maxPrice}. Refresh and approve a new maximum.`,
      );
    }
    const proceeds = BigInt(order.pricePerToken) * BigInt(dto.amount);

    const escrowed = await this.getQuoteBalance(buyerAddress, order.quoteAsset);
    if (BigInt(escrowed.balance) < proceeds) {
      throw new BadRequestException(
        `Insufficient escrowed ${order.quoteAsset}: required ${proceeds}, escrowed ${escrowed.balance}. ` +
        'Call POST /marketplace/escrow/deposit before purchasing.',
      );
    }

    const adminSecret = this.getAdminSecret();

    let transactionHash: string | undefined;
    try {
      ({ transactionHash } = await this.contractService.invokeContractMethod(
        this.configService.getDexRouterAddress(), 'execute_purchase', adminSecret,
        [
          Address.fromString(buyerAddress).toScVal(),
          nativeToScVal(BigInt(dto.orderId), { type: 'u64' }),
          nativeToScVal(BigInt(dto.maxPrice), { type: 'i128' }),
          nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
        ],
        buyerAddress,
      ));
    } catch (error) {
      throw this.mapDexError(error);
    }

    await this.redis.invalidateTag('orders');
    await this.redis.invalidateTag('prices');
    await this.redis.delPattern(`orders:*`);
    await this.redis.del(`order:${dto.orderId}`);
    await this.redis.del(`portfolio:${buyerAddress}`).catch(() => undefined);
    return { ...(await this.getOrder(dto.orderId)), transactionHash };
  }

  /**
   * Reconciliation (#91): same fresh-fetch-then-assert guard as
   * `buyBondTokens`, applied before `cancel_listing`. The contract invocation
   * is now also wrapped in `mapDexError` (previously unmapped), so a
   * contract-level rejection in the narrow race window between this check
   * and the on-chain call (e.g. the order was just filled) still surfaces as
   * a clean, typed error instead of a raw, unmapped exception.
   */
  async cancelOrder(orderId: number, callerAddress: string): Promise<void> {
    const order = await this.fetchOrderFromLedger(orderId);
    this.assertOrderIsActionable(order);

    const adminSecret = this.getAdminSecret();

    try {
      await this.contractService.invokeContractMethod(
        this.configService.getDexRouterAddress(), 'cancel_listing', adminSecret,
        [
          Address.fromString(callerAddress).toScVal(),
          nativeToScVal(BigInt(orderId), { type: 'u64' }),
        ],
        callerAddress,
      );
    } catch (error) {
      throw this.mapDexError(error);
    }

    await this.redis.invalidateTag('orders');
    await this.redis.invalidateTag('prices');
    await this.redis.delPattern(`orders:*`);
    await this.redis.del(`order:${orderId}`);
    await this.redis.del(`portfolio:${callerAddress}`).catch(() => undefined);
  }

  async getOrder(orderId: number): Promise<OrderResponse> {
    const cacheKey = `order:${orderId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const order = await this.fetchOrderFromLedger(orderId);

    await this.redis.setEx(cacheKey, 60, JSON.stringify(order));
    return order;
  }

  /** Reads the order directly from the ledger, bypassing the Redis cache entirely. */
  async fetchOrderFromLedger(orderId: number): Promise<OrderResponse> {
    const orderScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getDexRouterAddress(),
      method: 'get_order',
      args: [nativeToScVal(BigInt(orderId), { type: 'u64' })],
    });
    return this.decodeOrder(scValToNative(orderScVal) as any[]);
  }

  /**
   * Rejects an order that is not currently open for buy/cancel, with a clear
   * message identifying its actual state (#91).
   */
  private assertOrderIsActionable(order: OrderResponse): void {
    if (order.status !== OrderStatus.Open && order.status !== OrderStatus.PartiallyFilled) {
      throw new ConflictException(
        `Order ${order.id} is no longer available (status: ${order.status}). Refresh to see the latest order list.`,
      );
    }
  }

  async getQuoteBalance(
    address: string,
    asset: QuoteAsset = 'USDC',
  ): Promise<QuoteBalanceResponse> {
    // Callers that reach here without going through a DTO's @IsQuoteAssetSymbol
    // (e.g. the default above, or an internal caller) still get the same
    // registry check + canonical casing before we build the contract call.
    const normalizedAsset = normalizeQuoteAssetSymbol(asset);

    const balanceScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getDexRouterAddress(),
      method: 'get_quote_balance',
      args: [
        Address.fromString(address).toScVal(),
        nativeToScVal(normalizedAsset, { type: 'symbol' }),
      ],
    });
    const balance = toBigIntString(scValToNative(balanceScVal));
    return { address, asset: normalizedAsset, balance };
  }

  async depositQuote(
    dto: DepositQuoteDto,
    callerAddress: string,
  ): Promise<QuoteTransactionResponse> {
    const adminSecret = this.getAdminSecret();

    const { transactionHash } = await this.contractService.invokeContractMethod(
      this.configService.getDexRouterAddress(), 'deposit_quote', adminSecret,
      [
        Address.fromString(callerAddress).toScVal(),
        nativeToScVal(dto.asset, { type: 'symbol' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
      ],
      callerAddress,
    );

    await this.redis.del(`portfolio:${callerAddress}`).catch(() => undefined);
    await this.invalidateQuoteBalanceIndex(callerAddress, dto.asset);

    return { address: callerAddress, asset: dto.asset, amount: dto.amount, transactionHash };
  }

  async withdrawQuote(
    dto: WithdrawQuoteDto,
    callerAddress: string,
  ): Promise<QuoteTransactionResponse> {
    const adminSecret = this.getAdminSecret();

    const { transactionHash } = await this.contractService.invokeContractMethod(
      this.configService.getDexRouterAddress(), 'withdraw_quote', adminSecret,
      [
        Address.fromString(callerAddress).toScVal(),
        nativeToScVal(dto.asset, { type: 'symbol' }),
        nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
      ],
      callerAddress,
    );

    await this.redis.del(`portfolio:${callerAddress}`).catch(() => undefined);
    await this.invalidateQuoteBalanceIndex(callerAddress, dto.asset);

    return { address: callerAddress, asset: dto.asset, amount: dto.amount, transactionHash };
  }

  private quoteBalanceIndexKey(address: string, asset: QuoteAsset): string {
    return `quote:balance:${address}:${asset}`;
  }

  /**
   * Reconciliation (#recon): the API/indexed view of a wallet's escrowed quote
   * balance. The reconciliation job compares this against the on-chain
   * `get_quote_balance` value. Deposit/withdraw keep it fresh by evicting it;
   * a missed eviction is exactly what reconciliation surfaces as a balance
   * mismatch (a "stale cache" divergence).
   */
  async getIndexedQuoteBalance(address: string, asset: QuoteAsset): Promise<string | null> {
    return this.redis.get(this.quoteBalanceIndexKey(address, asset));
  }

  async setIndexedQuoteBalance(address: string, asset: QuoteAsset, balance: string): Promise<void> {
    await this.redis.setEx(this.quoteBalanceIndexKey(address, asset), 86_400, balance);
  }

  private async invalidateQuoteBalanceIndex(address: string, assetSymbol: string): Promise<void> {
    const asset = normalizeQuoteAssetSymbol(assetSymbol);
    await this.redis.del(this.quoteBalanceIndexKey(address, asset));
  }

  private decodeOrder(data: any[]): OrderResponse {
    const rawStatus = this.orderStatusFromIndex(Number(data[6]));
    const expiresAtSeconds = Number(data[8]);
    return {
      id: Number(data[0]),
      seller: data[1] as string,
      bondId: Number(data[2]),
      amount: toBigIntString(data[3]),
      pricePerToken: toBigIntString(data[4]),
      quoteAsset: data[5] as QuoteAsset,
      status: this.deriveEffectiveStatus(rawStatus, expiresAtSeconds),
      createdAt: new Date(Number(data[7]) * 1000).toISOString(),
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    };
  }

  private orderStatusFromIndex(index: number): OrderStatus {
    return (
      [
        OrderStatus.Open,
        OrderStatus.PartiallyFilled,
        OrderStatus.Filled,
        OrderStatus.Cancelled,
        OrderStatus.Expired,
      ][index] ?? OrderStatus.Open
    );
  }

  /**
   * Reconciliation (#91): the contract's own persisted `status` only becomes
   * `Expired` once the batched `clean_expired_orders` admin sweep (hourly,
   * see `dex.scheduler.ts`) has visited that order id -- it does not update
   * lazily on read. `expires_at` (a ledger-timestamp, i.e. Unix epoch
   * seconds -- see Stellar's Soroban `Env::ledger().timestamp()` docs) is
   * always current on every read, so deriving the effective status from it
   * here means every API response reflects true expiry immediately, instead
   * of for up to an hour after the deadline passes. Mirrors the contract's
   * own `is_order_expired` check (`ledger_timestamp >= expires_at`) against
   * server wall-clock time. O(1).
   */
  private deriveEffectiveStatus(rawStatus: OrderStatus, expiresAtSeconds: number): OrderStatus {
    const isOpenState = rawStatus === OrderStatus.Open || rawStatus === OrderStatus.PartiallyFilled;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return isOpenState && nowSeconds >= expiresAtSeconds ? OrderStatus.Expired : rawStatus;
  }

  private getAdminSecret(): string {
    return this.signingKeys.adminSecret();
  }

  /**
   * Invoke one bounded `clean_expired_orders` pass.
   * Pass `startId` from the previous result's `nextStartId` (or `1` / `0` to begin).
   * When `nextStartId` is `0`, the scan has reached `order_count`.
   */
  async cleanExpiredOrders(
    startId = 1,
    limit = 50,
  ): Promise<{ cleaned: number; nextStartId: number }> {
    const adminSecret = this.getAdminSecret();
    const adminAddress = this.stellarService
      .getKeypairFromSecret(adminSecret)
      .publicKey();

    const { result } = await this.contractService.invokeContractMethod(
      this.configService.getDexRouterAddress(),
      'clean_expired_orders',
      adminSecret,
      [
        Address.fromString(adminAddress).toScVal(),
        nativeToScVal(BigInt(startId), { type: 'u64' }),
        nativeToScVal(limit, { type: 'u32' }),
      ],
      adminAddress,
    );

    const decoded = scValToNative(result) as { cleaned?: number; next_start_id?: number } | unknown[];
    if (Array.isArray(decoded)) {
      return {
        cleaned: Number(decoded[0]),
        nextStartId: Number(decoded[1]),
      };
    }
    return {
      cleaned: Number((decoded as any).cleaned ?? 0),
      nextStartId: Number((decoded as any).next_start_id ?? 0),
    };
  }

  async getOrderCount(): Promise<number> {
    const countScVal = await this.contractService.simulateCall({
      contractAddress: this.configService.getDexRouterAddress(),
      method: 'order_count',
      args: [],
    });
    return Number(scValToNative(countScVal));
  }

  private async tryGetOrder(id: number): Promise<OrderResponse | null> {
    try {
      const orderScVal = await this.contractService.simulateCall({
        contractAddress: this.configService.getDexRouterAddress(),
        method: 'get_order',
        args: [nativeToScVal(BigInt(id), { type: 'u64' })],
      });
      return this.decodeOrder(scValToNative(orderScVal) as any[]);
    } catch {
      return null;
    }
  }

  private mapDexError(error: unknown): Error {
    if (error instanceof ContractException) {
      const code = error.rawErrorCode as number | undefined;
      if (code === DEX_ERROR_CODE.InsufficientFunds) {
        return new HttpException(
          'Insufficient escrowed funds. Call POST /marketplace/escrow/deposit before purchasing.',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      return new BadRequestException(error.detail || String(error.message));
    }

    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/#(\d+)/) ?? message.match(/Error\(-(\d+)/);
    const code = match ? Number(match[1]) : undefined;

    if (code === DEX_ERROR_CODE.InsufficientFunds) {
      return new HttpException(
        'Insufficient escrowed funds. Call POST /marketplace/escrow/deposit before purchasing.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // Reconciliation (#91): the pre-flight fetch in buyBondTokens/cancelOrder
    // narrows this to a rare race (the order changed state in the moment
    // between that check and this on-chain call), but it can still happen --
    // map it to the same clear, typed conflict rather than a raw contract error.
    if (code === DEX_ERROR_CODE.OrderAlreadyFilled || code === DEX_ERROR_CODE.OrderExpired) {
      return new ConflictException(
        'Order state changed on-chain before this action completed. Refresh to see the latest order list.',
      );
    }

    if (code === DEX_ERROR_CODE.OrderNotFound) {
      return new NotFoundException('Order not found.');
    }

    if (error instanceof HttpException) {
      return error;
    }

    return new BadRequestException(message);
  }
}
