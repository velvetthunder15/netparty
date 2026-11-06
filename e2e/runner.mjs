import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { E2E, EXT, MEDIA_DIR, SERVER_DIR, SERVER_LOG, browserOptions } from "./config.mjs";

export async function assertPortsFree(ports) {
  for (const port of ports) {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", (error) => reject(new Error(`Port ${port} is unavailable. Stop its owner or run tests elsewhere.`, { cause: error })));
      probe.listen(port, () => probe.close(resolve));
    });
  }
}

export async function preflight(script) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Use Node.js 22 or newer.");
  for (const file of [script, path.join(EXT, "manifest.json"), ...["test.webm", "test.gif", "key.pem", "cert.pem"].map((f) => path.join(MEDIA_DIR, f))]) {
    if (!fs.existsSync(file)) throw new Error(`Missing ${file}. See e2e/README.md for setup.`);
  }
  if (path.basename(script) === "anyvideo.mjs" && !fs.existsSync(path.join(MEDIA_DIR, "test-short.webm"))) {
    throw new Error("Generate test-short.webm as described in e2e/README.md.");
  }
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
    await import("ws");
    const { createRequire } = await import("node:module");
    createRequire(path.join(SERVER_DIR, "package.json")).resolve("ws");
  } catch (error) {
    throw new Error("Install dependencies: npm --prefix server ci && npm --prefix e2e ci", { cause: error });
  }
  const options = browserOptions();
  if (!options.executablePath && !fs.existsSync(chromium.executablePath())) {
    throw new Error("Install Chromium: npm --prefix e2e run browser:install, or set CHROMIUM_PATH.");
  }
}

async function ready(child, ports, isInterrupted) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (isInterrupted()) return;
    if (child.exitCode !== null || child.signalCode !== null || child.spawnError) throw new Error("Test service exited during startup; see service logs.");
    const connected = await Promise.all(ports.map((port) => new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const done = (ok) => { socket.destroy(); resolve(ok); };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(200, () => done(false));
    })));
    if (connected.every(Boolean)) return;
    await delay(100);
  }
  throw new Error("Test service startup timed out; see service logs.");
}

// Exported so cleanup and exit handling can be checked with small local fixtures.
export async function run({
  script = path.resolve(E2E, process.env.SCRIPT || "run.mjs"),
  timeout = Number(process.env.TMO || 230),
  log = path.resolve(E2E, process.env.LOG || "run.log"),
  ports = [8443, 8444, 8450, 8451, 8787, 8789, 8790, 8791, 8792, 8793, 8794, 8796, 8899],
  services = [
    { script: path.join(E2E, "fakesite.mjs"), cwd: E2E, log: path.join(E2E, "fake.log"), ports: [8443, 8444] },
    { script: path.join(SERVER_DIR, "server.js"), cwd: SERVER_DIR, log: SERVER_LOG, ports: [8787], env: { PORT: "8787" } },
  ],
  check = preflight,
} = {}) {
  if (process.platform === "win32") throw new Error("Run this suite in WSL. Cleanup requires POSIX process groups.");
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("TMO must be a positive number of seconds.");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "netparty-e2e-"));
  const children = [];
  let timer, interrupted;
  const signalGroup = (child, signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; }
  };
  const stop = async () => {
    for (const child of children) signalGroup(child, "SIGTERM");
    await delay(500);
    for (const child of children) signalGroup(child, "SIGKILL");
    await Promise.all(children.map((child) =>
      child.exitCode !== null || child.signalCode !== null || child.spawnError
        ? undefined : new Promise((resolve) => child.once("exit", resolve))));
  };
  const onInt = () => { interrupted = 130; };
  const onTerm = () => { interrupted = 143; };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const start = (item) => {
    const fd = fs.openSync(item.log, "w");
    let child;
    try {
      child = spawn(process.execPath, [item.script], {
        cwd: item.cwd || E2E, detached: true, stdio: ["ignore", fd, fd],
        env: { ...process.env, E2E_RUN_DIR: runDir, SERVER_LOG, EXT_DIR: EXT, MEDIA_DIR, SITE: process.env.SITE || "https://www.netflix.com/watch/12345", ...item.env },
      });
    } finally { fs.closeSync(fd); }
    child.on("error", (error) => { child.spawnError = error; });
    children.push(child);
    return child;
  };
  try {
    await check(script);
    await assertPortsFree(ports);
    for (const service of services) {
      if (interrupted) return interrupted;
      await ready(start(service), service.ports, () => interrupted);
    }
    if (interrupted) return interrupted;
    const test = start({ script, log });
    timer = setTimeout(() => { interrupted = 124; }, timeout * 1000);
    while (test.exitCode === null && test.signalCode === null && !test.spawnError && !interrupted) {
      const failed = children.slice(0, -1).find((c) => c.exitCode !== null || c.signalCode !== null || c.spawnError);
      if (failed) throw new Error("Test service stopped unexpectedly; see service logs.");
      await delay(50);
    }
    const code = interrupted || test.exitCode || (test.signalCode || test.spawnError ? 1 : 0);
    fs.appendFileSync(log, `\nexit ${code}\n`);
    console.log(`Test exit ${code}. Log: ${log}`);
    return code;
  } finally {
    clearTimeout(timer);
    await stop();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await run(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
