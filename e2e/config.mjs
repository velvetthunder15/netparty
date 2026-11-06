import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(E2E, "..");
export const EXT = path.resolve(process.env.EXT_DIR || path.join(REPO, "extension"));
export const SERVER_DIR = path.join(REPO, "server");
export const SERVER_LOG = path.resolve(process.env.SERVER_LOG || path.join(E2E, "server.log"));
export const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || E2E);
let runDir = process.env.E2E_RUN_DIR;
export const tempPath = (name) => {
  runDir ||= fs.mkdtempSync(path.join(os.tmpdir(), "netparty-e2e-"));
  return path.join(runDir, path.basename(name));
};

export function executableOnPath(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.resolve(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`${name} was not found on PATH. Set FIREFOX_PATH to your Firefox executable.`);
}

// Use Playwright's full Chromium build: its headless shell cannot load extensions.
export function browserOptions() {
  const executablePath = process.env.CHROMIUM_PATH;
  if (executablePath) {
    fs.accessSync(executablePath, fs.constants.X_OK);
    return { executablePath: path.resolve(executablePath) };
  }
  return { channel: "chromium" };
}

if (process.env.E2E_RUN_DIR) {
  process.once("SIGTERM", () => process.exit(143));
  process.once("SIGINT", () => process.exit(130));
}
