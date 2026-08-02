import { Global, Module } from '@nestjs/common';
import {
  KeywordRetrievalStrategy,
  KnowledgeRetrievalService,
  VectorRetrievalStrategy,
} from './knowledge-retrieval.service';

/**
 * Global because both the worker runtime and the knowledge tool depend on
 * retrieval, and they live in unrelated module trees.
 */
@Global()
@Module({
  providers: [
    KnowledgeRetrievalService,
    KeywordRetrievalStrategy,
    VectorRetrievalStrategy,
  ],
  exports: [KnowledgeRetrievalService, KeywordRetrievalStrategy, VectorRetrievalStrategy],
})
export class KnowledgeRetrievalModule {}
