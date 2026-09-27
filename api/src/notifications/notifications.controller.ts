import { Controller, Get, Post, Param, Req, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  getNotifications(@Req() req: any) {
    const userId = req.user?.sub || req.user?.id || 'unknown';
    return this.notificationsService.getNotifications(userId);
  }

  @Post(':id/read')
  markAsRead(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.sub || req.user?.id || 'unknown';
    return this.notificationsService.markAsRead(userId, id);
  }
}
