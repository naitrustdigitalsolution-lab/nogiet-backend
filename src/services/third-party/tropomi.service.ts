import { env } from "../../config/env";
import type { NormalizedSource } from "../../types/index";
import { NIGERIA_BBOX, isInsideBBox, type BBox } from "./carbon-mapper.service";
import { CacheService } from "../cache.service";

const ONE_DAY_SEC = 24 * 60 * 60;
const SEVEN_DAYS_SEC = 7 * ONE_DAY_SEC;

export function tropomiCacheKey(): string {
  return "nogiet:tropomi:scenes:CH4";
}

export function tropomiStaleKey(): string {
  return "nogiet:tropomi:scenes:CH4:stale";
}

/**
 * Sentinel-5P TROPOMI integration via the Copernicus Data Space Ecosystem (CDSE) OData API.
 *
 * The reference guide ships three reference methods (Google Earth Engine,
 * `sentinelsat`, Microsoft Planetary Computer) — **all three require Python and
 * heavy scientific tooling (NetCDF, xarray, GEE auth)**. None of them are
 * realistic to run inside a Node service that serves live map data.
 *
 * The CDSE OData catalogue exposes the same Sentinel-5P L2 CH4 corpus over a
 * plain HTTPS REST interface, requires **no API key** for catalogue browsing,
 * and returns scene metadata (footprint polygon, acquisition time, processing
 * version, S3 download path) in JSON. That's what this service uses.
 *
 * Trade-off: scene metadata does **not** include per-pixel CH4 ppb values —
 * those live in the raw NetCDF files referenced by `S3Path`. So each
 * `NormalizedSource` we emit represents a *satellite pass over Nigeria*, not a
 * detected plume. The map renders these as small low-intensity markers at the
 * scene centroid; they communicate coverage, not quantitative emissions.
 *
 * To upgrade to actual CH4 values you have two practical options:
 *   1. Run a separate Python batch job (GEE or NetCDF) on a cron, push
 *      pre-aggregated grid stats into Postgres, and serve them via a new route.
 *   2. Subscribe to SentinelHub Statistical API (paid) and add an OAuth-based
 *      service that returns aggregated `methane_mixing_ratio_bias_corrected`
 *      stats for a viewport. The shape returned would replace the placeholder
 *      `emissionRate: 0` below with a real ppb-derived value.
 *
 * Resilience model mirrors `ImeoService`:
 *   - 24h Redis cache of normalized scenes
 *   - 7-day long-lived stale fallback for outages
 *   - In-flight dedup so concurrent callers share a single upstream fetch
 */
export class TropomiService {
  private baseUrl: string;
  private fetchPromise: Promise<NormalizedSource[]> | null = null;

  constructor(private cache?: CacheService) {
    this.baseUrl = (env.TROPOMI_API_URL ?? "").replace(/\/$/, "");
  }

  /**
   * CDSE catalogue browsing is public, so we treat the service as "configured"
   * whenever the base URL is set. An API key would only be needed for raw
   * NetCDF download flows we don't perform here.
   */
  get isConfigured(): boolean {
    return !!this.baseUrl;
  }

  /** Standard fetch path. Returns cached scenes filtered to the caller's bbox. */
  async fetchSources(bbox?: BBox): Promise<NormalizedSource[]> {
    if (!this.isConfigured) return [];
    const all = await this.fetchAllSourcesCached();
    return bbox ? all.filter((s) => isInsideBBox(s.latitude, s.longitude, bbox)) : all;
  }

  /** Force-refresh path. Busts the 24h cache; still falls back to stale on failure. */
  async refreshSources(bbox?: BBox): Promise<NormalizedSource[]> {
    if (!this.isConfigured) return [];
    if (this.cache) await this.cache.del(tropomiCacheKey());
    const all = await this.fetchAllSourcesCached();
    return bbox ? all.filter((s) => isInsideBBox(s.latitude, s.longitude, bbox)) : all;
  }

  // ---------- Cached fetch core ----------

  private async fetchAllSourcesCached(): Promise<NormalizedSource[]> {
    const key = tropomiCacheKey();

    if (this.cache) {
      const cached = await this.cache.get<NormalizedSource[]>(key);
      if (cached && cached.length > 0) return cached;
    }

    return this.fetchAndCache();
  }

  private async fetchAndCache(): Promise<NormalizedSource[]> {
    if (this.fetchPromise) return this.fetchPromise;

    this.fetchPromise = this.fetchAllSourcesLive()
      .then(async (sources) => {
        if (this.cache && sources.length > 0) {
          await this.cache.set(tropomiCacheKey(), sources, ONE_DAY_SEC);
          await this.cache.set(tropomiStaleKey(), sources, SEVEN_DAYS_SEC);
        }
        return sources;
      })
      .catch(async (err: any) => {
        console.warn("[TROPOMI] live fetch failed:", err?.message ?? String(err));
        if (this.cache) {
          const stale = await this.cache.get<NormalizedSource[]>(tropomiStaleKey());
          if (stale && stale.length) {
            console.warn(
              `[TROPOMI] serving STALE cache (${stale.length} scenes) — refresh blocked.`,
            );
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

  /**
   * Single live OData query: most recent N scenes of the configured product type
   * over the configured bbox in the configured window. Throws on HTTP failure
   * so the caller's `.catch` can decide whether to serve stale data.
   */
  private async fetchAllSourcesLive(): Promise<NormalizedSource[]> {
    const url = this.buildCatalogueUrl();
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`CDSE OData returned ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { value?: any[] };
    const records = Array.isArray(body?.value) ? body.value : [];

    if (env.TROPOMI_LOG_RESPONSE) {
      console.log(`[TROPOMI] CDSE returned ${records.length} scenes`);
      if (records[0]) {
        console.log("[TROPOMI] first raw record:", JSON.stringify(records[0]).slice(0, 600));
      }
    }

    const normalized: NormalizedSource[] = [];
    for (const raw of records) {
      const n = this.normalize(raw);
      if (n) normalized.push(n);
    }
    return normalized;
  }

  /**
   * Build a CDSE OData `Products` query for the configured collection + product
   * type intersecting the configured (or default Nigeria) bbox in the window.
   * OData syntax reference: https://documentation.dataspace.copernicus.eu/APIs/OData.html
   */
  private buildCatalogueUrl(): string {
    const bbox = this.envBBox() ?? NIGERIA_BBOX;
    const sinceIso = this.windowStartIso();
    const polygon = bboxToWktPolygon(bbox);

    const filterClauses = [
      `Collection/Name eq '${env.TROPOMI_COLLECTION}'`,
      `contains(Name,'${env.TROPOMI_PRODUCT_TYPE}')`,
      `OData.CSC.Intersects(area=geography'SRID=4326;${polygon}')`,
      `ContentDate/Start gt ${sinceIso}`,
    ];

    // OData query strings must be URL-encoded. URLSearchParams handles that for us.
    const params = new URLSearchParams({
      "$filter": filterClauses.join(" and "),
      "$orderby": "ContentDate/Start desc",
      "$top": String(env.TROPOMI_MAX_RESULTS),
    });

    return `${this.baseUrl}/Products?${params.toString()}`;
  }

  /**
   * Maps one CDSE OData product record to a NormalizedSource. Returns `null`
   * when the record can't be placed on the map (no resolvable footprint).
   *
   * Centroid strategy: TROPOMI L2 footprints are long N-S swaths (~2,600 km
   * wide) that span far beyond Nigeria. Naïve vertex-averaging would put the
   * marker in the Sahel for a scene that "covered Nigeria" — actively
   * misleading. So we first clip the polygon vertices to the configured bbox
   * before averaging; the marker ends up over the portion of the swath that
   * actually intersected the AOI. Falls back to the un-clipped centroid only
   * when zero vertices fall inside (edge cases where the swath grazes a
   * corner of the bbox).
   */
  private normalize(raw: any): NormalizedSource | null {
    const id: string = raw?.Id ?? raw?.id ?? "";
    const name: string = raw?.Name ?? "";
    if (!id || !name) return null;

    const aoi = this.envBBox() ?? NIGERIA_BBOX;
    const centroid =
      footprintCentroid(raw?.GeoFootprint, aoi) ??
      wktCentroid(raw?.Footprint, aoi) ??
      footprintCentroid(raw?.GeoFootprint) ??
      wktCentroid(raw?.Footprint);
    if (!centroid) return null;

    const start: string = raw?.ContentDate?.Start ?? raw?.OriginDate ?? "";
    const end: string = raw?.ContentDate?.End ?? raw?.PublicationDate ?? start;

    // Best-effort processing-mode parsing from filename, e.g. "S5P_OFFL_L2__CH4____..."
    // OFFL = Offline (~5d latency, higher quality); NRTI = Near-Real-Time (~3h, lower quality).
    const processingMode: "OFFL" | "NRTI" | "RPRO" | "OTHER" =
      /\bOFFL\b/.test(name) ? "OFFL" : /\bNRTI\b/.test(name) ? "NRTI" : /\bRPRO\b/.test(name) ? "RPRO" : "OTHER";

    return {
      id: `tropomi-${id}`,
      name,
      provider: "tropomi",
      latitude: centroid.lat,
      longitude: centroid.lon,
      // CDSE catalogue does not expose per-pixel CH4 values; this is an honest
      // placeholder. See the file header for upgrade paths.
      emissionRate: 0,
      gas: "CH4",
      sector: "Satellite Coverage",
      instrument: "TROPOMI/Sentinel-5P",
      persistence: 0,
      // We model each scene as a single "observation" so the map dot renders at
      // its base size rather than disappearing into the lowest plume-count tier.
      plumeCount: 1,
      firstDetected: start,
      lastDetected: end,
      metadata: {
        cdseProductId: id,
        processingMode,
        contentLength: raw?.ContentLength ?? 0,
        s3Path: raw?.S3Path ?? "",
        footprint: raw?.Footprint ?? null,
        note: "CDSE catalogue scene metadata. Centroid shown — see s3Path for raw NetCDF.",
      },
    };
  }

  private envBBox(): BBox | null {
    const raw = (env.TROPOMI_BBOX ?? "").trim();
    if (!raw) return null;
    const parts = raw.split(",").map((p) => Number(p.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [minLon, minLat, maxLon, maxLat] = parts;
    return { minLon, minLat, maxLon, maxLat };
  }

  private windowStartIso(): string {
    const cutoff = new Date(Date.now() - env.TROPOMI_DAYS_BACK * 86_400_000);
    // CDSE expects unquoted ISO-8601 timestamps in the `gt` clause.
    return cutoff.toISOString();
  }
}

// ---------- Geometry helpers ----------

interface Centroid {
  lat: number;
  lon: number;
}

/**
 * Computes the centroid of a CDSE `GeoFootprint` GeoJSON Polygon / MultiPolygon
 * by averaging vertices. When `clip` is supplied, only vertices inside that
 * bbox are averaged — see the call-site comment for why this matters with
 * TROPOMI's long swath footprints.
 */
function footprintCentroid(geo: any, clip?: BBox): Centroid | null {
  if (!geo || typeof geo !== "object") return null;
  const coords: number[][] = [];
  if (geo.type === "Polygon" && Array.isArray(geo.coordinates?.[0])) {
    for (const ring of geo.coordinates) {
      for (const pt of ring) {
        if (Array.isArray(pt) && pt.length >= 2) coords.push([pt[0], pt[1]]);
      }
    }
  } else if (geo.type === "MultiPolygon" && Array.isArray(geo.coordinates)) {
    for (const polygon of geo.coordinates) {
      for (const ring of polygon) {
        for (const pt of ring) {
          if (Array.isArray(pt) && pt.length >= 2) coords.push([pt[0], pt[1]]);
        }
      }
    }
  }
  return averageCoords(clip ? coords.filter((p) => insideBBox(p, clip)) : coords);
}

/**
 * Falls back to parsing the OData `Footprint` WKT string when GeoFootprint
 * isn't present. Format: `POLYGON((lon lat, lon lat, ...))` or `SRID=4326;POLYGON(...)`.
 */
function wktCentroid(wkt: string | undefined, clip?: BBox): Centroid | null {
  if (!wkt || typeof wkt !== "string") return null;
  const match = wkt.match(/POLYGON\s*\(\(([^)]+)\)\)/i);
  if (!match) return null;
  const coords = match[1]
    .split(",")
    .map((pair) => pair.trim().split(/\s+/).map(Number))
    .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return averageCoords(clip ? coords.filter((p) => insideBBox(p, clip)) : coords);
}

function insideBBox(point: number[], bbox: BBox): boolean {
  const [lon, lat] = point;
  return lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat;
}

function averageCoords(coords: number[][]): Centroid | null {
  if (coords.length === 0) return null;
  let lon = 0;
  let lat = 0;
  for (const [x, y] of coords) {
    lon += x;
    lat += y;
  }
  return { lon: lon / coords.length, lat: lat / coords.length };
}

/** Builds a WKT POLYGON string for the OData spatial filter. */
function bboxToWktPolygon(bbox: BBox): string {
  const { minLon, minLat, maxLon, maxLat } = bbox;
  return (
    `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ` +
    `${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`
  );
}
