import { createRequire } from "node:module";
import { env } from "../../config/env";

const require = createRequire(import.meta.url);
export const ee = require("@google/earthengine");

/**
 * `ee.initialize()` is process-global in the Earth Engine Node SDK — calling it
 * more than once (e.g. once per GEE-backed provider service) is unsafe. This
 * module memoizes the auth+init promise so every provider (TropomiService,
 * EmitService, ...) shares a single Earth Engine session per process.
 */
let geeReady: Promise<void> | null = null;

export function isGeeConfigured(): boolean {
  return !!(
    env.GEE_PROJECT_ID?.trim() &&
    (env.GEE_PRIVATE_KEY_JSON?.trim() ||
      (env.GEE_SERVICE_ACCOUNT_EMAIL?.trim() && env.GEE_PRIVATE_KEY?.trim()))
  );
}

export function ensureEarthEngineReady(): Promise<void> {
  if (geeReady) return geeReady;

  geeReady = new Promise<void>((resolve, reject) => {
    const privateKey = parseGeePrivateKey();
    ee.data.authenticateViaPrivateKey(
      privateKey,
      () => {
        ee.initialize(
          null,
          null,
          () => resolve(undefined),
          (err: unknown) => reject(new Error(`Earth Engine initialization failed: ${formatGeeError(err)}`)),
          null,
          env.GEE_PROJECT_ID,
        );
      },
      (err: unknown) => reject(new Error(`Earth Engine authentication failed: ${formatGeeError(err)}`)),
    );
  }).catch((err) => {
    geeReady = null;
    throw err;
  });

  return geeReady;
}

export function parseGeePrivateKey(): Record<string, unknown> {
  if (env.GEE_PRIVATE_KEY_JSON?.trim()) {
    try {
      return JSON.parse(env.GEE_PRIVATE_KEY_JSON);
    } catch (err) {
      throw new Error(`Invalid GEE_PRIVATE_KEY_JSON: ${(err as Error).message}`);
    }
  }

  const clientEmail = env.GEE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = env.GEE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!clientEmail || !privateKey) {
    throw new Error("Missing Google Earth Engine service-account credentials");
  }

  return {
    type: "service_account",
    project_id: env.GEE_PROJECT_ID,
    client_email: clientEmail,
    private_key: privateKey,
  };
}

export function evaluateEe<T>(obj: any): Promise<T> {
  return new Promise((resolve, reject) => {
    obj.evaluate((result: T, err: unknown) => {
      if (err) reject(new Error(formatGeeError(err)));
      else resolve(result);
    });
  });
}

export function formatGeeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
