import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';
import { TimelineEvent, TimelineEventType, TimelineFilter, TimelineQueryResult, TimelineEventResponse } from './timeline.interface';
import * as crypto from 'crypto';

@Injectable()
export class TimelineService {
  private readonly logger = new Logger(TimelineService.name);
  private readonly EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

  constructor(private readonly redis: RedisService) {}

  async recordEvent(event: Omit<TimelineEvent, 'id'>): Promise<TimelineEvent> {
    const id = this.generateEventId();
    const fullEvent: TimelineEvent = {
      ...event,
      id,
    };

    const key = this.getEventKey(id);
    await this.redis.setEx(key, this.EVENT_RETENTION_SECONDS, JSON.stringify(fullEvent));

    const indexKey = this.getEventIndexKey(event.actor, event.isPublic);
    await this.redis.lpush(indexKey, id);
    await this.redis.expire(indexKey, this.EVENT_RETENTION_SECONDS);

    if (event.bondId) {
      const bondIndexKey = this.getBondEventIndexKey(event.bondId, event.isPublic);
      await this.redis.lpush(bondIndexKey, id);
      await this.redis.expire(bondIndexKey, this.EVENT_RETENTION_SECONDS);
    }

    this.logger.debug(`Event recorded: ${fullEvent.eventType} by ${event.actor}`);
    return fullEvent;
  }

  async getTimelineForAddress(address: string, filter: TimelineFilter = {}): Promise<TimelineQueryResult> {
    const indexKey = this.getEventIndexKey(address, true);
    const skip = filter.skip || 0;
    const limit = filter.limit || 50;

    let eventIds: string[] = [];
    try {
      const allIds = await this.redis.lrange(indexKey, 0, -1);
      eventIds = allIds || [];
    } catch (error) {
      this.logger.warn(`Failed to retrieve event index for ${address}`, error);
      return { events: [], total: 0, skip, limit };
    }

    const filteredIds = await this.filterEventIds(eventIds, filter);
    const total = filteredIds.length;
    const paginatedIds = filteredIds.slice(skip, skip + limit);

    const events: TimelineEventResponse[] = [];
    for (const id of paginatedIds) {
      try {
        const event = await this.getEvent(id);
        if (event && event.isPublic) {
          events.push(this.toEventResponse(event, address));
        }
      } catch (error) {
        this.logger.warn(`Failed to retrieve event ${id}`, error);
      }
    }

    return { events, total, skip, limit };
  }

  async getTimelineForBond(bondId: number, filter: TimelineFilter = {}): Promise<TimelineQueryResult> {
    const indexKey = this.getBondEventIndexKey(bondId, true);
    const skip = filter.skip || 0;
    const limit = filter.limit || 50;

    let eventIds: string[] = [];
    try {
      const allIds = await this.redis.lrange(indexKey, 0, -1);
      eventIds = allIds || [];
    } catch (error) {
      this.logger.warn(`Failed to retrieve event index for bond ${bondId}`, error);
      return { events: [], total: 0, skip, limit };
    }

    const filteredIds = await this.filterEventIds(eventIds, filter);
    const total = filteredIds.length;
    const paginatedIds = filteredIds.slice(skip, skip + limit);

    const events: TimelineEventResponse[] = [];
    for (const id of paginatedIds) {
      try {
        const event = await this.getEvent(id);
        if (event && event.isPublic) {
          events.push(this.toEventResponse(event));
        }
      } catch (error) {
        this.logger.warn(`Failed to retrieve event ${id}`, error);
      }
    }

    return { events, total, skip, limit };
  }

  async recordSubscription(bondId: number, investorAddress: string, amount: string): Promise<TimelineEvent> {
    return this.recordEvent({
      eventType: TimelineEventType.BOND_SUBSCRIBED,
      timestamp: Math.floor(Date.now() / 1000),
      actor: investorAddress,
      bondId,
      amount,
      isPublic: true,
      metadata: { action: 'subscribe' },
    });
  }

  async recordCouponClaim(bondId: number, investorAddress: string, credits: string): Promise<TimelineEvent> {
    return this.recordEvent({
      eventType: TimelineEventType.COUPON_CLAIMED,
      timestamp: Math.floor(Date.now() / 1000),
      actor: investorAddress,
      bondId,
      amount: credits,
      isPublic: true,
      metadata: { action: 'claim' },
    });
  }

  async recordCouponDistribution(bondId: number, amount: string, holderCount: number): Promise<TimelineEvent> {
    return this.recordEvent({
      eventType: TimelineEventType.COUPON_DISTRIBUTED,
      timestamp: Math.floor(Date.now() / 1000),
      actor: 'system',
      bondId,
      amount,
      isPublic: true,
      metadata: { holderCount, action: 'distribute' },
    });
  }

  async recordBondTransfer(
    bondId: number,
    fromAddress: string,
    toAddress: string,
    amount: string,
  ): Promise<TimelineEvent> {
    return this.recordEvent({
      eventType: TimelineEventType.BOND_TRANSFERRED,
      timestamp: Math.floor(Date.now() / 1000),
      actor: fromAddress,
      bondId,
      amount,
      isPublic: true,
      metadata: { to: toAddress, action: 'transfer' },
    });
  }

  async recordAuditEvent(
    eventType: TimelineEventType,
    actor: string,
    bondId?: number,
    metadata?: Record<string, any>,
  ): Promise<TimelineEvent> {
    return this.recordEvent({
      eventType,
      timestamp: Math.floor(Date.now() / 1000),
      actor,
      bondId,
      isPublic: false,
      metadata,
    });
  }

  private async getEvent(id: string): Promise<TimelineEvent | null> {
    try {
      const key = this.getEventKey(id);
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.warn(`Failed to parse event ${id}`, error);
      return null;
    }
  }

  private async filterEventIds(eventIds: string[], filter: TimelineFilter): Promise<string[]> {
    if (!filter.eventTypes && !filter.after && !filter.before) {
      return eventIds;
    }

    const filtered: string[] = [];
    for (const id of eventIds) {
      const event = await this.getEvent(id);
      if (!event) continue;

      if (filter.eventTypes && !filter.eventTypes.includes(event.eventType)) {
        continue;
      }

      if (filter.after && event.timestamp < filter.after) {
        continue;
      }

      if (filter.before && event.timestamp > filter.before) {
        continue;
      }

      filtered.push(id);
    }

    return filtered;
  }

  private toEventResponse(event: TimelineEvent, forAddress?: string): TimelineEventResponse {
    let description = '';
    let link = '';

    switch (event.eventType) {
      case TimelineEventType.BOND_SUBSCRIBED:
        description = `Subscribed to bond #${event.bondId} with ${event.amount} units`;
        link = `/bonds/${event.bondId}`;
        break;
      case TimelineEventType.COUPON_CLAIMED:
        description = `Claimed ${event.amount} credits from bond #${event.bondId}`;
        link = `/bonds/${event.bondId}`;
        break;
      case TimelineEventType.COUPON_DISTRIBUTED:
        description = `${event.amount} credits distributed to ${event.metadata?.holderCount || 0} holders`;
        link = `/bonds/${event.bondId}`;
        break;
      case TimelineEventType.BOND_TRANSFERRED:
        description = `Transferred ${event.amount} units to ${event.metadata?.to}`;
        link = `/bonds/${event.bondId}`;
        break;
      case TimelineEventType.CREDIT_RETIRED:
        description = `Retired ${event.amount} credits`;
        break;
      default:
        description = `${event.eventType} event`;
    }

    return {
      id: event.id,
      eventType: event.eventType,
      timestamp: event.timestamp,
      bondId: event.bondId,
      amount: event.amount,
      description,
      link,
      metadata: event.metadata,
    };
  }

  private generateEventId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private getEventKey(id: string): string {
    return `timeline:event:${id}`;
  }

  private getEventIndexKey(address: string, isPublic: boolean): string {
    return `timeline:index:${address}:${isPublic ? 'public' : 'private'}`;
  }

  private getBondEventIndexKey(bondId: number, isPublic: boolean): string {
    return `timeline:bond:${bondId}:${isPublic ? 'public' : 'private'}`;
  }
}
