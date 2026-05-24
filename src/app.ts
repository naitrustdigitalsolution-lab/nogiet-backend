import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Server as SocketIOServer } from "socket.io";

import { env } from "./config/env";
import { errorHandler } from "./middlewares/error-handler.middleware";
import { requestLogger } from "./middlewares/request-logger.middleware";

import { UserRepository } from "./repositories/user.repository";
import { EmissionRepository } from "./repositories/emission.repository";
import { RoleRepository } from "./repositories/role.repository";

import { AuthService } from "./services/auth.service";
import { UserService } from "./services/user.service";
import { EmissionService } from "./services/emission.service";
import { RoleService } from "./services/role.service";
import { EmailService } from "./services/email/email.service";
import { SmsService } from "./services/sms/sms.service";
import { CarbonMapperService } from "./services/third-party/carbon-mapper.service";
import { ImeoService } from "./services/third-party/imeo.service";
import { TropomiService } from "./services/third-party/tropomi.service";
import { SatelliteAggregatorService } from "./services/third-party/satellite-aggregator.service";
import { CloudflareR2Service } from "./services/third-party/cloudflare-r2.service";
import { CacheService } from "./services/cache.service";

import { AuthController } from "./controllers/auth.controller";
import { UserController } from "./controllers/user.controller";
import { EmissionController } from "./controllers/emission.controller";
import { RoleController } from "./controllers/role.controller";
import { UploadController } from "./controllers/upload.controller";

import { authRoutes } from "./routes/auth.routes";
import { userRoutes } from "./routes/user.routes";
import { emissionRoutes } from "./routes/emission.routes";
import { roleRoutes } from "./routes/role.routes";
import { uploadRoutes } from "./routes/upload.routes";

export interface AppContext {
  fastify: FastifyInstance;
  emissionService: EmissionService;
}

export async function buildApp(db: any): Promise<AppContext> {
  const fastify = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  // --- Plugins ---
  await fastify.register(cors, {
    origin: [env.FRONTEND_URL],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await fastify.register(helmet, { contentSecurityPolicy: false });

  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await fastify.register(jwt, { secret: env.JWT_SECRET });
  await fastify.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  await fastify.register(cookie);

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: "NOGIET API",
        description: "Nigerian Oil and Gas Methane Portal API",
        version: "1.0.0",
      },
      servers: [{ url: `http://localhost:${env.PORT}` }],
    },
  });

  await fastify.register(swaggerUi, { routePrefix: "/docs" });

  // --- Global hooks ---
  fastify.setErrorHandler(errorHandler);
  // fastify.addHook("onRequest", requestLogger);

  // --- Dependency injection ---
  const userRepo = new UserRepository(db);
  const emissionRepo = new EmissionRepository(db);
  const roleRepo = new RoleRepository(db);

  const emailService = new EmailService();
  const smsService = new SmsService();
  const carbonMapper = new CarbonMapperService();
  const r2 = new CloudflareR2Service();
  const cacheService = new CacheService();
  // IMEO + TROPOMI share the resilience pattern: 24h Redis cache + 7-day stale
  // fallback. Both upstreams are unreliable from arbitrary egress IPs (IMEO via
  // Cloudflare WAF, CDSE via occasional 5xx) so stale fallback keeps the map
  // populated through outages.
  const imeoService = new ImeoService(cacheService);
  const tropomiService = new TropomiService(cacheService);
  const aggregator = new SatelliteAggregatorService(carbonMapper, imeoService, tropomiService, cacheService);

  const authService = new AuthService(userRepo, emailService, smsService, fastify);
  const userService = new UserService(userRepo, emailService);
  const emissionService = new EmissionService(emissionRepo, carbonMapper, cacheService, aggregator, emailService, smsService, userRepo, imeoService);
  const roleService = new RoleService(roleRepo);

  const authController = new AuthController(authService);
  const userController = new UserController(userService);
  const emissionController = new EmissionController(emissionService);
  const roleController = new RoleController(roleService);
  const uploadController = new UploadController(r2);

  // --- Routes ---
  fastify.register(
    async (instance) => {
      authRoutes(instance, authController);
      userRoutes(instance, userController);
      emissionRoutes(instance, emissionController);
      roleRoutes(instance, roleController);
      uploadRoutes(instance, uploadController);
    },
    { prefix: "/api/v1" }
  );

  fastify.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // --- Socket.IO (attached directly to Fastify's raw HTTP server) ---
  fastify.ready().then(() => {
    const io = new SocketIOServer(fastify.server, {
      cors: {
        origin: [env.FRONTEND_URL],
        credentials: true,
      },
    });

    emissionService.setSocketIO(io);

    io.on("connection", (socket) => {
      fastify.log.info(`[Socket.IO] client connected: ${socket.id}`);
      socket.on("disconnect", () => {
        fastify.log.info(`[Socket.IO] client disconnected: ${socket.id}`);
      });
    });
  });

  return { fastify, emissionService };
}
