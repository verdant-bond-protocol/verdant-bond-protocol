import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { BadRequestException } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';

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

  it('delivers opted-in optional notifications and suppresses opted-out ones', async () => {
    await service.setPreferences('user1', { bond_updates: false });
    expect(service.createNotification({ userId: 'user1', type: 'BOND_ISSUED', message: 'A', eventId: 'evt-a' })).toBeNull();
    expect(service.getNotifications('user1')).toHaveLength(0);
    await service.setPreferences('user1', { bond_updates: true });
    expect(service.createNotification({ userId: 'user1', type: 'BOND_ISSUED', message: 'B', eventId: 'evt-b' })).not.toBeNull();
    expect((await service.getDecisions('user1')).map(d => d.delivered)).toEqual([false, true]);
  });

  it('always delivers mandatory alerts and records the override', async () => {
    await service.setPreferences('admin', { bond_updates: false, coupon_updates: false, project_reports: false });
    const alert = service.createNotification({ userId: 'admin', type: 'RECOVERY_INTERRUPTED', message: 'Critical', eventId: 'evt-critical' });
    expect(alert?.mandatory).toBe(true);
    expect((await service.getDecisions('admin'))[0]).toMatchObject({ mandatory: true, delivered: true, category: 'settlement_failure' });
    await expect(service.setPreferences('admin', { settlement_failure: false })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only edits the authenticated wallet preferences', async () => {
    const controller = new NotificationsController(service);
    const request = { user: { walletAddress: 'user1', roles: [] } } as any;
    await expect(controller.setPreferences(request, { userId: 'user2', bond_updates: false })).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getPreferences('user2').bond_updates).toBe(true);
    await controller.setPreferences(request, { bond_updates: false });
    expect(service.getPreferences('user1').bond_updates).toBe(false);
    expect(service.getPreferences('user2').bond_updates).toBe(true);
  });
});
