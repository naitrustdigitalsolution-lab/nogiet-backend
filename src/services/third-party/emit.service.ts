import { env } from "../../config/env";
import type { NormalizedSource } from "../../types/index";
import { isInsideBBox, type BBox } from "./carbon-mapper.service";
import { CacheService } from "../cache.service";
import { SATELLITE_REFRESH_INTERVAL_SEC } from "./satellite-refresh.constants";
import { ee, ensureEarthEngineReady, evaluateEe, isGeeConfigured } from "./gee-client";
import { findContainingOilBlock, isAllowedOilBlockFeature, loadOilBlockFeatures, type MatchedOilBlock } from "./oil-block-filter";

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
const GEE_CH4PLM_COLLECTION = "NASA/EMIT/L2B/CH4PLM";
const GEE_CH4ENH_COLLECTION = "NASA/EMIT/L2B/CH4ENH";
const GEE_CH4ENH_BAND = "vertical_column_enhancement";

/**
 * NASA EMIT — Earth Surface Mineral Dust Source Investigation — via Google
 * Earth Engine. Reuses the same GEE service-account credentials already
 * configured for TROPOMI, no separate auth flow.
 *
 * Two EMIT products are combined here, because relying on only one badly
 * under-represents real EMIT coverage (confirmed live 2026-07-26/27):
 *
 * 1. `NASA/EMIT/L2B/CH4PLM` — manually QA'd, fully quantified plume
 *    complexes. High confidence, but NASA's curation is extremely
 *    conservative: as of 2026-07-26 there is exactly ONE such plume in all
 *    of Nigeria, out of 1,590 worldwide. Real, but sparse — not a bug.
 *    Fields used: `Plume_ID`, `Latitude/Longitude_of_max_concentration`,
 *    `Max_Plume_Concentration` (ppm·m — NOT kg/hr, see below),
 *    `Concentration_Uncertainty`, `system:time_start`.
 *
 * 2. `NASA/EMIT/L2B/CH4ENH` — raw per-pixel column-enhancement rasters,
 *    every EMIT scene (not just NASA-curated plumes). Reduced to a
 *    mean/min/max/count per Nigerian oil block using the exact same
 *    `reduceRegions` pattern TropomiService already uses for
 *    `COPERNICUS/S5P/OFFL/L3_CH4`. Confirmed live: 41 of Nigeria's 287
 *    oil-block polygons have real, non-null EMIT enhancement statistics
 *    (vs. 1 plume from product #1) — this is the source of most of the
 *    data NOGIET actually shows for EMIT.
 *
 * Neither product exposes a wind-derived kg/hr mass-flux rate — both are
 * concentration/enhancement values (ppm·m), stored in `emissionRate` as a
 * best-effort proxy consistent with TropomiService's existing convention,
 * with `metadata.measurementUnit` stamped so callers don't mistake it for
 * kg/hr. The aggregator's `hasMeasuredEmissionRate` filter (emissionRate > 0)
 * already drops non-positive background/noise readings from both products.
 */
export function emitCacheKey(): string {
  return "nogiet:emit:sources:CH4:v2-ch4enh";
}

export function emitStaleKey(): string {
  return "nogiet:emit:sources:CH4:v2-ch4enh:stale";
}

export class EmitService {
  private fetchPromise: Promise<NormalizedSource[]> | null = null;

  constructor(private cache?: CacheService) {}

  get isConfigured(): boolean {
    return isGeeConfigured();
  }

  async fetchSources(bbox?: BBox): Promise<NormalizedSource[]> {
    if (!this.isConfigured) return [];
    const all = await this.fetchAllSourcesCached();
    return bbox ? all.filter((s) => isInsideBBox(s.latitude, s.longitude, bbox)) : all;
  }

  async refreshSources(bbox?: BBox): Promise<NormalizedSource[]> {
    if (!this.isConfigured) return [];
    if (this.cache) await this.cache.del(emitCacheKey());
    const all = await this.fetchAllSourcesCached();
    return bbox ? all.filter((s) => isInsideBBox(s.latitude, s.longitude, bbox)) : all;
  }

  private async fetchAllSourcesCached(): Promise<NormalizedSource[]> {
    const key = emitCacheKey();
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
          await this.cache.set(emitCacheKey(), sources, SATELLITE_REFRESH_INTERVAL_SEC);
          await this.cache.set(emitStaleKey(), sources, SEVEN_DAYS_SEC);
        }
        return sources;
      })
      .catch(async (err: any) => {
        console.warn("[EMIT] live fetch failed:", err?.message ?? String(err));
        if (this.cache) {
          const stale = await this.cache.get<NormalizedSource[]>(emitStaleKey());
          if (stale && stale.length) {
            console.warn(`[EMIT] serving STALE cache (${stale.length} source(s)) — refresh blocked.`);
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

  private async fetchAllSourcesLive(): Promise<NormalizedSource[]> {
    await ensureEarthEngineReady();

    const [plumes, enhancements] = await Promise.all([
      this.fetchPlumeComplexes().catch((err) => {
        console.warn("[EMIT] CH4PLM fetch failed:", err?.message ?? String(err));
        return [] as NormalizedSource[];
      }),
      this.fetchEnhancementZonalStats().catch((err) => {
        console.warn("[EMIT] CH4ENH fetch failed:", err?.message ?? String(err));
        return [] as NormalizedSource[];
      }),
    ]);

    if (env.EMIT_LOG_RESPONSE || env.NODE_ENV === "development") {
      console.log(`[EMIT] ${plumes.length} plume complex(es) + ${enhancements.length} oil-block enhancement stat(s)`);
    }

    return [...plumes, ...enhancements];
  }

  // ---------- Product 1: CH4PLM plume complexes ----------

  private async fetchPlumeComplexes(): Promise<NormalizedSource[]> {
    // Fixed to the same NIGERIA_BBOX-shaped rectangle used elsewhere; mirrors
    // carbon-mapper.service's NIGERIA_BBOX exactly (2.67, 4.27, 14.68, 13.89).
    const nigeria = ee.Geometry.Rectangle([2.67, 4.27, 14.68, 13.89]);
    const start = new Date(Date.now() - env.EMIT_DAYS_BACK * 86_400_000);

    const plumes = ee
      .ImageCollection(GEE_CH4PLM_COLLECTION)
      .filterBounds(nigeria)
      .filterDate(start.toISOString(), new Date().toISOString());

    const count = await evaluateEe<number>(plumes.size());
    if (count === 0) return [];

    // `.toDictionary()` only returns user properties — GEE strips `system:*`
    // keys (system:time_start, system:index, ...) from it, so the detection
    // timestamp has to be re-attached explicitly via `.set()`.
    const propsList = await evaluateEe<Record<string, unknown>[]>(
      plumes.toList(count).map((img: any) => {
        const image = ee.Image(img);
        return image.toDictionary().set("system:time_start", image.get("system:time_start"));
      })
    );

    const normalized: NormalizedSource[] = [];
    for (const props of propsList) {
      const n = this.normalizePlume(props);
      if (n) normalized.push(n);
    }
    return normalized;
  }

  private normalizePlume(props: Record<string, unknown>): NormalizedSource | null {
    const lat = toNum(props.Latitude_of_max_concentration);
    const lon = toNum(props.Longitude_of_max_concentration);
    if (lat == null || lon == null) return null;

    let matchedBlock: MatchedOilBlock | null = null;
    if (env.EMIT_FILTER_TO_OIL_BLOCKS) {
      matchedBlock = findContainingOilBlock(lon, lat);
      if (!matchedBlock) return null;
      if (!isAllowedOilBlockFeature({ properties: matchedBlock }, env.EMIT_OIL_BLOCK_TYPES, env.EMIT_OIL_GAS_BASINS)) {
        return null;
      }
    }

    const plumeId = String(
      props.Plume_ID ?? props.global_plume_identifier ?? props["system:index"] ?? `${lat.toFixed(4)}_${lon.toFixed(4)}`,
    );
    const maxConcentration = toNum(props.Max_Plume_Concentration) ?? 0;
    const uncertainty = toNum(props.Concentration_Uncertainty);
    const timeStartMs = toNum(props["system:time_start"]);
    const detectedAt = timeStartMs != null ? new Date(timeStartMs).toISOString() : "";

    return {
      id: `emit-plume-${plumeId}`,
      name: `EMIT plume ${plumeId}`,
      provider: "emit",
      latitude: lat,
      longitude: lon,
      emissionRate: maxConcentration,
      gas: "CH4",
      sector: "Oil and Gas",
      instrument: "EMIT",
      persistence: 0,
      plumeCount: 1,
      firstDetected: detectedAt,
      lastDetected: detectedAt,
      metadata: {
        measurementType: "max_plume_concentration",
        measurementUnit: "ppm-m",
        concentrationUncertainty: uncertainty ?? null,
        orbit: props.Orbit ?? null,
        daacSceneNames: props.DAAC_Scene_Names ?? null,
        oilBlock: matchedBlock,
      },
    };
  }

  // ---------- Product 2: CH4ENH per-pixel enhancement, reduced over oil blocks ----------

  private async fetchEnhancementZonalStats(): Promise<NormalizedSource[]> {
    const features = loadOilBlockFeatures().filter((f) =>
      isAllowedOilBlockFeature(f, env.EMIT_OIL_BLOCK_TYPES, env.EMIT_OIL_GAS_BASINS)
    );
    if (features.length === 0) return [];

    const start = new Date(Date.now() - env.EMIT_DAYS_BACK * 86_400_000);

    const eeFeatures = features.map((feature: any) => {
      const props = feature.properties ?? {};
      return ee.Feature(ee.Geometry(feature.geometry), {
        name: props.name ?? "Unknown Block",
        type: props.type ?? "",
        operator: props.operator ?? "",
        basin: props.basin ?? "",
      });
    });
    const oilBlocks = ee.FeatureCollection(eeFeatures);

    const composite = ee
      .ImageCollection(GEE_CH4ENH_COLLECTION)
      .select(GEE_CH4ENH_BAND)
      .filterDate(start.toISOString(), new Date().toISOString())
      .filterBounds(oilBlocks.geometry())
      .mean();

    const reduced = composite
      .reduceRegions({
        collection: oilBlocks,
        reducer: ee.Reducer.mean()
          .combine({ reducer2: ee.Reducer.minMax(), sharedInputs: true })
          .combine({ reducer2: ee.Reducer.count(), sharedInputs: true }),
        scale: 500,
        crs: "EPSG:4326",
      })
      .filter(ee.Filter.notNull(["mean"]));

    const result = await evaluateEe<any>(reduced);
    const rows: any[] = Array.isArray(result?.features) ? result.features : [];

    const normalized: NormalizedSource[] = [];
    for (const row of rows) {
      const props = row.properties ?? {};
      const mean = Number(props.mean);
      if (!Number.isFinite(mean)) continue;
      const centroid = polygonCentroid(row.geometry) ?? polygonCentroid(
        features.find((f: any) => (f.properties?.name ?? "Unknown Block") === props.name)?.geometry,
      );
      if (!centroid) continue;

      normalized.push({
        id: `emit-enh-${slugify(String(props.name ?? "unknown"))}`,
        name: `EMIT CH4 enhancement over ${props.name ?? "oil block"}`,
        provider: "emit",
        latitude: centroid.lat,
        longitude: centroid.lon,
        emissionRate: mean,
        gas: "CH4",
        sector: "Oil and Gas",
        instrument: "EMIT",
        persistence: 0,
        plumeCount: 1,
        firstDetected: start.toISOString(),
        lastDetected: new Date().toISOString(),
        metadata: {
          measurementType: "vertical_column_enhancement_mean",
          measurementUnit: "ppm-m",
          enhancementMean: mean,
          enhancementMin: Number.isFinite(Number(props.min)) ? Number(props.min) : undefined,
          enhancementMax: Number.isFinite(Number(props.max)) ? Number(props.max) : undefined,
          pixelCount: Number.isFinite(Number(props.count)) ? Number(props.count) : undefined,
          daysBack: env.EMIT_DAYS_BACK,
          geeCollection: GEE_CH4ENH_COLLECTION,
          geeBand: GEE_CH4ENH_BAND,
          oilBlock: { name: props.name ?? "Unknown Block", type: props.type ?? "", operator: props.operator ?? "" },
          basin: props.basin,
        },
      });
    }
    return normalized;
  }
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

interface Centroid {
  lat: number;
  lon: number;
}

/** Averages Polygon/MultiPolygon ring vertices — good enough for compact oil-block polygons. */
function polygonCentroid(geometry: any): Centroid | null {
  if (!geometry || typeof geometry !== "object") return null;
  const coords: number[][] = [];
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates?.[0])) {
    for (const ring of geometry.coordinates) {
      for (const pt of ring) if (Array.isArray(pt) && pt.length >= 2) coords.push([pt[0], pt[1]]);
    }
  } else if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) {
        for (const pt of ring) if (Array.isArray(pt) && pt.length >= 2) coords.push([pt[0], pt[1]]);
      }
    }
  }
  if (coords.length === 0) return null;
  let lon = 0, lat = 0;
  for (const [x, y] of coords) { lon += x; lat += y; }
  return { lon: lon / coords.length, lat: lat / coords.length };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}
