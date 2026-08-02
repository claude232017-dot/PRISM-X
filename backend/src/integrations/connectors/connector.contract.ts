import type { IntegrationCategory } from '@prisma/client';

/**
 * The contract every external service implements.
 *
 * Six methods, deliberately: `connect` / `authenticate` / `validate` /
 * `execute` / `disconnect` / `healthCheck`. Adding a service means writing one
 * class against this interface and registering it — the Integration Manager
 * supplies retries, circuit breaking, rate limiting, credential decryption,
 * usage accounting and logging identically for all of them.
 *
 * Connectors therefore stay small and boring, which is the point: the
 * interesting behaviour belongs in one place where it can be reasoned about,
 * not duplicated fifteen times with fifteen subtle variations.
 */
export interface ConnectorConfig {
  integrationId: string;
  /** Decrypted secret. Never logged, never returned by the API. */
  secret?: string;
  /** Non-secret settings from `integration.config`. */
  options: Record<string, unknown>;
  /** Operations the operator granted this integration. */
  permissions: string[];
}

export interface ConnectorAction {
  key: string;
  description: string;
  /** Permission this action requires, checked against `permissions`. */
  requires: string;
  /** Whether the action changes external state. Governs dry-run behaviour. */
  mutates: boolean;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export interface ConnectorResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** Provider-side identifier, when the action created something. */
  externalId?: string;
  /** Raw response, retained for diagnosis. */
  raw?: unknown;
}

export interface ConnectorHealth {
  healthy: boolean;
  latencyMs?: number;
  message?: string;
  checkedAt: Date;
}

export interface IConnector {
  readonly kind: string;
  readonly displayName: string;
  readonly category: IntegrationCategory;
  /** api_key | bearer | basic | oauth2 | none */
  readonly authMethod: string;
  readonly actions: ConnectorAction[];

  /** Establishes whatever session the service needs. Often a no-op for REST. */
  connect(): Promise<void>;

  /** Proves the credential is usable. Throws ConnectorError when it is not. */
  authenticate(): Promise<void>;

  /** Checks configuration without contacting the service. */
  validate(): Promise<{ valid: boolean; errors: string[] }>;

  /** Performs one action. */
  execute(action: string, input: Record<string, unknown>): Promise<ConnectorResult>;

  /** Releases any session. Must be safe to call when never connected. */
  disconnect(): Promise<void>;

  /** Cheap liveness probe. Must not throw. */
  healthCheck(): Promise<ConnectorHealth>;
}

export interface ConnectorFactory {
  readonly kind: string;
  readonly displayName: string;
  readonly category: IntegrationCategory;
  readonly authMethod: string;
  readonly actions: ConnectorAction[];
  create(config: ConnectorConfig): IConnector;
}

/** Raised by a connector. `retryable` tells the manager whether to try again. */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}
