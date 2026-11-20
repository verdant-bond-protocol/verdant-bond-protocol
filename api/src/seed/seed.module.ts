import { Global, Module } from '@nestjs/common';
import { SeedService } from './seed.service';

@Global()
@Module({
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
