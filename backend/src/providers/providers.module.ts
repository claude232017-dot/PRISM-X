import { Global, Module } from '@nestjs/common';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { ProviderRegistry } from './provider-registry.service';

/**
 * Global because ProviderRegistry is the single resolution point that mission
 * execution and worker runtime will both depend on in later phases.
 */
@Global()
@Module({
  controllers: [ProvidersController],
  providers: [ProvidersService, ProviderRegistry],
  exports: [ProvidersService, ProviderRegistry],
})
export class ProvidersModule {}
