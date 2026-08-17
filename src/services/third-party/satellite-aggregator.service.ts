import { CarbonMapperService, NIGERIA_BBOX, isInsideBBox } from "./carbon-mapper.service";
import type { BBox } from "./carbon-mapper.service";
import { ImeoService } from "./imeo.service";
import { TropomiService } from "./tropomi.service";
import { EmitService } from "./emit.service";
import { CacheService } from "../cache.service";
import type { NormalizedSource, SatelliteProvider, CarbonMapperSource } from "../../types/index";
import { SATELLITE_REFRESH_INTERVAL_SEC } from "./satellite-refresh.constants";
import type { ImeoFeedService } from "../imeo-feed.service";

const AGGREGATED_CACHE_VERSION = "v3-emit";

function hasMeasuredEmissionRate(source: NormalizedSource): boolean {
  return Number.isFinite(source.emissionRate) && source.emissionRate > 0;
}

function carbonMapperToNormalized(src: CarbonMapperSource): NormalizedSource {
  return {
    id: `cm-${src.source_name}`,
    name: src.source_name,
    provider: "carbon_mapper",
    latitude: src.lat,
    longitude: src.lon,
    emissionRate: src.emission_rate,
    gas: src.gas,
    sector: src.sector,
    instrument: src.instrument,
    persistence: src.persistence,
    plumeCount: src.plume_count,
    firstDetected: src.first_detected,
    lastDetected: src.last_detected,
    metadata: {
      emissionUncertainty: src.emission_uncertainty ?? 0,
    },
  };
}

export class SatelliteAggregatorService {
  constructor(
    private carbonMapper: CarbonMapperService,
    private imeo: ImeoService,
    private tropomi: TropomiService,
    private emit: EmitService,
    private cache: CacheService,
    private imeoFeed?: ImeoFeedService,
  ) {}

  get configuredProviders(): SatelliteProvider[] {
    const providers: SatelliteProvider[] = [];
    if (this.imeoFeed || this.carbonMapper.isConfigured) providers.push("carbon_mapper");
    if (this.imeoFeed || this.imeo.isConfigured) providers.push("imeo");
    if (this.imeoFeed || this.tropomi.isConfigured) providers.push("tropomi");
    if (this.imeoFeed || this.emit.isConfigured) providers.push("emit");
    return providers;
  }

  async getImeoFeedStatus() {
    return this.imeoFeed?.status() ?? { mode: "api", activeBatch: null, blockedReason: this.imeo.lastBlockedReasonPublic };
  }

  async fetchAllSources(
    bbox?: BBox,
    providerFilter?: SatelliteProvider,
    gasType: string = "CH4",
  ): Promise<NormalizedSource[]> {
    const cacheKey = `nogiet:sat:aggregated:${AGGREGATED_CACHE_VERSION}:${gasType}:${providerFilter ?? "all"}`;
    const cached = await this.cache.get<NormalizedSource[]>(cacheKey);
    if (cached) {
      return bbox ? cached.filter(s => isInsideBBox(s.latitude, s.longitude, bbox)) : cached;
    }

    const results = await this.fetchFromProviders(providerFilter, gasType);

    if (results.length > 0) {
      await this.cache.set(cacheKey, results, SATELLITE_REFRESH_INTERVAL_SEC);
    }

    return bbox ? results.filter(s => isInsideBBox(s.latitude, s.longitude, bbox)) : results;
  }

  async refreshAllSources(
    bbox?: BBox,
    providerFilter?: SatelliteProvider,
    gasType: string = "CH4",
  ): Promise<NormalizedSource[]> {
    const cacheKey = `nogiet:sat:aggregated:${AGGREGATED_CACHE_VERSION}:${gasType}:${providerFilter ?? "all"}`;
    await this.cache.del(cacheKey);

    const results = await this.fetchFromProviders(providerFilter, gasType, /* forceRefresh */ true);

    if (results.length > 0) {
      await this.cache.set(cacheKey, results, SATELLITE_REFRESH_INTERVAL_SEC);
    }

    return bbox ? results.filter(s => isInsideBBox(s.latitude, s.longitude, bbox)) : results;
  }

  private async fetchFromProviders(
    providerFilter?: SatelliteProvider,
    gasType: string = "CH4",
    forceRefresh: boolean = false,
  ): Promise<NormalizedSource[]> {
    const fetchTasks: Promise<NormalizedSource[]>[] = [];

    const shouldFetch = (p: SatelliteProvider) => !providerFilter || providerFilter === p;

    if (shouldFetch("carbon_mapper") && (this.imeoFeed || this.carbonMapper.isConfigured)) {
      const mode = this.imeoFeed ? await this.imeoFeed.getMode("carbon_mapper") : "api";
      fetchTasks.push(
        (mode !== "api" ? this.imeoFeed!.getManualSources("carbon_mapper") : this.carbonMapper
          .fetchAllSources({ gasType: gasType as "CH4" | "CO2" })
          .then(sources => sources.map(carbonMapperToNormalized)))
          .catch(err => {
            console.warn("[Aggregator] CarbonMapper failed:", err.message);
            return [];
          })
      );
    }

    if (shouldFetch("imeo") && (this.imeoFeed || this.imeo.isConfigured)) {
      const mode = this.imeoFeed ? await this.imeoFeed.getMode("imeo") : "api";
      const imeoCall = mode !== "api"
        ? this.imeoFeed!.getManualSources("imeo")
        : (forceRefresh ? this.imeo.refreshSources(NIGERIA_BBOX, gasType) : this.imeo.fetchSources(NIGERIA_BBOX, gasType));
      fetchTasks.push(
        imeoCall.then((sources) => sources.map((source) => ({
          ...source,
          metadata: { ...source.metadata, imeoFeedMode: mode },
        }))).catch(err => {
          console.warn("[Aggregator] IMEO failed:", err.message);
          return [];
        })
      );
    }

    if (shouldFetch("tropomi") && (this.imeoFeed || this.tropomi.isConfigured)) {
      const mode = this.imeoFeed ? await this.imeoFeed.getMode("tropomi") : "api";
      // Force-refresh path busts the fresh cache so a manual `/satellite/refresh`
      // tick can pick up the latest CDSE scenes; standard reads serve cache.
      const tropomiCall = mode !== "api" ? this.imeoFeed!.getManualSources("tropomi") : forceRefresh
        ? this.tropomi.refreshSources(NIGERIA_BBOX)
        : this.tropomi.fetchSources(NIGERIA_BBOX);
      fetchTasks.push(
        tropomiCall.catch(err => {
          console.warn("[Aggregator] TROPOMI failed:", err.message);
          return [];
        })
      );
    }

    if (shouldFetch("emit") && (this.imeoFeed || this.emit.isConfigured)) {
      const mode = this.imeoFeed ? await this.imeoFeed.getMode("emit") : "api";
      const emitCall = mode !== "api" ? this.imeoFeed!.getManualSources("emit") : forceRefresh
        ? this.emit.refreshSources(NIGERIA_BBOX)
        : this.emit.fetchSources(NIGERIA_BBOX);
      fetchTasks.push(
        emitCall.catch(err => {
          console.warn("[Aggregator] EMIT failed:", err.message);
          return [];
        })
      );
    }

    const allSources = (await Promise.all(fetchTasks)).flat();
    const measuredSources = allSources.filter(hasMeasuredEmissionRate);
    const dropped = allSources.length - measuredSources.length;
    if (dropped > 0) {
      console.log(`[Aggregator] dropped ${dropped} satellite source(s) with zero or missing emission rate`);
    }
    return measuredSources;
  }
}
