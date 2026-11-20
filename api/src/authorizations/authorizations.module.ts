import { Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { AuthorizationsController } from './authorizations.controller';

@Module({
  controllers: [AuthorizationsController],
  providers: [AuthorizationService],
  exports: [AuthorizationService],
})
export class AuthorizationsModule {}
