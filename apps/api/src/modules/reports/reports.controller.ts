import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { FindingsDto, FinanceReportDto, JobListDto, JobQueryDto, OrganizerSalesDto, OrganizerSalesQueryDto, PeriodQueryDto, ReconciliationDto, RestartDto } from '../../common/flows.dto.js';
import { appError } from '../../common/result.js';
import { ReportsService } from './reports.service.js';

@ApiTags('reports')
@ApiBearerAuth()
@ApiErrors()
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Roles('organizer')
  @Get('organizer/reports/sales')
  @ApiOkResponse({ type: OrganizerSalesDto })
  organizer(@CurrentUser() user: AuthUser, @Query() q: OrganizerSalesQueryDto): Promise<OrganizerSalesDto> {
    return this.reports.organizer(user.id, q.from, q.to, q.eventId);
  }

  @Roles('finance')
  @Get('finance/reports')
  @ApiOkResponse({ type: FinanceReportDto })
  finance(@Query() q: PeriodQueryDto): Promise<FinanceReportDto> {
    return this.reports.finance(q.from, q.to);
  }

  @Roles('finance')
  @Get('finance/reconciliation')
  @ApiOkResponse({ type: ReconciliationDto })
  reconciliation(): Promise<ReconciliationDto> {
    return this.reports.reconcile();
  }

  @Roles('finance')
  @Post('finance/reconciliation/run')
  @HttpCode(200)
  @ApiOkResponse({ type: FindingsDto })
  async runReconciliation(): Promise<FindingsDto> {
    return { found: await this.reports.runReconciliation() };
  }

  @Roles('finance')
  @Get('finance/jobs')
  @ApiOkResponse({ type: JobListDto })
  async jobs(@Query() q: JobQueryDto): Promise<JobListDto> {
    return { items: await this.reports.jobs(q.status) };
  }

  @Roles('finance')
  @Post('finance/jobs/:id/restart')
  @HttpCode(200)
  @ApiOkResponse({ type: RestartDto })
  async restart(@Param('id', ParseUUIDPipe) id: string): Promise<RestartDto> {
    const restarted = await this.reports.restart(id);
    if (!restarted) throw new AppException(appError('CONFLICT', 'Only failed or stuck jobs can be restarted'));
    return { restarted };
  }
}
