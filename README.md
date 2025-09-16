# KaraKeep Shim

This shim wraps the [KaraKeep MCP server](https://github.com/karakeep-app/karakeep) when running under [`mcpo`](https://github.com/open-webui/mcpo), and makes its tools available as a proper JSON API for Open WebUI.

It solves two main issues:

- KaraKeep’s MCP tools return **plain text** (bookmark listings), which Open WebUI cannot parse.
- Pagination (`nextCursor`) was failing because `null` values were being passed incorrectly.

This shim:
- Proxies `/openapi.json` from the upstream `mcpo-karakeep` container.
- Converts plain-text responses into structured JSON.
- Fixes pagination by omitting `nextCursor` when `null`.
- Exposes a simple REST API on port **9000** (mapped to `8084` in `docker-compose`).

## ⚡ Quick Start

Build and run the shim with Docker Compose:

```bash
docker-compose build shim-karakeep
docker-compose up -d shim-karakeep
```

## 🛠️ API Endpoints

### `/openapi.json`
Passthrough to `mcpo-karakeep`.
This lets Open WebUI discover KaraKeep tools normally.

### `/search-bookmarks`
Search for bookmarks.

**Request:**
```json
{
  "query": "",
  "limit": 10,
  "nextCursor": "10"   // optional
}
```

**Response:**
```json
{
  "bookmarks": [
    {
      "id": "abc123",
      "createdAt": "2025-09-09T20:00:11.000Z",
      "title": "Example Title",
      "summary": "",
      "note": "",
      "type": "link",
      "url": "https://example.com",
      "description": "Example description",
      "author": "John Doe",
      "publisher": "Example Publisher",
      "tags": ["tag1", "tag2"]
    }
  ],
  "cursor": "10",
  "hasMore": true
}
```

### `/get-bookmark`
Get a single bookmark by ID.

**Request:**
```json
{ "bookmarkId": "abc123" }
```

### `/create-bookmark`
Create a link or text bookmark.

**Request:**
```json
{
  "type": "link",
  "title": "My Site",
  "content": "https://mysite.com"
}
```

### `/get-bookmark-content`
Get full content of a bookmark in Markdown/plaintext.

**Request:**
```json
{ "bookmarkId": "abc123" }
```

## 🔧 Development Notes

- The shim is written in Node.js (Express + node-fetch).
- It runs as a sidecar container in `docker-compose`.
- It proxies all requests to `mcpo-karakeep` on port 8000.
- If it gets JSON, it just passes it through, unless it's a single JSON field containing JSON in which case it unwraps it.
- Output parsing uses spaces to build the JSON output.

## 🧪 Testing

Manually test endpoints with `curl`:

```bash
# First page
curl -s -X POST http://localhost:8084/search-bookmarks \
  -H "Content-Type: application/json" \
  -d '{"query": "", "limit": 2}' | jq

# Next page (using cursor from previous response)
curl -s -X POST http://localhost:8084/search-bookmarks \
  -H "Content-Type: application/json" \
  -d '{"query": "", "limit": 2, "nextCursor": "2"}' | jq
```

## ✅ Status

- [x] `/openapi.json` passthrough
- [x] Text → JSON parsing
- [x] Pagination fix (`nextCursor`)
- [x] Robust bookmark parsing
- [ ] (optional) Add `totalCount` to responses for debugging

