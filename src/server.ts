import "dotenv/config";
import { buildApp } from "./app";
import { env } from "./config/env";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./db/schema/index";
import { connectRedis } from "./config/redis";
import { CronService } from "./services/cron.service";

async function main() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  await connectRedis();

  const { fastify, emissionService, imeoFeedService } = await buildApp(db);

  const cronService = new CronService(emissionService, imeoFeedService);
  cronService.start();

  try {
    await fastify.listen({ port: env.PORT, host: env.HOST });
    fastify.log.info(`Server running at http://${env.HOST}:${env.PORT}`);
    fastify.log.info(`Docs at http://${env.HOST}:${env.PORT}/docs`);
  } catch (err) {
    fastify.log.error(err);
    cronService.stop();
    process.exit(1);
  }
}

main();
