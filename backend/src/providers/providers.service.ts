import { BadRequestException, Injectable } from '@nestjs/common';
import { Provider, ProviderStatus } from '@prisma/client';
import {
  CredentialRepository,
  ProviderRepository,
  WorkerRepository,
} from '../database/repositories/tenant.repositories';
import { CryptoService } from '../shared/crypto/crypto.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { ProviderRegistry } from './provider-registry.service';
import {
  CreateProviderDto,
  QueryProvidersDto,
  UpdateProviderDto,
} from './dto/provider.dto';
import { paginate } from '../shared/dto/pagination.dto';

/**
 * Provider registration and lifecycle.
 *
 * The API surface is deliberately one-way for secrets: an `apiKey` goes in,
 * and only a four-character hint ever comes back out. Decryption happens
 * exclusively inside ProviderRegistry when an adapter is constructed.
 */
@Injectable()
export class ProvidersService {
  constructor(
    private readonly providers: ProviderRepository,
    private readonly credentials: CredentialRepository,
    private readonly workers: WorkerRepository,
    private readonly crypto: CryptoService,
    private readonly registry: ProviderRegistry,
    private readonly events: EventBusService,
  ) {}

  async create(dto: CreateProviderDto): Promise<unknown> {
    let credentialId: string | null = null;

    if (dto.apiKey) {
      const sealed = this.crypto.seal(dto.apiKey);
      const credential = await this.credentials.create({
        name: `${dto.name} key`,
        type: 'provider_api_key',
        value: sealed.value,
        iv: sealed.iv,
        authTag: sealed.authTag,
      });
      credentialId = credential.id;
    }

    if (dto.isDefault) await this.providers.clearDefault();

    const provider = await this.providers.create({
      name: dto.name,
      kind: dto.kind,
      config: (dto.config ?? {}) as never,
      credentialId,
      isDefault: dto.isDefault ?? false,
      // A key alone does not prove the provider works; status only becomes
      // CONNECTED after a successful health check.
      status: ProviderStatus.DISCONNECTED,
    });

    await this.events.publish(DomainEvent.ProviderConnected, {
      providerId: provider.id,
      kind: provider.kind,
    });

    return this.present(provider, dto.apiKey);
  }

  async findAll(query: QueryProvidersDto) {
    const where: Record<string, unknown> = {};
    if (query.kind) where.kind = query.kind;
    if (query.status) where.status = query.status;

    const { rows, total } = await this.providers.paginate(where, {
      skip: query.skip,
      take: query.limit,
      orderBy: { [query.sortBy]: query.sortOrder },
    });

    const presented = await Promise.all(rows.map((row) => this.present(row)));
    return paginate(presented, total, query.page, query.limit);
  }

  async findOne(id: string) {
    return this.present(await this.providers.findByIdOrFail(id));
  }

  async update(id: string, dto: UpdateProviderDto) {
    const provider = await this.providers.findByIdOrFail(id);
    const patch: Record<string, unknown> = {};

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.config !== undefined) patch.config = dto.config;

    if (dto.apiKey) {
      const sealed = this.crypto.seal(dto.apiKey);
      if (provider.credentialId) {
        await this.credentials.update(provider.credentialId, {
          value: sealed.value,
          iv: sealed.iv,
          authTag: sealed.authTag,
        });
      } else {
        const credential = await this.credentials.create({
          name: `${provider.name} key`,
          type: 'provider_api_key',
          value: sealed.value,
          iv: sealed.iv,
          authTag: sealed.authTag,
        });
        patch.credentialId = credential.id;
      }
      // Rotating the key invalidates the previous health verdict.
      patch.status = ProviderStatus.DISCONNECTED;
    }

    if (dto.isDefault === true) {
      await this.providers.clearDefault();
      patch.isDefault = true;
    } else if (dto.isDefault === false) {
      patch.isDefault = false;
    }

    return this.present(await this.providers.update(id, patch));
  }

  /**
   * Probes the provider and records the verdict.
   *
   * With no adapter registered (the Phase 1 state) this reports honestly that
   * the provider cannot be reached yet, rather than reporting a false success.
   */
  async healthCheck(id: string) {
    const provider = await this.providers.findByIdOrFail(id);

    if (!this.registry.isRegistered(provider.kind)) {
      await this.providers.update(id, { lastCheckedAt: new Date() });
      return {
        providerId: id,
        healthy: false,
        status: ProviderStatus.DISCONNECTED,
        message:
          `No adapter is registered for "${provider.kind}". Provider configuration is ` +
          'stored and valid, but execution requires a Phase 2 vendor adapter.',
        checkedAt: new Date(),
      };
    }

    const adapter = await this.registry.resolve(id);
    const health = await adapter.healthCheck();
    const status = health.healthy ? ProviderStatus.CONNECTED : ProviderStatus.ERROR;

    await this.providers.update(id, { status, lastCheckedAt: health.checkedAt });
    await this.events.publish(
      health.healthy ? DomainEvent.ProviderConnected : DomainEvent.ProviderFailed,
      { providerId: id, message: health.message },
    );

    return { providerId: id, status, ...health };
  }

  async remove(id: string): Promise<void> {
    const provider = await this.providers.findByIdOrFail(id);

    // Deleting a provider that workers depend on would leave them unable to
    // run with no indication of why.
    const dependents = await this.workers.countByProvider(id);
    if (dependents > 0) {
      throw new BadRequestException(
        `${dependents} worker(s) still use this provider. Reassign them first.`,
      );
    }

    await this.providers.remove(id);
    if (provider.credentialId) await this.credentials.purge(provider.credentialId);

    await this.events.publish(DomainEvent.ProviderDisconnected, { providerId: id });
  }

  /** Shapes a provider for the API: no ciphertext, no key, just a hint. */
  private async present(provider: Provider, plaintextKey?: string) {
    let keyHint: string | null = null;

    if (plaintextKey) {
      keyHint = this.crypto.hint(plaintextKey);
    } else if (provider.credentialId) {
      const credential = await this.credentials.findById(provider.credentialId);
      if (credential) {
        keyHint = this.crypto.hint(
          this.crypto.open({
            value: credential.value,
            iv: credential.iv,
            authTag: credential.authTag,
          }),
        );
      }
    }

    return {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      status: provider.status,
      isDefault: provider.isDefault,
      config: provider.config,
      keyHint,
      adapterAvailable: this.registry.isRegistered(provider.kind),
      lastCheckedAt: provider.lastCheckedAt,
      createdAt: provider.createdAt,
    };
  }

  /** Which vendor adapters are currently registered. */
  capabilities() {
    return {
      registered: this.registry.registeredKinds(),
      note:
        'Provider configuration is fully supported in Phase 1. Vendor adapters ' +
        '(OpenAI, Anthropic, Gemini, Hermes) register against the same interface in Phase 2.',
    };
  }
}
