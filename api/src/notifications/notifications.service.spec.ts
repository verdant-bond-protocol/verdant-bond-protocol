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
    expect(notif1.id).toBeDefined();
    expect(notif1.read).toBeFalsy();

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

    expect(notif.read).toBeFalsy();
    service.markAsRead('user1', notif.id);
    const fetched = service.getNotifications('user1').find(n => n.id === notif.id);
    expect(fetched.read).toBeTruthy();
  });
});
