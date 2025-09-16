export const PORT = process.env.PORT ? Number(process.env.PORT) : 9000;

// Where the MCPO (OpenAPI proxy) is reachable from inside the Docker network
export const MCPO_URL = process.env.MCPO_URL || "http://mcpo-karakeep:8000";

// Toggle verbose logs (set SHIM_DEBUG=0 to quiet down)
export const SHIM_DEBUG = process.env.SHIM_DEBUG !== "2";

// Startup OpenAPI fetch retry
export const OPENAPI_RETRY_MS = process.env.OPENAPI_RETRY_MS
  ? Number(process.env.OPENAPI_RETRY_MS)
  : 1000;

// Upstream fetch timeout (ms)
export const FETCH_TIMEOUT_MS = process.env.FETCH_TIMEOUT_MS
  ? Number(process.env.FETCH_TIMEOUT_MS)
  : 20000;
