import { FastifyInstance } from "fastify";
import { EmissionController } from "../controllers/emission.controller";
import { validate } from "../middlewares/validate.middleware";
import { authenticate, authorize } from "../middlewares/auth.middleware";
import {
  submitGroundDataSchema,
  facilityIdParamSchema,
  emissionFilterSchema,
  analyticsReportSchema,
  createFacilitySchema,
  updateFacilitySchema,
  createAlertSchema,
  updateFacilityThresholdSchema,
  oilBlockIdParamSchema,
  updateOilBlockOverrideSchema,
  createGeofenceSchema,
  updateGeofenceSchema,
  createFieldSubmissionSchema,
  reviewFieldSubmissionSchema,
} from "../validations/emission.validation";

export function emissionRoutes(fastify: FastifyInstance, controller: EmissionController) {
  // Facilities
  fastify.get("/facilities", {
    preHandler: [authenticate],
    handler: controller.getFacilities,
  });

  fastify.get("/facilities/:id", {
    preHandler: [authenticate, validate(facilityIdParamSchema, "params")],
    handler: controller.getFacilityById,
  });

  fastify.post("/facilities", {
    preHandler: [authenticate, validate(createFacilitySchema)],
    handler: controller.createFacility,
  });

  fastify.put("/facilities/:id", {
    preHandler: [authenticate, validate(facilityIdParamSchema, "params"), validate(updateFacilitySchema)],
    handler: controller.updateFacility,
  });

  fastify.put("/facilities/:id/threshold", {
    preHandler: [authenticate, validate(facilityIdParamSchema, "params"), validate(updateFacilityThresholdSchema)],
    handler: controller.updateFacilityThreshold,
  });

  fastify.delete("/facilities/:id", {
    preHandler: [authenticate, validate(facilityIdParamSchema, "params")],
    handler: controller.deleteFacility,
  });

  fastify.get("/facilities/filter-options", {
    preHandler: [authenticate],
    handler: controller.getFacilityFilterOptions,
  });

  // Oil block metadata overrides
  fastify.get("/oil-block-overrides", {
    preHandler: [authenticate],
    handler: controller.getOilBlockOverrides,
  });

  fastify.put("/oil-block-overrides/:blockId", {
    preHandler: [
      authenticate,
      authorize("admin", "regulator"),
      validate(oilBlockIdParamSchema, "params"),
      validate(updateOilBlockOverrideSchema),
    ],
    handler: controller.updateOilBlockOverride,
  });

  // Alerts
  fastify.post("/alerts", {
    preHandler: [authenticate, validate(createAlertSchema)],
    handler: controller.createAlert,
  });

  fastify.post("/ground-data", {
    preHandler: [authenticate, validate(submitGroundDataSchema)],
    handler: controller.submitGroundData,
  });

  fastify.get("/ground-data/:id", {
    preHandler: [authenticate, validate(facilityIdParamSchema, "params")],
    handler: controller.getGroundData,
  });

  fastify.get("/alerts", {
    preHandler: [authenticate],
    handler: controller.getAlerts,
  });

  fastify.post("/alerts/mark-read", {
    preHandler: [authenticate],
    handler: controller.markAllAlertsRead,
  });

  fastify.get("/alerts/unread-count", {
    preHandler: [authenticate],
    handler: controller.getUnreadAlertCount,
  });

  fastify.get("/stats", {
    preHandler: [authenticate],
    handler: controller.getStats,
  });

  fastify.post("/settings/alert-threshold", {
    preHandler: [authenticate],
    handler: controller.setAlertThreshold,
  });

  fastify.post("/settings/email-alerts", {
    preHandler: [authenticate],
    handler: controller.setEmailAlerts,
  });

  // Satellite
  fastify.get("/satellite/sources", {
    preHandler: [authenticate, validate(emissionFilterSchema, "querystring")],
    handler: controller.getSatelliteSources,
  });

  fastify.get("/satellite/refresh", {
    preHandler: [authenticate, validate(emissionFilterSchema, "querystring")],
    handler: controller.refreshSatelliteRegion,
  });

  fastify.get("/satellite/plumes/:sourceId", {
    preHandler: [authenticate],
    handler: controller.getSatellitePlumes,
  });

  fastify.get("/satellite/imeo/plume-image/:plumeId", {
    preHandler: [authenticate],
    handler: controller.getImeoPlumeImage,
  });

  fastify.get("/satellite/imeo/last-update", {
    preHandler: [authenticate],
    handler: controller.getImeoLastUpdate,
  });

  fastify.get("/comparison/:id", {
    preHandler: [authenticate, validate(facilityIdParamSchema, "params")],
    handler: controller.getComparisonData,
  });

  // Geofences
  fastify.get("/geofences", {
    preHandler: [authenticate],
    handler: controller.getGeofences,
  });

  fastify.post("/geofences", {
    preHandler: [authenticate, validate(createGeofenceSchema)],
    handler: controller.createGeofence,
  });

  fastify.put("/geofences/:id", {
    preHandler: [authenticate, validate(facilityIdParamSchema, "params"), validate(updateGeofenceSchema)],
    handler: controller.updateGeofence,
  });

  fastify.delete("/geofences/:id", {
    preHandler: [authenticate, validate(facilityIdParamSchema, "params")],
    handler: controller.deleteGeofence,
  });

  // Field Submissions
  fastify.post("/field-submissions", {
    preHandler: [authenticate, validate(createFieldSubmissionSchema)],
    handler: controller.createFieldSubmission,
  });

  fastify.get("/field-submissions", {
    preHandler: [authenticate],
    handler: controller.getFieldSubmissions,
  });

  fastify.put("/field-submissions/:id/review", {
    preHandler: [authenticate, authorize("super_admin", "admin"), validate(facilityIdParamSchema, "params"), validate(reviewFieldSubmissionSchema)],
    handler: controller.reviewFieldSubmission,
  });

  // Dashboard
  fastify.get("/dashboard/summary", {
    preHandler: [authenticate],
    handler: controller.getDashboardSummary,
  });

  fastify.get("/emissions/aggregations", {
    preHandler: [authenticate],
    handler: controller.getEmissionAggregations,
  });

  fastify.get("/analytics/report", {
    preHandler: [authenticate, validate(analyticsReportSchema, "querystring")],
    handler: controller.getAnalyticsReport,
  });

  fastify.get("/emissions/completeness", {
    preHandler: [authenticate],
    handler: controller.getDataCompletenessAudit,
  });
}
