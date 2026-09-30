import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

export const OPTIONAL_NOTIFICATION_CATEGORIES = ['bond_updates', 'coupon_updates', 'project_reports'] as const;
export const MANDATORY_NOTIFICATION_CATEGORIES = ['compliance', 'security', 'settlement_failure'] as const;
export type OptionalNotificationCategory = typeof OPTIONAL_NOTIFICATION_CATEGORIES[number];
export type NotificationCategory = OptionalNotificationCategory | typeof MANDATORY_NOTIFICATION_CATEGORIES[number];

const TYPE_CATEGORY: Record<string, NotificationCategory> = {
  BOND_ISSUED: 'bond_updates',
  COUPON_DISTRIBUTED: 'coupon_updates',
  PROJECT_REPORT: 'project_reports',
  RECOVERY_INTERRUPTED: 'settlement_failure',
  PARTIAL_FAILURE: 'settlement_failure',
  COMPLIANCE_ALERT: 'compliance',
  SECURITY_ALERT: 'security',
};

export interface NotificationDecision {
  userId: string;
  eventId: string;
  type: string;
  category: NotificationCategory;
  delivered: boolean;
  mandatory: boolean;
  decidedAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  type: string;
  message: string;
  /**
   * Per-user read state. This is a read receipt, not a visibility flag: an
   * unread notification is still listed by default, and the caller filters on
   * it explicitly rather than the flag quietly removing rows.
   */
  read: boolean;
  readAt?: string;
  link?: string;
  eventId: string; // Used for deduplication
  createdAt: Date;
  category?: NotificationCategory;
  mandatory?: boolean;
}

export interface NotificationQuery {
  /** Return only unread notifications. */
  unreadOnly?: boolean;
  /** Return only notifications for this type. */
  type?: string;
}

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private notifications: Notification[] = [];
  private preferences = new Map<string, Record<OptionalNotificationCategory, boolean>>();
  private decisions: NotificationDecision[] = [];
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
  private readonly logger = new Logger(NotificationsService.name);

  async onModuleInit(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT PRIMARY KEY, preferences JSONB NOT NULL
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS notification_decisions (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL,
      type TEXT NOT NULL, category TEXT NOT NULL, delivered BOOLEAN NOT NULL,
      mandatory BOOLEAN NOT NULL, decided_at TIMESTAMPTZ NOT NULL,
      UNIQUE (user_id, event_id)
    )`);
    const rows = await this.pool.query('SELECT user_id, preferences FROM notification_preferences');
    for (const row of rows.rows) this.preferences.set(row.user_id, row.preferences);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  getPreferences(userId: string): Record<OptionalNotificationCategory, boolean> {
    return { bond_updates: true, coupon_updates: true, project_reports: true, ...this.preferences.get(userId) };
  }

  async setPreferences(userId: string, updates: unknown): Promise<Record<OptionalNotificationCategory, boolean>> {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new BadRequestException('Preferences must be an object');
    }
    for (const [key, value] of Object.entries(updates)) {
      if (!OPTIONAL_NOTIFICATION_CATEGORIES.includes(key as OptionalNotificationCategory) || typeof value !== 'boolean') {
        throw new BadRequestException(`Invalid optional notification preference: ${key}`);
      }
    }
    const next = { ...this.getPreferences(userId), ...updates };
    if (this.pool) {
      await this.pool.query(`INSERT INTO notification_preferences (user_id, preferences) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences`, [userId, JSON.stringify(next)]);
    }
    this.preferences.set(userId, next);
    return { ...next };
  }

  async getDecisions(userId: string): Promise<NotificationDecision[]> {
    if (this.pool) {
      const rows = await this.pool.query(`SELECT user_id, event_id, type, category, delivered, mandatory, decided_at
        FROM notification_decisions WHERE user_id = $1 ORDER BY id DESC`, [userId]);
      return rows.rows.map(row => ({ userId: row.user_id, eventId: row.event_id, type: row.type,
        category: row.category, delivered: row.delivered, mandatory: row.mandatory,
        decidedAt: new Date(row.decided_at).toISOString() }));
    }
    return this.decisions.filter(decision => decision.userId === userId).map(decision => ({ ...decision }));
  }

  createNotification(data: Omit<Notification, 'id' | 'read' | 'createdAt'>): Notification | null {
    // Deduplication check
    const existing = this.notifications.find(n => n.eventId === data.eventId && n.userId === data.userId);
    if (existing) {
      return null;
    }

    const category = TYPE_CATEGORY[data.type] ?? 'bond_updates';
    const mandatory = (MANDATORY_NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
    const delivered = mandatory || this.getPreferences(data.userId)[category as OptionalNotificationCategory];
    const decision = { userId: data.userId, eventId: data.eventId, type: data.type,
      category, delivered, mandatory, decidedAt: new Date().toISOString() };
    this.decisions.push(decision);
    if (this.pool) {
      void this.pool.query(`INSERT INTO notification_decisions
        (user_id, event_id, type, category, delivered, mandatory, decided_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, event_id) DO NOTHING`,
      [decision.userId, decision.eventId, decision.type, decision.category, decision.delivered,
        decision.mandatory, decision.decidedAt]).catch(error => this.logger.error('Notification decision audit write failed', error));
    }
    if (!delivered) return null;

    const notification: Notification = {
      ...data,
      id: randomUUID(),
      read: false,
      createdAt: new Date(),
      category,
      mandatory,
    };
    this.notifications.push(notification);
    return notification;
  }

  getNotifications(userId: string, query: NotificationQuery = {}): Notification[] {
    return this.notifications
      .filter((n) => n.userId === userId)
      .filter((n) => (query.unreadOnly ? !n.read : true))
      .filter((n) => (query.type ? n.type === query.type : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Unread count for an inbox, so a client can badge without paging the list. */
  countUnread(userId: string): number {
    return this.getNotifications(userId, { unreadOnly: true }).length;
  }

  markAsRead(userId: string, id: string, now: Date = new Date()): Notification | null {
    const notification = this.notifications.find(n => n.id === id && n.userId === userId);
    if (notification && !notification.read) {
      notification.read = true;
      notification.readAt = now.toISOString();
    }
    return notification ?? null;
  }

  /** Mark a whole inbox read. Returns how many changed, so a repeat call is a visible no-op. */
  markAllAsRead(userId: string, now: Date = new Date()): number {
    const at = now.toISOString();
    let changed = 0;
    for (const notification of this.notifications) {
      if (notification.userId !== userId || notification.read) continue;
      notification.read = true;
      notification.readAt = at;
      changed += 1;
    }
    return changed;
  }
}
