import { FastifyRequest, FastifyReply } from "fastify";
import { EmissionService } from "../services/emission.service";
import { success, created, error } from "../utils/api-response";
import type {
  SubmitGroundDataInput,
  EmissionFilterInput,
  AnalyticsReportInput,
  CreateFacilityInput,
  UpdateFacilityInput,
  CreateAlertInput,
  UpdateFacilityThresholdInput,
  UpdateOilBlockOverrideInput,
  CreateGeofenceInput,
  UpdateGeofenceInput,
  CreateFieldSubmissionInput,
  ReviewFieldSubmissionInput,
} from "../validations/emission.validation";

export class EmissionController {
  constructor(private emissionService: EmissionService) {}

  getFacilities = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { state, lga, oilBlock, operator, facilityType, subSector } = request.query as any;
      const result = await this.emissionService.getFacilities({ state, lga, oilBlock, operator, facilityType, subSector });
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getFacilityById = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const result = await this.emissionService.getFacilityById(id);
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  createFacility = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.emissionService.createFacility(
        request.body as CreateFacilityInput
      );
      return created(reply, result, "Facility created");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  updateFacility = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const result = await this.emissionService.updateFacility(
        id,
        request.body as UpdateFacilityInput
      );
      return success(reply, result, "Facility updated");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  deleteFacility = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const result = await this.emissionService.deleteFacility(id);
      return success(reply, result, "Facility deleted");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  updateFacilityThreshold = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const result = await this.emissionService.updateFacilityThreshold(
        id,
        request.body as UpdateFacilityThresholdInput
      );
      return success(reply, result, "Threshold updated");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getFacilityFilterOptions = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.emissionService.getFacilityFilterOptions();
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getOilBlockOverrides = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.emissionService.getOilBlockOverrides();
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  updateOilBlockOverride = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { blockId } = request.params as { blockId: string };
      const userId = (request as any).user.sub;
      const result = await this.emissionService.updateOilBlockOverride(
        blockId,
        userId,
        request.body as UpdateOilBlockOverrideInput,
      );
      return success(reply, result, "Oil block metadata updated");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  createAlert = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.emissionService.createAlert(
        request.body as CreateAlertInput
      );
      return created(reply, result, "Alert created");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  submitGroundData = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = (request as any).user.sub;
      const result = await this.emissionService.submitGroundData(
        userId,
        request.body as SubmitGroundDataInput
      );
      return created(reply, result, "Ground data submitted");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getGroundData = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };
      const result = await this.emissionService.getGroundData(id, startDate, endDate);
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getAlerts = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { limit } = request.query as { limit?: number };
      const result = await this.emissionService.getAlerts(limit);
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  markAllAlertsRead = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await this.emissionService.markAllAlertsRead();
      return success(reply, null, "All alerts marked as read");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getUnreadAlertCount = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const count = await this.emissionService.getUnreadAlertCount();
      return success(reply, { count });
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getStats = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.emissionService.getEmissionStats();
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  setAlertThreshold = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { minEmissionRate } = request.body as { minEmissionRate: number };
      this.emissionService.setAlertThreshold(minEmissionRate);
      return success(reply, { minEmissionRate }, "Alert threshold updated");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  setEmailAlerts = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { enabled } = request.body as { enabled: boolean };
      this.emissionService.setEmailAlertsEnabled(enabled);
      return success(reply, { enabled }, "Email alerts " + (enabled ? "enabled" : "disabled"));
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getSatelliteSources = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filters = request.query as EmissionFilterInput;
      const result = await this.emissionService.getSatelliteSources(filters);
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  refreshSatelliteRegion = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filters = request.query as EmissionFilterInput;
      request.log.info({ bbox: filters.bbox }, "[Refresh] region requested");
      const result = await this.emissionService.refreshSatelliteRegion(filters);
      request.log.info({ total: result.total, source: result.source }, "[Refresh] completed");
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getSatellitePlumes = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { sourceId } = request.params as { sourceId: string };
      const result = await this.emissionService.getSatellitePlumes(sourceId);
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getImeoPlumeImage = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { plumeId } = request.params as { plumeId: string };
      const image = await this.emissionService.getImeoPlumeImage(plumeId);
      if (!image) return error(reply, "Plume image not available", 404);
      reply.header("Content-Type", image.contentType);
      reply.header("Cache-Control", "public, max-age=86400");
      return reply.send(image.bytes);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getImeoLastUpdate = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const lastUpdate = await this.emissionService.getImeoLastUpdate();
      return success(reply, { lastUpdate });
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getComparisonData = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const { startDate, endDate, mode, maxDistance } = request.query as {
        startDate?: string; endDate?: string; mode?: string; maxDistance?: string;
      };
      const maxKm = maxDistance ? Number(maxDistance) : undefined;
      const result = await this.emissionService.getComparisonData(
        id, startDate, endDate,
        mode as "nearest" | "area" | undefined,
        maxKm && !isNaN(maxKm) ? maxKm : undefined,
      );
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  // ---- Geofences ----

  getGeofences = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = (request as any).user.sub;
      const result = await this.emissionService.getGeofences(userId);
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  createGeofence = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = (request as any).user.sub;
      const result = await this.emissionService.createGeofence(userId, request.body as CreateGeofenceInput);
      return created(reply, result, "Geofence created");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  updateGeofence = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const userId = (request as any).user.sub;
      const result = await this.emissionService.updateGeofence(id, userId, request.body as UpdateGeofenceInput);
      return success(reply, result, "Geofence updated");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  deleteGeofence = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const userId = (request as any).user.sub;
      const result = await this.emissionService.deleteGeofence(id, userId);
      return success(reply, result, "Geofence deleted");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  // ---- Field Submissions ----

  createFieldSubmission = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = (request as any).user.sub;
      const result = await this.emissionService.createFieldSubmission(userId, request.body as CreateFieldSubmissionInput);
      return created(reply, result, "Field submission created");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getFieldSubmissions = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { facilityId } = request.query as { facilityId?: string };
      const result = await this.emissionService.getFieldSubmissions(facilityId);
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  reviewFieldSubmission = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const result = await this.emissionService.reviewFieldSubmission(id, request.body as ReviewFieldSubmissionInput);
      return success(reply, result, "Submission reviewed");
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  // ---- Dashboard ----

  getDashboardSummary = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.emissionService.getDashboardSummary();
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getEmissionAggregations = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.emissionService.getEmissionAggregations();
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getAnalyticsReport = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.emissionService.getAnalyticsReport(request.query as AnalyticsReportInput);
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };

  getDataCompletenessAudit = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.emissionService.getDataCompletenessAudit();
      return success(reply, result);
    } catch (err: any) {
      return error(reply, err.message, err.statusCode ?? 500);
    }
  };
}
