// FRONTEND_URL supports one URL or a comma-separated list of browser origins.
export function getAllowedOrigins(frontendUrl: string, additionalOrigins = ""): string[] {
  return [...new Set([
    ...frontendUrl.split(","),
    ...additionalOrigins.split(","),
  ].map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean))];
}
