import { pgTable, uuid, varchar, text, timestamp, real, integer, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users";

export const facilities = pgTable("facilities", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  sector: varchar("sector", { length: 100 }).default("Oil & Gas"),
  region: varchar("region", { length: 100 }),
  state: varchar("state", { length: 100 }),
  lga: varchar("lga", { length: 100 }),
  subSector: varchar("sub_sector", { length: 20 }).default("Upstream").notNull(),
  oilBlock: varchar("oil_block", { length: 100 }),
  oilfield: varchar("oilfield", { length: 255 }),
  operator: varchar("operator", { length: 255 }),
  facilityType: varchar("facility_type", { length: 100 }),
  geographicLocation: varchar("geographic_location", { length: 20 }),
  customField1: text("custom_field_1"),
  customField2: text("custom_field_2"),
  customField3: text("custom_field_3"),
  alertThreshold: real("alert_threshold"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const geofences = pgTable("geofences", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  geometry: jsonb("geometry").notNull(),
  alertEnabled: boolean("alert_enabled").default(true).notNull(),
  threshold: real("threshold"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fieldSubmissions = pgTable("field_submissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  facilityId: uuid("facility_id")
    .references(() => facilities.id, { onDelete: "cascade" })
    .notNull(),
  submittedBy: uuid("submitted_by")
    .references(() => users.id)
    .notNull(),
  photos: jsonb("photos").default([]),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  weatherConditions: varchar("weather_conditions", { length: 255 }),
  equipmentUsed: varchar("equipment_used", { length: 255 }),
  notes: text("notes"),
  methaneReading: real("methane_reading").notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const groundMeasurements = pgTable("ground_measurements", {
  id: uuid("id").defaultRandom().primaryKey(),
  facilityId: uuid("facility_id")
    .references(() => facilities.id, { onDelete: "cascade" })
    .notNull(),
  submittedBy: uuid("submitted_by")
    .references(() => users.id)
    .notNull(),
  measurementDate: timestamp("measurement_date", { withTimezone: true }).notNull(),
  methaneReading: real("methane_reading").notNull(),
  methodology: varchar("methodology", { length: 100 }).notNull(),
  latitude: real("latitude"),
  longitude: real("longitude"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const alerts = pgTable("alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  facilityId: uuid("facility_id")
    .references(() => facilities.id, { onDelete: "cascade" }),
  sourceName: varchar("source_name", { length: 255 }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  emissionRate: real("emission_rate"),
  severity: varchar("severity", { length: 20 }).default("medium"),
  isRead: integer("is_read").default(0),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const imeoFeedConfig = pgTable("imeo_feed_config", {
  id: integer("id").primaryKey().default(1),
  mode: varchar("mode", { length: 10 }).notNull().default("manual"),
  activeBatchId: uuid("active_batch_id"),
  lastApiTestAt: timestamp("last_api_test_at", { withTimezone: true }),
  lastApiTestSuccess: boolean("last_api_test_success"),
  lastApiTestMessage: text("last_api_test_message"),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const imeoUploadBatches = pgTable("imeo_upload_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  filename: varchar("filename", { length: 255 }).notNull(),
  checksum: varchar("checksum", { length: 64 }).notNull(),
  format: varchar("format", { length: 20 }).notNull(),
  reportingMonth: varchar("reporting_month", { length: 7 }).notNull(),
  provider: varchar("provider", { length: 30 }).notNull().default("imeo"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
  uploadedBy: uuid("uploaded_by").references(() => users.id).notNull(),
  r2Key: text("r2_key").notNull(),
  recordCount: integer("record_count").notNull(),
  rejectedCount: integer("rejected_count").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default("published"),
  failureSummary: text("failure_summary"),
  isActive: boolean("is_active").notNull().default(false),
  restoredAt: timestamp("restored_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ checksumIdx: uniqueIndex("imeo_upload_batches_provider_checksum_idx").on(table.provider, table.checksum) }));

export const dataFeedConfig = pgTable("data_feed_config", {
  provider: varchar("provider", { length: 30 }).primaryKey(),
  mode: varchar("mode", { length: 10 }).notNull().default("inactive"),
  activeBatchId: uuid("active_batch_id"),
  lastApiTestAt: timestamp("last_api_test_at", { withTimezone: true }),
  lastApiTestSuccess: boolean("last_api_test_success"),
  lastApiTestMessage: text("last_api_test_message"),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const imeoManualRecords = pgTable("imeo_manual_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  batchId: uuid("batch_id").references(() => imeoUploadBatches.id, { onDelete: "cascade" }).notNull(),
  sourceId: varchar("source_id", { length: 255 }).notNull(),
  payload: jsonb("payload").notNull(),
}, (table) => ({ batchSourceIdx: uniqueIndex("imeo_manual_records_batch_source_idx").on(table.batchId, table.sourceId) }));
