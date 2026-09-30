import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [NotificationsService],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a notification and deduplicate based on eventId', () => {
    const data = {
      userId: 'user1',
      type: 'BOND_ISSUED',
      message: 'A new bond was issued',
      eventId: 'evt-123'
    };

    const notif1 = service.createNotification(data);
    expect(notif1).toBeDefined();
    expect(notif1!.id).toBeDefined();
    expect(notif1!.read).toBeFalsy();

    const notif2 = service.createNotification(data);
    expect(notif2).toBeNull(); // Deduplicated
  });

  it('should mark notification as read', () => {
    const notif = service.createNotification({
      userId: 'user1',
      type: 'APPROVAL',
      message: 'Approved',
      eventId: 'evt-456'
    });

    expect(notif!.read).toBeFalsy();
    service.markAsRead('user1', notif!.id);
    const fetched = service.getNotifications('user1').find(n => n.id === notif!.id);
    expect(fetched!.read).toBeTruthy();
    expect(fetched!.readAt).toBeDefined();
  });

  it('the read flag is queryable rather than silently dropping notifications', () => {
    const first = service.createNotification({ userId: 'user1', type: 'APPROVAL', message: 'A', eventId: 'evt-a' })!;
    service.createNotification({ userId: 'user1', type: 'REVIEW', message: 'B', eventId: 'evt-b' });
    service.markAsRead('user1', first.id);

    // Default listing still returns everything: the read flag is a receipt,
    // not a visibility switch.
    expect(service.getNotifications('user1')).toHaveLength(2);
    expect(service.getNotifications('user1', { unreadOnly: true }).map(n => n.id)).toEqual([expect.not.stringContaining(first.id)]);
    expect(service.getNotifications('user1', { type: 'REVIEW' })).toHaveLength(1);
    expect(service.countUnread('user1')).toBe(1);
  });

  it('marks a whole inbox read and reports how many changed', () => {
    service.createNotification({ userId: 'user1', type: 'A', message: 'A', eventId: 'evt-a' });
    service.createNotification({ userId: 'user1', type: 'B', message: 'B', eventId: 'evt-b' });
    service.createNotification({ userId: 'user2', type: 'C', message: 'C', eventId: 'evt-c' });

    expect(service.markAllAsRead('user1')).toBe(2);
    expect(service.markAllAsRead('user1')).toBe(0); // repeat call is a visible no-op
    expect(service.countUnread('user1')).toBe(0);
    // Another user's inbox is untouched.
    expect(service.countUnread('user2')).toBe(1);
  });
});
