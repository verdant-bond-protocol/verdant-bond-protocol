import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit.service';
import { AuditWrite } from '../classes/audit.classes';
import { AuditWriteResult, VerificationReport } from '../classes/audit.classes';
import { AuditRecord } from '../interfaces/audit.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

/**
 * Audit trail API (issue #260).
 *
 * Writes are authenticated (any logged-in principal may record a change it
 * performed); verification and history reads are admin-only, because a
 * verifier that is readable by everyone doubles as an oracle for "does this
 * entity have a history," and steady-state history dumps are large.
 */
@Controller('api/v1/audit')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Post('record')
  async record(@Body() body: AuditWrite): Promise<{ chainHead: string | null }> {
    const result = await this.audit.record(body);
    return { chainHead: result.record?.hash ?? null };
  }

  // Verification rebuilds hashes from stored content, so it is never itself
  // a mutation. Admin-gated because the report enumerates every checkable
  // entity id.
  @Get('verify/:entityType/:entityId')
  @UseGuards(AdminGuard)
  async verify(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ): Promise<VerificationReport> {
    return this.audit.verifyEntity(entityType, entityId);
  }

  @Get('history/:entityType/:entityId')
  @UseGuards(AdminGuard)
  async history(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ): Promise<AuditRecord[]> {
    return this.audit.getEntityHistory(entityType, entityId);
  }

  @Get('stats')
  async stats() {
    return this.audit.getStats();
  }
}
