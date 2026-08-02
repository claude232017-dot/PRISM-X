import { Global, Module } from '@nestjs/common';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { ProviderRegistry } from './provider-registry.service';
import { ProviderManager } from './provider-manager.service';

/**
 * Global because the Provider Manager is the single gateway every AI call
 * passes through — the worker runtime and mission orchestrator both depend on
 * it, and requiring each to import this module would add noise without adding
 * safety.
 */
@Global()
@Module({
  controllers: [ProvidersController],
  providers: [ProvidersService, ProviderRegistry, ProviderManager],
  exports: [ProvidersService, ProviderRegistry, ProviderManager],
})
export class ProvidersModule {}
