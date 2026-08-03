import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  // `rawBody` keeps the exact request bytes alongside the parsed body.
  // Node-to-node signatures cover those bytes, and re-serializing a parsed
  // object would change key order or spacing and fail a valid signature.
  const app = await NestFactory.create(AppModule, { bufferLogs: false, rawBody: true });
  const config = app.get(ConfigService);

  const apiPrefix = config.get<string>('apiPrefix', 'api/v1');
  app.setGlobalPrefix(apiPrefix);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.enableCors({
    origin: true,
    credentials: true,
    // The organization selector must survive CORS preflight.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id', 'X-Request-Id'],
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
