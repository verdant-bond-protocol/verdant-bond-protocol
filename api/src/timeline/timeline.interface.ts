export enum TimelineEventType {
  BOND_SUBSCRIBED = 'bond_subscribed',
  COUPON_CLAIMED = 'coupon_claimed',
  COUPON_DISTRIBUTED = 'coupon_distributed',
  BOND_TRANSFERRED = 'bond_transferred',
  BOND_CREATED = 'bond_created',
  CREDIT_RETIRED = 'credit_retired',
  LISTING_CREATED = 'listing_created',
  LISTING_FILLED = 'listing_filled',
  PROJECT_REGISTERED = 'project_registered',
  REPORT_PUBLISHED = 'report_published',
}

export interface TimelineEvent {
  id: string;
  eventType: TimelineEventType;
  timestamp: number;
  actor: string;
  bondId?: number;
  projectId?: string;
  reportId?: number;
  amount?: string;
  metadata?: Record<string, any>;
  isPublic: boolean;
}

export interface TimelineFilter {
  eventTypes?: TimelineEventType[];
  bondId?: number;
  projectId?: string;
  after?: number;
  before?: number;
  skip?: number;
  limit?: number;
}

export interface TimelineEventResponse {
  id: string;
  eventType: TimelineEventType;
  timestamp: number;
  bondId?: number;
  projectId?: string;
  amount?: string;
  description: string;
  link?: string;
  metadata?: Record<string, any>;
}

export interface TimelineQueryResult {
  events: TimelineEventResponse[];
  total: number;
  skip: number;
  limit: number;
}
