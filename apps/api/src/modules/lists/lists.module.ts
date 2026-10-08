import { Module } from '@nestjs/common';
import { ListsController } from './lists.controller';
import { ListsService } from './lists.service';
import { ReviewDueService } from './review-due.service';

@Module({
  controllers: [ListsController],
  providers: [ListsService, ReviewDueService],
})
export class ListsModule {}
