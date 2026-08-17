import { FastifyRequest } from "fastify";

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

export interface AuthenticatedRequest extends FastifyRequest {
  user: JwtPayload;
}

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: Record<string, string[]>;
}

export interface CarbonMapperTokens {
  access: string;
  refresh: string;
}

export interface CarbonMapperSource {
  source_name: string;
  lat: number;
  lon: number;
  sector: string;
  gas: string;
  emission_rate: number;
  emission_uncertainty: number;
  persistence: number;
  plume_count: number;
  instrument: string;
  first_detected: string;
  last_detected: string;
}

export interface CarbonMapperPlume {
  plume_id: string;
  source_name: string;
  lat: number;
  lon: number;
  emission_rate: number;
  ime: number;
  gas: string;
  instrument: string;
  datetime: string;
  scene_id: string;
}

export type SatelliteProvider = "carbon_mapper" | "imeo" | "tropomi" | "emit";

export interface NormalizedSource {
  id: string;
  name: string;
  provider: SatelliteProvider;
  latitude: number;
  longitude: number;
  emissionRate: number;
  gas: string;
  sector: string;
  instrument: string;
  persistence: number;
  plumeCount: number;
  firstDetected: string;
  lastDetected: string;
  metadata: Record<string, unknown>;
}
