import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { KycService } from '../../auth/kyc.service';
import { KycStatus, AuthenticatedUser } from '../interfaces/authenticated-request.interface';

@Injectable()
export class KycGuard implements CanActivate {
  constructor(private readonly kycService: KycService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const { eligible, record } = await this.kycService.isEligibleRecord(
      user.walletAddress,
      KycStatus.VERIFIED,
    );
    if (!eligible) {
      const status = record.status;
      if (status === KycStatus.EXPIRED) {
        throw new ForbiddenException('KYC verification has expired; please re-verify');
      }
      if (status === KycStatus.REJECTED) {
        throw new ForbiddenException('KYC verification was rejected');
      }
      throw new ForbiddenException('KYC verification required');
    }

    user.kycStatus = record.status;
    return true;
  }
}
