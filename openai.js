import fetch from "node-fetch";
import { MCPO_URL, FETCH_TIMEOUT_MS, OPENAPI_RETRY_MS } from "./config.js";
import { info, warn, err, dbg } from "./logger.js";
import { markOpenAPILoaded } from "./health.js";

let cachedSpec = null;

function withTimeout(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(id) };
}

export async function fetchOpenAPIOnce() {
  const url = `${MCPO_URL}/openapi.json`;
  dbg(`Fetching OpenAPI spec from ${url} ...`);
  const t = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: t.signal });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Upstream returned ${r.status}: ${txt}`);
    const spec = JSON.parse(txt);
    cachedSpec = spec;
    markOpenAPILoaded(true);
    info(`OpenAPI loaded: ${spec.info?.title || "unknown"} v${spec.info?.version || "?"}`);
    return spec;
  } catch (e) {
    markOpenAPILoaded(false);
    throw e;
  } finally {
    t.cancel();
  }
}

export async function fetchOpenAPIWithRetry() {
  // Keep retrying until success; health endpoint remains 503 meanwhile.
  // We intentionally don't crash the process to let Docker healthcheck govern restarts.
  // This function resolves only once we succeed.
  // If you prefer not to block startup, you can call this without await and rely on health gating.
  // Here we block to ensure dynamic routes exist when server starts listening.
  for (;;) {
    try {
      return await fetchOpenAPIOnce();
    } catch (e) {
      warn(`OpenAPI fetch failed; retrying in ${OPENAPI_RETRY_MS}ms`);
      await new Promise((r) => setTimeout(r, OPENAPI_RETRY_MS));
    }
  }
}

export function getCachedOpenAPI() {
  return cachedSpec;
}

// Passthrough GET /openapi.json
export async function openapiPassthrough(req, res) {
  const url = `${MCPO_URL}/openapi.json`;
  const t = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: t.signal });
    const body = await r.text();
    res.status(r.status);
    for (const [k, v] of r.headers.entries()) {
      // Filter out hop-by-hop headers if needed; here passthrough is fine
      if (k.toLowerCase() === "content-length") continue;
      res.setHeader(k, v);
    }
    res.type("application/json").send(body);
  } catch (e) {
    err("OpenAPI passthrough failed", e);
    res.status(502).json({ detail: "Failed to fetch upstream openapi.json" });
  } finally {
    t.cancel();
  }
}
