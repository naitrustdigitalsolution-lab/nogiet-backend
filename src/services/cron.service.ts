import cron from "node-cron";
import { EmissionService } from "./emission.service";
import { SATELLITE_REFRESH_INTERVAL_LABEL } from "./third-party/satellite-refresh.constants";

export class CronService {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private isRefreshingSatellites = false;

  constructor(
    private emissionService: EmissionService,
  ) {}

  start() {
    this.refreshSatellitesAndCheckThresholds().catch((err: any) => {
      console.warn("[Cron] startup satellite refresh failed:", err.message);
    });

    this.task = cron.schedule("*/30 * * * *", async () => {
      try {
        await this.refreshSatellitesAndCheckThresholds();
      } catch (err: any) {
        console.warn("[Cron] satellite refresh failed:", err.message);
      }
    });
    console.log(`[Cron] Satellite refresh + threshold monitoring started (startup + every ${SATELLITE_REFRESH_INTERVAL_LABEL})`);
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }

  private async refreshSatellitesAndCheckThresholds() {
    if (this.isRefreshingSatellites) {
      console.log("[Cron] Satellite refresh skipped; previous refresh still running");
      return;
    }

    this.isRefreshingSatellites = true;
    try {
      const result = await this.emissionService.refreshSatelliteRegion({
        gasType: "CH4",
        page: 1,
        limit: 100,
      });

      if (result.total > 0) {
        console.log(`[Cron] Evaluated ${result.total} satellite sources for threshold alerts`);
      }
    } finally {
      this.isRefreshingSatellites = false;
    }
  }
}
