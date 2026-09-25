import {
  Controller, Get, Post, Body, Param, Query, Req, UseGuards,
  HttpCode, HttpStatus, ParseIntPipe,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { ProjectResponse, ProjectProvenanceResponse } from './interfaces/project.interface';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { RequireIntent } from '../common/decorators/require-intent.decorator';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: CreateProjectDto, @Req() req: any): Promise<ProjectResponse> {
    const ownerAddress = req.user?.walletAddress || req.headers['x-wallet-address'] || '';
    return this.projectsService.register(dto, ownerAddress);
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

  @Get(':id/provenance')
  async provenance(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProjectProvenanceResponse> {
    return this.projectsService.getProvenance(id);
  }

  @Post(':id/approve')
  @UseGuards(JwtAuthGuard, AdminGuard, IntentGuard)
  @RequireIntent('approve_project')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProjectResponse> {
    return this.projectsService.approve(id);
  }

  @Post(':id/reject')
  @UseGuards(JwtAuthGuard, AdminGuard, IntentGuard)
  @RequireIntent('reject_project')
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

  @Get(':id/export')
  @UseGuards(JwtAuthGuard)
  async exportProject(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ): Promise<any> {
    const auditorAddress = req.user?.walletAddress || '';
    return this.projectsService.exportProject(id, auditorAddress);
  }

  @Get(':id/documents/:hash')
  async getDocument(
    @Param('id', ParseIntPipe) id: number,
    @Param('hash') hash: string,
  ): Promise<any> {
    return this.projectsService.getDocument(id, hash);
  }

  @Post(':id/documents/:hash/flag-audit')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async flagDocumentAsAudit(
    @Param('id', ParseIntPipe) id: number,
    @Param('hash') hash: string,
    @Body() body: { disputeId?: string },
  ): Promise<any> {
    return this.projectsService.flagDocumentAsAudit(id, hash, body?.disputeId);
  }

  @Post(':id/documents/:hash/escalate')
  @HttpCode(HttpStatus.ACCEPTED)
  async escalateDocument(
    @Param('id', ParseIntPipe) id: number,
    @Param('hash') hash: string,
  ): Promise<any> {
    return this.projectsService.escalateDocument(id, hash);
  }

  @Get(':id/documents/:hash/health')
  async getDocumentHealth(
    @Param('id', ParseIntPipe) id: number,
    @Param('hash') hash: string,
  ): Promise<any> {
    return this.projectsService.getDocumentHealth(id, hash);
  }
}
