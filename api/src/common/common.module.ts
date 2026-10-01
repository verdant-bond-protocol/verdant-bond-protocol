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
import { SearchIndexService } from './search/search-index.service';
import { EnvConfigValidator } from './config/env-config.validator';
import { TelemetryService } from './services/telemetry.service';
import { TelemetryInterceptor } from './interceptors/telemetry.interceptor';
import { QuotaService } from './services/quota.service';
import { QuotaGuard } from './guards/quota.guard';
import { StellarModule } from '../stellar/stellar.module';
import { QuotaController } from './quota.controller';

@Global()
@Module({
  imports: [StellarModule],
  controllers: [RedisHealthController, QuotaController],
  providers: [
    NonceService, RedisService, SigningKeyProvider, ConfigService, KycStoreService,
    HolderIndexService, IntentService, IntentGuard, IdempotencyService,
    SearchIndexService, EnvConfigValidator, TelemetryService, TelemetryInterceptor,
    QuotaService, QuotaGuard
  ],
  exports: [
    NonceService, RedisService, SigningKeyProvider, ConfigService, KycStoreService,
    HolderIndexService, IntentService, IntentGuard, IdempotencyService,
    SearchIndexService, EnvConfigValidator, TelemetryService, TelemetryInterceptor,
    QuotaService, QuotaGuard
  ],
})
export class CommonModule {}
