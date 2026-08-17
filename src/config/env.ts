import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(10),
  JWT_REFRESH_SECRET: z.string().min(10),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

  CARBON_MAPPER_API_URL: z
    .string()
    .default("https://api.carbonmapper.org/api/v1"),
  CARBON_MAPPER_EMAIL: z.string().optional(),
  CARBON_MAPPER_PASSWORD: z.string().optional(),

  // UNEP IMEO v2 (Eye on Methane — https://methanedata.unep.org/api/docs)
  IMEO_API_URL: z
    .string()
    .default("https://methanedata.unep.org/api/v2"),
  /** API token / JWT from IMEO docs Authorize — see IMEO_AUTH_MODE. */
  IMEO_API_KEY: z.string().optional(),
  /** Client-provided NOGIET access token sent to IMEO as X-Nogiet-Token. */
  IMEO_NOGIET_TOKEN: z.string().optional(),
  /**
   * bearer (default): Authorization: Bearer <token> as documented in IMEO Swagger.
   * x-api-key: send X-API-Key only.
   * both: send Authorization: Bearer + X-API-Key on every request.
   * auto: Bearer first; on 401/403 retry with X-API-Key.
   */
  IMEO_AUTH_MODE: z.enum(["bearer", "x-api-key", "both", "auto"]).optional().default("bearer"),
  /** When true, logs IMEO response envelope + first raw record (server logs only). */
  IMEO_LOG_RESPONSE: z.coerce.boolean().optional().default(false),
  /** Optional outbound HTTP/HTTPS proxy used for IMEO requests (Cloudflare bypass). */
  IMEO_PROXY_URL: z.string().optional(),
  /**
   * Cloudflare clearance cookie value(s). Paste from a browser that solved the CF challenge.
   * Example: "cf_clearance=...; __cf_bm=..." — sent verbatim as the Cookie header.
   */
  IMEO_COOKIE: z.string().optional(),
  /**
   * ISO 3166-1 alpha-3 country code(s) to retain after fetching IMEO globally.
   * Example: `NGA` (Nigeria only), `NGA,CMR,NER` (Nigeria + neighbours).
   * Leave blank or set `*`/`ALL` to disable country filtering.
   */
  IMEO_COUNTRY_FILTER: z.string().optional().default("NGA"),
  /**
   * Comma-separated sector substrings to retain (case-insensitive substring match).
   * Default: `oil and gas` — keeps any record whose `sector` contains "oil and gas".
   * Set `*` or `ALL` to disable sector filtering.
   */
  IMEO_SECTOR_FILTER: z.string().optional().default("oil and gas"),
  IMEO_UPLOAD_MAX_MB: z.coerce.number().int().positive().default(50),
  MANUAL_UPLOAD_STORAGE_DIR: z.string().default("storage/manual-uploads"),

  // ---- Sentinel-5P TROPOMI (Copernicus Data Space Ecosystem) ----
  // Catalogue browsing is public (no API key required). An API key is only
  // needed when downloading the raw NetCDF granules, which this service does
  // not do — it only surfaces scene metadata.
  TROPOMI_API_URL: z
    .string()
    .default("https://catalogue.dataspace.copernicus.eu/odata/v1"),
  /** Reserved for future raw-product download flows. Empty = browse-only. */
  TROPOMI_API_KEY: z.string().optional(),
  /** Mission / collection name in CDSE OData (`SENTINEL-5P`). */
  TROPOMI_COLLECTION: z.string().default("SENTINEL-5P"),
  /** Product type substring matched via OData `contains(Name, ...)`. */
  TROPOMI_PRODUCT_TYPE: z.string().default("L2__CH4___"),
  /** Look-back window in days for scene discovery (CDSE keeps roughly the last year). */
  TROPOMI_DAYS_BACK: z.coerce.number().int().positive().default(30),
  /** Hard cap on how many scenes we hold in cache; keeps the map uncluttered. */
  TROPOMI_MAX_RESULTS: z.coerce.number().int().positive().default(50),
  /** Optional bbox override; defaults to NIGERIA_BBOX from carbon-mapper.service. */
  TROPOMI_BBOX: z.string().optional(),
  /**
   * Sector label stamped onto every normalized TROPOMI source. CDSE L2 CH4
   * scenes have no native sector classification (they're atmospheric column
   * measurements, not point sources), but the rest of the platform filters
   * by sector. Default `"Oil and Gas"` keeps TROPOMI in sync with NOGIET's
   * monitoring scope; set to e.g. `"Satellite Coverage"` to opt out of the
   * sector filter chain entirely.
   */
  TROPOMI_SECTOR_LABEL: z.string().default("Oil and Gas"),
  /**
   * When true (default), every TROPOMI scene whose AOI-clipped centroid does
   * NOT fall inside a Nigerian oil block (OML / OPL / Block polygon) is
   * dropped. This is the spatial implementation of "TROPOMI sources should
   * only return oil & gas". Set false to keep all scenes regardless of
   * acreage — useful when debugging coverage gaps.
   */
  TROPOMI_FILTER_TO_OIL_BLOCKS: z.coerce.boolean().optional().default(true),
  /** Emit the first raw CDSE record to server logs for debugging. */
  TROPOMI_LOG_RESPONSE: z.coerce.boolean().optional().default(false),
  /** Optional percentile filter for elevated TROPOMI CH4 values. Blank/0 disables enhancement filtering. */
  TROPOMI_ENHANCEMENT_PERCENTILE: z.coerce.number().min(0).max(1).optional().default(0),
  /** Optional absolute CH4 floor for TROPOMI values. If omitted, percentile-only filtering is used. */
  TROPOMI_MIN_CH4: z.coerce.number().positive().optional(),
  /** Comma-separated oil-block types used as oil/gas-sector proxy for TROPOMI. Default OML = producing acreage. */
  TROPOMI_OIL_BLOCK_TYPES: z.string().optional().default("OML"),
  /** Comma-separated basins considered oil/gas industry acreage for TROPOMI filtering. */
  TROPOMI_OIL_GAS_BASINS: z.string().optional().default("NIGER DLTA,BENIN EMBT,ANAM-NIGER,NIGER FAN,AVON FAN"),
  /** Google Earth Engine service-account config, shared by every GEE-backed provider (TROPOMI, EMIT). */
  GEE_PROJECT_ID: z.string().optional(),
  GEE_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  GEE_PRIVATE_KEY: z.string().optional(),
  /** Optional full service-account JSON string. Takes precedence over email/private key fields. */
  GEE_PRIVATE_KEY_JSON: z.string().optional(),

  // ---- NASA EMIT (via Google Earth Engine, same GEE_* credentials as TROPOMI) ----
  /** Look-back window in days for EMIT plume-complex discovery (data begins Aug 2022). */
  EMIT_DAYS_BACK: z.coerce.number().int().positive().default(1500),
  /**
   * When true (default), every EMIT plume complex is required to fall inside a
   * Nigerian oil block polygon — same "oil & gas only" spatial restriction as TROPOMI.
   */
  EMIT_FILTER_TO_OIL_BLOCKS: z.coerce.boolean().optional().default(true),
  /** Comma-separated oil-block types allowed for EMIT (mirrors TROPOMI_OIL_BLOCK_TYPES). */
  EMIT_OIL_BLOCK_TYPES: z.string().optional().default("OML"),
  /** Comma-separated basins allowed for EMIT (mirrors TROPOMI_OIL_GAS_BASINS). */
  EMIT_OIL_GAS_BASINS: z.string().optional().default("NIGER DLTA,BENIN EMBT,ANAM-NIGER,NIGER FAN,AVON FAN"),
  /** Emit the raw GEE plume properties to server logs for debugging. */
  EMIT_LOG_RESPONSE: z.coerce.boolean().optional().default(false),

  // Resend (Email)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("NOGIET Portal <noreply@nogiet.gov.ng>"),

  // Termii (SMS)
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().default("NOGIET"),
  TERMII_BASE_URL: z.string().default("https://v3.api.termii.com"),

  // Cloudflare R2 (S3-compatible storage)
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().default("nogiet"),
  R2_PUBLIC_URL: z.string().optional(),

  REDIS_URL: z.string().default("redis://localhost:6379"),

  FRONTEND_URL: z.string().default("http://localhost:5173"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:", result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
