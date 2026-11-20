import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { DeduplicationService } from './deduplication.service';
import {
  CandidateFilter,
  CandidateStatus,
  DeduplicationScanOptions,
  EntityType,
  FieldResolutionStrategy,
} from './deduplication.types';

export class ScanDto {
  entityType!: EntityType;
  minConfidence?: number;
  limit?: number;
}

export class ReviewCandidateDto {
  decision!: 'approved' | 'rejected' | 'dismissed';
  reason!: string;
  fieldStrategies?: Record<string, { strategy: FieldResolutionStrategy; manualValue?: any }>;
}

export class ExecuteMergeDto {
  reason?: string;
}

export class ReverseMergeDto {
  reason!: string;
}

@Controller('api/v1/deduplication')
@UseGuards(JwtAuthGuard, AdminGuard)
export class DeduplicationController {
  constructor(private readonly deduplicationService: DeduplicationService) {}

  @Post('scan')
  async scan(@Body() dto: ScanDto) {
    if (!dto.entityType) {
      throw new BadRequestException('entityType is required');
    }
    return this.deduplicationService.scan(dto);
  }

  @Get('candidates')
  async listCandidates(
    @Query('entityType') entityType?: EntityType,
    @Query('status') status?: CandidateStatus,
    @Query('minConfidence') minConfidence?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    const filter: CandidateFilter = {
      entityType,
      status,
      minConfidence: minConfidence ? Number(minConfidence) : undefined,
      offset: offset ? Number(offset) : undefined,
      limit: limit ? Number(limit) : undefined,
    };
    return this.deduplicationService.listCandidates(filter);
  }

  @Get('candidates/:id')
  async getCandidate(@Param('id') id: string) {
    return this.deduplicationService.getCandidate(id);
  }

  @Post('candidates/:id/review')
  async reviewCandidate(
    @Param('id') id: string,
    @Body() dto: ReviewCandidateDto,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!dto.decision || !dto.reason) {
      throw new BadRequestException('decision and reason are required');
    }
    const reviewer = req.user?.walletAddress || 'admin';
    return this.deduplicationService.reviewCandidate(id, {
      reviewer,
      decision: dto.decision,
      reason: dto.reason,
      fieldStrategies: dto.fieldStrategies,
    });
  }

  @Post('candidates/:id/merge')
  async executeMerge(
    @Param('id') id: string,
    @Body() dto: ExecuteMergeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const actor = req.user?.walletAddress || 'admin';
    return this.deduplicationService.executeMerge(id, actor, dto.reason);
  }

  @Get('merges')
  async listMerges() {
    return this.deduplicationService.listMerges();
  }

  @Get('merges/:id')
  async getMerge(@Param('id') id: string) {
    return this.deduplicationService.getMerge(id);
  }

  @Post('merges/:id/reverse')
  async reverseMerge(
    @Param('id') id: string,
    @Body() dto: ReverseMergeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!dto.reason) {
      throw new BadRequestException('reversal reason is required');
    }
    const actor = req.user?.walletAddress || 'admin';
    return this.deduplicationService.reverseMerge(id, actor, dto.reason);
  }
}
