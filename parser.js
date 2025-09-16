// parser.js
//
// Why this file exists (and why it looks this way):
// -------------------------------------------------
// We observed multiple failure modes in tool responses:
//  1) The tool's `result` field is sometimes empty, while the real JSON
//     payload lives in `sources[].document[*]` as a JSON string.
//  2) The `items` array may be "interleaved": one bookmark is split
//     across several small objects (Bookmark_ID row, then URL row, then
//     description row, etc.). We must coalesce these into one object.
//  3) Pagination is inconsistent: servers return `cursor`, `nextCursor`,
//     `next_page_token`, etc. We normalize to `nextCursor` and a boolean
//     `hasMore`. (Clients should use `nextCursor` when present.)
//  4) Some model/tool outputs include leaked `<details>` debug blocks.
//     We never want to render those to users; we provide a sanitizer.
//
// This module provides:
//  - tryParseJSON(text)
//  - stripDebugBlocks(html)
//  - parseToolResponse(toolResp)   -> robustly extract the JSON payload
//  - normalizeKarakeepPayload(raw) -> fix interleaving, dedupe, nextCursor
//  - input2JSON(raw)               -> legacy path for non-JSON/KV text
//
// Keep these utilities together—downstream code (router/renderers) rely on
// this consistent shape: { items: [], nextCursor: string|null, hasMore: bool }.

/* ------------------------------------------------------------------ */
/* Basic JSON helpers                                                  */
/* ------------------------------------------------------------------ */

// Try to parse JSON; return parsed value or null on failure
export function tryParseJSON(text) {
  if (text == null) return null;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Repeatedly unwraps if the payload is a JSON-encoded *string*.
 * e.g. "\"\\nBookmark ID: ...\\n\""  ->  "\nBookmark ID: ...\n"
 * Safe-capped to avoid runaway loops.
 */
function unwrapDeepJSONString(raw, maxDepth = 5) {
  let out = raw;
  for (let i = 0; i < maxDepth; i++) {
    const parsed = tryParseJSON(out);
    if (typeof parsed === "string") {
      out = parsed;
      continue;
    }
    // Stop if parsed is non-string (object/array/number/bool) or parse failed
    return { parsed, text: typeof parsed === "string" ? parsed : out };
  }
  // If we looped too many times, just return as text
  return { parsed: null, text: out };
}

/* ------------------------------------------------------------------ */
/* Sanitizer                                                           */
/* ------------------------------------------------------------------ */

/**
 * Remove any leaked chain-of-thought / debug <details> blocks from text/HTML.
 * We call this before rendering any model/tool text to end users.
 */
export function stripDebugBlocks(html = "") {
  return String(html).replace(/<details[^>]*>[\s\S]*?<\/details>/gi, "");
}

/* ------------------------------------------------------------------ */
/* Robust tool response extraction                                     */
/* ------------------------------------------------------------------ */

/**
 * Extract the first valid JSON object from an arbitrary string.
 * This is a "rescue" for cases where JSON is embedded in surrounding text.
 */
function extractFirstJSONObjectFromText(text) {
  if (typeof text !== "string") return null;
  // Fast path: whole string is JSON
  const direct = tryParseJSON(text);
  if (direct && typeof direct === "object") return direct;

  // Slow path: scan for the outermost {...} or [...]
  // We try a greedy match first; if that fails, we try a non-greedy fallback.
  const objMatch =
    text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
  if (objMatch) {
    const maybe = tryParseJSON(objMatch[0]);
    if (maybe && typeof maybe === "object") return maybe;
  }
  return null;
}

/**
 * parseToolResponse(toolResp)
 * ---------------------------
 * Some tool adapters return:
 *   - { result: "<JSON string>" }
 *   - { result: {} } (already parsed)
 *   - { result: "" , sources: [{ document: ["<JSON string>", ...] }, ...] }
 *   - Or even just a plain string (rare)
 *
 * This function robustly digs out the first valid JSON object/array.
 * Returns the parsed object (or null if nothing usable is found).
 */
export function parseToolResponse(toolResp) {
  if (toolResp == null) return null;

  // If the entire thing is a string, try to parse/extract JSON
  if (typeof toolResp === "string") {
    return extractFirstJSONObjectFromText(toolResp);
  }

  // 1) Prefer a non-empty `result`
  const res = toolResp.result;
  if (res != null && String(res).trim() !== "") {
    if (typeof res === "string") {
      // It might be JSON or JSON-encoded text; unwrap deeply
      const { parsed, text } = unwrapDeepJSONString(res);
      if (parsed && typeof parsed === "object") return parsed;
      const rescued = extractFirstJSONObjectFromText(text);
      if (rescued) return rescued;
    } else if (typeof res === "object") {
      return res;
    }
  }

  // 2) Fallback to sources[].document[*]
  const sources = Array.isArray(toolResp.sources) ? toolResp.sources : [];
  for (const s of sources) {
    const docs = Array.isArray(s?.document) ? s.document : (s?.document ? [s.document] : []);
    for (const doc of docs) {
      if (doc == null) continue;
      if (typeof doc === "object") {
        // Already a JSON-like object
        return doc;
      }
      if (typeof doc === "string") {
        // Try deep unwrap and extraction
        const { parsed, text } = unwrapDeepJSONString(doc);
        if (parsed && typeof parsed === "object") return parsed;
        const rescued = extractFirstJSONObjectFromText(text);
        if (rescued) return rescued;
      }
    }
  }

  // 3) As a final rescue, check toolResp itself for embedded JSON text
  const rescued = extractFirstJSONObjectFromText(String(toolResp));
  if (rescued) return rescued;

  return null;
}

/* ------------------------------------------------------------------ */
/* Karakeep payload normalization                                      */
/* ------------------------------------------------------------------ */

/**
 * Normalize mixed / interleaved KaraKeep payloads into:
 *   { items: [...], nextCursor: string|null, hasMore: boolean }
 *
 * - Coalesces interleaved rows so each bookmark becomes a single object.
 *   Example of interleaving we receive per bookmark:
 *     { Bookmark_ID, Created_at, Title, ... }
 *     { Bookmarked_URL: ... }
 *     { description: ... }
 *     { author: ... }
 *     { publisher: ..., Tags: [...] }
 *
 * - De-dupes by Bookmark_ID (last write wins).
 * - Unifies pagination across `nextCursor`, `next_cursor`, `next_page_token`, `cursor`, etc.
 */
export function normalizeKarakeepPayload(raw) {
  // Guard: always return a stable shape
  if (!raw || typeof raw !== "object") {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const rows = Array.isArray(raw.items) ? raw.items : [];
  const coalesced = [];
  let current = null;

  // Iterate rows and fold subsequent non-ID rows into the current bookmark.
  for (const row of rows) {
    if (row && typeof row === "object" && Object.prototype.hasOwnProperty.call(row, "Bookmark_ID")) {
      // Start a new bookmark object
      if (current) coalesced.push(current);
      current = { ...row };
    } else if (row && typeof row === "object" && current) {
      // Merge aux fields (URL/description/author/publisher/Tags/etc.)
      Object.assign(current, row);
    } else {
      // If we get a row that isn't an object or there's no current yet, ignore it
      // (we only care about rows associated with a bookmark block).
    }
  }
  if (current) coalesced.push(current);

  // De-dupe by Bookmark_ID, merging fields (last write wins).
  const byId = new Map();
  for (const it of coalesced) {
    const id = it.Bookmark_ID || `tmp_${byId.size}`;
    const existing = byId.get(id) || {};
    byId.set(id, { ...existing, ...it });
  }

  // Normalize pagination token names
  const tokenCandidates = [
    raw.nextCursor,
    raw.next_cursor,
    raw.nextPageToken,
    raw.next_page_token,
    raw.cursor // NOTE: some servers echo the *request* cursor here; clients should treat it as opaque.
  ];
  let nextCursor = tokenCandidates.find(t => typeof t === "string" && t.trim() !== "") || null;

  // Normalize hasMore: prefer explicit boolean, else infer from presence of token (non-empty)
  let hasMore;
  if (typeof raw.hasMore === "boolean") {
    hasMore = raw.hasMore;
  } else if (typeof raw.has_more === "boolean") {
    hasMore = raw.has_more;
  } else {
    hasMore = Boolean(nextCursor && String(nextCursor).trim() !== "");
  }

  // Return in a consistent, consumer-friendly shape
  return {
    items: Array.from(byId.values()),
    nextCursor,
    hasMore
  };
}

/* ------------------------------------------------------------------ */
/* Legacy KV-block parsing (for non-JSON text payloads)                */
/* ------------------------------------------------------------------ */

/**
 * Generic KV-block parser.
 * - Groups entries into items based on top-level (no-indent) keys.
 * - Splits commas for "Tags" keys.
 * - Extracts "Next cursor" to { cursor, hasMore } when present.
 *
 * This is kept for backwards compatibility with older model outputs that
 * weren't JSON. If you remove it, double-check any paths still calling
 * input2JSON on free-form text.
 */
function parseKVBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  const items = [];
  let current = null;
  let cursor = null;
  let hasMore = undefined;

  const flush = () => {
    if (current && Object.keys(current).length > 0) {
      items.push(current);
    }
    current = null;
  };

  for (const rawLine of lines) {
    const m = rawLine.match(/^(\s*)([^:]+):\s*(.*)$/);
    if (!m) {
      // Blank or non-KV lines can delimit items, but we don't have to flush here.
      continue;
    }

    const indent = m[1] || "";
    const key = m[2].trim();
    const value = m[3];

    // Handle cursor line (often at the end)
    if (/^next\s+cursor$/i.test(key)) {
      cursor = value.replace(/^'+|'+$/g, "").trim();
      hasMore = cursor !== "" && cursor !== "0";
      continue;
    }

    // Start a new item when we hit a top-level key after already starting one
    if (indent.length === 0 && current && Object.keys(current).length > 0) {
      flush();
    }
    if (!current) current = {};

    // Normalize key into a simple label (friendly snake-ish)
    const normKey = key
      .replace(/\s+/g, "_")
      .replace(/[^\w]/g, "_")
      .replace(/^_+|_+$/g, "");

    if (/^tags?$/i.test(key)) {
      current[normKey] = value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else {
      current[normKey] = value.trim();
    }
  }

  flush();

  if (items.length > 0 || cursor !== null) {
    return { items, cursor, hasMore: !!hasMore };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Single entry point for free-form inputs (non-tool text)             */
/* ------------------------------------------------------------------ */

/**
 * input2JSON(raw)
 * ----------------
 * Accepts ANY upstream body (string) and ALWAYS returns a JSON-safe object:
 * - If upstream is JSON object/array → returns it directly.
 * - If upstream is a JSON-encoded *string*, unwraps to text, then:
 *    - Parses KV blocks into { items, cursor?, hasMore? }, or
 *    - Falls back to { text: "<raw text>" }.
 * - If upstream isn't JSON at all:
 *    - Parses KV blocks or returns { text: "<raw text>" }.
 *
 * Note: For tool responses, prefer parseToolResponse(...) + normalizeKarakeepPayload(...).
 */
export function input2JSON(raw) {
  if (raw == null) return { text: "" };

  // If it's already an object/array, just return it.
  if (typeof raw === "object") return raw;

  // Ensure we have a string to operate on
  let bodyText = String(raw);

  // First: try to unwrap deep-encoded JSON strings
  const { parsed, text } = unwrapDeepJSONString(bodyText);
  if (parsed && typeof parsed === "object") {
    // Upstream returned a real JSON object/array
    return parsed;
  }

  // At this point, `text` is the best-effort plain string
  // Try KV-block parsing
  const kv = parseKVBlocks(text);
  if (kv) {
    return kv;
  }

  // Fallback: return as simple text wrapper
  return { text };
}

/* ------------------------------------------------------------------ */
/* End of file                                                         */
/* ------------------------------------------------------------------ */
