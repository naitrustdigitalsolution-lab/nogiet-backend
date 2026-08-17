import { env } from "../../config/env";
import type { NormalizedSource } from "../../types/index";
import { NIGERIA_BBOX, isInsideBBox, type BBox } from "./carbon-mapper.service";
import { CacheService } from "../cache.service";
import { SATELLITE_REFRESH_INTERVAL_SEC } from "./satellite-refresh.constants";
import { ee, ensureEarthEngineReady, evaluateEe, isGeeConfigured } from "./gee-client";
import { findContainingOilBlock, isAllowedOilBlockFeature, loadOilBlockFeatures } from "./oil-block-filter";

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

// Cache key version. Bump when the normalized scene shape changes so old
// payloads become unreachable and a fresh fetch repopulates Redis.
// v3 = scenes now filtered to oil-block polygons (was sector-relabel only in v2).
// v4 = each scene now carries metadata.oilBlock (matched polygon name + type + operator).
// v5 = strict oil-block filtering; missing block polygons no longer fail open.
// v6 = live Google Earth Engine CH4 statistics per oil block.
// v7 = filters GEE CH4 stats to elevated methane enhancements only.
// v8 = restricts TROPOMI oil/gas-sector proxy to configured block types (default OML).
// v9 = restricts TROPOMI oil/gas-sector proxy to configured petroleum basins.
// v10 = disables enhancement filtering by default; petroleum basin filter is primary.
export function tropomiCacheKey(): string {
  return "nogiet:tropomi:scenes:CH4:v10";
}

export function tropomiStaleKey(): string {
  return "nogiet:tropomi:scenes:CH4:v10:stale";
}

const GEE_CH4_COLLECTION = "COPERNICUS/S5P/OFFL/L3_CH4";
const GEE_CH4_BAND = "CH4_column_volume_mixing_ratio_dry_air";

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
 *   - 30-minute Redis cache of normalized scenes
 *   - 7-day long-lived stale fallback for outages
 *   - In-flight dedup so concurrent callers share a single upstream fetch
 */
export class TropomiService {
  private lastDiagnostic = "TROPOMI has not been tested yet";
  private baseUrl: string;
  private fetchPromise: Promise<NormalizedSource[]> | null = null;

  constructor(private cache?: CacheService) {
    this.baseUrl = (env.TROPOMI_API_URL ?? "").replace(/\/$/, "");
  }

  /**
   * TROPOMI is enabled only when Google Earth Engine service-account credentials
   * are present. The public CDSE catalogue path is kept for metadata fallback,
   * but catalogue-only rows are not exposed as emissions.
   */
  get isConfigured(): boolean {
    return isGeeConfigured();
  }

  get diagnosticMessage(): string {
    if (!this.isConfigured) {
      return "Google Earth Engine is not configured. Set GEE_PROJECT_ID and either GEE_PRIVATE_KEY_JSON or GEE_SERVICE_ACCOUNT_EMAIL plus GEE_PRIVATE_KEY.";
    }
    return this.lastDiagnostic;
  }

  /** Standard fetch path. Returns cached scenes filtered to the caller's bbox. */
  async fetchSources(bbox?: BBox): Promise<NormalizedSource[]> {
    if (!this.isConfigured) return [];
    const all = await this.fetchAllSourcesCached();
    return bbox ? all.filter((s) => isInsideBBox(s.latitude, s.longitude, bbox)) : all;
  }

  /** Force-refresh path. Busts the fresh cache; still falls back to stale on failure. */
  async refreshSources(bbox?: BBox): Promise<NormalizedSource[]> {
    if (!this.isConfigured) return [];
    if (this.cache) await this.cache.del(tropomiCacheKey());
    const all = await this.fetchAllSourcesCached();
    return bbox ? all.filter((s) => isInsideBBox(s.latitude, s.longitude, bbox)) : all;
  }

  /** Strict health-check path: bypasses fresh and stale caches and propagates upstream failures. */
  async testLiveConnection(bbox?: BBox): Promise<NormalizedSource[]> {
    if (!this.isConfigured) throw new Error(this.diagnosticMessage);
    const all = await this.fetchAllSourcesLive();
    return bbox ? all.filter((source) => isInsideBBox(source.latitude, source.longitude, bbox)) : all;
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
          await this.cache.set(tropomiCacheKey(), sources, SATELLITE_REFRESH_INTERVAL_SEC);
          await this.cache.set(tropomiStaleKey(), sources, SEVEN_DAYS_SEC);
        }
        return sources;
      })
      .catch(async (err: any) => {
        this.lastDiagnostic = `TROPOMI upstream request failed: ${err?.message ?? String(err)}`;
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
    if (this.isConfigured) return this.fetchEarthEngineSources();

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
    if (env.TROPOMI_LOG_RESPONSE || env.NODE_ENV === "development") {
      console.log(
        `[TROPOMI] normalized ${normalized.length}/${records.length} scenes after oil-block filtering`,
      );
    }
    if (env.TROPOMI_FILTER_TO_OIL_BLOCKS && records.length > 0 && normalized.length === 0) {
      console.warn(
        "[TROPOMI] oil-block filtering removed every returned scene. " +
        "Check src/data/oil-blocks.geojson if this is unexpected.",
      );
    }
    return normalized;
  }

  private async fetchEarthEngineSources(): Promise<NormalizedSource[]> {
    this.lastDiagnostic = "Connecting to Google Earth Engine";
    await ensureEarthEngineReady();

    const features = loadOilBlockFeatures().filter((f) =>
      isAllowedOilBlockFeature(f, env.TROPOMI_OIL_BLOCK_TYPES, env.TROPOMI_OIL_GAS_BASINS)
    );
    if (features.length === 0) {
      this.lastDiagnostic = `No Nigerian oil-block polygons matched TROPOMI_OIL_BLOCK_TYPES=${env.TROPOMI_OIL_BLOCK_TYPES} and TROPOMI_OIL_GAS_BASINS=${env.TROPOMI_OIL_GAS_BASINS}.`;
      return [];
    }

    const daysBack = env.TROPOMI_DAYS_BACK;
    const start = new Date(Date.now() - daysBack * 86_400_000);
    const end = new Date();

    const eeFeatures = features.map((feature) => {
      const props = feature.properties ?? {};
      return ee.Feature(ee.Geometry(feature.geometry), {
        name: props.name ?? "Unknown Block",
        type: props.type ?? "",
        operator: props.operator ?? "",
        status: props.status ?? "",
        terrain: props.terrain ?? "",
        basin: props.basin ?? "",
      });
    });

    const oilBlocks = ee.FeatureCollection(eeFeatures);
    const ch4 = ee.ImageCollection(GEE_CH4_COLLECTION)
      .select(GEE_CH4_BAND)
      .filterDate(start.toISOString(), end.toISOString())
      .filterBounds(oilBlocks.geometry())
      .mean();

    const reduced = ch4.reduceRegions({
      collection: oilBlocks,
      reducer: ee.Reducer.mean().combine({
        reducer2: ee.Reducer.minMax(),
        sharedInputs: true,
      }),
      scale: 7000,
      crs: "EPSG:4326",
    }).filter(ee.Filter.notNull(["mean"]));

    const result = await evaluateEe<any>(reduced);
    const rows = Array.isArray(result?.features) ? result.features : [];
    if (rows.length === 0) {
      this.lastDiagnostic = `Google Earth Engine connected, but no quality-valid TROPOMI CH4 pixels were found over ${features.length} selected Nigerian oil block(s) in the last ${daysBack} days. This may be caused by cloud/quality filtering or the selected date window.`;
      return [];
    }

    const sources: NormalizedSource[] = [];
    for (const row of rows) {
      const props = row.properties ?? {};
      const mean = Number(props.mean);
      if (!Number.isFinite(mean) || mean <= 0) continue;
      const centroid = geometryCentroid(row.geometry) ?? geometryCentroid(
        features.find((f) => (f.properties?.name ?? "Unknown Block") === props.name)?.geometry,
      );
      if (!centroid) continue;
      sources.push({
        id: `tropomi-gee-${slugify(String(props.name ?? "unknown"))}`,
        name: `TROPOMI CH4 over ${props.name ?? "oil block"}`,
        provider: "tropomi",
        latitude: centroid.lat,
        longitude: centroid.lon,
        emissionRate: mean,
        gas: "CH4",
        sector: env.TROPOMI_SECTOR_LABEL,
        instrument: "TROPOMI/Sentinel-5P",
        persistence: 0,
        plumeCount: 1,
        firstDetected: start.toISOString(),
        lastDetected: end.toISOString(),
        metadata: {
          measurementType: "methane_column_mean",
          measurementUnit: "mol/m2",
          methaneMean: mean,
          methaneMin: Number.isFinite(Number(props.min)) ? Number(props.min) : undefined,
          methaneMax: Number.isFinite(Number(props.max)) ? Number(props.max) : undefined,
          daysBack,
          geeCollection: GEE_CH4_COLLECTION,
          geeBand: GEE_CH4_BAND,
          oilBlock: {
            name: props.name ?? "Unknown Block",
            type: props.type ?? "",
            operator: props.operator ?? "",
          },
          status: props.status,
          terrain: props.terrain,
          basin: props.basin,
        },
      });
    }

    const enhanced = filterTropomiEnhancements(sources);
    if (sources.length === 0) {
      this.lastDiagnostic = `Earth Engine returned ${rows.length} oil-block result(s), but none had a positive finite CH4 mean and usable geometry.`;
    } else if (enhanced.length === 0) {
      this.lastDiagnostic = `${sources.length} TROPOMI CH4 result(s) were found, but all were removed by the configured enhancement threshold (percentile=${env.TROPOMI_ENHANCEMENT_PERCENTILE}, minimum=${env.TROPOMI_MIN_CH4 ?? "none"}).`;
    } else {
      this.lastDiagnostic = `Google Earth Engine returned ${enhanced.length} usable TROPOMI CH4 observation(s) over ${features.length} selected Nigerian oil block(s).`;
    }

    if (env.TROPOMI_LOG_RESPONSE || env.NODE_ENV === "development") {
      console.log(
        `[TROPOMI/GEE] produced ${sources.length} measured oil-block CH4 statistic(s), ` +
        `${enhanced.length} elevated enhancement(s) kept`,
      );
    }
    return enhanced;
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
   * when the record can't be placed on the map OR when the scene's centroid
   * doesn't fall inside any Nigerian oil block (sector restriction).
   *
   * Centroid strategy: TROPOMI L2 footprints are long N-S swaths (~2,600 km
   * wide) that span far beyond Nigeria. Naïve vertex-averaging would put the
   * marker in the Sahel for a scene that "covered Nigeria" — actively
   * misleading. So we first clip the polygon vertices to the configured bbox
   * before averaging; the marker ends up over the portion of the swath that
   * actually intersected the AOI. Falls back to the un-clipped centroid only
   * when zero vertices fall inside (edge cases where the swath grazes a
   * corner of the bbox).
   *
   * Oil-and-gas restriction: when `TROPOMI_FILTER_TO_OIL_BLOCKS` is true
   * (default), we additionally require the resulting centroid to lie inside
   * a Nigerian oil block polygon (OML / OPL / Block). This is the user-
   * facing "only oil & gas sources" requirement — a TROPOMI swath that grazed
   * northern Nigeria but never crossed any oil-producing acreage is dropped.
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

    // Look up the containing oil block (if any). This serves two roles at once:
    //   (a) the "oil & gas only" filter — drop scenes outside any oil block when
    //       TROPOMI_FILTER_TO_OIL_BLOCKS is enabled
    //   (b) provenance — keep the matched block's name/type/operator on the
    //       NormalizedSource so the map popup can show "TROPOMI scene over OML 42"
    const matchedBlock = findContainingOilBlock(centroid.lon, centroid.lat);
    if (env.TROPOMI_FILTER_TO_OIL_BLOCKS && !matchedBlock) return null;

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
      // CDSE catalogue rows do not expose measured CH4 values. This value is
      // intentionally zero and the aggregator filters it out of emissions views.
      emissionRate: 0,
      gas: "CH4",
      // L2 CH4 scenes have no native sector classification. We stamp the
      // configured label (default "Oil and Gas") so TROPOMI participates in
      // the platform's sector filter chain like the other providers — NOGIET
      // only monitors O&G, so every scene over Nigeria is implicitly relevant.
      sector: env.TROPOMI_SECTOR_LABEL,
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
        // Block context for the frontend popup — undefined for scenes that
        // pre-date the v4 cache or were saved with filtering disabled.
        oilBlock: matchedBlock
          ? {
              name: matchedBlock.name,
              type: matchedBlock.type,
              operator: matchedBlock.operator,
            }
          : null,
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

function geometryCentroid(geometry: any): Centroid | null {
  if (!geometry || typeof geometry !== "object") return null;
  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const [lon, lat] = geometry.coordinates;
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
  }
  return footprintCentroid(geometry);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function filterTropomiEnhancements(sources: NormalizedSource[]): NormalizedSource[] {
  if (sources.length === 0) return sources;
  if (!env.TROPOMI_ENHANCEMENT_PERCENTILE || env.TROPOMI_ENHANCEMENT_PERCENTILE <= 0) {
    return sources;
  }

  const sorted = sources
    .map((s) => s.emissionRate)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const percentile = env.TROPOMI_ENHANCEMENT_PERCENTILE;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  const percentileThreshold = sorted[idx];
  const absoluteThreshold = env.TROPOMI_MIN_CH4;
  const threshold = Math.max(percentileThreshold, absoluteThreshold ?? 0);

  return sources
    .filter((s) => s.emissionRate >= threshold)
    .map((s) => ({
      ...s,
      metadata: {
        ...s.metadata,
        enhancementFilter: {
          percentile,
          percentileThreshold,
          absoluteThreshold: absoluteThreshold ?? null,
          appliedThreshold: threshold,
          populationSize: sorted.length,
        },
      },
    }));
}

/** Builds a WKT POLYGON string for the OData spatial filter. */
function bboxToWktPolygon(bbox: BBox): string {
  const { minLon, minLat, maxLon, maxLat } = bbox;
  return (
    `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ` +
    `${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`
  );
}
