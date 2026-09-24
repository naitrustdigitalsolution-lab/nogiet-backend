import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { getAllowedOrigins } from "../../config/cors";

describe("frontend CORS origins", () => {
  it("normalizes and deduplicates configured origins", () => {
    expect(getAllowedOrigins("https://nogiet.ng/", " https://preview.example/, ,https://nogiet.ng "))
      .toEqual(["https://nogiet.ng", "https://preview.example"]);
  });

  it("does not allow public domains unless configured", () => {
    expect(getAllowedOrigins("http://localhost:3000")).toEqual(["http://localhost:3000"]);
    expect(getAllowedOrigins("", "")).toEqual([]);
  });

  it.each([
    ["https://nogiet.ng", true],
    ["https://www.nogiet.ng", true],
    ["https://previous.example", true],
    ["http://localhost:3000", true],
    ["https://nogiet.ng.attacker.example", false],
    ["https://untrusted.example", false],
  ])("checks login preflight and response for %s", async (origin, allowed) => {
    const app = Fastify();
    await app.register(cors, {
      origin: getAllowedOrigins(" https://nogiet.ng/, https://www.nogiet.ng, https://previous.example/, http://localhost:3000/ , "),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    });
    app.post("/api/v1/auth/login", async (_, reply) => reply.code(401).send({ message: "Invalid credentials" }));
    try {
      const preflight = await app.inject({
        method: "OPTIONS", url: "/api/v1/auth/login",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe(allowed ? origin : undefined);
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin } });
      expect(response.statusCode).toBe(401);
      expect(response.headers["access-control-allow-origin"]).toBe(allowed ? origin : undefined);
    } finally {
      await app.close();
    }
  });
});
