import { ProxyAgent } from "undici";
import { env } from "../../config/env";
import type { NormalizedSource } from "../../types/index";
import { isInsideBBox, type BBox } from "./carbon-mapper.service";
import { CacheService } from "../cache.service";
import { SATELLITE_REFRESH_INTERVAL_SEC } from "./satellite-refresh.constants";

/** Cache key helper — mirrors `bboxCacheKey` from CarbonMapperService. */
export function imeoCacheKey(gasType: string): string {
  return `nogiet:imeo:plumes:${gasType}`;
}
/** Stale fallback key — read when fresh fetch fails (CF block etc). */
export function imeoStaleKey(gasType: string): string {
  return `nogiet:imeo:plumes:${gasType}:stale`;
}

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

/**
 * UNEP IMEO — Eye on Methane **API v2** (actively maintained).
 * Docs: https://methanedata.unep.org/api/docs (OAS 3.0).
 *
 * V2 Plume Detection endpoints used here:
 *  - GET /api/v2/plumes_w_wo_sources         → all plume detections (list)
 *  - GET /api/v2/plumes/{id_source}          → plumes by MARS source ID
 *  - GET /api/v2/plumes_last_update          → last data update timestamp
 *  - GET /api/v2/plumes/image/{id_plume}     → plume satellite image (binary)
 *
 * Auth (v2): Swagger Authorize gives a Bearer JWT; some accounts only get an API key
 * (then `X-API-Key`). Client-specific access is passed as `X-Nogiet-Token` when configured.
 * `IMEO_AUTH_MODE=auto` (default) tries Bearer, then `X-API-Key` on 401/403.
 *
 * Use host **methanedata.unep.org**. The hostname `api.methanedata.unep.org` often does not
 * resolve in DNS, which yields a useless Node error: `fetch failed`.
 */
function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  const chain = err as Error & { cause?: unknown };
  if (chain.cause instanceof Error) {
    parts.push(`cause: ${chain.cause.message}`);
    const ce = chain.cause as NodeJS.ErrnoException;
    if (ce.code) parts.push(`code: ${ce.code}`);
  }
  const top = err as NodeJS.ErrnoException;
  if (top.code && !parts.some((p) => p.includes(top.code!))) parts.push(`code: ${top.code}`);
  return parts.join(" | ");
}

function toNum(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function extractRecords(data: unknown): unknown[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data !== "object") return [];
  const d = data as Record<string, unknown>;

  if (Array.isArray(d.results)) return d.results;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d.records)) return d.records;
  if (Array.isArray(d.plumes)) return d.plumes;
  if (d.features && Array.isArray(d.features)) return d.features as unknown[];
  if (d.type === "FeatureCollection" && Array.isArray(d.features)) return d.features as unknown[];

  return [];
}

function resolveNextUrl(base: string, next: unknown): string | null {
  if (typeof next !== "string" || !next.length) return null;
  if (next.startsWith("http")) return next;
  try {
    const u = new URL(base);
    return new URL(next, `${u.origin}/`).toString();
  } catch {
    return null;
  }
}

/** Normalize configured base URL to v2 prefix and a resolvable host. */
function normalizeImeoBaseUrl(raw: string): string {
  let u = raw.replace(/\/$/, "");
  u = u.replace(/^https?:\/\/api\.methanedata\.unep\.org/i, "https://methanedata.unep.org");
  if (!u) return "https://methanedata.unep.org/api/v2";
  if (/\/v1$/i.test(u)) return u.replace(/\/v1$/i, "/api/v2");
  if (u === "https://methanedata.unep.org" || u === "http://methanedata.unep.org") {
    return `${u}/api/v2`;
  }
  return u;
}

export interface ImeoPlumeImage {
  contentType: string;
  bytes: Buffer;
}

export class ImeoService {
  private baseUrl: string;
  private cachedAuthHeaders: Record<string, string> | null = null;
  private proxyDispatcher: ProxyAgent | null = null;
  /** In-flight dedupe — mirrors CarbonMapperService pattern in EmissionService. */
  private fetchPromise: Promise<NormalizedSource[]> | null = null;
  /**
   * Set whenever a live fetch is rejected by Cloudflare's WAF before reaching the
   * IMEO API (403 + "Just a moment..." body). Surfaced via `lastBlockedReason` so
   * the completeness audit can distinguish "blocked, awaiting UNEP whitelist" from
   * a generic "configured but no data" gap. Cleared on the next successful fetch.
   */
  private lastBlockedReason: string | null = null;

  /** Non-null when the most recent live fetch was blocked by Cloudflare, not an auth/config issue. */
  get lastBlockedReasonPublic(): string | null {
    return this.lastBlockedReason;
  }

  constructor(private cache?: CacheService) {
    this.baseUrl = normalizeImeoBaseUrl(env.IMEO_API_URL ?? "");
    if (env.IMEO_PROXY_URL) {
      try {
        this.proxyDispatcher = new ProxyAgent(env.IMEO_PROXY_URL);
        console.log(`[IMEO v2] using proxy ${env.IMEO_PROXY_URL.replace(/:[^:@]+@/, ":***@")}`);
      } catch (e) {
        console.warn("[IMEO v2] invalid IMEO_PROXY_URL:", (e as Error).message);
      }
    }
  }

  private async doFetch(url: string, init?: RequestInit): Promise<Response> {
    const opts: RequestInit & { dispatcher?: ProxyAgent } = { ...init };
    if (this.proxyDispatcher) opts.dispatcher = this.proxyDispatcher;
    return fetch(url, opts as RequestInit);
  }

  get isConfigured(): boolean {
    return !!(env.IMEO_API_KEY?.trim() || env.IMEO_NOGIET_TOKEN?.trim());
  }

  // ---------- Auth ----------

  private buildHeaders(scheme: "bearer" | "x-api-key" | "both"): Record<string, string> {
    // Strip whitespace and surrounding quotes accidentally included in the env value.
    const token = (env.IMEO_API_KEY ?? "").replace(/^['"\s]+|['"\s]+$/g, "");
    const nogietToken = (env.IMEO_NOGIET_TOKEN ?? "").replace(/^['"\s]+|['"\s]+$/g, "");
    // X-Nigeria-Traffic identifies our requests in IMEO's Cloudflare logs (per UNEP support).
    // Honest UA + minimal headers — no browser spoofing, since UNEP wants to allowlist by tag.
    const common: Record<string, string> = {
      accept: "*/*",
      "user-agent": "NOGIET-Backend/1.0 (Nigerian Oil & Gas Industry Emissions Tracker)",
      "X-Nigeria-Traffic": "1",
    };
    if (nogietToken) common["X-Nogiet-Token"] = nogietToken;
    if (env.IMEO_COOKIE) common.cookie = env.IMEO_COOKIE;
    if (!token) return common;
    if (scheme === "x-api-key") return { ...common, "X-API-Key": token };
    if (scheme === "both") return { ...common, Authorization: `Bearer ${token}`, "X-API-Key": token };
    return { ...common, Authorization: `Bearer ${token}` };
  }

  /**
   * First request decides the auth scheme; subsequent requests reuse cached headers.
   * `auto`: Bearer → on 401/403 → X-API-Key.
   */
  private async fetchAuthed(url: string, init?: RequestInit): Promise<Response> {
    const mode = env.IMEO_AUTH_MODE ?? "bearer";

    if (this.cachedAuthHeaders) {
      return this.doFetch(url, { ...init, headers: { ...this.cachedAuthHeaders, ...(init?.headers ?? {}) } });
    }

    if (mode !== "auto") {
      const headers = this.buildHeaders(mode);
      const response = await this.doFetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
      if (response.ok) this.cachedAuthHeaders = headers;
      return response;
    }

    let headers = this.buildHeaders("bearer");
    let response = await this.doFetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (response.status === 401 || response.status === 403) {
      headers = this.buildHeaders("x-api-key");
      response = await this.doFetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
      if (response.ok && env.NODE_ENV === "development") {
        console.log("[IMEO v2] authenticated with X-API-Key (Bearer was rejected)");
      }
    }
    if (response.ok) this.cachedAuthHeaders = headers;
    return response;
  }

  // ---------- Public API ----------

  /**
   * Fetches all IMEO plume detections, applying:
   *   1. fresh Redis cache hit → return immediately
   *   2. miss → fetch live + dedupe in-flight calls
   *   3. live fetch failure (e.g. Cloudflare 403) → fall back to **stale** cached copy
   *
   * Mirrors `EmissionService.getAllSourcesCached` + `fetchAndCache` (CarbonMapper) pattern.
   * `bbox` and `iso3cd` are NOT sent to IMEO (no documented filter for `/plumes_w_wo_sources`);
   * filtering happens in-memory after the cached global fetch via `applyFilters()`.
   */
  async fetchSources(bbox?: BBox, gasType: string = "CH4"): Promise<NormalizedSource[]> {
    if (!this.isConfigured) return [];
    const all = await this.fetchAllSourcesCached(gasType);
    return this.applyFilters(all, bbox);
  }

  /** Force-refresh path. Bypasses fresh cache; still falls back to stale on failure. */
  async refreshSources(bbox?: BBox, gasType: string = "CH4"): Promise<NormalizedSource[]> {
    if (!this.isConfigured) return [];
    if (this.cache) await this.cache.del(imeoCacheKey(gasType));
    const all = await this.fetchAllSourcesCached(gasType);
    return this.applyFilters(all, bbox);
  }

  /** Bypasses every cache and stale fallback; used before enabling API mode. */
  async testLiveConnection(bbox?: BBox): Promise<NormalizedSource[]> {
    if (!this.isConfigured) throw new Error("IMEO API credentials are not configured");
    const all = await this.fetchAllSourcesLive();
    return this.applyFilters(all, bbox);
  }

  /**
   * Applies env-controlled filters in order:
   *   1. country (`IMEO_COUNTRY_FILTER`, ISO3 list)
   *   2. sector  (`IMEO_SECTOR_FILTER`, comma-separated substrings — default "oil and gas")
   *   3. bbox    (caller-supplied)
   *
   * Each filter accepts `*` or `ALL` to disable.
   */
  private applyFilters(all: NormalizedSource[], bbox?: BBox): NormalizedSource[] {
    let out = all;

    const countryEnv = (env.IMEO_COUNTRY_FILTER ?? "").trim().toUpperCase();
    if (countryEnv && countryEnv !== "*" && countryEnv !== "ALL") {
      const allow = new Set(countryEnv.split(",").map((s) => s.trim()).filter(Boolean));
      out = this.getSourcesByCountry(out, allow);
    }

    const sectorEnv = (env.IMEO_SECTOR_FILTER ?? "").trim().toLowerCase();
    if (sectorEnv && sectorEnv !== "*" && sectorEnv !== "all") {
      const needles = sectorEnv.split(",").map((s) => s.trim()).filter(Boolean);
      out = this.getSourcesBySector(out, needles);
    }

    if (bbox) out = this.getSourcesInBBox(out, bbox);
    return out;
  }

  /** Symmetric helper to CarbonMapperService.getSourcesInBBox. */
  getSourcesInBBox(allSources: NormalizedSource[], bbox: BBox): NormalizedSource[] {
    return allSources.filter((s) => isInsideBBox(s.latitude, s.longitude, bbox));
  }

  /** Filters by ISO 3166-1 alpha-3 code(s) using the per-record `iso3cd` metadata. */
  getSourcesByCountry(
    allSources: NormalizedSource[],
    iso3: string | Iterable<string>,
  ): NormalizedSource[] {
    const allow =
      typeof iso3 === "string"
        ? new Set([iso3.toUpperCase()])
        : new Set(Array.from(iso3, (s) => s.toUpperCase()));
    return allSources.filter((s) => {
      const code = (s.metadata?.iso3cd as string | undefined)?.toUpperCase();
      return !!code && allow.has(code);
    });
  }

  /**
   * Case-insensitive substring filter over `sector`. A row is kept if its sector
   * contains ANY of the supplied needles. Designed for the IMEO use case where the
   * sector column contains long phrases like "Oil and Gas" or "Coal Mining".
   */
  getSourcesBySector(
    allSources: NormalizedSource[],
    needles: string[] | Iterable<string>,
  ): NormalizedSource[] {
    const list = Array.from(needles, (n) => n.toLowerCase().trim()).filter(Boolean);
    if (list.length === 0) return allSources;
    return allSources.filter((s) => {
      const sector = (s.sector ?? "").toLowerCase();
      if (!sector) return false;
      return list.some((needle) => sector.includes(needle));
    });
  }

  /** Mirror of CarbonMapperService.getSourceDetail — looks up first plume by MARS source id. */
  async getSourceDetail(idSource: string): Promise<NormalizedSource | null> {
    const rows = await this.getPlumesBySource(idSource);
    if (!rows.length) return null;
    return this.normalize(rows[0], "plumes");
  }

  // ---------- Cached fetch core ----------

  private async fetchAllSourcesCached(gasType: string): Promise<NormalizedSource[]> {
    const key = imeoCacheKey(gasType);

    if (this.cache) {
      const cached = await this.cache.get<NormalizedSource[]>(key);
      if (cached && cached.length > 0) return cached;
    }

    return this.fetchAndCache(gasType);
  }

  private async fetchAndCache(gasType: string): Promise<NormalizedSource[]> {
    if (this.fetchPromise) return this.fetchPromise;

    this.fetchPromise = this.fetchAllSourcesLive()
      .then(async (sources) => {
        if (this.cache && sources.length > 0) {
          await this.cache.set(imeoCacheKey(gasType), sources, SATELLITE_REFRESH_INTERVAL_SEC);
          // Long-lived stale copy for resilience (CF blocks, IMEO downtime).
          await this.cache.set(imeoStaleKey(gasType), sources, SEVEN_DAYS_SEC);
        }
        return sources;
      })
      .catch(async (err) => {
        console.warn("[IMEO v2] live fetch failed:", formatFetchError(err));
        if (this.cache) {
          const stale = await this.cache.get<NormalizedSource[]>(imeoStaleKey(gasType));
          if (stale && stale.length) {
            console.warn(`[IMEO v2] serving STALE cache (${stale.length} sources) — refresh blocked.`);
            return stale;
          }
        }
        return [];
      })
      .finally(() => {
        this.fetchPromise = null;
      });

    return this.fetchPromise;
  }

  /** Single live call to /plumes_w_wo_sources + normalize. Throws on failure. */
  private async fetchAllSourcesLive(): Promise<NormalizedSource[]> {
    const items = await this.fetchPagedResource("plumes_w_wo_sources");

    if (items.records.length === 0 && items.firstStatus !== 200) {
      throw new Error(`/plumes_w_wo_sources returned ${items.firstStatus}`);
    }

    this.lastBlockedReason = null;

    const normalized: NormalizedSource[] = [];
    for (const raw of items.records) {
      const n = this.normalize(raw, "plumes");
      if (n) normalized.push(n);
    }

    if (env.NODE_ENV === "development") {
      console.log(
        `[IMEO v2] /plumes_w_wo_sources → fetched ${items.records.length} raw, normalized ${normalized.length}`,
      );
    }
    return normalized;
  }

  /** GET /api/v2/plumes/{id_source} — raw plume rows for a MARS source id. */
  async getPlumesBySource(idSource: string): Promise<unknown[]> {
    if (!this.isConfigured) return [];
    const id = encodeURIComponent(idSource);
    try {
      const response = await this.fetchAuthed(`${this.baseUrl}/plumes/${id}`);
      if (!response.ok) {
        console.warn(`[IMEO v2] /plumes/${idSource} → ${response.status} ${response.statusText}`);
        return [];
      }
      const data: unknown = await response.json();
      return extractRecords(data);
    } catch (err) {
      console.warn("[IMEO v2] /plumes/{id_source} failed:", formatFetchError(err));
      return [];
    }
  }

  /** GET /api/v2/plumes_last_update — last-update timestamp for plume data. */
  async getLastUpdate(): Promise<string | null> {
    if (!this.isConfigured) return null;
    try {
      const response = await this.fetchAuthed(`${this.baseUrl}/plumes_last_update`);
      if (!response.ok) {
        console.warn(`[IMEO v2] /plumes_last_update → ${response.status} ${response.statusText}`);
        return null;
      }
      const data: unknown = await response.json();
      if (typeof data === "string") return data;
      if (data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        const v = d.last_update ?? d.last_updated ?? d.timestamp ?? d.updated_at ?? d.value;
        if (typeof v === "string") return v;
        if (typeof v === "number") return new Date(v).toISOString();
      }
      return null;
    } catch (err) {
      console.warn("[IMEO v2] /plumes_last_update failed:", formatFetchError(err));
      return null;
    }
  }

  /** GET /api/v2/plumes/image/{id_plume} — plume satellite image (binary). */
  async getPlumeImage(idPlume: string): Promise<ImeoPlumeImage | null> {
    if (!this.isConfigured) return null;
    const id = encodeURIComponent(idPlume);
    try {
      const response = await this.fetchAuthed(`${this.baseUrl}/plumes/image/${id}`, {
        headers: { Accept: "image/*,application/octet-stream" },
      });
      if (!response.ok) {
        console.warn(`[IMEO v2] /plumes/image/${idPlume} → ${response.status} ${response.statusText}`);
        return null;
      }
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const buf = Buffer.from(await response.arrayBuffer());
      return { contentType, bytes: buf };
    } catch (err) {
      console.warn("[IMEO v2] /plumes/image/{id_plume} failed:", formatFetchError(err));
      return null;
    }
  }

  // ---------- Internal helpers ----------

  private async fetchPagedResource(
    resource: string,
  ): Promise<{ records: unknown[]; firstStatus: number }> {
    const collected: unknown[] = [];
    let url: string | null = `${this.baseUrl}/${resource}`;
    let pages = 0;
    const maxPages = 20;
    let loggedEnvelope = false;
    let firstStatus = 0;

    while (url && pages < maxPages) {
      const response = await this.fetchAuthed(url);
      if (pages === 0) firstStatus = response.status;

      if (!response.ok) {
        if (pages === 0 && (response.status === 401 || response.status === 403)) {
          const tokLen = (env.IMEO_API_KEY ?? "").trim().length;
          let body = "";
          try {
            body = (await response.clone().text()).slice(0, 240);
          } catch { /* ignore */ }
          const looksCloudflare = /cloudflare|just a moment|cf-ray|cf-mitigated/i.test(body);
          if (looksCloudflare) {
            this.lastBlockedReason =
              "Blocked by Cloudflare WAF — egress IP not yet whitelisted by UNEP. " +
              "Email unep-methanedata@un.org to whitelist, or set IMEO_PROXY_URL / IMEO_COOKIE as a stop-gap.";
            console.warn(
              `[IMEO v2] BLOCKED BY CLOUDFLARE (${response.status}). Not an auth problem — your egress IP is being challenged. ` +
              "Fixes: (1) email unep-methanedata@un.org to whitelist your server IP; (2) set IMEO_PROXY_URL to a clean residential proxy; " +
              "(3) solve the challenge once in a browser at https://methanedata.unep.org/api/docs and paste cf_clearance into IMEO_COOKIE.",
            );
          } else {
            console.warn(
              `[IMEO v2] auth rejected (${response.status}). mode=${env.IMEO_AUTH_MODE} tokenLen=${tokLen} body="${body}"`,
            );
          }
        }
        console.warn(`[IMEO v2] ${url} → ${response.status} ${response.statusText}`);
        if (pages === 0) return { records: [], firstStatus: response.status };
        break;
      }

      const data: unknown = await response.json();

      if (!loggedEnvelope && (env.IMEO_LOG_RESPONSE || env.NODE_ENV === "development")) {
        loggedEnvelope = true;
        const keys = data && typeof data === "object" ? Object.keys(data as object) : [];
        const sample = extractRecords(data).slice(0, 1);
        console.log(`[IMEO v2] /${resource} envelope keys:`, keys);
        console.log("[IMEO v2] first raw record:", JSON.stringify(sample[0] ?? null, null, 2));
      }

      const batch = extractRecords(data);
      collected.push(...batch);

      const d = data as Record<string, unknown>;
      const nextUrl: string | null =
        resolveNextUrl(url, d.next) ??
        resolveNextUrl(url, d.next_page_url) ??
        resolveNextUrl(url, d.links && typeof d.links === "object"
          ? (d.links as Record<string, unknown>).next
          : null);

      if (nextUrl && nextUrl !== url) {
        url = nextUrl;
        pages += 1;
        continue;
      }
      break;
    }

    return { records: collected, firstStatus: firstStatus || 200 };
  }

  // ---------- Normalization ----------

  /** GeoJSON-aware normalize wrapper. */
  normalize(item: unknown, listKind: "plumes" | "events" = "plumes"): NormalizedSource | null {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;

    if (row.type === "Feature") {
      const p = (row.properties && typeof row.properties === "object" ? row.properties : {}) as Record<
        string,
        unknown
      >;
      if (!row.geometry || typeof row.geometry !== "object") return this.normalizeFlat(p, listKind);
      const g = row.geometry as Record<string, unknown>;
      if (g.type === "Point" && Array.isArray(g.coordinates)) {
        const [lon, lat] = g.coordinates as [number, number];
        return this.normalizeFlat({ ...p, lon, lat, longitude: lon, latitude: lat }, listKind);
      }
      // UNEP downloadable plume GeoJSON uses Polygon/MultiPolygon geometry but
      // includes plume centroid `lat`/`lon` in properties.
      return this.normalizeFlat(p, listKind);
    }
    return this.normalizeFlat(row, listKind);
  }

  private normalizeFlat(event: Record<string, unknown>, listKind: "plumes" | "events"): NormalizedSource | null {
    const lat =
      toNum(event.latitude) ??
      toNum(event.lat) ??
      toNum(event.Latitude) ??
      toNum((event.location as Record<string, unknown>)?.lat);
    const lon =
      toNum(event.longitude) ??
      toNum(event.lon) ??
      toNum(event.lng) ??
      toNum(event.Longitude) ??
      toNum((event.location as Record<string, unknown>)?.lon);

    if (lat == null || lon == null) return null;
    if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return null;

    const idRaw =
      event.id_plume ??
      event.id_mars_plume ??
      event.plume_id ??
      event.plumeId ??
      event.id ??
      event.uuid ??
      event.id_source ??
      event.id_mars_source ??
      event.mars_id ??
      `${lat.toFixed(4)}_${lon.toFixed(4)}`;
    const idStr = String(idRaw);

    const idSource =
      (event.id_mars_source ??
        event.id_source ??
        event.source_id ??
        event.mars_id ??
        "") as string | number;
    const sourceName = String(
      event.source_name ??
        event.sourceName ??
        event.name ??
        event.facility_name ??
        event.title ??
        event.asset_name ??
        event.site_name ??
        event.basin ??
        (idSource ? `IMEO source ${String(idSource).slice(0, 8)}` : `IMEO ${idStr.slice(0, 12)}`),
    );

    const emissionRate =
      toNum(event.ch4_fluxrate) ??
      toNum(event.emission_rate) ??
      toNum(event.emissionRate) ??
      toNum(event.estimated_emission) ??
      toNum(event.estimated_emission_rate) ??
      toNum(event.methane_emission_rate) ??
      toNum(event.emission_rate_kgh) ??
      toNum(event.rate_kg_hr) ??
      toNum(event.flux_kg_hr) ??
      toNum(event.flux) ??
      toNum(event.quantification) ??
      toNum(event.total_emission) ??
      0;
    const emissionRateStd = toNum(event.ch4_fluxrate_std) ?? toNum(event.total_emission_std);

    const gas = String(event.gas ?? event.gas_type ?? "CH4");
    const sector = String(event.sector ?? event.category ?? event.subsector ?? event.asset_type ?? "");
    const instrument = String(
      event.satellite ?? event.instrument ?? event.sensor ?? event.platform ?? "IMEO",
    );
    const persistence = toNum(event.persistence) ?? 0;

    const plumeCount =
      toNum(event.plume_count) ??
      toNum(event.plumeCount) ??
      toNum(event.detection_count) ??
      1;

    const firstDetected = String(
      event.tile_date ??
        event.first_detected ??
        event.start_date ??
        event.detection_date ??
        event.observation_date ??
        event.detected_at ??
        event.created_at ??
        "",
    );
    const lastDetected = String(
      event.last_update ??
        event.last_detected ??
        event.end_date ??
        event.updated_at ??
        event.modified_at ??
        firstDetected,
    );

    // Compose IMEO plume image URL: img_path (CDN base) + img_ch4_cropped (relative path).
    let plumeImageUrl: string | undefined;
    const imgPath = typeof event.img_path === "string" ? event.img_path.replace(/\/$/, "") : "";
    const imgCropped = typeof event.img_ch4_cropped === "string" ? event.img_ch4_cropped.replace(/^\//, "") : "";
    if (imgPath && imgCropped) plumeImageUrl = `${imgPath}/${imgCropped}`;

    // Country: keep both human name and ISO 3166-1 alpha-3 code for filtering.
    const countryName = (event.country ?? event.country_code ?? "") as string;
    const iso3cd =
      typeof event.iso3cd === "string"
        ? event.iso3cd.toUpperCase()
        : typeof event.country_code === "string" && event.country_code.length === 3
          ? event.country_code.toUpperCase()
          : undefined;

    const meta: Record<string, unknown> = {
      imeoEventId: idStr,
      imeoResource: listKind === "plumes" ? "plume" : "event",
      idSource: idSource || undefined,
      idMarsPlume: event.id_mars_plume,
      idMarsSource: event.id_mars_source,
      country: countryName || iso3cd,
      iso3cd,
      status: event.status,
      notification_level: event.notification_level,
      operator: event.operator ?? event.operator_name,
      confidence: event.confidence ?? event.uncertainty,
      emissionUncertainty: emissionRateStd,
      windSpeed: toNum(event.wind_speed),
      basin: event.basin,
      source_link: event.url ?? event.permalink ?? event.detail_url,
      plumeImageUrl,
    };

    for (const k of Object.keys(event)) {
      if (meta[k] === undefined && !["latitude", "longitude", "lat", "lon", "lng", "geometry"].includes(k)) {
        const v = event[k];
        if (v != null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
          meta[k] = v;
      }
    }

    return {
      id: `imeo-${idStr}`,
      name: sourceName,
      provider: "imeo",
      latitude: lat,
      longitude: lon,
      emissionRate,
      gas,
      sector,
      instrument,
      persistence,
      plumeCount: Math.max(0, Math.round(plumeCount)),
      firstDetected,
      lastDetected,
      metadata: meta,
    };
  }
}
