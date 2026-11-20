import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

export const OPTIONAL_NOTIFICATION_CATEGORIES = ['bond_updates', 'coupon_updates', 'project_reports'] as const;
export const MANDATORY_NOTIFICATION_CATEGORIES = ['compliance', 'security', 'settlement_failure'] as const;
export type OptionalNotificationCategory = typeof OPTIONAL_NOTIFICATION_CATEGORIES[number];
export type NotificationCategory = OptionalNotificationCategory | typeof MANDATORY_NOTIFICATION_CATEGORIES[number];

/**
 * Routing table: every known notification type maps to a category so the
 * delivery engine can decide mandatory vs optional without callers having
 * to know the category.
 */
const TYPE_CATEGORY: Record<string, NotificationCategory> = {
  BOND_ISSUED: 'bond_updates',
  COUPON_DISTRIBUTED: 'coupon_updates',
  PROJECT_REPORT: 'project_reports',
  RECOVERY_INTERRUPTED: 'settlement_failure',
  PARTIAL_FAILURE: 'settlement_failure',
  COMPLIANCE_ALERT: 'compliance',
  SECURITY_ALERT: 'security',
};

/**
 * How far back decisions are restored at startup for duplicate suppression
 * (#410). Producer retries arrive within minutes or hours; 30 days covers a
 * long outage without loading the whole decision history into memory.
 */
const DEDUPE_RESTORE_WINDOW_DAYS = 30;

const decisionKey = (userId: string, eventId: string): string => `${userId}\u0000${eventId}`;

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

/**
 * One entry in the durable preference change history.
 *
 * Stored in `notification_preference_history` so operators can audit when
 * and why a user changed their optional-category opt-ins, and so that
 * mandatory-category override events are permanently visible.
 */
export interface PreferenceHistoryEntry {
  id: string;
  userId: string;
  changedAt: string;
  /** Snapshot of preferences before this change. */
  before: Record<OptionalNotificationCategory, boolean>;
  /** Snapshot of preferences after this change. */
  after: Record<OptionalNotificationCategory, boolean>;
  /** Free-text reason supplied by the caller (defaults to 'user_request'). */
  reason: string;
}

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private notifications: Notification[] = [];
  private preferences = new Map<string, Record<OptionalNotificationCategory, boolean>>();
  private decisions: NotificationDecision[] = [];
  /**
   * Every (user, event) already decided — delivered or suppressed (#410).
   * An O(1) lookup that makes a decision final: a redelivered event never
   * produces a second decision or a second inbox entry.
   */
  private readonly decidedEvents = new Set<string>();
  /** In-memory fallback for preference history when no DB is configured. */
  private preferenceHistory: PreferenceHistoryEntry[] = [];
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
    /**
     * Durable preference-change audit trail.  Each row captures a before/after
     * snapshot so mandatory-override events and user opt-outs are permanently
     * visible to operators.
     */
    await this.pool.query(`CREATE TABLE IF NOT EXISTS notification_preference_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL,
      before_prefs JSONB NOT NULL,
      after_prefs  JSONB NOT NULL,
      reason TEXT NOT NULL DEFAULT 'user_request'
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS notification_preference_history_user_idx
      ON notification_preference_history (user_id, changed_at DESC)`);

    const rows = await this.pool.query('SELECT user_id, preferences FROM notification_preferences');
    for (const row of rows.rows) this.preferences.set(row.user_id, row.preferences);

    // Duplicate suppression survives a restart for the restore window (#410).
    const decided = await this.pool.query(
      `SELECT user_id, event_id FROM notification_decisions
        WHERE decided_at > now() - make_interval(days => $1)`,
      [DEDUPE_RESTORE_WINDOW_DAYS],
    );
    for (const row of decided.rows) this.decidedEvents.add(decisionKey(row.user_id, row.event_id));
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  getPreferences(userId: string): Record<OptionalNotificationCategory, boolean> {
    return { bond_updates: true, coupon_updates: true, project_reports: true, ...this.preferences.get(userId) };
  }

  async setPreferences(
    userId: string,
    updates: unknown,
    reason = 'user_request',
  ): Promise<Record<OptionalNotificationCategory, boolean>> {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new BadRequestException('Preferences must be an object');
    }
    for (const [key, value] of Object.entries(updates)) {
      // Mandatory categories may never be disabled through the preferences API.
      if ((MANDATORY_NOTIFICATION_CATEGORIES as readonly string[]).includes(key)) {
        throw new BadRequestException(
          `Cannot change mandatory notification category: ${key}`,
        );
      }
      if (!OPTIONAL_NOTIFICATION_CATEGORIES.includes(key as OptionalNotificationCategory) || typeof value !== 'boolean') {
        throw new BadRequestException(`Invalid optional notification preference: ${key}`);
      }
    }

    const before = this.getPreferences(userId);
    const next = { ...before, ...(updates as Record<string, boolean>) };

    if (this.pool) {
      await this.pool.query(
        `INSERT INTO notification_preferences (user_id, preferences) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences`,
        [userId, JSON.stringify(next)],
      );
    }
    this.preferences.set(userId, next);

    // Record preference change in durable audit trail.
    await this.recordPreferenceHistory(userId, before, next, reason);

    return { ...next };
  }

  private async recordPreferenceHistory(
    userId: string,
    before: Record<OptionalNotificationCategory, boolean>,
    after: Record<OptionalNotificationCategory, boolean>,
    reason: string,
  ): Promise<void> {
    const entry: PreferenceHistoryEntry = {
      id: randomUUID(),
      userId,
      changedAt: new Date().toISOString(),
      before,
      after,
      reason,
    };
    this.preferenceHistory.push(entry);

    if (this.pool) {
      await this.pool
        .query(
          `INSERT INTO notification_preference_history
             (id, user_id, changed_at, before_prefs, after_prefs, reason)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [
            entry.id,
            entry.userId,
            entry.changedAt,
            JSON.stringify(entry.before),
            JSON.stringify(entry.after),
            entry.reason,
          ],
        )
        .catch((error) =>
          this.logger.error('Preference history write failed', error),
        );
    }
  }

  /**
   * Return the full preference-change history for a user, newest first.
   * Mandatory-override attempts that were rejected are NOT recorded here
   * because they never succeed; the audit trail for attempted overrides lives
   * in notification_decisions (delivered=false rows for mandatory categories).
   */
  async getPreferenceHistory(userId: string): Promise<PreferenceHistoryEntry[]> {
    if (this.pool) {
      const rows = await this.pool.query(
        `SELECT id, user_id, changed_at, before_prefs, after_prefs, reason
           FROM notification_preference_history
          WHERE user_id = $1
          ORDER BY changed_at DESC`,
        [userId],
      );
      return rows.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        changedAt: new Date(row.changed_at).toISOString(),
        before: row.before_prefs as Record<OptionalNotificationCategory, boolean>,
        after: row.after_prefs as Record<OptionalNotificationCategory, boolean>,
        reason: row.reason as string,
      }));
    }
    return this.preferenceHistory
      .filter((e) => e.userId === userId)
      .slice()
      .reverse();
  }

  async getDecisions(userId: string): Promise<NotificationDecision[]> {
    if (this.pool) {
      const rows = await this.pool.query(
        `SELECT user_id, event_id, type, category, delivered, mandatory, decided_at
           FROM notification_decisions WHERE user_id = $1 ORDER BY id DESC`,
        [userId],
      );
      return rows.rows.map((row) => ({
        userId: row.user_id,
        eventId: row.event_id,
        type: row.type,
        category: row.category,
        delivered: row.delivered,
        mandatory: row.mandatory,
        decidedAt: new Date(row.decided_at).toISOString(),
      }));
    }
    return this.decisions
      .filter((decision) => decision.userId === userId)
      .map((decision) => ({ ...decision }));
  }

  /**
   * Decide and, if allowed, deliver one notification. Returns null when the
   * notification is suppressed by preference or is a duplicate of an event
   * already decided for this user (#410).
   */
  createNotification(data: Omit<Notification, 'id' | 'read' | 'createdAt'>): Notification | null {
    const key = decisionKey(data.userId, data.eventId);
    if (this.decidedEvents.has(key)) {
      this.logger.debug(`Duplicate notification suppressed: ${data.type} ${data.eventId}`);
      return null;
    }
    this.decidedEvents.add(key);

    const category = TYPE_CATEGORY[data.type] ?? 'bond_updates';
    const mandatory = (MANDATORY_NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
    const delivered =
      mandatory || this.getPreferences(data.userId)[category as OptionalNotificationCategory];

    const decision: NotificationDecision = {
      userId: data.userId,
      eventId: data.eventId,
      type: data.type,
      category,
      delivered,
      mandatory,
      decidedAt: new Date().toISOString(),
    };
    this.decisions.push(decision);

    if (this.pool) {
      void this.pool
        .query(
          `INSERT INTO notification_decisions
             (user_id, event_id, type, category, delivered, mandatory, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, event_id) DO NOTHING`,
          [
            decision.userId,
            decision.eventId,
            decision.type,
            decision.category,
            decision.delivered,
            decision.mandatory,
            decision.decidedAt,
          ],
        )
        .catch((error) =>
          this.logger.error('Notification decision audit write failed', error),
        );
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

  /** Count unread notifications for a user's inbox. */
  countUnread(userId: string): number {
    return this.notifications.filter((n) => n.userId === userId && !n.read).length;
  }

  markAsRead(userId: string, id: string, now: Date = new Date()): Notification | null {
    const notification = this.notifications.find(
      (n) => n.id === id && n.userId === userId,
    );
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
