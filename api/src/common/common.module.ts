import { Global, Module } from '@nestjs/common';
import { NonceService } from './services/nonce.service';
import { RedisService } from './services/redis.service';
import { SigningKeyProvider } from './services/signing-key.provider';
import { KycStoreService } from './services/kyc-store.service';
import { RedisHealthController } from './redis-health.controller';
import { ConfigService } from '../config/config.service';
import { HolderIndexService } from '../bonds/holder-index.service';
import { IntentService } from './services/intent.service';
import { IntentGuard } from './guards/intent.guard';
import { IdempotencyService } from './services/idempotency.service';
import { TelemetryService } from './services/telemetry.service';
import { TelemetryInterceptor } from './interceptors/telemetry.interceptor';

@Global()
@Module({
  controllers: [RedisHealthController],
  providers: [NonceService, RedisService, SigningKeyProvider, ConfigService, KycStoreService, HolderIndexService, IntentService, IntentGuard, IdempotencyService, TelemetryService, TelemetryInterceptor],
  exports: [NonceService, RedisService, SigningKeyProvider, ConfigService, KycStoreService, HolderIndexService, IntentService, IntentGuard, IdempotencyService, TelemetryService, TelemetryInterceptor],
})
export class CommonModule {}
