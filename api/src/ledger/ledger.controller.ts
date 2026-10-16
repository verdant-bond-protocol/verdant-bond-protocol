import { BadRequestException, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EventLedgerService, LedgerStatus } from './event-ledger.service';
import {
  LEDGER_EVENT_TYPES,
  LedgerCategory,
  LedgerCheckpoint,
  LedgerEvent,
  LedgerEventType,
  LedgerExport,
  LedgerVerificationReport,
} from './ledger.types';

/**
 * Read-only, admin-only ledger API. There is no append route: events are
 * emitted server-side by the services performing the action.
 */
@Controller('api/v1/ledger')
@UseGuards(JwtAuthGuard, AdminGuard)
export class LedgerController {
  constructor(private readonly ledger: EventLedgerService) {}

  @Get('status')
  status(): LedgerStatus {
    return this.ledger.getStatus();
  }

  @Get('events')
  events(
    @Query('fromSequence') fromSequence?: string,
    @Query('limit') limit?: string,
    @Query('category') category?: string,
    @Query('type') type?: string,
    @Query('subjectType') subjectType?: string,
    @Query('subjectId') subjectId?: string,
  ): Promise<LedgerEvent[]> {
    if (category !== undefined && category !== 'privileged' && category !== 'financial') {
      throw new BadRequestException('category must be privileged or financial');
    }
    if (type !== undefined && !Object.prototype.hasOwnProperty.call(LEDGER_EVENT_TYPES, type)) {
      throw new BadRequestException(`unknown event type: ${type}`);
    }
    return this.ledger.query({
      fromSequence: optionalInt(fromSequence, 'fromSequence'),
      limit: optionalInt(limit, 'limit'),
      category: category as LedgerCategory | undefined,
      type: type as LedgerEventType | undefined,
      subjectType,
      subjectId,
    });
  }

  @Get('verify')
  verify(): Promise<LedgerVerificationReport> {
    return this.ledger.verify();
  }

  @Get('export')
  export(
    @Req() req: { user?: { walletAddress?: string } },
    @Query('fromSequence') fromSequence?: string,
    @Query('toSequence') toSequence?: string,
  ): Promise<LedgerExport> {
    return this.ledger.export({
      fromSequence: optionalInt(fromSequence, 'fromSequence'),
      toSequence: optionalInt(toSequence, 'toSequence'),
      exportedBy: req.user?.walletAddress ?? 'unknown',
    });
  }

  @Post('checkpoints')
  checkpoint(): Promise<LedgerCheckpoint> {
    return this.ledger.createCheckpoint();
  }
}

function optionalInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new BadRequestException(`${name} must be an integer`);
  return n;
}
