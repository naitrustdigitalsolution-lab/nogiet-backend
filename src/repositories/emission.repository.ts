import { eq, desc, sql, and, gte, lte, lt, ilike } from "drizzle-orm";
import { facilities, groundMeasurements, alerts, geofences, fieldSubmissions } from "../db/schema/index";

export interface FacilityFilters {
  state?: string;
  lga?: string;
  oilBlock?: string;
  operator?: string;
  facilityType?: string;
}

export class EmissionRepository {
  constructor(private db: any) {}

  // Facilities
  async findAllFacilities(filters?: FacilityFilters) {
    const conditions: any[] = [];
    if (filters?.state) conditions.push(ilike(facilities.state, `%${filters.state}%`));
    if (filters?.lga) conditions.push(ilike(facilities.lga, `%${filters.lga}%`));
    if (filters?.oilBlock) conditions.push(ilike(facilities.oilBlock, `%${filters.oilBlock}%`));
    if (filters?.operator) conditions.push(ilike(facilities.operator, `%${filters.operator}%`));
    if (filters?.facilityType) conditions.push(eq(facilities.facilityType, filters.facilityType));

    if (conditions.length > 0) {
      return this.db.select().from(facilities).where(and(...conditions)).orderBy(facilities.name);
    }
    return this.db.select().from(facilities).orderBy(facilities.name);
  }

  async findFacilityById(id: string) {
    const [facility] = await this.db
      .select()
      .from(facilities)
      .where(eq(facilities.id, id))
      .limit(1);
    return facility ?? null;
  }

  async createFacility(data: typeof facilities.$inferInsert) {
    const [facility] = await this.db.insert(facilities).values(data).returning();
    return facility;
  }

  async updateFacilityThreshold(id: string, alertThreshold: number | null) {
    const [updated] = await this.db
      .update(facilities)
      .set({ alertThreshold })
      .where(eq(facilities.id, id))
      .returning();
    return updated ?? null;
  }

  async deleteFacility(id: string) {
    const [deleted] = await this.db.delete(facilities).where(eq(facilities.id, id)).returning();
    return deleted ?? null;
  }

  async getDistinctFacilityValues() {
    const states = await this.db.selectDistinct({ value: facilities.state }).from(facilities).where(sql`${facilities.state} IS NOT NULL`);
    const lgas = await this.db.selectDistinct({ value: facilities.lga }).from(facilities).where(sql`${facilities.lga} IS NOT NULL`);
    const oilBlocks = await this.db.selectDistinct({ value: facilities.oilBlock }).from(facilities).where(sql`${facilities.oilBlock} IS NOT NULL`);
    const operators = await this.db.selectDistinct({ value: facilities.operator }).from(facilities).where(sql`${facilities.operator} IS NOT NULL`);
    const facilityTypes = await this.db.selectDistinct({ value: facilities.facilityType }).from(facilities).where(sql`${facilities.facilityType} IS NOT NULL`);
    return {
      states: states.map((r: any) => r.value).filter(Boolean),
      lgas: lgas.map((r: any) => r.value).filter(Boolean),
      oilBlocks: oilBlocks.map((r: any) => r.value).filter(Boolean),
      operators: operators.map((r: any) => r.value).filter(Boolean),
      facilityTypes: facilityTypes.map((r: any) => r.value).filter(Boolean),
    };
  }

  // Ground measurements
  async submitGroundData(data: typeof groundMeasurements.$inferInsert) {
    const [measurement] = await this.db
      .insert(groundMeasurements)
      .values(data)
      .returning();
    return measurement;
  }

  async getGroundDataByFacility(facilityId: string, startDate?: Date, endDate?: Date) {
    const conditions = [eq(groundMeasurements.facilityId, facilityId)];
    if (startDate) conditions.push(gte(groundMeasurements.measurementDate, startDate));
    if (endDate) conditions.push(lte(groundMeasurements.measurementDate, endDate));

    return this.db
      .select()
      .from(groundMeasurements)
      .where(and(...conditions))
      .orderBy(desc(groundMeasurements.measurementDate));
  }

  // Alerts
  async getAlerts(limit = 20) {
    return this.db
      .select()
      .from(alerts)
      .orderBy(desc(alerts.createdAt))
      .limit(limit);
  }

  async createAlert(data: typeof alerts.$inferInsert) {
    const [alert] = await this.db.insert(alerts).values(data).returning();
    return alert;
  }

  async findAlertBySourceName(sourceName: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [existing] = await this.db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.sourceName, sourceName),
          gte(alerts.createdAt, today)
        )
      )
      .limit(1);
    return existing ?? null;
  }

  async createSatelliteAlert(data: {
    sourceName: string;
    title: string;
    description?: string;
    emissionRate?: number;
    severity?: string;
  }) {
    const [alert] = await this.db
      .insert(alerts)
      .values({
        sourceName: data.sourceName,
        title: data.title,
        description: data.description,
        emissionRate: data.emissionRate,
        severity: data.severity ?? "medium",
      })
      .returning();
    return alert;
  }

  async markAlertRead(id: string) {
    const [alert] = await this.db
      .update(alerts)
      .set({ isRead: 1 })
      .where(eq(alerts.id, id))
      .returning();
    return alert ?? null;
  }

  async markAllAlertsRead() {
    return this.db
      .update(alerts)
      .set({ isRead: 1 })
      .where(eq(alerts.isRead, 0))
      .returning();
  }

  async deleteOldAlerts(olderThan: Date) {
    return this.db
      .delete(alerts)
      .where(lt(alerts.createdAt, olderThan))
      .returning();
  }

  async getUnreadAlertCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(eq(alerts.isRead, 0));
    return Number(row?.count ?? 0);
  }

  async getEmissionStats() {
    const [sourceCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(facilities);
    const [plumeCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(groundMeasurements);
    const [alertCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(gte(alerts.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));

    return {
      totalSources: Number(sourceCount?.count ?? 0),
      totalMeasurements: Number(plumeCount?.count ?? 0),
      alertsThisWeek: Number(alertCount?.count ?? 0),
    };
  }

  // Geofences
  async findAllGeofences(userId?: string) {
    if (userId) {
      return this.db.select().from(geofences).where(eq(geofences.userId, userId)).orderBy(desc(geofences.createdAt));
    }
    return this.db.select().from(geofences).orderBy(desc(geofences.createdAt));
  }

  async findGeofenceById(id: string) {
    const [gf] = await this.db.select().from(geofences).where(eq(geofences.id, id)).limit(1);
    return gf ?? null;
  }

  async createGeofence(data: typeof geofences.$inferInsert) {
    const [gf] = await this.db.insert(geofences).values(data).returning();
    return gf;
  }

  async updateGeofence(id: string, data: Partial<typeof geofences.$inferInsert>) {
    const [gf] = await this.db.update(geofences).set(data).where(eq(geofences.id, id)).returning();
    return gf ?? null;
  }

  async deleteGeofence(id: string) {
    const [deleted] = await this.db.delete(geofences).where(eq(geofences.id, id)).returning();
    return deleted ?? null;
  }

  async findEnabledGeofences() {
    return this.db.select().from(geofences).where(eq(geofences.alertEnabled, true));
  }

  // Field Submissions
  async createFieldSubmission(data: typeof fieldSubmissions.$inferInsert) {
    const [sub] = await this.db.insert(fieldSubmissions).values(data).returning();
    return sub;
  }

  async findFieldSubmissions(facilityId?: string) {
    if (facilityId) {
      return this.db.select().from(fieldSubmissions).where(eq(fieldSubmissions.facilityId, facilityId)).orderBy(desc(fieldSubmissions.createdAt));
    }
    return this.db.select().from(fieldSubmissions).orderBy(desc(fieldSubmissions.createdAt));
  }

  async findFieldSubmissionById(id: string) {
    const [sub] = await this.db.select().from(fieldSubmissions).where(eq(fieldSubmissions.id, id)).limit(1);
    return sub ?? null;
  }

  async updateFieldSubmissionStatus(id: string, status: string) {
    const [sub] = await this.db.update(fieldSubmissions).set({ status }).where(eq(fieldSubmissions.id, id)).returning();
    return sub ?? null;
  }

  // Aggregations for dashboard
  async getDashboardSummary() {
    const [facilityCount] = await this.db.select({ count: sql<number>`count(*)` }).from(facilities);
    const [measurementCount] = await this.db.select({ count: sql<number>`count(*)` }).from(groundMeasurements);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [alertWeekCount] = await this.db.select({ count: sql<number>`count(*)` }).from(alerts).where(gte(alerts.createdAt, weekAgo));
    const [totalAlertCount] = await this.db.select({ count: sql<number>`count(*)` }).from(alerts);

    const recentAlerts = await this.db.select().from(alerts).orderBy(desc(alerts.createdAt)).limit(5);

    const topFacilities = await this.db
      .select({
        facilityId: groundMeasurements.facilityId,
        facilityName: facilities.name,
        totalReading: sql<number>`sum(${groundMeasurements.methaneReading})`,
        measurementCount: sql<number>`count(*)`,
      })
      .from(groundMeasurements)
      .leftJoin(facilities, eq(groundMeasurements.facilityId, facilities.id))
      .groupBy(groundMeasurements.facilityId, facilities.name)
      .orderBy(desc(sql`sum(${groundMeasurements.methaneReading})`))
      .limit(10);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dailyTrend = await this.db
      .select({
        day: sql<string>`to_char(${alerts.createdAt}, 'Dy')`,
        dayDate: sql<string>`${alerts.createdAt}::date`,
        totalRate: sql<number>`coalesce(sum(${alerts.emissionRate}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(alerts)
      .where(gte(alerts.createdAt, sevenDaysAgo))
      .groupBy(sql`${alerts.createdAt}::date, to_char(${alerts.createdAt}, 'Dy')`)
      .orderBy(sql`${alerts.createdAt}::date`);

    return {
      totalFacilities: Number(facilityCount?.count ?? 0),
      totalMeasurements: Number(measurementCount?.count ?? 0),
      alertsThisWeek: Number(alertWeekCount?.count ?? 0),
      totalAlerts: Number(totalAlertCount?.count ?? 0),
      recentAlerts,
      topFacilities: topFacilities.map((r: any) => ({
        facilityId: r.facilityId,
        facilityName: r.facilityName,
        totalReading: Number(r.totalReading ?? 0),
        measurementCount: Number(r.measurementCount ?? 0),
      })),
      dailyTrend: dailyTrend.map((r: any) => ({
        day: r.day,
        date: r.dayDate,
        totalRate: Number(r.totalRate ?? 0),
        count: Number(r.count ?? 0),
      })),
    };
  }

  async getEmissionAggregations() {
    // Aiven Postgres adds ~200-300ms per round-trip from our dev/EU egress, so
    // running these three independent group-by queries sequentially used to cost
    // ~1s of pure network latency. They have no inter-dependency — fire them in
    // parallel so total wall time ≈ slowest single query, not their sum.
    const [byRegion, byOperator, cumulativeByFacility] = await Promise.all([
      this.db
        .select({
          region: facilities.region,
          count: sql<number>`count(*)`,
          avgReading: sql<number>`avg(${groundMeasurements.methaneReading})`,
        })
        .from(groundMeasurements)
        .leftJoin(facilities, eq(groundMeasurements.facilityId, facilities.id))
        .groupBy(facilities.region),
      this.db
        .select({
          operator: facilities.operator,
          count: sql<number>`count(*)`,
          avgReading: sql<number>`avg(${groundMeasurements.methaneReading})`,
        })
        .from(groundMeasurements)
        .leftJoin(facilities, eq(groundMeasurements.facilityId, facilities.id))
        .groupBy(facilities.operator),
      this.db
        .select({
          facilityId: groundMeasurements.facilityId,
          facilityName: facilities.name,
          totalEmission: sql<number>`sum(${groundMeasurements.methaneReading})`,
          count: sql<number>`count(*)`,
          latestDate: sql<string>`max(${groundMeasurements.measurementDate})`,
        })
        .from(groundMeasurements)
        .leftJoin(facilities, eq(groundMeasurements.facilityId, facilities.id))
        .groupBy(groundMeasurements.facilityId, facilities.name),
    ]);

    return {
      byRegion: byRegion.map((r: any) => ({ region: r.region, count: Number(r.count), avgReading: Number(r.avgReading ?? 0) })),
      byOperator: byOperator.map((r: any) => ({ operator: r.operator, count: Number(r.count), avgReading: Number(r.avgReading ?? 0) })),
      cumulativeByFacility: cumulativeByFacility.map((r: any) => ({
        facilityId: r.facilityId,
        facilityName: r.facilityName,
        totalEmission: Number(r.totalEmission ?? 0),
        count: Number(r.count),
        latestDate: r.latestDate,
      })),
    };
  }
}
