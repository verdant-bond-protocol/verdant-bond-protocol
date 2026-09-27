import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser, KycStatus } from '../common/interfaces/authenticated-request.interface';
import { ConfigService } from '../config/config.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getJwtSecret(),
    });
  }

  async validate(payload: { sub: string; kycStatus: string; roles?: string[]; permissions?: string[] }): Promise<AuthenticatedUser> {
    return {
      walletAddress: payload.sub,
      kycStatus: payload.kycStatus as KycStatus,
      roles: payload.roles || [],
      permissions: payload.permissions || [],
    };
  }
}
