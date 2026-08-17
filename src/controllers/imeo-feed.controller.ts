import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthenticatedRequest } from "../types/index";
import { error, success } from "../utils/api-response";
import { DATA_FEED_PROVIDERS, ImeoFeedService, type DataFeedProvider, type ImeoFeedMode } from "../services/imeo-feed.service";

export class ImeoFeedController {
  constructor(private service: ImeoFeedService) {}

  private provider(request: FastifyRequest): DataFeedProvider {
    const provider = (request.params as { provider?: string }).provider ?? "imeo";
    if (!DATA_FEED_PROVIDERS.includes(provider as DataFeedProvider)) throw new Error("Unsupported data feed provider");
    return provider as DataFeedProvider;
  }
  status = async (request: FastifyRequest, reply: FastifyReply) => success(reply, await this.service.status(this.provider(request)));
  history = async (request: FastifyRequest, reply: FastifyReply) => success(reply, await this.service.history(this.provider(request)));

  sample = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = this.service.sampleTemplate(this.provider(request), (request.params as { format: string }).format);
      return reply.header("Content-Type", result.contentType)
        .header("Content-Disposition", `attachment; filename="${result.filename}"`)
        .send(result.bytes);
    } catch (err) { return error(reply, (err as Error).message, 400); }
  };

  preview = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let file: { bytes: Buffer; filename: string } | null = null;
      for await (const part of request.parts()) if (part.type === "file") file = { bytes: await part.toBuffer(), filename: part.filename };
      if (!file) return error(reply, "No data feed file was provided", 400);
      return success(reply, await this.service.previewUpload({ ...file, provider: this.provider(request) }), "Data feed inspected");
    } catch (err) { return error(reply, (err as Error).message, 400); }
  };

  upload = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let file: { bytes: Buffer; filename: string; mimetype: string } | null = null;
      let reportingMonth = "";
      let expiresAt = "";
      for await (const part of request.parts()) {
        if (part.type === "file") file = { bytes: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
        else if (part.fieldname === "reportingMonth") reportingMonth = String(part.value);
        else if (part.fieldname === "expiresAt") expiresAt = String(part.value);
      }
      if (!file) return error(reply, "No data feed file was provided", 400);
      const userId = (request as AuthenticatedRequest).user.sub;
      return success(reply, await this.service.publishUpload({ ...file, reportingMonth, expiresAt, provider: this.provider(request), userId }), "Data feed published", 201);
    } catch (err) { return error(reply, (err as Error).message, 400); }
  };

  restore = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { batchId } = request.params as { batchId: string };
      return success(reply, await this.service.restore(this.provider(request), batchId, (request as AuthenticatedRequest).user.sub), "Data feed restored");
    } catch (err) { return error(reply, (err as Error).message, 400); }
  };

  deleteBatch = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { batchId } = request.params as { batchId: string };
      return success(reply, await this.service.deleteBatch(this.provider(request), batchId), "Archived dataset deleted");
    } catch (err) { return error(reply, (err as Error).message, 409); }
  };

  testApi = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await this.service.testApi(this.provider(request), (request as AuthenticatedRequest).user.sub);
    if (!result.success) {
      return error(reply, result.blockedReason ?? result.message ?? "Provider API test failed", 502);
    }
    return success(reply, result, "Provider API is available");
  };

  setMode = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { mode } = request.body as { mode: ImeoFeedMode };
      if (mode !== "manual" && mode !== "api") return error(reply, "Mode must be manual or api", 400);
      return success(reply, await this.service.setMode(this.provider(request), mode, (request as AuthenticatedRequest).user.sub), `${mode} mode enabled`);
    } catch (err) { return error(reply, (err as Error).message, 409); }
  };

  download = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await this.service.download((request.params as { batchId: string }).batchId);
      return reply.header("Content-Type", result.contentType)
        .header("Content-Disposition", `attachment; filename="${result.batch.filename.replace(/["\r\n]/g, "_")}"`)
        .send(result.bytes);
    } catch (err) { return error(reply, (err as Error).message, 404); }
  };
}
