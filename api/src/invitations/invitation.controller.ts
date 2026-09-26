import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InvitationService } from './invitation.service';
import { Invitation } from './invitation.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

/**
 * Invitation & collaboration API (issue #265).
 *
 * All routes require wallet authentication. The authenticated wallet is the
 * actor: creation invites from that wallet, acceptance is limited to the
 * invited wallet, and revocation to the inviter or a higher role. The granted
 * role is always the one fixed server-side at creation, so a client cannot
 * escalate by posting a different role.
 */
@Controller('api/v1/invitations')
@UseGuards(JwtAuthGuard)
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @Post()
  create(
    @Req() req: { user: { walletAddress: string } },
    @Body()
    body: {
      scope: string;
      inviteeAddress: string;
      role: Invitation['role'];
      ttlMs?: number;
    },
  ): Invitation {
    return this.invitations.create({
      scope: body.scope,
      inviterAddress: req.user.walletAddress,
      inviteeAddress: body.inviteeAddress,
      role: body.role,
      ttlMs: body.ttlMs,
    });
  }

  @Post(':id/accept')
  accept(
    @Param('id') id: string,
    @Req() req: { user: { walletAddress: string } },
  ): Invitation {
    return this.invitations.accept(id, req.user.walletAddress);
  }

  @Post(':id/revoke')
  revoke(
    @Param('id') id: string,
    @Req() req: { user: { walletAddress: string } },
  ): Invitation {
    return this.invitations.revoke(id, req.user.walletAddress);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @Req() req: { user: { walletAddress: string } },
  ): Invitation {
    return this.invitations.get(id);
  }

  @Get()
  list(@Req() req: { user: { walletAddress: string } }): Invitation[] {
    return this.invitations.list({ inviteeAddress: req.user.walletAddress });
  }
}
