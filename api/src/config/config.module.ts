import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { FeatureFlagsService } from './feature-flags.service';

@Global()
@Module({
  providers: [ConfigService, FeatureFlagsService],
  exports: [ConfigService, FeatureFlagsService],
})
export class ConfigModule {}
