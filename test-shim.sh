#!/usr/bin/env bash
set -euo pipefail

SHIM_URL="${SHIM_URL:-http://localhost:8084}"
MCP_CONTAINER="${MCP_CONTAINER:-mcpo-karakeep}"
FAILURES=0
BOOKMARK_ID=""

log() {
  echo -e "\033[1;34m[INFO]\033[0m $*"
}

fail() {
  echo -e "\033[1;31m[FAIL]\033[0m $*"
  FAILURES=$((FAILURES+1))
}

pass() {
  echo -e "\033[1;32m[PASS]\033[0m $*"
}

get_logs() {
  docker logs "$MCP_CONTAINER" --since "$1" 2>&1
}

### 1. Check openapi.json passthrough
log "Checking /openapi.json passthrough..."
OPENAPI=$(curl -s -o - -w "%{http_code}" "$SHIM_URL/openapi.json")
if echo "$OPENAPI" | grep -q '"openapi":'; then
  pass "OpenAPI spec successfully returned"
else
  fail "OpenAPI spec missing or invalid: $OPENAPI"
fi

### 2. Check /health endpoint
log "Checking /health endpoint..."
if curl -s -o /dev/null -w "%{http_code}" "$SHIM_URL/health" | grep -q "200"; then
  pass "Health check succeeded"
else
  fail "Health check failed"
fi

### 3. First search-bookmarks call to get a real bookmark ID
log "Fetching a real bookmark with /search-bookmarks..."
SEARCH_RESPONSE=$(curl -s -X POST "$SHIM_URL/search-bookmarks" \
  -H "Content-Type: application/json" \
  -d '{"query": "today", "limit": 1}')

if echo "$SEARCH_RESPONSE" | jq empty >/dev/null 2>&1; then
  BOOKMARK_ID=$(echo "$SEARCH_RESPONSE" | jq -r '..|.Bookmark_ID? // empty' | head -n 1)
  if [[ -n "$BOOKMARK_ID" ]]; then
    pass "Found bookmark ID: $BOOKMARK_ID"
  else
    fail "No Bookmark_ID found in response: $SEARCH_RESPONSE"
  fi
else
  fail "Search-bookmarks returned invalid JSON: $SEARCH_RESPONSE"
fi

### 4. Iterate through endpoints with dynamic payloads
declare -A TEST_PAYLOADS
TEST_PAYLOADS["/search-bookmarks"]="{\"query\":\"test\",\"limit\":1}"
TEST_PAYLOADS["/get-bookmark"]="$(jq -n --arg id "$BOOKMARK_ID" '{bookmarkId:$id}')"
#TEST_PAYLOADS["/create-bookmark"]='{"type":"text","title":"Test Bookmark","content":"Hello world"}'
TEST_PAYLOADS["/get-bookmark-content"]="$(jq -n --arg id "$BOOKMARK_ID" '{bookmarkId:$id}')"
TEST_PAYLOADS["/get-lists"]='{}'
#TEST_PAYLOADS["/add-bookmark-to-list"]="$(jq -n --arg id "$BOOKMARK_ID" '{listId:"dummy-list",bookmarkId:$id}')"
#TEST_PAYLOADS["/remove-bookmark-from-list"]="$(jq -n --arg id "$BOOKMARK_ID" '{listId:"dummy-list",bookmarkId:$id}')"
#TEST_PAYLOADS["/create-list"]='{"name":"Test List","icon":"📚"}'
#TEST_PAYLOADS["/attach-tag-to-bookmark"]="$(jq -n --arg id "$BOOKMARK_ID" '{bookmarkId:$id,tagsToAttach:["tag1"]}')"
#TEST_PAYLOADS["/detach-tag-from-bookmark"]="$(jq -n --arg id "$BOOKMARK_ID" '{bookmarkId:$id,tagsToDetach:["tag1"]}')"

for ENDPOINT in "${!TEST_PAYLOADS[@]}"; do
  log "Testing $ENDPOINT..."
  TIMESTAMP=$(date --utc +"%Y-%m-%dT%H:%M:%S")

  RESPONSE=$(curl -s -X POST "$SHIM_URL$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "${TEST_PAYLOADS[$ENDPOINT]}" || true)

  if echo "$RESPONSE" | jq empty >/dev/null 2>&1; then
    pass "$ENDPOINT returned valid JSON"
  else
    fail "$ENDPOINT returned invalid JSON: $RESPONSE"
  fi

  LOGS=$(get_logs "$TIMESTAMP")
  if echo "$LOGS" | grep -q "500 Internal Server Error"; then
    fail "$ENDPOINT caused internal server error, see logs below:"
    echo "$LOGS" | grep "500 Internal"
  fi
done

### Summary
if [[ $FAILURES -eq 0 ]]; then
  echo -e "\033[1;32mAll tests passed ✅\033[0m"
  exit 0
else
  echo -e "\033[1;31m$FAILURES tests failed ❌\033[0m"
  exit 1
fi
