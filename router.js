// router.js
//
// Why this file changed:
// ----------------------
// 1) Some upstream tool calls (esp. KaraKeep) return an envelope where `result` is
//    empty but the real JSON lives in `sources[].document[*]`. We now *always*
//    attempt to extract that using parseToolResponse(...).
// 2) KaraKeep's bookmark payload is "interleaved" (one bookmark split across
//    several small rows). We normalize that into one object per bookmark and
//    unify pagination as { nextCursor, hasMore }.
// 3) GET calls were not forwarding query params to upstream. Fixed.
// 4) We keep a robust fallback (input2JSON) for non-JSON / KV text responses.
//
// Downstream consumers should expect a consistent shape:
//   - For KaraKeep bookmarks: { items: [...], nextCursor: string|null, hasMore: boolean }
//   - Otherwise: the parsed JSON (or the input2JSON fallback) with status preserved.

import express from "express";
import fetch from "node-fetch";
import { MCPO_URL, FETCH_TIMEOUT_MS } from "./config.js";
import { dbg, info, warn, err } from "./logger.js";
import {
  input2JSON,
  parseToolResponse,
  normalizeKarakeepPayload,
  stripDebugBlocks,
} from "./parser.js";

/** Make an AbortController with timeout so upstream hangs can't stall the shim */
function withTimeout(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(id) };
}

/** Append query parameters for GET passthrough (we used to drop these — bug fix) */
function buildUpstreamURL(base, path, queryObj) {
  const url = new URL(`${base}${path}`);
  if (queryObj && typeof queryObj === "object") {
    for (const [k, v] of Object.entries(queryObj)) {
      // Express query can be string | string[]
      if (Array.isArray(v)) {
        v.forEach((val) => url.searchParams.append(k, String(val)));
      } else if (v != null) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

/** Heuristic: is this the KaraKeep search-bookmarks endpoint? */
function isKaraKeepBookmarksPath(path) {
  // Keep this loose to tolerate versioning or prefix changes.
  // Examples seen in the wild:
  //   /tool_search_bookmarks_post
  //   /karakeep/tool_search_bookmarks_post
  //   /server:2/tool_search_bookmarks_post (OpenAPI name mapped to path)
  return /search[_-]?bookmarks/i.test(path);
}

/**
 * Try to normalize a tool payload:
 * - If it "looks like" KaraKeep bookmarks, coalesce rows & unify pagination.
 * - Otherwise, return the parsed object as-is.
 * Always returns *something* JSON-safe.
 */
function normalizeToolPayload(parsed, path) {
  if (parsed && typeof parsed === "object") {
    const maybeItems = Array.isArray(parsed.items) ? parsed.items : [];
    const looksLikeKarakeep =
      isKaraKeepBookmarksPath(path) ||
      // Secondary heuristic: items containing Bookmark_ID rows
      maybeItems.some((r) => r && typeof r === "object" && "Bookmark_ID" in r);

    if (looksLikeKarakeep) {
      return normalizeKarakeepPayload(parsed);
    }

    // Not KaraKeep: pass through
    return parsed;
  }

  // Fallback to legacy text/KV handler
  return input2JSON(parsed);
}

export function buildRouterFromOpenAPI(spec) {
  const router = express.Router();

  if (!spec || !spec.paths || typeof spec.paths !== "object") {
    throw new Error("OpenAPI spec has no 'paths'; cannot build router.");
  }

  for (const [path, pathObj] of Object.entries(spec.paths)) {
    // Only wire up verbs present in the spec (commonly POST/GET).
    for (const method of Object.keys(pathObj)) {
      const lower = method.toLowerCase();
      if (!["post", "get"].includes(lower)) continue;

      info(`Registering [${lower.toUpperCase()}] ${path}`);

      router[lower](path, async (req, res) => {
        const startedAt = Date.now();
        try {
          // Avoid logging full bodies; they can be large.
          const inboundPreview = JSON.stringify(req.body ?? {});
          dbg(`[IN]  ${path} body: ${inboundPreview.slice(0, 400)}${inboundPreview.length > 400 ? "…" : ""}`);

          const upstreamURL =
            lower === "get"
              ? buildUpstreamURL(MCPO_URL, path, req.query) // <- bug fix
              : buildUpstreamURL(MCPO_URL, path, null);

          const t = withTimeout(FETCH_TIMEOUT_MS);
          const init = {
            method: lower.toUpperCase(),
            headers: { "Content-Type": "application/json" },
            signal: t.signal,
          };

          if (lower === "post") {
            init.body = JSON.stringify(req.body || {});
          }

          const r = await fetch(upstreamURL, init);
          const bodyStr = await r.text(); // Always read text; we'll parse robustly below.
          t.cancel();

          dbg(`[UP]  ${path} status: ${r.status}`);
          dbg(
            `[UP]  ${path} raw (first 400): ${JSON.stringify(
              bodyStr.slice(0, 400)
            )}${bodyStr.length > 400 ? "…" : ""}`
          );

          // Sanitize leaked <details> debug blocks early (seen in some tool logs)
          const cleanText = stripDebugBlocks(bodyStr);

          // 1) Preferred path: parse tool envelope (handles result/sources.document)
          let parsed = parseToolResponse(cleanText);

          // 2) If that failed, fall back hard (this handles plain JSON/KV text)
          if (!parsed) {
            parsed = input2JSON(cleanText);
          }

          // 3) Normalize when appropriate (esp. KaraKeep bookmarks)
          const payload = normalizeToolPayload(parsed, path);

          // Clients expect JSON, not a bare string, and status mirrored from upstream.
          res.set("Cache-Control", "no-store");
          res.status(r.status).json(payload);
        } catch (e) {
          const duration = Date.now() - startedAt;
          if (e?.name === "AbortError") {
            warn(`Upstream timeout on ${path} after ${duration}ms`);
            return res
              .status(504)
              .json({ detail: `Upstream timeout on ${path} after ${duration}ms` });
          }
          err(`Router error on ${path}: ${e?.message || e}`, e);
          res.status(502).json({ detail: `Shim failed on ${path}` });
        }
      });
    }
  }

  return router;
}
