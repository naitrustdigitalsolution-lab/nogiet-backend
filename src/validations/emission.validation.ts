import { z } from "zod";

export const submitGroundDataSchema = z.object({
  facilityId: z.string().uuid("Invalid facility ID"),
  measurementDate: z.string().datetime("Invalid date format"),
  methaneReading: z.number().positive("Methane reading must be positive"),
  methodology: z.enum(["OGI Camera", "Sniffer Drone", "Fixed Sensor"]),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const facilityIdParamSchema = z.object({
  id: z.string().uuid("Invalid facility ID"),
});

export const oilBlockIdParamSchema = z.object({
  blockId: z.string().min(1, "Oil block ID is required").max(120),
});

export const emissionFilterSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  sector: z.string().optional(),
  gasType: z.enum(["CH4", "CO2"]).optional().default("CH4"),
  instrument: z.string().optional(),
  provider: z.string().optional(),
  minEmissionRate: z.coerce.number().optional(),
  maxEmissionRate: z.coerce.number().optional(),
  minPlumes: z.coerce.number().int().optional(),
  maxPlumes: z.coerce.number().int().optional(),
  minPersistence: z.coerce.number().optional(),
  maxPersistence: z.coerce.number().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  bbox: z.string().optional(),
  state: z.string().optional(),
  lga: z.string().optional(),
  oilBlock: z.string().optional(),
  operator: z.string().optional(),
  facilityType: z.string().optional(),
  subSector: z.enum(["Upstream", "Midstream", "Downstream"]).optional(),
});

export const analyticsReportSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  period: z.enum(["monthly", "yearly"]).optional().default("monthly"),
  subSector: z.enum(["Upstream", "Midstream", "Downstream"]).optional(),
  source: z.enum(["satellite", "ground", "combined"]).optional().default("combined"),
  provider: z.enum(["carbon_mapper", "imeo", "tropomi"]).optional(),
});

export const createFacilitySchema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  sector: z.string().max(100).optional().default("Oil & Gas"),
  region: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  lga: z.string().max(100).optional(),
  subSector: z.enum(["Upstream", "Midstream", "Downstream"], {
    required_error: "Facilities Classification or Sub-Sector is required",
  }),
  oilBlock: z.string().max(100).optional(),
  oilfield: z.string().max(255).optional(),
  operator: z.string().max(255).optional(),
  facilityType: z.string().max(100).optional(),
  geographicLocation: z.enum(["Onshore", "Offshore"]).optional(),
  customField1: z.string().optional(),
  customField2: z.string().optional(),
  customField3: z.string().optional(),
});

export const updateFacilitySchema = createFacilitySchema.partial().extend({
  subSector: z.enum(["Upstream", "Midstream", "Downstream"]).optional(),
  alertThreshold: z.number().positive().nullable().optional(),
});

export const updateFacilityThresholdSchema = z.object({
  alertThreshold: z.number().positive().nullable(),
});

export const updateOilBlockOverrideSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.string().max(100).optional(),
  status: z.string().max(100).optional(),
  operator: z.string().max(255).optional(),
  terrain: z.string().max(100).optional(),
  basin: z.string().max(100).optional(),
  areaSqkm: z.string().max(100).optional(),
  awardDate: z.string().max(100).optional(),
  contract: z.string().max(255).optional(),
  rights: z.string().max(255).optional(),
});

export const createAlertSchema = z.object({
  facilityId: z.string().uuid("Invalid facility ID").optional(),
  title: z.string().min(1, "Title is required").max(255),
  description: z.string().optional(),
  emissionRate: z.number().positive().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
});

export const createGeofenceSchema = z.object({
  name: z.string().min(1).max(255),
  geometry: z.any(),
  alertEnabled: z.boolean().optional().default(true),
  threshold: z.number().positive().optional(),
});

export const updateGeofenceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  alertEnabled: z.boolean().optional(),
  threshold: z.number().positive().nullable().optional(),
});

export const createFieldSubmissionSchema = z.object({
  facilityId: z.string().uuid("Invalid facility ID"),
  photos: z.array(z.string()).optional().default([]),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  weatherConditions: z.string().max(255).optional(),
  equipmentUsed: z.string().max(255).optional(),
  notes: z.string().optional(),
  methaneReading: z.number().positive("Methane reading must be positive"),
});

export const reviewFieldSubmissionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

export type SubmitGroundDataInput = z.infer<typeof submitGroundDataSchema>;
export type EmissionFilterInput = z.infer<typeof emissionFilterSchema>;
export type AnalyticsReportInput = z.infer<typeof analyticsReportSchema>;
export type CreateFacilityInput = z.infer<typeof createFacilitySchema>;
export type UpdateFacilityInput = z.infer<typeof updateFacilitySchema>;
export type CreateAlertInput = z.infer<typeof createAlertSchema>;
export type UpdateFacilityThresholdInput = z.infer<typeof updateFacilityThresholdSchema>;
export type UpdateOilBlockOverrideInput = z.infer<typeof updateOilBlockOverrideSchema>;
export type CreateGeofenceInput = z.infer<typeof createGeofenceSchema>;
export type UpdateGeofenceInput = z.infer<typeof updateGeofenceSchema>;
export type CreateFieldSubmissionInput = z.infer<typeof createFieldSubmissionSchema>;
export type ReviewFieldSubmissionInput = z.infer<typeof reviewFieldSubmissionSchema>;
