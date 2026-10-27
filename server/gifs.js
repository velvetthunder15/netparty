// GIF search proxy (KLIPY). Shared by the Node server and the Cloudflare Worker.
// The KLIPY key lives only on the server (env KLIPY_KEY); the extension never sees it.
// KLIPY's Tenor-compatible API: GET {base}/v2/search?key=&q=&limit=&pos=&contentfilter=&media_filter=
// and GET {base}/v2/featured (trending). Results carry media_formats.{gif,tinygif,nanogif,...}.{url,dims}.
// Docs: https://docs.klipy.com/migrate-from-tenor/search, /features, /response-objects/media-object
import { isKlipyMediaUrl } from "./core.js";

export const KLIPY_DEFAULT_BASE = "https://api.klipy.com";
const LIMIT = 24;
export const GIF_CACHE_SECONDS = 600;

// Only what the extension needs may read these responses: the extension itself
// (its background fetches them: chrome-extension://<32 a-p> in Chrome, moz-extension://<random UUID>
// in Firefox, which has no fixed ID in the origin) and the sites it runs on.
const PAGE_ORIGINS = new Set(["https://www.netflix.com", "https://www.hotstar.com", "https://www.jiohotstar.com", "https://www.youtube.com"]);
export function corsHeaders(origin) {
  const ok = typeof origin === "string" && (/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(origin) || PAGE_ORIGINS.has(origin));
  return ok
    ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400", vary: "Origin" }
    : { vary: "Origin" };
}

// Parse /api/gifs/<kind>?q=&pos= into a normalized request, or an error.
export function parseGifRequest(url) {
  const m = url.pathname.match(/^\/api\/gifs\/(search|trending)\/?$/);
  if (!m) return { error: "not_found", status: 404 };
  const kind = m[1];
  const q = String(url.searchParams.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const pos = String(url.searchParams.get("pos") || "").slice(0, 200);
  if (kind === "search" && !q) return { error: "missing_query", status: 400 };
  if (pos && !/^[\w.=+\/-]+$/.test(pos)) return { error: "bad_pos", status: 400 };
  return { kind, q, pos };
}

const int = (n) => (Number.isFinite(+n) && +n > 0 && +n <= 4096 ? Math.round(+n) : null);

// Accept both the Tenor-compatible v2 shape and KLIPY's native v1 shape, defensively,
// and keep only media on KLIPY's own hosts (anything else could not be sent in chat).
export function normalizeKlipy(body) {
  const out = [];
  const v2 = Array.isArray(body?.results) ? body.results : null;
  const v1 = Array.isArray(body?.data?.data) ? body.data.data : null;
  for (const r of v2 || v1 || []) {
    let pick = null, prev = null;
    if (v2) {
      const f = r?.media_formats || {};
      pick = f.tinygif || f.mediumgif || f.gif || null;
      prev = f.tinygif || f.nanogif || pick;
      pick = pick && { url: pick.url, w: pick.dims?.[0], h: pick.dims?.[1] };
      prev = prev && { url: prev.url };
    } else {
      const f = r?.file || {};
      const g = f.sm?.gif || f.md?.gif || f.hd?.gif || null;
      pick = g && { url: g.url, w: g.width, h: g.height };
      prev = (f.xs?.gif || f.sm?.gif || g) && { url: (f.sm?.gif || f.xs?.gif || g).url };
    }
    if (!pick || !isKlipyMediaUrl(pick.url)) continue;
    out.push({
      id: String(r.id ?? r.slug ?? out.length).slice(0, 64),
      url: pick.url,
      preview: prev && isKlipyMediaUrl(prev.url) ? prev.url : pick.url,
      w: int(pick.w),
      h: int(pick.h),
      title: typeof r.title === "string" ? r.title.slice(0, 120) : "",
    });
  }
  let next = v2 ? body.next : body?.data?.has_next ? String((body.data.current_page || 1) + 1) : "";
  next = typeof next === "string" || typeof next === "number" ? String(next).slice(0, 200) : "";
  if (next === "0") next = "";
  return { results: out, next };
}

// -> { status, body }. fetchImpl defaults to global fetch.
export async function gifSearch(req, { key, base = KLIPY_DEFAULT_BASE, country = "", fetchImpl = fetch } = {}) {
  if (!key) return { status: 503, body: { error: "gifs_unavailable" } };
  const u = new URL((base || KLIPY_DEFAULT_BASE).replace(/\/+$/, "") + (req.kind === "search" ? "/v2/search" : "/v2/featured"));
  u.searchParams.set("key", key);
  u.searchParams.set("client_key", "netparty");
  if (req.kind === "search") u.searchParams.set("q", req.q);
  u.searchParams.set("limit", String(LIMIT));
  if (req.pos) u.searchParams.set("pos", req.pos);
  u.searchParams.set("contentfilter", "medium");
  u.searchParams.set("media_filter", "tinygif,nanogif,mediumgif,gif");
  if (/^[A-Z]{2}$/.test(country)) u.searchParams.set("country", country);
  let res;
  try {
    res = await fetchImpl(u.toString(), { headers: { accept: "application/json" } });
  } catch {
    return { status: 502, body: { error: "gifs_upstream" } };
  }
  if (res.status === 401 || res.status === 403) return { status: 503, body: { error: "gifs_unavailable" } };
  if (!res.ok) return { status: 502, body: { error: "gifs_upstream" } };
  let body;
  try {
    body = await res.json();
  } catch {
    return { status: 502, body: { error: "gifs_upstream" } };
  }
  return { status: 200, body: normalizeKlipy(body) };
}

// Small fixed-window limiter (per IP). In the Worker it's per isolate, so it's a
// soft limit; the edge cache absorbs repeated searches anyway.
export function makeLimiter({ max = 60, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.start > windowMs) {
      h = { start: now, n: 0 };
      hits.set(ip, h);
      if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    }
    h.n++;
    return h.n <= max;
  };
}
