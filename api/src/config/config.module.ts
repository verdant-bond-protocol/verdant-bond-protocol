import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { EnvConfigValidator } from '../common/config/env-config.validator';
import { FeatureFlagsService } from './feature-flags.service';
import { EnvConfigValidator } from '../common/config/env-config.validator';

@Global()
@Module({
  providers: [ConfigService, EnvConfigValidator, FeatureFlagsService],
  exports: [ConfigService, EnvConfigValidator, FeatureFlagsService],
})
export class ConfigModule {}
