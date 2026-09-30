import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { NotificationsService, OPTIONAL_NOTIFICATION_CATEGORIES, MANDATORY_NOTIFICATION_CATEGORIES } from './notifications.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { Role } from '../auth/rbac';

/** Inbox that system services (recovery, partial failures) notify. */
export const ADMIN_INBOX = 'admin';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // Notifications are keyed by the authenticated wallet (JwtStrategy sets
  // walletAddress); maintainers also read the shared admin inbox.
  private inboxes(req: AuthenticatedRequest): string[] {
    const inboxes = [req.user.walletAddress];
    if (req.user.roles?.includes(Role.MAINTAINER)) inboxes.push(ADMIN_INBOX);
    return inboxes;
  }

  @Get('preferences')
  getPreferences(@Req() req: AuthenticatedRequest) {
    return {
      optional: this.notificationsService.getPreferences(req.user.walletAddress),
      mandatory: MANDATORY_NOTIFICATION_CATEGORIES,
      optionalCategories: OPTIONAL_NOTIFICATION_CATEGORIES,
    };
  }

  @Patch('preferences')
  setPreferences(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.notificationsService.setPreferences(req.user.walletAddress, body);
  }

  @Get('decisions')
  async getDecisions(@Req() req: AuthenticatedRequest) {
    return (await Promise.all(this.inboxes(req).map(inbox => this.notificationsService.getDecisions(inbox)))).flat();
  }

  /**
   * The inbox, newest first. `?unread=true` and `?type=` filter explicitly;
   * without them the read flag removes nothing, so a caller always knows
   * whether it is looking at everything or a subset.
   */
  @Get()
  getNotifications(
    @Req() req: AuthenticatedRequest,
    @Query('unread') unread?: string,
    @Query('type') type?: string,
  ) {
    const query = { unreadOnly: unread === 'true', type };
    return this.inboxes(req)
      .flatMap((inbox) => this.notificationsService.getNotifications(inbox, query))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Unread badge count across the caller's inboxes. */
  @Get('unread-count')
  unreadCount(@Req() req: AuthenticatedRequest): { unread: number } {
    const unread = this.inboxes(req).reduce(
      (total, inbox) => total + this.notificationsService.countUnread(inbox),
      0,
    );
    return { unread };
  }

  @Post(':id/read')
  markAsRead(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    for (const inbox of this.inboxes(req)) {
      const notification = this.notificationsService.markAsRead(inbox, id);
      if (notification) return notification;
    }
    throw new NotFoundException('Notification not found');
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  markAllAsRead(@Req() req: AuthenticatedRequest): { marked: number } {
    const marked = this.inboxes(req).reduce(
      (total, inbox) => total + this.notificationsService.markAllAsRead(inbox),
      0,
    );
    return { marked };
  }
}
