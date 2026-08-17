import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";

/**
 * NOSDRA-derived oil block geometries (OML / OPL / Block polygons) covering
 * the Nigerian onshore + offshore acreage. Loaded once at module init and
 * kept in memory — shared by every GEE-backed provider (TROPOMI, EMIT, ...)
 * so they all agree on what counts as "oil & gas acreage".
 */
let oilBlocksCache: any[] | null = null;

export function loadOilBlockFeatures(): any[] {
  if (oilBlocksCache) return oilBlocksCache;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, "..", "..", "data", "oil-blocks.geojson");
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { features?: any[] };
    oilBlocksCache = Array.isArray(parsed?.features) ? parsed.features : [];
    applyOilBlockOverrides(oilBlocksCache, join(here, "..", "..", "data", "oil-block-overrides.json"));
  } catch (err: any) {
    console.warn(
      "[OilBlockFilter] Failed to load oil-blocks.geojson — oil-block filtering disabled:",
      err?.message ?? err,
    );
    oilBlocksCache = [];
  }
  return oilBlocksCache;
}

function applyOilBlockOverrides(features: any[], overridesPath: string) {
  try {
    const raw = readFileSync(overridesPath, "utf8");
    const overrides = JSON.parse(raw) as Record<string, { properties?: Record<string, unknown> }>;
    for (const feature of features) {
      const blockId = String(feature?.properties?.block_id ?? feature?.id ?? feature?.properties?.name ?? "");
      if (!blockId) continue;
      const override = overrides[blockId];
      if (!override?.properties) continue;
      feature.properties = {
        ...(feature.properties ?? {}),
        block_id: blockId,
        ...override.properties,
      };
    }
  } catch {
    // Overrides are optional; source GeoJSON remains the fallback.
  }
}

export interface MatchedOilBlock {
  name: string;
  type: string;
  operator: string;
  basin: string;
}

let oilBlockUnavailableWarned = false;

/**
 * Finds the first oil block polygon containing `(lon, lat)` — `null` if the
 * point is outside every block. Fail-closed: when the GeoJSON can't be
 * loaded, no point is treated as oil-and-gas acreage.
 */
export function findContainingOilBlock(lon: number, lat: number): MatchedOilBlock | null {
  const features = loadOilBlockFeatures();
  if (features.length === 0) {
    if (!oilBlockUnavailableWarned) {
      console.warn(
        "[OilBlockFilter] no polygons loaded; dropping sector-restricted sources until polygons are available.",
      );
      oilBlockUnavailableWarned = true;
    }
    return null;
  }
  const point = {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [lon, lat] },
    properties: {},
  };
  for (const feature of features) {
    try {
      if (booleanPointInPolygon(point as any, feature as any)) {
        const props = (feature as any)?.properties ?? {};
        return {
          name: typeof props.name === "string" && props.name ? props.name : "Unknown Block",
          type: typeof props.type === "string" ? props.type : "",
          operator: typeof props.operator === "string" ? props.operator : "",
          basin: typeof props.basin === "string" ? props.basin : "",
        };
      }
    } catch {
      // Malformed feature — skip and continue.
    }
  }
  return null;
}

/**
 * Generic block/basin allow-list filter, parameterized by env var names so
 * each provider (TROPOMI_OIL_BLOCK_TYPES, EMIT_OIL_BLOCK_TYPES, ...) can have
 * its own configured allow-list while sharing the same matching logic.
 */
export function isAllowedOilBlockFeature(
  feature: any,
  typeEnvVar: string | undefined,
  basinEnvVar: string | undefined,
): boolean {
  const typeRaw = (typeEnvVar ?? "").trim();
  const basinRaw = (basinEnvVar ?? "").trim();

  const typeAllowed = !typeRaw || typeRaw === "*" || typeRaw.toUpperCase() === "ALL"
    ? null
    : new Set(typeRaw.split(",").map((v) => v.trim().toUpperCase()).filter(Boolean));
  const basinAllowed = !basinRaw || basinRaw === "*" || basinRaw.toUpperCase() === "ALL"
    ? null
    : new Set(basinRaw.split(",").map((v) => v.trim().toUpperCase()).filter(Boolean));

  const type = String(feature?.properties?.type ?? "").trim().toUpperCase();
  const basin = String(feature?.properties?.basin ?? "").trim().toUpperCase();

  return (!typeAllowed || typeAllowed.has(type)) && (!basinAllowed || basinAllowed.has(basin));
}
