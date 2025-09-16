import express from "express";
import { PORT } from "./config.js";
import { info } from "./logger.js";
import { healthHandler } from "./health.js";
import { fetchOpenAPIWithRetry, openapiPassthrough, getCachedOpenAPI } from "./openapi.js";
import { buildRouterFromOpenAPI } from "./router.js";

const app = express();
app.use(express.json());

// Health endpoint — only 200 once OpenAPI is loaded
app.get("/health", healthHandler);

// Passthrough of upstream OpenAPI
app.get("/openapi.json", openapiPassthrough);

(async () => {
  // Block until OpenAPI is fetched so we can build routes
  const spec = await fetchOpenAPIWithRetry();

  // Build and mount dynamic router
  const router = buildRouterFromOpenAPI(spec);
  app.use("/", router);

  app.listen(PORT, () => info(`Shim listening on port ${PORT}`));
})();
