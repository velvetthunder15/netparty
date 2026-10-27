// Shared helpers for the NetParty browser e2e suites (features.mjs, youtube.mjs).
import { chromium } from "/workspace/work/pw/node_modules/playwright/index.mjs";
import fs from "node:fs";
export const EXT = "/workspace/projects/1bdb1792-2c02-41f9-b663-90d4ea93a9ee/netparty/extension";
export const SERVER = process.env.SERVER || "ws://localhost:8787";
export const out = (...a) => console.log(...a);
let fails = 0, passes = 0;
export const check = (name, cond, extra = "") => {
  out((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
  cond ? passes++ : fails++;
  return !!cond;
};
export const summary = (label) => {
  out(fails ? `\n${fails} FAILED, ${passes} passed` : `\nALL ${passes} ${label} CHECKS PASSED`);
  return fails;
};
export async function launch(dir, { name, avatar, extra = {} } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: "/usr/bin/chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--host-resolver-rules=MAP www.netflix.com:443 127.0.0.1:8443, MAP www.hotstar.com:443 127.0.0.1:8443, MAP www.youtube.com:443 127.0.0.1:8443, MAP static.klipy.com:443 127.0.0.1:8443",
      "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--no-proxy-server",
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  await new Promise((r) => setTimeout(r, 1000)); // let onInstalled finish first
  await sw.evaluate((p) => chrome.storage.sync.set(p), { serverUrl: SERVER, ...(name ? { name } : {}), ...(avatar ? { avatar } : {}), ...extra });
  return { ctx, sw };
}
// run fn(shadowRoot, arg) in the page
export const shadow = (page, fn, arg) =>
  page.evaluate(([f, a]) => {
    const r = document.getElementById("netparty-root")?.shadowRoot;
    return r ? new Function("r", "a", f)(r, a) : null;
  }, [fn.toString().replace(/^[^{]*{|}$/g, ""), arg]);
export async function until(fn, ms = 10000, step = 200) {
  for (let t = 0; t < ms; t += step) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
}
export const status = (x, page) =>
  x.sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => t.url === u) || tabs.find((t) => /netflix|hotstar|youtube/.test(t.url || ""));
    return chrome.tabs.sendMessage(t.id, { cmd: "status" }).catch((e) => ({ error: String(e) }));
  }, page.url());
export const people = (p) => p.evaluate(() => [...(document.getElementById("netparty-root")?.shadowRoot?.querySelectorAll(".np-pname") || [])].map((n) => n.textContent));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
