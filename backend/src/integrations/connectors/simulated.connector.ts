import { IntegrationCategory } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  ConnectorAction,
  ConnectorConfig,
  ConnectorError,
  ConnectorFactory,
  ConnectorHealth,
  ConnectorResult,
  IConnector,
} from './connector.contract';

/**
 * A deterministic in-process connector (`kind: "simulated"`).
 *
 * Like the LOCAL intelligence provider, this is a real registered connector
 * rather than a test double. It exists because everything the Integration
 * Manager does around a connector — permission checks, retries, circuit
 * breaking, usage accounting, health tracking, dead-lettering — is the part
 * that must be verified, and verifying it should not require credentials for
 * ten third-party services.
 *
 * `options.simulate` injects faults, which is how retry and circuit-breaking
 * are exercised without waiting for a real outage.
 */
export interface SimulateOptions {
  failureRate?: number;
  alwaysFail?: boolean;
  retryableFailures?: boolean;
  latencyMs?: number;
  /** Fail authenticate(), to exercise the unhealthy path. */
  failAuth?: boolean;
}

const ACTIONS: ConnectorAction[] = [
  {
    key: 'send',
    description: 'Simulate delivering a message to an external service.',
    requires: 'send',
    mutates: true,
    parameters: {
      to: { type: 'string', description: 'Recipient.', required: true },
      message: { type: 'string', description: 'Body.', required: true },
    },
  },
  {
    key: 'fetch',
    description: 'Simulate reading records from an external service.',
    requires: 'read',
    mutates: false,
    parameters: {
      query: { type: 'string', description: 'What to fetch.' },
      limit: { type: 'number', description: 'How many records.' },
    },
  },
  {
    key: 'upsert',
    description: 'Simulate creating or updating a record.',
    requires: 'write',
    mutates: true,
    parameters: {
      collection: { type: 'string', description: 'Target collection.', required: true },
      record: { type: 'object', description: 'Record payload.', required: true },
    },
  },
];

export class SimulatedConnector implements IConnector {
  readonly kind = 'simulated';
  readonly displayName = 'Simulated Service';
  readonly category = IntegrationCategory.CUSTOM_API;
  readonly authMethod = 'api_key';
  readonly actions = ACTIONS;

  private readonly options: SimulateOptions;
  private callIndex = 0;
  private connected = false;

  constructor(private readonly config: ConnectorConfig) {
    this.options = (config.options.simulate as SimulateOptions) ?? {};
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async authenticate(): Promise<void> {
    if (this.options.failAuth) {
      throw new ConnectorError('Simulated authentication failure', false, 401);
    }
    if (!this.config.secret) {
      throw new ConnectorError('Simulated connector requires a credential', false, 401);
    }
  }

  async validate(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    if (!this.config.secret) errors.push('No credential configured');
    return { valid: errors.length === 0, errors };
  }

  async execute(action: string, input: Record<string, unknown>): Promise<ConnectorResult> {
    const definition = ACTIONS.find((a) => a.key === action);
    if (!definition) {
      throw new ConnectorError(`Unknown action "${action}"`, false);
    }

    const granted = this.config.permissions;
    if (granted.length > 0 && !granted.includes(definition.requires)) {
      throw new ConnectorError(
        `Integration is not granted "${definition.requires}" (needed for ${action})`,
        false,
      );
    }

    const missing = Object.entries(definition.parameters)
      .filter(([name, p]) => p.required && input[name] === undefined)
      .map(([name]) => name);
    if (missing.length) {
      throw new ConnectorError(`Missing required input: ${missing.join(', ')}`, false);
    }

    if (this.options.latencyMs) {
      await new Promise((r) => setTimeout(r, this.options.latencyMs));
    }

    const index = this.callIndex++;
    if (this.options.alwaysFail) {
      throw new ConnectorError('Simulated connector failure (alwaysFail)', this.options.retryableFailures ?? true, 503);
    }

    // Deterministic rather than random, so a test that expects the third call
    // to fail gets that on every run.
    const rate = this.options.failureRate ?? 0;
    if (rate > 0 && index % Math.max(1, Math.round(1 / rate)) === 0) {
      throw new ConnectorError(
        `Simulated connector failure (call ${index})`,
        this.options.retryableFailures ?? true,
        503,
      );
    }

    const externalId = createHash('sha256')
      .update(`${action}:${JSON.stringify(input)}:${index}`)
      .digest('hex')
      .slice(0, 12);

    return {
      ok: true,
      externalId,
      data: {
        simulated: true,
        action,
        echo: input,
        externalId,
        deliveredAt: new Date().toISOString(),
      },
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<ConnectorHealth> {
    if (this.options.alwaysFail || this.options.failAuth) {
      return {
        healthy: false,
        latencyMs: this.options.latencyMs ?? 1,
        message: 'Simulated connector is configured to fail',
        checkedAt: new Date(),
      };
    }
    return {
      healthy: Boolean(this.config.secret),
      latencyMs: this.options.latencyMs ?? 1,
      message: this.config.secret
        ? 'Simulated connector — no network call performed'
        : 'No credential configured',
      checkedAt: new Date(),
    };
  }
}

export const simulatedConnectorFactory: ConnectorFactory = {
  kind: 'simulated',
  displayName: 'Simulated Service',
  category: IntegrationCategory.CUSTOM_API,
  authMethod: 'api_key',
  actions: ACTIONS,
  create: (config) => new SimulatedConnector(config),
};
