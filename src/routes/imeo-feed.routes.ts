import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middlewares/auth.middleware";
import { ImeoFeedController } from "../controllers/imeo-feed.controller";

export function imeoFeedRoutes(fastify: FastifyInstance, controller: ImeoFeedController) {
  const superAdmin = [authenticate, authorize("super_admin")];
  fastify.get("/imeo-feed/status", { preHandler: superAdmin, handler: controller.status });
  fastify.get("/imeo-feed/history", { preHandler: superAdmin, handler: controller.history });
  fastify.post("/imeo-feed/upload", { preHandler: superAdmin, handler: controller.upload });
  fastify.post("/imeo-feed/preview", { preHandler: superAdmin, handler: controller.preview });
  fastify.post("/imeo-feed/batches/:batchId/restore", { preHandler: superAdmin, handler: controller.restore });
  fastify.get("/imeo-feed/batches/:batchId/download", { preHandler: superAdmin, handler: controller.download });
  fastify.delete("/imeo-feed/batches/:batchId", { preHandler: superAdmin, handler: controller.deleteBatch });
  fastify.post("/imeo-feed/test-api", { preHandler: superAdmin, handler: controller.testApi });
  fastify.put("/imeo-feed/mode", { preHandler: superAdmin, handler: controller.setMode });
  fastify.get("/data-feeds/:provider/status", { preHandler: superAdmin, handler: controller.status });
  fastify.get("/data-feeds/:provider/history", { preHandler: superAdmin, handler: controller.history });
  fastify.get("/data-feeds/:provider/sample/:format", { preHandler: superAdmin, handler: controller.sample });
  fastify.post("/data-feeds/:provider/upload", { preHandler: superAdmin, handler: controller.upload });
  fastify.post("/data-feeds/:provider/preview", { preHandler: superAdmin, handler: controller.preview });
  fastify.post("/data-feeds/:provider/batches/:batchId/restore", { preHandler: superAdmin, handler: controller.restore });
  fastify.get("/data-feeds/:provider/batches/:batchId/download", { preHandler: superAdmin, handler: controller.download });
  fastify.delete("/data-feeds/:provider/batches/:batchId", { preHandler: superAdmin, handler: controller.deleteBatch });
  fastify.post("/data-feeds/:provider/test-api", { preHandler: superAdmin, handler: controller.testApi });
  fastify.put("/data-feeds/:provider/mode", { preHandler: superAdmin, handler: controller.setMode });
}
