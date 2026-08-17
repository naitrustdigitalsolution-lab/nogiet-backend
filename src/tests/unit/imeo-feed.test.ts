import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET ||= "test-jwt-secret-long-enough";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-long-enough";

let parseImeoCsv: typeof import("../../services/imeo-feed.service").parseImeoCsv;
let parseImeoJson: typeof import("../../services/imeo-feed.service").parseImeoJson;

beforeAll(async () => {
  ({ parseImeoCsv, parseImeoJson } = await import("../../services/imeo-feed.service"));
});

describe("IMEO manual file parsers", () => {
  it("parses quoted CSV values and a UTF-8 BOM", () => {
    expect(parseImeoCsv('\uFEFFid_plume,latitude,longitude,source_name\r\np-1,6.5,5.2,"Site, One"')).toEqual([
      { id_plume: "p-1", latitude: "6.5", longitude: "5.2", source_name: "Site, One" },
    ]);
  });

  it("rejects malformed CSV", () => {
    expect(() => parseImeoCsv('latitude,longitude\n"6.5,5.2')).toThrow("unterminated");
    expect(() => parseImeoCsv("latitude,longitude")).toThrow("header");
  });

  it("extracts GeoJSON features", () => {
    const features = [{ type: "Feature", geometry: { type: "Point", coordinates: [5.2, 6.5] }, properties: { id: "p-1" } }];
    expect(parseImeoJson(Buffer.from(JSON.stringify({ type: "FeatureCollection", features })))).toEqual(features);
  });

  it("rejects unsupported JSON envelopes", () => {
    expect(() => parseImeoJson(Buffer.from('{"hello":"world"}'))).toThrow("FeatureCollection");
  });
});
