import { Injectable } from '@nestjs/common';

export interface Notification {
  id: string;
  userId: string;
  type: string;
  message: string;
  read: boolean;
  link?: string;
  eventId: string; // Used for deduplication
  createdAt: Date;
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

  getNotifications(userId: string): Notification[] {
    return this.notifications.filter(n => n.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  markAsRead(userId: string, id: string): Notification | null {
    const notification = this.notifications.find(n => n.id === id && n.userId === userId);
    if (notification) {
      notification.read = true;
    }
    return notification ?? null;
  }
}
