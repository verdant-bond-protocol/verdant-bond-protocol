import { Module } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [ConfigModule],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
