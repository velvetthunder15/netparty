// 2.3: the invite QR code (extension/qr.js) decodes back to exactly the text it was made from.
// Every length from 1 byte to the version-10 limit, every mask, real invite links, and non-ASCII text,
// checked with an independent decoder (jsQR). Run: node --test qr.test.mjs (or npm --prefix e2e run test:qr).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import jsQR from "jsqr";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, "..", "extension", "qr.js")).href);
const QR = globalThis.NP_QR;

// the modules as an RGBA image (quiet zone included), scaled up like a screen would show it
function decode(q, px = 4) {
  const quiet = 4, n = (q.size + quiet * 2) * px;
  const rgba = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++) {
      if (!q.dark[y][x]) continue;
      for (let dy = 0; dy < px; dy++)
        for (let dx = 0; dx < px; dx++) {
          const i = (((y + quiet) * px + dy) * n + (x + quiet) * px + dx) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
        }
    }
  const r = jsQR(rgba, n, n, { inversionAttempts: "dontInvert" });
  return r ? { text: r.data, version: r.version } : null;
}
const sample = (n) => Array.from({ length: n }, (_, i) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_#/:?=&."[(i * 7 + n) % 71]).join("");

test("invite links decode exactly, at the expected size", () => {
  for (let i = 0; i < 25; i++) {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const code = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex").slice(0, 8);
    const link = `https://netparty.tech/j/${code}#k=${key}`;
    const q = QR.encode(link);
    assert.equal(q.version, 5, "an 78-character invite link fits version 5 (37 x 37)");
    assert.equal(q.size, 37);
    assert.equal(decode(q)?.text, link);
  }
});

test("every length 1..MAX_BYTES decodes (versions 1-10, all block layouts)", () => {
  assert.equal(QR.MAX_BYTES, 213);
  const seen = new Set();
  for (let n = 1; n <= QR.MAX_BYTES; n++) {
    const s = sample(n);
    const q = QR.encode(s);
    assert.ok(q, "fits: " + n);
    seen.add(q.version);
    const d = decode(q);
    assert.equal(d?.text, s, `length ${n} (version ${q.version}, mask ${q.mask})`);
    assert.equal(d.version, q.version);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(QR.encode(sample(QR.MAX_BYTES + 1)), null, "too long: no code rather than a wrong one");
});

test("all 8 masks decode, in every version", () => {
  for (const n of [5, 20, 40, 60, 80, 100, 120, 150, 180, 213])
    for (let m = 0; m < 8; m++) {
      const s = sample(n);
      const q = QR.encode(s, { mask: m });
      assert.equal(q.mask, m);
      assert.equal(decode(q)?.text, s, `length ${n} mask ${m}`);
    }
});

test("UTF-8 text decodes", () => {
  for (const s of ["https://netparty.tech/j/abcd1234#k=ä", "पार्टी में आइए", "🎉 watch party"]) assert.equal(decode(QR.encode(s))?.text, s);
});
