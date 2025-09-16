let openapiLoaded = false;

export function markOpenAPILoaded(ok) {
  openapiLoaded = !!ok;
}

export function isHealthy() {
  return openapiLoaded;
}

export function healthHandler(req, res) {
  if (!isHealthy()) return res.status(503).json({ status: "starting" });
  return res.json({ status: "ok" });
}
