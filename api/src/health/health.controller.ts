import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async getHealth(@Res() res: Response): Promise<void> {
    const report = await this.healthService.getReport();
    const statusCode =
      report.status === 'down'
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.OK;

    res.status(statusCode).json(report);
  }

  @Get('dependencies')
  async getDependencies(@Res() res: Response): Promise<void> {
    const report = await this.healthService.getReport();
    const statusCode =
      report.status === 'down'
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.OK;

    res.status(statusCode).json({
      status: report.status,
      timestamp: report.timestamp,
      dependencies: report.dependencies,
    });
  }
}
