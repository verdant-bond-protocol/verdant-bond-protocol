import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { RedisService } from './services/redis.service';
import { ContractService } from '../stellar/contract.service';
import { ConfigService } from '../config/config.service';
import { StrKey } from '@stellar/stellar-sdk';

type ContractState = 'reachable' | 'unreachable' | 'misconfigured';

@Controller('health')
export class RedisHealthController {
  constructor(
    private readonly redis: RedisService,
    private readonly contracts: ContractService,
    private readonly config: ConfigService,
  ) {}

  @Get('redis')
  redisHealth() {
    return {
      redis: this.redis.isHealthy() ? 'up' : 'degraded',
    };
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async readiness() {
    const configured = [
      ['bondIssuer', this.config.getBondIssuerAddress()],
      ['couponEngine', this.config.getCouponEngineAddress()],
      ['dexRouter', this.config.getDexRouterAddress()],
      ['projectRegistry', this.config.getProjectRegistryAddress()],
      ['oracleConsumer', this.config.getOracleConsumerAddress()],
      ['creditRetirement', this.config.getCreditRetirementAddress()],
    ] as const;
    const details = Object.fromEntries(await Promise.all(
      configured.map(async ([name, address]) => [name, await this.probe(address)]),
    )) as Record<string, { status: ContractState; address: string; error?: string }>;
    const ready = this.redis.isHealthy()
      && Object.values(details).every((detail) => detail.status === 'reachable');
    return { status: ready ? 'ready' : 'degraded', redis: this.redis.isHealthy() ? 'up' : 'degraded', contracts: details };
  }

  private async probe(address: string): Promise<{ status: ContractState; address: string; error?: string }> {
    if (!address || !StrKey.isValidContract(address)) {
      return { status: 'misconfigured', address: address || '', error: 'Invalid Stellar contract address' };
    }
    try {
      await this.contracts.simulateCall({ contractAddress: address, method: 'get_admin', args: [] });
      return { status: 'reachable', address };
    } catch (error) {
      return {
        status: 'unreachable',
        address,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
