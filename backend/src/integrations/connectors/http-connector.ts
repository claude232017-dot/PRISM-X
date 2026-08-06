import { Logger } from '@nestjs/common';
import { IntegrationCategory } from '@prisma/client';
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
 * A declarative description of an HTTP service.
 *
 * Most integrations differ only in base URL, how the credential is attached,
 * and which endpoint each action maps to. Expressing that as data rather than
 * a class means a new connector is a ~20-line object with no logic to get
 * wrong, and every one of them inherits identical error classification,
 * templating and health behaviour.
 */
export interface HttpConnectorSpec {
  kind: string;
  displayName: string;
  category: IntegrationCategory;
  /** api_key | bearer | basic | oauth2 | none */
  authMethod: string;
  baseUrl: string;
  /** Builds auth headers from the decrypted secret. */
  auth: (secret: string, options: Record<string, unknown>) => Record<string, string>;
  /** Endpoint used by authenticate()/healthCheck(). */
  probe?: { method: string; path: string };
  actions: (ConnectorAction & {
    method: string;
    /** Supports `{{field}}` interpolation from the action input. */
    path: string;
    /** Body template; `{{field}}` placeholders resolve against input. */
    body?: Record<string, unknown>;
    /** Reads the created object's id out of the response. */
    externalIdPath?: string;
  })[];
}

/**
 * Generic HTTP connector driven by a spec.
 *
 * Everything service-specific lives in the spec; everything shared lives here.
 */
export class HttpConnector implements IConnector {
  private readonly logger: Logger;
  private connected = false;

  constructor(
    private readonly spec: HttpConnectorSpec,
    private readonly config: ConnectorConfig,
  ) {
    this.logger = new Logger(`Connector:${spec.kind}`);
  }

  get kind(): string {
    return this.spec.kind;
  }
  get displayName(): string {
    return this.spec.displayName;
  }
  get category(): IntegrationCategory {
    return this.spec.category;
  }
  get authMethod(): string {
    return this.spec.authMethod;
  }
  get actions(): ConnectorAction[] {
    return this.spec.actions.map(({ method: _m, path: _p, body: _b, ...rest }) => rest);
  }

  async connect(): Promise<void> {
    // REST services are connectionless; the flag exists so `disconnect` and
    // repeated `connect` calls behave predictably for stateful connectors
    // added later.
    this.connected = true;
  }

  async authenticate(): Promise<void> {
    if (this.spec.authMethod !== 'none' && !this.config.secret) {
      throw new ConnectorError(
        `${this.spec.displayName} requires a credential but none is configured`,
        false,
      );
    }
    if (!this.spec.probe) return;

    // A reachable host with a rejected credential is not authenticated, so the
    // probe has to be a real authenticated call rather than a ping.
    await this.request(this.spec.probe.method, this.spec.probe.path, undefined);
  }

  async validate(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    if (this.spec.authMethod !== 'none' && !this.config.secret) {
      errors.push('No credential configured');
    }
    const baseUrl = (this.config.options.baseUrl as string) ?? this.spec.baseUrl;
    if (!baseUrl) errors.push('No base URL configured');
    else if (!/^https?:\/\//.test(baseUrl)) errors.push(`Base URL "${baseUrl}" is not a valid URL`);

    return { valid: errors.length === 0, errors };
  }

  async execute(action: string, input: Record<string, unknown>): Promise<ConnectorResult> {
    const definition = this.spec.actions.find((a) => a.key === action);
    if (!definition) {
      throw new ConnectorError(
        `${this.spec.displayName} has no action "${action}". Available: ` +
          this.spec.actions.map((a) => a.key).join(', '),
        false,
      );
    }

    // Operator-granted permissions are checked before the call leaves the
    // process — an integration configured read-only cannot be talked into
    // writing by a workflow step.
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

    const path = interpolate(definition.path, input);
    const body = definition.body ? resolveTemplate(definition.body, input) : input;

    const payload = await this.request(
      definition.method,
      path,
      definition.method === 'GET' ? undefined : body,
    );

    return {
      ok: true,
      data: payload,
      externalId: definition.externalIdPath
        ? String(readPath(payload, definition.externalIdPath) ?? '')
        : undefined,
      raw: payload,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async healthCheck(): Promise<ConnectorHealth> {
    const startedAt = Date.now();
    try {
      await this.authenticate();
      return { healthy: true, latencyMs: Date.now() - startedAt, checkedAt: new Date() };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startedAt,
        message: (error as Error).message,
        checkedAt: new Date(),
      };
    }
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const baseUrl = ((this.config.options.baseUrl as string) ?? this.spec.baseUrl).replace(
      /\/+$/,
      '',
    );
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;

    try {
      // `baseUrl` is tenant configuration, so this is a request the platform
      // makes from inside its own network to an address a customer chose. It
      // goes through the egress guard, which resolves the name, refuses
      // private and metadata addresses, pins the socket to the address it
      // approved, and revalidates every redirect. The auth header below is one
      // of the reasons that matters — an unguarded redirect would hand the
      // tenant's own credential to whoever the `Location` names.
      const response = await this.config.http.request({
        url,
        method,
        headers: {
          'content-type': 'application/json',
          ...this.spec.auth(this.config.secret ?? '', this.config.options),
          ...((this.config.options.headers as Record<string, string>) ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
      });

      const text = response.body;
      const ok = response.status >= 200 && response.status < 300;
      if (!ok) {
        throw new ConnectorError(
          `${this.spec.displayName} returned ${response.status}: ${text.slice(0, 300)}`,
          // 429 and 5xx are transient; other 4xx will fail identically on retry.
          response.status === 429 || response.status >= 500,
          response.status,
        );
      }

      try {
        return text ? JSON.parse(text) : {};
      } catch {
        // Not every service answers with JSON.
        return { raw: text };
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new ConnectorError(`${this.spec.displayName} timed out`, true);
      }
      throw new ConnectorError(
        `${this.spec.displayName} request failed: ${(error as Error).message}`,
        true,
      );
    }
  }
}

export function httpConnectorFactory(spec: HttpConnectorSpec): ConnectorFactory {
  return {
    kind: spec.kind,
    displayName: spec.displayName,
    category: spec.category,
    authMethod: spec.authMethod,
    actions: spec.actions.map(({ method: _m, path: _p, body: _b, ...rest }) => rest),
    create: (config) => new HttpConnector(spec, config),
  };
}

// ------------------------------------------------------------------
// Templating
// ------------------------------------------------------------------

/** Replaces `{{field}}` in a string with the matching input value. */
export function interpolate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = readPath(input, key);
    return value === undefined || value === null ? '' : encodeURIComponent(String(value));
  });
}

/**
 * Resolves `{{field}}` placeholders throughout a body template.
 *
 * A placeholder that is the *entire* string resolves to the raw value, so
 * `{ "count": "{{n}}" }` yields a number rather than the string "5". Anything
 * else interpolates textually.
 */
export function resolveTemplate(
  template: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(value);
      if (whole) return readPath(input, whole[1]);
      return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
        const found = readPath(input, key);
        return found === undefined || found === null ? '' : String(found);
      });
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolve(v)]),
      );
    }
    return value;
  };

  return resolve(template) as Record<string, unknown>;
}

/** Reads a dotted path out of a nested object. */
export function readPath(source: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
      source,
    );
}
