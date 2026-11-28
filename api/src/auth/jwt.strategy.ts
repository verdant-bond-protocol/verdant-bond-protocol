import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser, KycStatus } from '../common/interfaces/authenticated-request.interface';
import { ConfigService } from '../config/config.service';
import { SessionService } from './session.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private readonly sessions: SessionService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getJwtSecret(),
    });
  }

  async validate(payload: {
    sub: string;
    kycStatus: string;
    roles?: string[];
    permissions?: string[];
    sv?: number;
    jti?: string;
  }): Promise<AuthenticatedUser> {
    // Signature and exp are already verified by passport-jwt. Revocation and
    // session staleness are checked here so every guarded route is covered.
    await this.sessions.assertActive({ sub: payload.sub, sv: payload.sv, jti: payload.jti });
    return {
      walletAddress: payload.sub,
      kycStatus: payload.kycStatus as KycStatus,
      roles: payload.roles || [],
      permissions: payload.permissions || [],
      sessionId: payload.jti,
      sessionVersion: payload.sv ?? 0,
    };
  }
}
