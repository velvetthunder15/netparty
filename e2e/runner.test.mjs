import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { run, assertPortsFree } from "./runner.mjs";

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test("runner preserves failure and cleans only owned processes on timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netparty runner with spaces "));
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    const script = path.join(dir, "test script.mjs");
    const log = path.join(dir, "test.log");
    const options = { script, log, ports: [], services: [], check: async () => {} };
    fs.writeFileSync(script, "process.exit(7);");
    assert.equal(await run(options), 7);
    fs.writeFileSync(script, "console.log('ok');");
    assert.equal(await run(options), 0);
    fs.writeFileSync(script, `
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      fs.writeFileSync(${JSON.stringify(path.join(dir, "pids.json"))}, JSON.stringify([process.pid, child.pid]));
      process.on('SIGTERM', () => { child.once('exit', () => process.exit(0)); child.kill(); });
      setInterval(() => {}, 1000);
    `);
    assert.equal(await run({ ...options, timeout: 1 }), 124);
    const pids = JSON.parse(fs.readFileSync(path.join(dir, "pids.json")));
    assert.ok(pids.every((pid) => !alive(pid)), "test and descendant stopped");
    assert.ok(alive(sentinel.pid), "unrelated process survived");
    assert.match(fs.readFileSync(log, "utf8"), /exit 124/);
    await assert.rejects(run({ ...options, timeout: NaN }), /TMO/);
    await assert.rejects(run({ ...options, check: async () => { throw new Error("missing fixture"); } }), /missing fixture/);
  } finally {
    sentinel.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("occupied port is rejected without stopping its owner", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await assert.rejects(assertPortsFree([server.address().port]), /unavailable/);
    assert.ok(server.listening);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`${signal} returns ${status} and stops its test child`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netparty-signal-"));
    let runner;
    try {
      const pidFile = path.join(dir, "pid");
      const script = path.join(dir, "child.mjs");
      fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
      const wrapper = path.join(dir, "wrapper.mjs");
      fs.writeFileSync(wrapper, `import { run } from ${JSON.stringify(new URL("./runner.mjs", import.meta.url).href)};
        process.exitCode = await run({ script: ${JSON.stringify(script)}, log: ${JSON.stringify(path.join(dir, "run.log"))}, services: [], ports: [], check: async () => {} });`);
      runner = spawn(process.execPath, [wrapper], { stdio: "ignore" });
      const exited = new Promise((resolve) => runner.once("exit", resolve));
      for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(fs.existsSync(pidFile), "test child started");
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      runner.kill(signal);
      assert.equal(await exited, status);
      assert.ok(!alive(pid), "test child stopped");
    } finally {
      runner?.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("service startup failure prevents test execution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netparty-startup-"));
  try {
    const service = path.join(dir, "service.mjs");
    fs.writeFileSync(service, "process.exit(9);");
    await assert.rejects(run({
      script: path.join(dir, "must-not-run.mjs"), ports: [], check: async () => {},
      services: [{ script: service, log: path.join(dir, "service.log"), ports: [1] }],
    }), /exited during startup/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
