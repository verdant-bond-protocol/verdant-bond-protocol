import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { EnvConfigValidator } from '../common/config/env-config.validator';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureFlagsRollbackService } from './feature-flags-rollback.service';

@Global()
@Module({
  providers: [ConfigService, EnvConfigValidator, FeatureFlagsService, FeatureFlagsRollbackService],
  exports: [ConfigService, EnvConfigValidator, FeatureFlagsService, FeatureFlagsRollbackService],
})
export class ConfigModule {}
