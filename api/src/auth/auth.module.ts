import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { KycService } from './kyc.service';
import { KycGuard } from '../common/guards/kyc.guard';
import { ConfigService } from '../config/config.service';
import { InvestorEligibilityCacheService } from './investor-eligibility-cache.service';

import { RbacService } from './rbac.service';

@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: (config: ConfigService) => ({
        secret: config.getJwtSecret(),
        signOptions: { expiresIn: config.getJwtExpiry() },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, KycService, KycGuard, RbacService, InvestorEligibilityCacheService],
  exports: [AuthService, KycService, KycGuard, RbacService, InvestorEligibilityCacheService],
})
export class AuthModule {}
