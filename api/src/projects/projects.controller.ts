import {
  Controller, Get, Post, Body, Param, Query,
  HttpCode, HttpStatus, ParseIntPipe, UseGuards, Req,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PrivacyExportService } from '../common/services/privacy-export.service';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { ProjectResponse } from './interfaces/project.interface';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService, private readonly privacyExport: PrivacyExportService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: CreateProjectDto): Promise<ProjectResponse> {
    return this.projectsService.register(dto, '');
  }

  @Get()
  async findAll(@Query() query: PaginationDto) {
    return this.projectsService.findAll(query.page, query.limit);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProjectResponse> {
    return this.projectsService.findOne(id);
  }

  @Get(':id/export')
  @UseGuards(JwtAuthGuard)
  async exportProject(@Param('id', ParseIntPipe) id: number, @Req() request: AuthenticatedRequest) {
    return this.privacyExport.exportProject(await this.projectsService.findOne(id), request.user.walletAddress);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProjectResponse> {
    return this.projectsService.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProjectResponse> {
    return this.projectsService.reject(id);
  }

  @Post(':id/documents')
  @HttpCode(HttpStatus.OK)
  async uploadDocuments(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { files: any[] },
  ): Promise<any> {
    return this.projectsService.uploadDocuments(id, body.files || []);
  }
}
