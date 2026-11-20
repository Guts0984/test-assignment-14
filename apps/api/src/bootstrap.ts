import { RequestMethod, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import helmet from 'helmet';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module.js';
import { jsonOnlyMiddleware, rejectNullBytes } from './common/content-type.js';
import { AllExceptionsFilter, errorMiddleware } from './common/error.filter.js';
import { requestContextMiddleware } from './common/request-id.js';
import type { Env } from './config/env.schema.js';

/** Builds the fully configured application without listening (used by main, the OpenAPI emitter and tests). */
export const createApp = async (env: Env): Promise<INestApplication> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), { bodyParser: false, logger: env.NODE_ENV === 'test' ? ['error'] : ['error', 'warn', 'log'] });
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(requestContextMiddleware(env.API_INSTANCE_ID));
  app.enableCors({ origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean), credentials: true, exposedHeaders: ['Retry-After', 'x-request-id', 'x-api-instance'] });
  app.use(jsonOnlyMiddleware);
  const keepRaw = (req: IncomingMessage & { rawBody?: Buffer }, _res: unknown, buf: Buffer): void => {
    req.rawBody = buf; // webhook signatures are computed over the exact bytes
  };
  app.use('/api/venues', json({ limit: env.VENUE_UPLOAD_LIMIT_BYTES, verify: keepRaw }));
  app.use(json({ limit: env.BODY_LIMIT_BYTES, verify: keepRaw }));
  app.use(errorMiddleware);
  app.use(rejectNullBytes);
  app.setGlobalPrefix('api', { exclude: [{ path: 'stub/*splat', method: RequestMethod.ALL }] });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  return app;
};

export const buildOpenApiDocument = (app: INestApplication) =>
  cleanupOpenApiDoc(SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Concert tickets API').setVersion('1.0').addBearerAuth().build()));
