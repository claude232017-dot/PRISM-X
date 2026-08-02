import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ProviderKind } from '@prisma/client';
import {
  IIntelligenceProvider,
  ProviderAdapterFactory,
  ProviderNotImplementedError,
  ProviderRuntimeConfig,
} from './contracts/intelligence-provider.interface';
import {
  CredentialRepository,
  ProviderRepository,
} from '../database/repositories/tenant.repositories';
import { CryptoService } from '../shared/crypto/crypto.service';

/**
 * Resolves a stored provider record into a live adapter.
 *
 * This is the single place that knows how to go from "the org's default
 * provider" to "an object you can call `.complete()` on", which means:
 *
 *  - Credentials are decrypted here and nowhere else.
 *  - Callers name a provider by id or ask for the default; they never name a
 *    vendor. Nothing outside this file mentions OpenAI or Anthropic.
 *  - Phase 1 has an empty adapter table, so `resolve()` raises a clear
 *    ProviderNotImplementedError rather than failing obscurely.
 */
@Injectable()
export class ProviderRegistry {
  private readonly logger = new Logger(ProviderRegistry.name);
  private readonly factories = new Map<ProviderKind, ProviderAdapterFactory>();

  constructor(
    private readonly providers: ProviderRepository,
    private readonly credentials: CredentialRepository,
    private readonly crypto: CryptoService,
  ) {}

  /** Registers a vendor adapter. Called by Phase 2 provider modules. */
  register(factory: ProviderAdapterFactory): void {
    if (this.factories.has(factory.kind)) {
      this.logger.warn(`Replacing existing adapter for "${factory.kind}"`);
    }
    this.factories.set(factory.kind, factory);
    this.logger.log(`Registered intelligence adapter: ${factory.kind}`);
  }

  isRegistered(kind: ProviderKind): boolean {
    return this.factories.has(kind);
  }

  registeredKinds(): ProviderKind[] {
    return [...this.factories.keys()];
  }

  /** Builds an adapter for a stored provider, decrypting its credential. */
  async resolve(providerId: string): Promise<IIntelligenceProvider> {
    const record = await this.providers.findByIdOrFail(providerId);
    const factory = this.factories.get(record.kind);
    if (!factory) throw new ProviderNotImplementedError(record.kind);

    return factory.create(await this.buildConfig(record));
  }

  /** Builds an adapter for the organization's default provider. */
  async resolveDefault(): Promise<IIntelligenceProvider> {
    const record = await this.providers.findDefault();
    if (!record) {
      throw new NotFoundException(
        'No default intelligence provider is configured for this organization',
      );
    }
    const factory = this.factories.get(record.kind);
    if (!factory) throw new ProviderNotImplementedError(record.kind);

    return factory.create(await this.buildConfig(record));
  }

  private async buildConfig(record: {
    id: string;
    credentialId: string | null;
    config: unknown;
  }): Promise<ProviderRuntimeConfig> {
    const config = (record.config ?? {}) as Record<string, unknown>;
    let apiKey: string | undefined;

    if (record.credentialId) {
      const credential = await this.credentials.findById(record.credentialId);
      if (credential) {
        apiKey = this.crypto.open({
          value: credential.value,
          iv: credential.iv,
          authTag: credential.authTag,
        });
        await this.credentials.touch(credential.id);
      }
    }

    return {
      providerId: record.id,
      apiKey,
      baseUrl: config.baseUrl as string | undefined,
      defaultModel: config.defaultModel as string | undefined,
      options: config,
    };
  }
}
