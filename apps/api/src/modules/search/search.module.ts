import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchIndexService } from './search-index.service';
import { SearchService } from './search.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService, SearchIndexService],
  exports: [SearchIndexService],
})
export class SearchModule {}
