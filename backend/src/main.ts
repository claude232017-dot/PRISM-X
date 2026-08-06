import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { recordApiOperationCount } from './production/readiness.service';
import { verifyEgressPolicies } from './shared/http/egress-policies';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Before anything is listening: every registered outbound policy is checked
  // against the destinations no policy may reach.
  //
  // What this catches is a *code* regression — someone reordering the checks
  // in `permits()` so an allowlist is consulted before the deny floor, or
  // shrinking `ALWAYS_DENIED`. A misconfigured allowlist does not reach here,
  // because it cannot: an entry naming 169.254.0.0/16 is already inert by
  // construction. Both failure modes are covered, at the layer each belongs
  // to, and this is the one worth dying for — an unhandled throw is the
  // intended outcome, since a process that cannot enforce its egress policy
  // has no safe degraded mode.
  verifyEgressPolicies();

  // `rawBody` keeps the exact request bytes alongside the parsed body.
  // Node-to-node signatures cover those bytes, and re-serializing a parsed
  // object would change key order or spacing and fail a valid signature.
  const app = await NestFactory.create(AppModule, { bufferLogs: false, rawBody: true });
  const config = app.get(ConfigService);

  const environment = String(config.get('app.environment') ?? process.env.NODE_ENV ?? 'development');
  const isProduction = environment === 'production';

  const apiPrefix = config.get<string>('apiPrefix', 'api/v1');
  app.setGlobalPrefix(apiPrefix);

  // Behind a load balancer the client address arrives in a header. Trusting
  // the proxy is what makes rate limiting and IP restrictions see the caller
  // rather than the balancer — and it is opt-in, because trusting it when
  // nothing terminates in front lets any caller spoof their own address.
  if (config.get<boolean>('app.trustProxy') ?? process.env.TRUST_PROXY === 'true') {
    app.getHttpAdapter().getInstance().set?.('trust proxy', 1);
  }

  app.use(
    helmet({
      // The API serves JSON, not documents, so a content policy buys nothing
      // here — but the Swagger UI it also serves needs inline styles.
      contentSecurityPolicy: false,
      // Told to browsers only when TLS actually terminates in front; sending
      // HSTS from a plaintext deployment locks users out of it.
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
      noSniff: true,
    }),
  );

  // `origin: true` reflects whatever origin asks, which in production is a
  // wildcard wearing a disguise: every authenticated browser session becomes
  // an API key for any site the user visits. Production must name its origins.
  const configuredOrigins = String(
    config.get<string>('app.corsOrigins') ?? process.env.CORS_ORIGINS ?? '',
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (isProduction && !configuredOrigins.length) {
    throw new Error(
      'CORS_ORIGINS must list the permitted origins in production. ' +
        'Reflecting any origin would expose every authenticated session.',
    );
  }

  app.enableCors({
    origin: configuredOrigins.length ? configuredOrigins : true,
    credentials: true,
    // The organization selector must survive CORS preflight.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Organization-Id',
      'X-Request-Id',
      'X-Api-Key',
    ],
    exposedHeaders: ['X-Request-Id', 'X-Instance-Id', 'X-RateLimit-Remaining', 'Retry-After'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown keys and reject requests that send them, so a client
      // cannot smuggle fields (organizationId, role) past a DTO.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableShutdownHooks();

  if (config.get<boolean>('swagger.enabled')) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('PRISM-X API')
        .setDescription(
          'Backend for the PRISM-X Intelligence Operating System.\n\n' +
            '**Authentication** — every endpoint except those marked public requires a ' +
            'bearer token from `POST /auth/login`.\n\n' +
            '**Organization scoping** — a token resolves to one organization. Accounts ' +
            'belonging to several workspaces select one with the `X-Organization-Id` ' +
            'header; otherwise the first active membership is used. Every query is ' +
            'scoped to that organization in the repository layer, and Postgres ' +
            'row-level security enforces the same boundary independently.\n\n' +
            '**Permissions** — endpoints declare the `resource:action` permissions they ' +
            'need. A caller missing one receives 403 naming the missing permission.',
        )
        .setVersion('1.0.0')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'bearer',
        )
        .addGlobalParameters({
          name: 'X-Organization-Id',
          in: 'header',
          required: false,
          description: 'Act within a specific organization.',
          schema: { type: 'string' },
        })
        .addTag('Auth', 'Registration, sessions, password reset')
        .addTag('Organizations', 'Workspaces and membership')
        .addTag('Workers', 'Autonomous agents')
        .addTag('Missions', 'Objectives and their task graphs')
        .addTag('Knowledge', 'Stored knowledge and insights')
        .addTag('Providers', 'Intelligence provider registration')
        .addTag('Integrations', 'External system connectors')
        .addTag('Extensions', 'Installed extensions')
        .addTag('Events', 'Domain event log')
        .addTag('Analytics', 'Aggregate metrics')
        .addTag('Storage', 'File storage')
        .addTag('Queues', 'Background job queues')
        .addTag('Nodes', 'The fleet of machines PRISM-X executes on')
        .addTag('Distributed Execution', 'Placing, migrating and monitoring work across nodes')
        .addTag('Distributed Memory', 'Replicated state and its synchronisation')
        .addTag('Federation', 'Sharing resources between organizations')
        .addTag('Node Agent', 'Machine-to-machine endpoints, authenticated by node signature')
        .addTag('Health', 'Liveness and dependencies')
        .build(),
    );

    SwaggerModule.setup(config.get<string>('swagger.path', 'docs'), app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
      customSiteTitle: 'PRISM-X API',
    });

    // The readiness review asks how much of the API is documented. Counting
    // here, from the document that is actually served, keeps the answer
    // truthful — re-deriving it later could produce a different number.
    recordApiOperationCount(
      Object.values(document.paths ?? {}).reduce(
        (total, path) =>
          total +
          Object.keys(path).filter((method) =>
            ['get', 'post', 'put', 'patch', 'delete'].includes(method),
          ).length,
        0,
      ),
    );
  }

  const port = config.get<number>('port', 3000);
  await app.listen(port);

  logger.log(`PRISM-X backend listening on :${port}/${apiPrefix}`);
  logger.log(`Auth driver: ${config.get('auth.driver')} · Storage: ${config.get('storage.driver')}`);
  if (config.get<boolean>('swagger.enabled')) {
    logger.log(`API documentation: :${port}/${config.get('swagger.path')}`);
  }
}

void bootstrap();
