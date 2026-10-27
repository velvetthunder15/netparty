#!/usr/bin/env node
// Builds the Firefox (addons.mozilla.org) package from extension/ without touching it.
//   node scripts/build-firefox.mjs            -> ../netparty-firefox-<version>.zip (project root)
//   node scripts/build-firefox.mjs --dir out  -> also leaves the unpacked build in ./out
// The source files are copied as they are; only manifest.json differs from the Chrome build:
//   - background: an event page ("scripts") instead of a service worker, still an ES module
//   - no minimum_chrome_version
//   - browser_specific_settings.gecko: add-on ID, minimum Firefox version and the data the
//     extension transmits (Firefox's built-in data-collection consent, required for new add-ons)
// Needs the `zip` command line tool.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // netparty/
const SRC = path.join(ROOT, "extension");
const OUT_DIR = path.resolve(ROOT, ".."); // the project root, next to the Chrome store zip

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
if (!manifest.background?.service_worker) throw new Error("expected background.service_worker in extension/manifest.json");

const ff = { ...manifest };
ff.background = { scripts: [manifest.background.service_worker], type: manifest.background.type || "module" };
delete ff.minimum_chrome_version;
ff.browser_specific_settings = {
  gecko: {
    id: "netparty@netparty.tech",
    // 140: Firefox's built-in data-collection consent (and the current ESR)
    strict_min_version: "140.0",
    data_collection_permissions: {
      // What leaves the browser (categories from Firefox's data-consent taxonomy,
      // https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/; details in
      // https://netparty.tech/privacy). All of it is needed for the extension to work, so all required.
      //   personalCommunications: party chat, GIFs, reactions, display names and pictures and voice-call setup
      //     (end-to-end encrypted, relayed by netparty.tech) and voice audio (peer to peer between friends)
      //   websiteActivity: play / pause / seek events and positions on the streaming site
      //   browsingActivity: the ID of the title being watched (Netflix / JioHotstar / YouTube video ID)
      //   websiteContent: the title's name read from the page, used as the GIF search when the GIF picker opens
      required: ["personalCommunications", "websiteActivity", "browsingActivity", "websiteContent"],
    },
  },
};

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "netparty-firefox-"));
const skip = (name) => name.startsWith(".");
(function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copy(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
})(SRC, stage);
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(ff, null, 2) + "\n");

const zip = path.join(OUT_DIR, `netparty-firefox-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
// -X: no extra file attributes; -D: no directory entries; run inside the stage so manifest.json is at the zip root
execFileSync("zip", ["-qrXD", zip, "."], { cwd: stage, stdio: "inherit" });

const i = process.argv.indexOf("--dir");
if (i > 0 && process.argv[i + 1]) {
  const dir = path.resolve(process.argv[i + 1]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(stage, dir, { recursive: true });
  console.log("unpacked:", dir);
}
fs.rmSync(stage, { recursive: true, force: true });
console.log("built:", zip);
