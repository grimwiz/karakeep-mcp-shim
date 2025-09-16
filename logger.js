import { SHIM_DEBUG } from "./config.js";

function ts() {
  return new Date().toISOString();
}

export function info(msg) {
  console.log(`[INFO] ${ts()} ${msg}`);
}

export function warn(msg) {
  console.warn(`[WARN] ${ts()} ${msg}`);
}

export function dbg(msg) {
  if (SHIM_DEBUG) console.log(`[DEBUG] ${ts()} ${msg}`);
}

export function err(msg, e) {
  console.error(`[ERROR] ${ts()} ${msg}${e ? `: ${e.stack || e}` : ""}`);
}
