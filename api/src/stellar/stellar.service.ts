import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import {
  Horizon,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

@Injectable()
export class StellarService {
  private horizon: Horizon.Server;
  private networkPassphrase: string;
  private accountCache: Map<string, CacheEntry<Horizon.AccountResponse>> = new Map();
  private readonly CACHE_TTL_MS = 30_000;

  constructor() {
    this.horizon = new Horizon.Server(
      process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    );
    this.networkPassphrase = process.env.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
  }

  async getAccount(publicKey: string): Promise<Horizon.AccountResponse> {
    const cached = this.accountCache.get(publicKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
    try {
      const account = await this.horizon.loadAccount(publicKey);
      this.accountCache.set(publicKey, {
        data: account,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });
      return account;
    } catch (error) {
      throw new HttpException(
        `Failed to load account ${publicKey}: ${error.message}`,
        HttpStatus.NOT_FOUND,
      );
    }
  }

  async getBalance(publicKey: string, assetCode?: string, assetIssuer?: string): Promise<string> {
    const account = await this.getAccount(publicKey);
    
    if (!assetCode || assetCode === 'XLM' || assetCode === 'native') {
      const native = account.balances.find((b) => b.asset_type === 'native');
      return native?.balance ?? '0';
    }

    const match = account.balances.find((b) => {
      if (b.asset_type === 'native') return false;
      
      const bcode = (b as any).asset_code;
      const bissuer = (b as any).asset_issuer;
      
      const codeMatch = bcode === assetCode;
      if (assetIssuer) return codeMatch && bissuer === assetIssuer;
      return codeMatch;
    });

    return match?.balance ?? '0';
  }

  async getBalances(publicKey: string): Promise<Horizon.HorizonApi.BalanceLine[]> {
    const account = await this.getAccount(publicKey);
    return account.balances;
  }

  async submitTransaction(
    txEnvelope: string,
  ): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
    try {
      const transaction = TransactionBuilder.fromXDR(txEnvelope, 'base64');
      return await this.horizon.submitTransaction(transaction);
    } catch (error) {
      throw new HttpException(
        `Transaction submission failed: ${error.message}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  streamPayments(
    publicKey: string,
    onPayment: (payment: Horizon.ServerApi.PaymentOperationRecord) => void,
    cursor?: string,
  ): () => void {
    const builder = this.horizon
      .payments()
      .forAccount(publicKey);

    if (cursor) {
      builder.cursor(cursor);
    }

    return builder.stream({
      onmessage: (value) => {
        onPayment(value as unknown as Horizon.ServerApi.PaymentOperationRecord);
      },
    });
  }

  getKeypairFromSecret(secretKey: string): Keypair {
    return Keypair.fromSecret(secretKey);
  }

  generateKeypair(): { publicKey: string; secretKey: string } {
    const keypair = Keypair.random();
    return {
      publicKey: keypair.publicKey(),
      secretKey: keypair.secret(),
    };
  }

  isValidPublicKey(address: string): boolean {
    return StrKey.isValidEd25519PublicKey(address);
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  async accountExists(publicKey: string): Promise<boolean> {
    try {
      await this.getAccount(publicKey);
      return true;
    } catch {
      return false;
    }
  }
}
