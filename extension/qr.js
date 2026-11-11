// QR codes for the invite link (2.3), made in the browser: the link carries the party's key, so it is never
// sent to a QR service. Byte mode, error correction level M, versions 1–10 (up to 213 bytes; an invite link is
// about 80). Follows ISO/IEC 18004: Reed–Solomon over GF(256), block interleaving, the 8 masks scored with the
// standard penalty rules. Shared by the content script and the popup: sets globalThis.NP_QR.
(() => {
  // per version, level M: [EC codewords per block, [blocks, data codewords], [blocks, data codewords]?]
  const BLOCKS = [
    null,
    [10, [1, 16]],
    [16, [1, 28]],
    [26, [1, 44]],
    [18, [2, 32]],
    [24, [2, 43]],
    [16, [4, 27]],
    [18, [4, 31]],
    [22, [2, 38], [2, 39]],
    [22, [3, 36], [2, 37]],
    [26, [4, 43], [1, 44]],
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const MAX_VERSION = 10;
  const dataCodewords = (v) => BLOCKS[v].slice(1).reduce((n, [b, d]) => n + b * d, 0);
  const countBits = (v) => (v < 10 ? 8 : 16); // byte mode character count

  // GF(256), x^8 + x^4 + x^3 + x^2 + 1
  const mul = (x, y) => {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  };
  function rsDivisor(degree) {
    const out = new Array(degree).fill(0);
    out[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < out.length; j++) {
        out[j] = mul(out[j], root);
        if (j + 1 < out.length) out[j] ^= out[j + 1];
      }
      root = mul(root, 0x02);
    }
    return out;
  }
  function rsRemainder(data, divisor) {
    const out = new Array(divisor.length).fill(0);
    for (const b of data) {
      const f = b ^ out.shift();
      out.push(0);
      divisor.forEach((c, i) => (out[i] ^= mul(c, f)));
    }
    return out;
  }

  // the data codewords for these bytes at version v (mode, count, bytes, terminator, padding)
  function codewords(bytes, v) {
    const bits = [];
    const put = (val, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    put(0b0100, 4);
    put(bytes.length, countBits(v));
    for (const b of bytes) put(b, 8);
    const cap = dataCodewords(v) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xec; out.length < dataCodewords(v); pad ^= 0xec ^ 0x11) out.push(pad);
    return out;
  }
  // split into blocks, add each block's EC codewords, interleave
  function withEcc(data, v) {
    const [ec, ...groups] = BLOCKS[v];
    const div = rsDivisor(ec);
    const blocks = [];
    let at = 0;
    for (const [n, d] of groups)
      for (let i = 0; i < n; i++) {
        const part = data.slice(at, at + d);
        at += d;
        blocks.push({ data: part, ec: rsRemainder(part, div) });
      }
    const out = [];
    const maxData = Math.max(...blocks.map((b) => b.data.length));
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);
    return out;
  }

  function build(v, cw, mask) {
    const size = v * 4 + 17;
    const dark = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, on) => {
      dark[y][x] = on;
      fn[y][x] = true;
    };
    // timing patterns, then finders (with their separators), alignment patterns
    for (let i = 0; i < size; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
    const al = ALIGN[v];
    for (let i = 0; i < al.length; i++)
      for (let j = 0; j < al.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    // format information (level M = 00) and the dark module
    const fmt = (() => {
      const data = (0b00 << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      return ((data << 10) | rem) ^ 0x5412;
    })();
    const bit = (n, i) => ((n >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(fmt, i));
    set(8, 7, bit(fmt, 6));
    set(8, 8, bit(fmt, 7));
    set(7, 8, bit(fmt, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(fmt, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(fmt, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(fmt, i));
    set(8, size - 8, true);
    // version information (7 and up)
    if (v >= 7) {
      let rem = v;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (v << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const on = bit(bits, i), a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, on);
        set(b, a, on);
      }
    }
    // the codewords, in the zigzag order, two columns at a time from the right
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? size - 1 - vert : vert;
          if (!fn[y][x] && i < cw.length * 8) {
            dark[y][x] = bit(cw[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
    }
    // the mask
    const flip = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ][mask];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && flip(x, y)) dark[y][x] = !dark[y][x];
    return { size, dark };
  }

  // standard penalty: runs of 5+, 2x2 blocks, finder-like 1:1:3:1:1 runs with 4 light modules beside, dark balance
  function penalty({ size, dark }) {
    let p = 0;
    const line = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          if (get(a, b) === get(a, b - 1)) {
            run++;
            if (run === 5) p += 3;
            else if (run > 5) p++;
          } else run = 1;
        }
        // finder-like: 10111010000 or 00001011101, with the light modules allowed to run off the edge
        const at = (b) => (b < 0 || b >= size ? false : get(a, b));
        for (let b = -4; b < size; b++) {
          const core = at(b) && !at(b + 1) && at(b + 2) && at(b + 3) && at(b + 4) && !at(b + 5) && at(b + 6);
          if (!core) continue;
          const before = !at(b - 1) && !at(b - 2) && !at(b - 3) && !at(b - 4);
          const after = !at(b + 7) && !at(b + 8) && !at(b + 9) && !at(b + 10);
          if (before) p += 40;
          if (after) p += 40;
        }
      }
    };
    line((y, x) => dark[y][x]);
    line((x, y) => dark[y][x]);
    let n = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (dark[y][x]) n++;
        if (x < size - 1 && y < size - 1) {
          const c = dark[y][x];
          if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) p += 3;
        }
      }
    const total = size * size;
    p += Math.floor(Math.abs(n * 20 - total * 10) / total) * 10;
    return p;
  }

  /**
   * text -> { size, dark: boolean[size][size], version, mask }, or null if it doesn't fit in version 10.
   * opts.mask forces one of the 8 masks (tests); otherwise the one with the lowest penalty is used.
   */
  function encode(text, opts = {}) {
    const bytes = [...new TextEncoder().encode(String(text))];
    let v = 1;
    while (v <= MAX_VERSION && 4 + countBits(v) + bytes.length * 8 > dataCodewords(v) * 8) v++;
    if (v > MAX_VERSION) return null;
    const cw = withEcc(codewords(bytes, v), v);
    let best = null;
    for (let m = 0; m < 8; m++) {
      if (Number.isInteger(opts.mask) && opts.mask !== m) continue;
      const q = build(v, cw, m);
      const s = penalty(q);
      if (!best || s < best.s) best = { s, q, m };
    }
    return { size: best.q.size, dark: best.q.dark, version: v, mask: best.m };
  }

  /** Draws the code on a canvas: dark modules on white, with the 4-module quiet zone the standard asks for. */
  function draw(canvas, text, px = 6, opts = {}) {
    const q = encode(text, opts);
    if (!q) return null;
    const quiet = 4;
    const n = q.size + quiet * 2;
    canvas.width = canvas.height = n * px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, n * px, n * px);
    ctx.fillStyle = opts.color || "#000000";
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark[y][x]) ctx.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    return q;
  }

  globalThis.NP_QR = { encode, draw, MAX_BYTES: Math.floor((dataCodewords(MAX_VERSION) * 8 - 4 - countBits(MAX_VERSION)) / 8) };
})();
