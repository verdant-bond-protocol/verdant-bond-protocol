import { Controller, Get, Query, Param, BadRequestException, Logger } from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { TimelineQueryResult, TimelineEventType } from './timeline.interface';

@Controller('timeline')
export class TimelineController {
  private readonly logger = new Logger(TimelineController.name);

  constructor(private readonly timelineService: TimelineService) {}

  @Get('address/:address')
  async getTimelineForAddress(
    @Param('address') address: string,
    @Query('eventTypes') eventTypesParam?: string,
    @Query('after') after?: string,
    @Query('before') before?: string,
    @Query('skip') skip?: string,
    @Query('limit') limit?: string,
  ): Promise<TimelineQueryResult> {
    try {
      const eventTypes = eventTypesParam
        ? eventTypesParam.split(',').filter((t) => Object.values(TimelineEventType).includes(t as TimelineEventType))
        : undefined;

      const result = await this.timelineService.getTimelineForAddress(address, {
        eventTypes: eventTypes as TimelineEventType[] | undefined,
        after: after ? parseInt(after, 10) : undefined,
        before: before ? parseInt(before, 10) : undefined,
        skip: skip ? parseInt(skip, 10) : 0,
        limit: limit ? Math.min(parseInt(limit, 10), 100) : 50,
      });

      return result;
    } catch (error) {
      this.logger.error(`Failed to retrieve timeline for address ${address}`, error);
      throw new BadRequestException('Failed to retrieve timeline');
    }
  }

  @Get('bond/:bondId')
  async getTimelineForBond(
    @Param('bondId') bondIdParam: string,
    @Query('eventTypes') eventTypesParam?: string,
    @Query('after') after?: string,
    @Query('before') before?: string,
    @Query('skip') skip?: string,
    @Query('limit') limit?: string,
  ): Promise<TimelineQueryResult> {
    const bondId = parseInt(bondIdParam, 10);
    if (isNaN(bondId)) {
      throw new BadRequestException('Invalid bond ID');
    }

    try {
      const eventTypes = eventTypesParam
        ? eventTypesParam.split(',').filter((t) => Object.values(TimelineEventType).includes(t as TimelineEventType))
        : undefined;

      const result = await this.timelineService.getTimelineForBond(bondId, {
        eventTypes: eventTypes as TimelineEventType[] | undefined,
        after: after ? parseInt(after, 10) : undefined,
        before: before ? parseInt(before, 10) : undefined,
        skip: skip ? parseInt(skip, 10) : 0,
        limit: limit ? Math.min(parseInt(limit, 10), 100) : 50,
      });

      return result;
    } catch (error) {
      this.logger.error(`Failed to retrieve timeline for bond ${bondId}`, error);
      throw new BadRequestException('Failed to retrieve timeline');
    }
  }
}
