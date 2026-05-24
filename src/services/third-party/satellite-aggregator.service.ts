import { CarbonMapperService, NIGERIA_BBOX, isInsideBBox } from "./carbon-mapper.service";
import type { BBox } from "./carbon-mapper.service";
import { ImeoService } from "./imeo.service";
import { TropomiService } from "./tropomi.service";
import { CacheService } from "../cache.service";
import type { NormalizedSource, SatelliteProvider, CarbonMapperSource } from "../../types/index";

const ONE_DAY_SEC = 24 * 60 * 60;

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
    private cache: CacheService,
  ) {}

  get configuredProviders(): SatelliteProvider[] {
    const providers: SatelliteProvider[] = [];
    if (this.carbonMapper.isConfigured) providers.push("carbon_mapper");
    if (this.imeo.isConfigured) providers.push("imeo");
    if (this.tropomi.isConfigured) providers.push("tropomi");
    return providers;
  }

  async fetchAllSources(
    bbox?: BBox,
    providerFilter?: SatelliteProvider,
    gasType: string = "CH4",
  ): Promise<NormalizedSource[]> {
    const cacheKey = `nogiet:sat:aggregated:${gasType}:${providerFilter ?? "all"}`;
    const cached = await this.cache.get<NormalizedSource[]>(cacheKey);
    if (cached) {
      return bbox ? cached.filter(s => isInsideBBox(s.latitude, s.longitude, bbox)) : cached;
    }

    const results = await this.fetchFromProviders(providerFilter, gasType);

    if (results.length > 0) {
      await this.cache.set(cacheKey, results, ONE_DAY_SEC);
    }

    return bbox ? results.filter(s => isInsideBBox(s.latitude, s.longitude, bbox)) : results;
  }

  async refreshAllSources(
    bbox?: BBox,
    providerFilter?: SatelliteProvider,
    gasType: string = "CH4",
  ): Promise<NormalizedSource[]> {
    const cacheKey = `nogiet:sat:aggregated:${gasType}:${providerFilter ?? "all"}`;
    await this.cache.del(cacheKey);

    const results = await this.fetchFromProviders(providerFilter, gasType, /* forceRefresh */ true);

    if (results.length > 0) {
      await this.cache.set(cacheKey, results, ONE_DAY_SEC);
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

    if (shouldFetch("carbon_mapper") && this.carbonMapper.isConfigured) {
      fetchTasks.push(
        this.carbonMapper
          .fetchAllSources({ gasType: gasType as "CH4" | "CO2" })
          .then(sources => sources.map(carbonMapperToNormalized))
          .catch(err => {
            console.warn("[Aggregator] CarbonMapper failed:", err.message);
            return [];
          })
      );
    }

    if (shouldFetch("imeo") && this.imeo.isConfigured) {
      const imeoCall = forceRefresh
        ? this.imeo.refreshSources(NIGERIA_BBOX, gasType)
        : this.imeo.fetchSources(NIGERIA_BBOX, gasType);
      fetchTasks.push(
        imeoCall.catch(err => {
          console.warn("[Aggregator] IMEO failed:", err.message);
          return [];
        })
      );
    }

    if (shouldFetch("tropomi") && this.tropomi.isConfigured) {
      // Force-refresh path busts the 24h cache so a manual `/satellite/refresh`
      // tick can pick up the latest CDSE scenes; standard reads serve cache.
      const tropomiCall = forceRefresh
        ? this.tropomi.refreshSources(NIGERIA_BBOX)
        : this.tropomi.fetchSources(NIGERIA_BBOX);
      fetchTasks.push(
        tropomiCall.catch(err => {
          console.warn("[Aggregator] TROPOMI failed:", err.message);
          return [];
        })
      );
    }

    const allResults = await Promise.all(fetchTasks);
    return allResults.flat();
  }
}
