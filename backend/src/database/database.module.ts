import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TENANT_REPOSITORIES } from './repositories/tenant.repositories';
import { IDENTITY_REPOSITORIES } from './repositories/identity.repositories';
import { EXECUTION_REPOSITORIES } from './repositories/execution.repositories';
import { AUTOMATION_REPOSITORIES } from './repositories/automation.repositories';
import { DISTRIBUTED_REPOSITORIES } from './repositories/distributed.repositories';

const REPOSITORIES = [
  ...TENANT_REPOSITORIES,
  ...IDENTITY_REPOSITORIES,
  ...EXECUTION_REPOSITORIES,
  ...AUTOMATION_REPOSITORIES,
  ...DISTRIBUTED_REPOSITORIES,
];

/**
 * Global so feature modules can inject repositories without re-importing.
 * PrismaService itself is exported only for the health check and migration
 * tooling — feature services must depend on a repository, never on Prisma.
 */
@Global()
@Module({
  providers: [PrismaService, ...REPOSITORIES],
  exports: [PrismaService, ...REPOSITORIES],
})
export class DatabaseModule {}
