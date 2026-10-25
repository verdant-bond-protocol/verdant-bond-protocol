export type NotificationStatus = 'pending' | 'sent' | 'acknowledged' | 'failed';

export interface CovenantNotification { id: string; covenantId: string; recipient: string; status: NotificationStatus; attempts: number; lastError?: string; acknowledgedAt?: string; }

export class CovenantNotificationFanout {
  private readonly notifications = new Map<string, CovenantNotification>();
  constructor(private readonly canNotify: (recipient: string) => boolean = () => true) {}

  fanOut(covenantId: string, recipients: string[]): CovenantNotification[] {
    return [...new Set(recipients)].map((recipient) => {
      const id = `${covenantId}:${recipient}`;
      const existing = this.notifications.get(id);
      if (existing) return { ...existing };
      const notification = { id, covenantId, recipient, status: 'pending' as const, attempts: 0 };
      this.notifications.set(id, notification);
      return { ...notification };
    });
  }

  deliver(id: string, send: (recipient: string) => void): CovenantNotification {
    const notification = this.require(id);
    if (!this.canNotify(notification.recipient)) throw new Error('Recipient is not authorized');
    notification.attempts += 1;
    try { send(notification.recipient); notification.status = 'sent'; delete notification.lastError; }
    catch (error) { notification.status = 'failed'; notification.lastError = error instanceof Error ? error.message : String(error); }
    return { ...notification };
  }

  acknowledge(id: string, at = new Date().toISOString()): CovenantNotification {
    const notification = this.require(id);
    if (notification.status !== 'sent') throw new Error('Only sent notifications can be acknowledged');
    notification.status = 'acknowledged'; notification.acknowledgedAt = at;
    return { ...notification };
  }

  list(covenantId: string): CovenantNotification[] { return [...this.notifications.values()].filter((n) => n.covenantId === covenantId).map((n) => ({ ...n })); }
  private require(id: string): CovenantNotification { const n = this.notifications.get(id); if (!n) throw new Error(`Unknown notification: ${id}`); return n; }
}

