import { Controller, Post, Get, Param, Body, UseGuards, Delete, Req } from '@nestjs/common';
import { Request } from 'express';
import { ImpersonationService } from './impersonation.service';
import { ImpersonationSession } from './impersonation.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

/**
 * Impersonation API (issue #264).
 *
 * Session start, end and audit are admin-only, matching `AdminGuard` (the
 * admin principal is `STELLAR_PUBLIC_KEY`). The visible indicator route
 * (`/indicators/:targetAddress`) stays JWT-authenticated for any signed-in
 * principal: an indicator that the impersonated user cannot see is not an
 * indicator.
 */
@Controller('api/v1/impersonation')
@UseGuards(JwtAuthGuard)
export class ImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @Post('sessions')
  @UseGuards(AdminGuard)
  async start(
    @Req() req: Request,
    @Body()
    body: {
      targetAddress: string;
      reason: string;
      allowedOperations: string[];
      allowDangerousMutations?: boolean;
      ttlSeconds?: number;
    },
  ): Promise<ImpersonationSession> {
    return this.impersonation.start({
      // AdminGuard has already established the caller is the admin principal;
      // the address is taken from the authenticated request, never from the
      // body, so a caller cannot impersonate "as" someone else.
      maintainerAddress: req.user?.walletAddress,
      targetAddress: body.targetAddress,
      scope: {
        allowedOperations: body.allowedOperations ?? [],
        allowDangerousMutations: body.allowDangerousMutations,
      },
      reason: body.reason,
      ttlSeconds: body.ttlSeconds,
    });
  }

  @Delete('sessions/:sessionId')
  @UseGuards(AdminGuard)
  async end(
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
  ): Promise<{ ended: boolean }> {
    const ended = await this.impersonation.end(sessionId, req.user?.walletAddress);
    return { ended };
  }

  @Get('sessions/:sessionId')
  async session(@Param('sessionId') sessionId: string) {
    return this.impersonation.getSession(sessionId);
  }

  /** Visible indicator: active impersonations of one user. */
  @Get('indicators/:targetAddress')
  async indicators(@Param('targetAddress') targetAddress: string) {
    return this.impersonation.getSessionsForTarget(targetAddress);
  }

  @Get('audit')
  @UseGuards(AdminGuard)
  async audit() {
    return this.impersonation.getAuditTrail();
  }
}
