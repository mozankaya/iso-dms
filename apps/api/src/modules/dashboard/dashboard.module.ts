import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [ApprovalsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
