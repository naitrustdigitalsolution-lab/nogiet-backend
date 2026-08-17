import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { and, desc, eq, isNotNull, lte, or } from "drizzle-orm";
import { strToU8, unzipSync, zipSync } from "fflate";
import { env } from "../config/env";
import { alerts, dataFeedConfig, imeoManualRecords, imeoUploadBatches } from "../db/schema/emissions";
import { users } from "../db/schema/users";
import type { NormalizedSource } from "../types/index";
import { CacheService } from "./cache.service";
import { CloudflareR2Service } from "./third-party/cloudflare-r2.service";
import { ImeoService } from "./third-party/imeo.service";
import { NIGERIA_BBOX, isInsideBBox } from "./third-party/carbon-mapper.service";
import { EmailService } from "./email/email.service";
import { CarbonMapperService } from "./third-party/carbon-mapper.service";
import { TropomiService } from "./third-party/tropomi.service";
import { EmitService } from "./third-party/emit.service";

export type ImeoFeedMode = "manual" | "api";
export type DataFeedRuntimeMode = "inactive" | ImeoFeedMode;
export type DataFeedProvider = "imeo" | "carbon_mapper" | "tropomi" | "emit";
export const DATA_FEED_PROVIDERS: DataFeedProvider[] = ["imeo", "carbon_mapper", "tropomi", "emit"];

function friendlyProviderError(provider: DataFeedProvider, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (provider === "imeo") {
    if (/credentials are not configured|not configured/i.test(raw)) {
      return "IMEO API is not configured. Please add the API credential and try again.";
    }
    if (/returned 401|\b401\b/.test(raw)) {
      return "IMEO access was denied. Please verify the API credential and authentication mode, then try again.";
    }
    if (/returned 403|\b403\b|cloudflare|blocked/i.test(raw)) {
      return "IMEO blocked access from NOGIET. Please ask IMEO to approve the server connection.";
    }
    if (/returned 5\d\d|fetch failed|timeout|timed out|ENOTFOUND|ECONN/i.test(raw)) {
      return "IMEO is currently unreachable. Please try again later.";
    }
    if (/no valid Nigerian methane records/i.test(raw)) {
      return "IMEO returned no usable Nigerian methane records. Please check the data filters and try again.";
    }
  }
  if (provider === "carbon_mapper") {
    if (/credentials not configured/i.test(raw)) return "Carbon Mapper API is not configured. Please add the API credentials and try again.";
    if (/401|auth failed/i.test(raw)) return "Carbon Mapper access was denied. Please verify the API credentials and try again.";
    if (/fetch failed|timeout|timed out|ENOTFOUND|ECONN/i.test(raw)) return "Carbon Mapper is currently unreachable. Please try again later.";
  }
  if (provider === "emit" && /no valid Nigerian methane records/i.test(raw)) {
    return "EMIT returned no usable Nigerian methane records for the selected area.";
  }
  return raw;
}

export function parseImeoCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error("CSV must contain a header and at least one data row");
  const headers = rows[0].map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim());
  if (headers.some((header) => !header)) throw new Error("CSV contains an empty column header");
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""])));
}

export function parseImeoJson(bytes: Buffer): unknown[] {
  let value: any;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("File is not valid JSON"); }
  if (value?.type === "FeatureCollection" && Array.isArray(value.features)) return value.features;
  if (Array.isArray(value)) return value;
  for (const key of ["results", "data", "items", "records", "plumes", "features"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  throw new Error("JSON must be an IMEO record array or GeoJSON FeatureCollection");
}

const REMINDER_DATE_KEYS = new Set([
  "expiry", "expirydate", "expiresat", "expirationdate", "validuntil",
  "nextupdate", "nextupdatedate", "renewaldate", "refreshdate", "updatedue",
  "datavaliduntil",
]);

const EMISSION_KEYS = new Set(["ch4fluxrate", "emissionrate", "estimatedemission", "estimatedemissionrate", "methaneemissionrate", "emissionratekgh", "ratekghr", "fluxkghr", "flux", "quantification", "totalemission"]);

function unsupportedDocumentMessage(records: unknown[]): string {
  const keys = new Set<string>();
  let hasGeoJsonCoordinates = false;
  for (const value of records.slice(0, 100)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const properties = row.properties && typeof row.properties === "object" ? row.properties as Record<string, unknown> : {};
    [...Object.keys(row), ...Object.keys(properties)].forEach((key) => keys.add(key.toLowerCase().replace(/[^a-z0-9]/g, "")));
    const geometry = row.geometry as { coordinates?: unknown } | undefined;
    if (Array.isArray(geometry?.coordinates)) hasGeoJsonCoordinates = true;
  }
  const hasLatitude = keys.has("latitude") || keys.has("lat");
  const hasLongitude = keys.has("longitude") || keys.has("lon") || keys.has("lng");
  const hasCoordinates = hasGeoJsonCoordinates || (hasLatitude && hasLongitude);
  const hasEmission = [...EMISSION_KEYS].some((key) => keys.has(key));
  const missing = [!hasCoordinates ? "location coordinates" : "", !hasEmission ? "a methane emission-rate field" : ""].filter(Boolean);
  const detail = missing.length ? ` Missing: ${missing.join(" and ")}.` : " The file contains no positive methane records located in Nigeria.";
  return `This does not appear to be the correct methane dataset.${detail} Upload an official provider export or download a sample template below.`;
}

function documentReminderDate(records: unknown[], now: Date): Date | null {
  const dates: Date[] = [];
  const inspect = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 2) return;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (REMINDER_DATE_KEYS.has(normalizedKey) && (typeof raw === "string" || typeof raw === "number")) {
        const numeric = typeof raw === "number" ? (raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : raw) : raw;
        const parsed = new Date(numeric);
        if (!Number.isNaN(parsed.getTime()) && parsed > now) dates.push(parsed);
      } else if (["properties", "metadata", "attributes"].includes(normalizedKey)) {
        inspect(raw, depth + 1);
      }
    }
  };
  records.forEach((record) => inspect(record));
  return dates.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

export class ImeoFeedService {
  constructor(
    private db: any,
    private imeo: ImeoService,
    private r2: CloudflareR2Service,
    private cache: CacheService,
    private email?: EmailService,
    private carbonMapper?: CarbonMapperService,
    private tropomi?: TropomiService,
    private emit?: EmitService,
  ) {}

  private localArchivePath(provider: DataFeedProvider, checksum: string, filename: string) {
    const extension = extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".dat";
    return resolve(env.MANUAL_UPLOAD_STORAGE_DIR, provider, `${checksum}${extension}`);
  }

  private async ensureConfig(provider: DataFeedProvider, executor: any = this.db) {
    await executor.insert(dataFeedConfig).values({ provider, mode: "inactive" }).onConflictDoNothing();
  }

  private normalizeRecords(raw: unknown[], provider: DataFeedProvider) {
    const normalized: NormalizedSource[] = [];
    const invalid: number[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < raw.length; index++) {
      const source = this.imeo.normalize(raw[index]);
      if (source && provider !== "imeo") {
        source.provider = provider;
        source.id = `${provider}-${source.id.replace(/^imeo-/, "")}`;
      }
      if (!source || !isInsideBBox(source.latitude, source.longitude, NIGERIA_BBOX)) continue;
      const valid = source.gas.toUpperCase().includes("CH4") && Number.isFinite(source.emissionRate) && source.emissionRate > 0;
      if (!valid) { invalid.push(index + 1); continue; }
      if (ids.has(source.id)) throw new Error(`Duplicate record ID in this file: ${source.id}`);
      ids.add(source.id);
      normalized.push(source);
    }
    return { normalized, invalid };
  }

  private comparableSource(source: NormalizedSource) {
    const metadata = { ...(source.metadata ?? {}) } as Record<string, unknown>;
    delete metadata.dataFeedMode;
    delete metadata.imeoFeedMode;
    delete metadata.reportingMonth;
    delete metadata.expiresAt;
    return { ...source, metadata };
  }

  private mergeSources(existing: NormalizedSource[], incoming: NormalizedSource[]) {
    const previous = new Map(existing.map((source) => [source.id, source]));
    let addedCount = 0, updatedCount = 0, unchangedCount = 0;
    for (const source of incoming) {
      const old = previous.get(source.id);
      if (!old) addedCount++;
      else if (JSON.stringify(this.comparableSource(old)) === JSON.stringify(this.comparableSource(source))) unchangedCount++;
      else updatedCount++;
    }
    const incomingIds = new Set(incoming.map((source) => source.id));
    const retained = existing.filter((source) => !incomingIds.has(source.id));
    return {
      sources: [...retained, ...incoming],
      addedCount,
      updatedCount,
      unchangedCount,
      retainedCount: retained.length,
      overlappingCount: updatedCount + unchangedCount,
    };
  }

  private async activeManualSources(provider: DataFeedProvider, executor: any = this.db): Promise<NormalizedSource[]> {
    const [config] = await executor.select().from(dataFeedConfig).where(eq(dataFeedConfig.provider, provider)).limit(1);
    if (!config?.activeBatchId) return [];
    const rows = await executor.select({ payload: imeoManualRecords.payload }).from(imeoManualRecords)
      .where(eq(imeoManualRecords.batchId, config.activeBatchId));
    return rows.map((row: any) => row.payload as NormalizedSource);
  }

  private async invalidate() {
    await Promise.all([
      this.cache.delByPattern("nogiet:imeo:plumes:*") ,
      this.cache.delByPattern("nogiet:sat:aggregated:*") ,
    ]);
  }

  async getMode(provider: DataFeedProvider = "imeo"): Promise<DataFeedRuntimeMode> {
    await this.ensureConfig(provider);
    const [config] = await this.db.select().from(dataFeedConfig).where(eq(dataFeedConfig.provider, provider)).limit(1);
    return config?.mode === "api" ? "api" : config?.mode === "manual" ? "manual" : "inactive";
  }

  async getManualSources(provider: DataFeedProvider = "imeo"): Promise<NormalizedSource[]> {
    await this.ensureConfig(provider);
    const [config] = await this.db.select().from(dataFeedConfig).where(eq(dataFeedConfig.provider, provider)).limit(1);
    if (!config?.activeBatchId) return [];
    const rows = await this.db.select({ payload: imeoManualRecords.payload }).from(imeoManualRecords)
      .where(eq(imeoManualRecords.batchId, config.activeBatchId));
    return rows.map((row: any) => row.payload as NormalizedSource);
  }

  async status(provider: DataFeedProvider = "imeo") {
    await this.ensureConfig(provider);
    const [config] = await this.db.select().from(dataFeedConfig).where(eq(dataFeedConfig.provider, provider)).limit(1);
    let activeBatch = null;
    if (config?.activeBatchId) {
      [activeBatch] = await this.db.select().from(imeoUploadBatches).where(eq(imeoUploadBatches.id, config.activeBatchId)).limit(1);
    }
    return { ...config, activeBatch, blockedReason: provider === "imeo" ? this.imeo.lastBlockedReasonPublic : null };
  }

  async history(provider: DataFeedProvider = "imeo") {
    return this.db.select().from(imeoUploadBatches).where(eq(imeoUploadBatches.provider, provider)).orderBy(desc(imeoUploadBatches.createdAt));
  }

  sampleTemplate(provider: DataFeedProvider, requestedFormat: string) {
    const format = requestedFormat.toLowerCase();
    if (!["csv", "json", "geojson", "zip"].includes(format)) throw new Error("Sample format must be CSV, JSON, GeoJSON, or ZIP");
    const providerLabel = provider === "imeo" ? "IMEO" : provider === "carbon_mapper" ? "Carbon Mapper" : provider.toUpperCase();
    const sample = {
      id_plume: "DEMO-NGA-001", latitude: 6.455, longitude: 3.384,
      ch4_fluxrate: 125.5, gas: "CH4", satellite: `${providerLabel} Demo Instrument`,
      sector: "Oil and gas", tile_date: "2026-08-01T10:30:00Z", last_update: "2026-08-01T10:30:00Z",
      country: "Nigeria", iso3cd: "NGA", source_name: "Demo facility — not real data",
    };
    const csv = `${Object.keys(sample).join(",")}\n${Object.values(sample).map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")}\n`;
    const geojson = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [sample.longitude, sample.latitude] }, properties: sample }] }, null, 2);
    if (format === "csv") return { bytes: Buffer.from(csv), filename: `${provider}-methane-sample.csv`, contentType: "text/csv; charset=utf-8" };
    if (format === "json") return { bytes: Buffer.from(JSON.stringify([sample], null, 2)), filename: `${provider}-methane-sample.json`, contentType: "application/json" };
    if (format === "geojson") return { bytes: Buffer.from(geojson), filename: `${provider}-methane-sample.geojson`, contentType: "application/geo+json" };
    return { bytes: Buffer.from(zipSync({ "detected_plumes.csv": strToU8(csv), "README.txt": strToU8("NOGIET demonstration template only. Replace the fake row with an official provider export before uploading.") })), filename: `${provider}-methane-sample.zip`, contentType: "application/zip" };
  }

  async previewUpload(input: { bytes: Buffer; filename: string; provider: DataFeedProvider }) {
    if (input.bytes.length > env.IMEO_UPLOAD_MAX_MB * 1024 * 1024) throw new Error(`File exceeds ${env.IMEO_UPLOAD_MAX_MB} MB limit`);
    const checksum = createHash("sha256").update(input.bytes).digest("hex");
    const duplicate = await this.db.select({ id: imeoUploadBatches.id }).from(imeoUploadBatches)
      .where(and(eq(imeoUploadBatches.checksum, checksum), eq(imeoUploadBatches.provider, input.provider))).limit(1);
    if (duplicate.length) throw new Error("This exact file has already been uploaded");
    const lower = input.filename.toLowerCase();
    let datasetBytes = input.bytes;
    let datasetName = input.filename;
    let format: "csv" | "geojson" | "json" | null = lower.endsWith(".csv") ? "csv" : lower.endsWith(".geojson") ? "geojson" : lower.endsWith(".json") ? "json" : null;
    if (lower.endsWith(".zip")) {
      let entries: Record<string, Uint8Array>;
      try { entries = unzipSync(new Uint8Array(input.bytes)); }
      catch { throw new Error("The ZIP file is invalid or cannot be opened"); }
      const selected = Object.entries(entries).find(([name]) => /detected_plumes\.(csv|geojson|json)$/i.test(name) && !name.startsWith("__MACOSX/"));
      if (!selected) throw new Error("The ZIP file does not contain a detected plumes CSV or GeoJSON dataset");
      [datasetName, datasetBytes] = [selected[0], Buffer.from(selected[1])];
      if (datasetBytes.length > env.IMEO_UPLOAD_MAX_MB * 1024 * 1024) throw new Error(`Extracted dataset exceeds ${env.IMEO_UPLOAD_MAX_MB} MB limit`);
      const inner = datasetName.toLowerCase();
      format = inner.endsWith(".csv") ? "csv" : inner.endsWith(".geojson") ? "geojson" : "json";
    }
    if (!format) throw new Error("Only CSV, GeoJSON, JSON, and official UNEP ZIP exports are supported");
    const raw = format === "csv" ? parseImeoCsv(datasetBytes.toString("utf8")) : parseImeoJson(datasetBytes);
    const { normalized: sources } = this.normalizeRecords(raw, input.provider);
    if (!sources.length) throw new Error(unsupportedDocumentMessage(raw));
    const merge = this.mergeSources(await this.activeManualSources(input.provider), sources);
    const dates = sources.flatMap((source) => [source.firstDetected, source.lastDetected]).map((value) => new Date(value)).filter((date) => !Number.isNaN(date.getTime())).sort((a, b) => a.getTime() - b.getTime());
    const months = [...new Set(dates.map((date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`))].sort();
    const now = new Date();
    const latestDate = dates.at(-1) ?? null;
    const observationReminder = latestDate ? new Date(latestDate) : null;
    observationReminder?.setUTCDate(observationReminder.getUTCDate() + 7);
    const documentReminder = documentReminderDate(raw, now);
    const fallbackReminder = new Date(now);
    fallbackReminder.setUTCDate(fallbackReminder.getUTCDate() + 7);
    const reminderAt = documentReminder ?? (observationReminder && observationReminder > now ? observationReminder : fallbackReminder);
    return {
      filename: basename(input.filename),
      containedDataset: basename(datasetName),
      format: lower.endsWith(".zip") ? `zip-${format}` : format,
      globalRecordCount: raw.length,
      recordCount: sources.length,
      finalRecordCount: merge.sources.length,
      addedCount: merge.addedCount,
      updatedCount: merge.updatedCount,
      unchangedCount: merge.unchangedCount,
      overlappingCount: merge.overlappingCount,
      retainedCount: merge.retainedCount,
      earliestDate: dates[0]?.toISOString() ?? null,
      latestDate: latestDate?.toISOString() ?? null,
      earliestMonth: months[0] ?? null,
      latestMonth: months.at(-1) ?? null,
      monthCount: months.length,
      monthScope: months.length > 1 ? "all_months" : "single_month",
      reminderAt: reminderAt.toISOString(),
      reminderBasis: documentReminder ? "document" : observationReminder && observationReminder > now ? "latest_observation" : "seven_day_default",
    };
  }

  async publishUpload(input: { bytes: Buffer; filename: string; mimetype: string; reportingMonth: string; expiresAt: string; provider: DataFeedProvider; userId: string }) {
    const requestedMonth = input.reportingMonth.trim();
    if (requestedMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)) throw new Error("Dataset month must use YYYY-MM format");
    if (input.bytes.length > env.IMEO_UPLOAD_MAX_MB * 1024 * 1024) throw new Error(`File exceeds ${env.IMEO_UPLOAD_MAX_MB} MB limit`);
    const requestedExpiry = input.expiresAt.trim();
    const suppliedExpiry = requestedExpiry ? new Date(requestedExpiry) : null;
    if (suppliedExpiry && (Number.isNaN(suppliedExpiry.getTime()) || suppliedExpiry <= new Date())) throw new Error("Reminder date must be in the future");
    const lower = input.filename.toLowerCase();
    let datasetBytes = input.bytes;
    let datasetName = input.filename;
    let format: "csv" | "geojson" | "json" | null = lower.endsWith(".csv") ? "csv" : lower.endsWith(".geojson") ? "geojson" : lower.endsWith(".json") ? "json" : null;
    if (lower.endsWith(".zip")) {
      let entries: Record<string, Uint8Array>;
      try { entries = unzipSync(new Uint8Array(input.bytes)); }
      catch { throw new Error("The ZIP file is invalid or cannot be opened"); }
      const selected = Object.entries(entries).find(([name]) => /detected_plumes\.(csv|geojson|json)$/i.test(name) && !name.startsWith("__MACOSX/"));
      if (!selected) throw new Error("The ZIP file does not contain a detected plumes CSV or GeoJSON dataset");
      [datasetName, datasetBytes] = [selected[0], Buffer.from(selected[1])];
      if (datasetBytes.length > env.IMEO_UPLOAD_MAX_MB * 1024 * 1024) throw new Error(`Extracted dataset exceeds ${env.IMEO_UPLOAD_MAX_MB} MB limit`);
      const inner = datasetName.toLowerCase();
      format = inner.endsWith(".csv") ? "csv" : inner.endsWith(".geojson") ? "geojson" : "json";
    }
    if (!format) throw new Error("Only CSV, GeoJSON, JSON, and official UNEP ZIP exports are supported");
    const raw = format === "csv" ? parseImeoCsv(datasetBytes.toString("utf8")) : parseImeoJson(datasetBytes);
    if (!raw.length) throw new Error("The uploaded file contains no records");

    const { normalized, invalid } = this.normalizeRecords(raw, input.provider);
    if (!normalized.length) throw new Error(unsupportedDocumentMessage(raw));

    // Staff may not know the source dataset's reporting month. Prefer an
    // explicit value, otherwise infer the newest valid observation month and
    // finally fall back to the upload month when the export contains no dates.
    const observedDates = normalized
      .flatMap((source) => [source.lastDetected, source.firstDetected])
      .map((value) => new Date(value))
      .filter((value) => !Number.isNaN(value.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());
    const inferredDate = observedDates[0] ?? new Date();
    const reportingMonth = requestedMonth || `${inferredDate.getUTCFullYear()}-${String(inferredDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const now = new Date();
    const defaultExpiry = new Date(now);
    defaultExpiry.setUTCDate(defaultExpiry.getUTCDate() + 7);
    const observationExpiry = observedDates[0] ? new Date(observedDates[0]) : null;
    observationExpiry?.setUTCDate(observationExpiry.getUTCDate() + 7);
    const expiry = suppliedExpiry
      ?? documentReminderDate(raw, now)
      ?? (observationExpiry && observationExpiry > now ? observationExpiry : defaultExpiry);
    normalized.forEach((source) => {
      source.metadata = { ...source.metadata, dataFeedMode: "manual", imeoFeedMode: input.provider === "imeo" ? "manual" : undefined, reportingMonth, expiresAt: expiry.toISOString() };
    });

    const checksum = createHash("sha256").update(input.bytes).digest("hex");
    const existing = await this.db.select({ id: imeoUploadBatches.id }).from(imeoUploadBatches)
      .where(and(eq(imeoUploadBatches.checksum, checksum), eq(imeoUploadBatches.provider, input.provider))).limit(1);
    if (existing.length) throw new Error("This exact file has already been uploaded");
    const archived = await this.r2.uploadBuffer(input.bytes, "imeo-uploads", input.mimetype);
    const localArchive = this.localArchivePath(input.provider, checksum, input.filename);
    try {
      await mkdir(resolve(env.MANUAL_UPLOAD_STORAGE_DIR, input.provider), { recursive: true });
      await writeFile(localArchive, input.bytes);
    } catch (error) {
      await this.r2.delete(archived.key).catch(() => undefined);
      throw new Error(`Could not archive the manual upload on the backend: ${(error as Error).message}`);
    }
    try {
      const batch = await this.db.transaction(async (tx: any) => {
        await this.ensureConfig(input.provider, tx);
        await tx.update(imeoUploadBatches).set({ isActive: false }).where(and(eq(imeoUploadBatches.isActive, true), eq(imeoUploadBatches.provider, input.provider)));
        const merge = this.mergeSources(await this.activeManualSources(input.provider, tx), normalized);
        const [created] = await tx.insert(imeoUploadBatches).values({
          filename: basename(input.filename), checksum, format: lower.endsWith(".zip") ? `zip-${format}` : format, reportingMonth,
          uploadedBy: input.userId, r2Key: archived.key, recordCount: merge.sources.length, rejectedCount: invalid.length, isActive: true, provider: input.provider, expiresAt: expiry,
        }).returning();
        await tx.insert(imeoManualRecords).values(merge.sources.map((payload) => ({ batchId: created.id, sourceId: payload.id, payload })));
        await tx.update(dataFeedConfig).set({ activeBatchId: created.id, mode: "manual", updatedBy: input.userId, updatedAt: new Date() })
          .where(eq(dataFeedConfig.provider, input.provider));
        return created;
      });
      await this.invalidate();
      return batch;
    } catch (error) {
      await this.r2.delete(archived.key).catch(() => undefined);
      await rm(localArchive, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async restore(provider: DataFeedProvider, batchId: string, userId: string) {
    const [batch] = await this.db.select().from(imeoUploadBatches).where(and(eq(imeoUploadBatches.id, batchId), eq(imeoUploadBatches.provider, provider), eq(imeoUploadBatches.status, "published"))).limit(1);
    if (!batch) throw new Error("Dataset was not found or is not restorable");
    await this.db.transaction(async (tx: any) => {
      await this.ensureConfig(provider, tx);
      await tx.update(imeoUploadBatches).set({ isActive: false }).where(and(eq(imeoUploadBatches.isActive, true), eq(imeoUploadBatches.provider, provider)));
      await tx.update(imeoUploadBatches).set({ isActive: true, restoredAt: new Date() }).where(eq(imeoUploadBatches.id, batchId));
      await tx.update(dataFeedConfig).set({ activeBatchId: batchId, mode: "manual", updatedBy: userId, updatedAt: new Date() }).where(eq(dataFeedConfig.provider, provider));
    });
    await this.invalidate();
    return this.status(provider);
  }

  async testApi(provider: DataFeedProvider, userId: string) {
    await this.ensureConfig(provider);
    let success = false, message = ""; let count = 0;
    try {
      if (provider === "imeo") count = (await this.imeo.testLiveConnection(NIGERIA_BBOX)).filter((row) => row.emissionRate > 0 && isInsideBBox(row.latitude, row.longitude, NIGERIA_BBOX)).length;
      else if (provider === "carbon_mapper") count = (await this.carbonMapper?.fetchAllSources({ gasType: "CH4" }) ?? []).filter((row) => row.emission_rate > 0 && row.gas.toUpperCase().includes("CH4") && isInsideBBox(row.lat, row.lon, NIGERIA_BBOX)).length;
      else if (provider === "tropomi") count = (await this.tropomi?.testLiveConnection(NIGERIA_BBOX) ?? []).filter((row) => row.emissionRate > 0 && row.gas.toUpperCase().includes("CH4") && isInsideBBox(row.latitude, row.longitude, NIGERIA_BBOX)).length;
      else count = (await this.emit?.refreshSources(NIGERIA_BBOX) ?? []).filter((row) => row.emissionRate > 0 && row.gas.toUpperCase().includes("CH4") && isInsideBBox(row.latitude, row.longitude, NIGERIA_BBOX)).length;
      if (!count) {
        if (provider === "tropomi") throw new Error(this.tropomi?.diagnosticMessage ?? "TROPOMI integration is unavailable");
        throw new Error(`${provider.replace(/_/g, " ")} returned no valid Nigerian methane records`);
      }
      success = true; message = `${provider.replace(/_/g, " ")} API returned ${count} valid Nigerian record(s)`;
    } catch (error) {
      console.warn(`[DataFeed] ${provider} API test failed:`, error instanceof Error ? error.message : error);
      message = friendlyProviderError(provider, error);
    }
    const [config] = await this.db.select().from(dataFeedConfig).where(eq(dataFeedConfig.provider, provider)).limit(1);
    const fallbackMode = config?.activeBatchId ? "manual" : "inactive";
    await this.db.transaction(async (tx: any) => {
      await tx.update(dataFeedConfig).set({
        lastApiTestAt: new Date(), lastApiTestSuccess: success, lastApiTestMessage: message,
        ...(success || config?.mode !== "api" ? {} : { mode: fallbackMode }),
        updatedBy: userId, updatedAt: new Date(),
      }).where(eq(dataFeedConfig.provider, provider));
      if (!success && config?.mode === "api" && config.activeBatchId) {
        await tx.update(imeoUploadBatches).set({ isActive: true }).where(eq(imeoUploadBatches.id, config.activeBatchId));
      }
    });
    if (!success && config?.mode === "api") await this.invalidate();
    return { success, message, count, blockedReason: this.imeo.lastBlockedReasonPublic };
  }

  async setMode(provider: DataFeedProvider, mode: ImeoFeedMode, userId: string) {
    await this.ensureConfig(provider);
    if (mode === "api") {
      const test = await this.testApi(provider, userId);
      if (!test.success) throw new Error(`API mode was not enabled: ${test.message}`);
      // Clear manual/aggregate results before warming the live provider cache.
      // Doing this afterward would discard the API records we just validated.
      await this.invalidate();
      const populated = provider === "imeo"
        ? (await this.imeo.refreshSources(NIGERIA_BBOX)).filter((row) => row.emissionRate > 0).length
        : provider === "carbon_mapper"
          ? (await this.carbonMapper?.fetchAllSources({ gasType: "CH4" }) ?? []).filter((row) => row.emission_rate > 0).length
          : provider === "tropomi"
            ? (await this.tropomi?.testLiveConnection(NIGERIA_BBOX) ?? []).filter((row) => row.emissionRate > 0 && row.gas.toUpperCase().includes("CH4") && isInsideBBox(row.latitude, row.longitude, NIGERIA_BBOX)).length
            : (await this.emit?.refreshSources(NIGERIA_BBOX) ?? []).filter((row) => row.emissionRate > 0).length;
      if (!populated) throw new Error("API mode was not enabled because the live map could not be populated with valid Nigerian records");
    } else {
      const [config] = await this.db.select().from(dataFeedConfig).where(eq(dataFeedConfig.provider, provider)).limit(1);
      if (!config?.activeBatchId) throw new Error(`Upload a valid ${provider.replace(/_/g, " ")} dataset before enabling Manual mode`);
    }
    await this.db.update(dataFeedConfig).set({ mode, updatedBy: userId, updatedAt: new Date() }).where(eq(dataFeedConfig.provider, provider));
    if (mode === "api") {
      // API replaces manual data only at runtime. Uploaded business records,
      // source files and normalized history remain archived until an admin
      // explicitly deletes an individual batch.
      await this.db.update(imeoUploadBatches).set({ isActive: false }).where(and(eq(imeoUploadBatches.provider, provider), eq(imeoUploadBatches.isActive, true)));
    } else {
      const [config] = await this.db.select().from(dataFeedConfig).where(eq(dataFeedConfig.provider, provider)).limit(1);
      if (config?.activeBatchId) await this.db.update(imeoUploadBatches).set({ isActive: true }).where(eq(imeoUploadBatches.id, config.activeBatchId));
    }
    if (mode !== "api") await this.invalidate();
    return this.status(provider);
  }

  async deleteBatch(provider: DataFeedProvider, batchId: string) {
    const [batch] = await this.db.select().from(imeoUploadBatches).where(and(eq(imeoUploadBatches.id, batchId), eq(imeoUploadBatches.provider, provider))).limit(1);
    if (!batch) throw new Error("Dataset was not found");
    const [config] = await this.db.select().from(dataFeedConfig).where(eq(dataFeedConfig.provider, provider)).limit(1);
    if (config?.mode === "manual" && config.activeBatchId === batchId) throw new Error("Activate another dataset or switch to API before deleting the active manual dataset");
    await this.db.transaction(async (tx: any) => {
      if (config?.activeBatchId === batchId) await tx.update(dataFeedConfig).set({ activeBatchId: null, updatedAt: new Date() }).where(eq(dataFeedConfig.provider, provider));
      await tx.delete(imeoUploadBatches).where(eq(imeoUploadBatches.id, batchId));
    });
    await Promise.all([
      this.r2.delete(batch.r2Key).catch(() => undefined),
      rm(this.localArchivePath(provider, batch.checksum, batch.filename), { force: true }).catch(() => undefined),
    ]);
    await this.invalidate();
    return { id: batchId, deleted: true };
  }

  async download(batchId: string) {
    const [batch] = await this.db.select().from(imeoUploadBatches).where(eq(imeoUploadBatches.id, batchId)).limit(1);
    if (!batch) throw new Error("Dataset was not found");
    try { return { batch, ...(await this.r2.downloadBuffer(batch.r2Key)) }; }
    catch {
      return { batch, bytes: await readFile(this.localArchivePath(batch.provider as DataFeedProvider, batch.checksum, batch.filename)), contentType: "application/octet-stream" };
    }
  }

  async sendExpiryReminders(): Promise<number> {
    const reminderCutoff = new Date();
    const batches = await this.db.select().from(imeoUploadBatches).where(and(
      eq(imeoUploadBatches.isActive, true),
      isNotNull(imeoUploadBatches.expiresAt),
      lte(imeoUploadBatches.expiresAt, reminderCutoff),
    ));
    let sent = 0;
    for (const batch of batches) {
      if (!batch.expiresAt) continue;
      const last = batch.lastReminderAt ? new Date(batch.lastReminderAt) : null;
      if (last && Date.now() - last.getTime() < 7 * 24 * 60 * 60 * 1000) continue;
      const recipients = await this.db.select({ id: users.id, email: users.email, fullName: users.fullName }).from(users)
        .where(or(eq(users.role, "super_admin"), eq(users.id, batch.uploadedBy)));
      const expired = batch.expiresAt.getTime() <= Date.now();
      const label = batch.provider.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
      await this.db.insert(alerts).values({
        sourceName: `data-feed-expiry-${batch.id}-${new Date().toISOString().slice(0, 10)}`,
        title: `${label} data feed update is due`,
        description: `Check for and upload a newer ${label} data feed. The update reminder was due ${batch.expiresAt.toISOString().slice(0, 10)}.`,
        severity: expired ? "high" : "medium",
        metadata: { kind: "data_feed_expiry", provider: batch.provider, batchId: batch.id, expiresAt: batch.expiresAt },
      });
      if (this.email) {
        for (const recipient of recipients) await this.email.sendDataFeedReminder(recipient.email, recipient.fullName, batch.provider, batch.expiresAt);
      }
      await this.db.update(imeoUploadBatches).set({ lastReminderAt: new Date() }).where(eq(imeoUploadBatches.id, batch.id));
      sent++;
    }
    return sent;
  }
}
