import { Injectable } from '@nestjs/common';

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
}

export interface NotificationQuery {
  /** Return only unread notifications. */
  unreadOnly?: boolean;
  /** Return only notifications for this type. */
  type?: string;
}

@Injectable()
export class NotificationsService {
  private notifications: Notification[] = [];

  createNotification(data: Omit<Notification, 'id' | 'read' | 'createdAt'>): Notification | null {
    // Deduplication check
    const existing = this.notifications.find(n => n.eventId === data.eventId && n.userId === data.userId);
    if (existing) {
      return null;
    }

    const notification: Notification = {
      ...data,
      id: Math.random().toString(36).substring(7),
      read: false,
      createdAt: new Date(),
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
