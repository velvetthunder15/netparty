// NetParty sync server on Cloudflare Workers. All WebSocket connections go to one
// Durable Object ("hub"), which runs the same room logic as the Node server.
import { createHub, iceProvider, joinPage, joinPageHeaders } from "../core.js";
import { parseGifRequest, gifSearch, corsHeaders, makeLimiter, GIF_CACHE_SECONDS } from "../gifs.js";
import extensionZip from "./public/netparty-extension.zip";
// landing site (copied from the Hark-built page) bundled into the Worker
import siteIndex from "./site/index.html";
import sitePrivacy from "./site/privacy.html";
import siteCss from "./site/hark.css";
import siteHeroCss from "./site/hark-hero.css";
import siteJs from "./site/hark.js.txt";
import imgSpace from "./site/still-space.webp";
import imgNeon from "./site/still-neon.webp";
import imgJio from "./site/jiohotstar-star.webp";
import svgNetflix from "./site/netflix.svg";
import svgYoutube from "./site/youtube.svg";
import svgPrime from "./site/primevideo.svg";
import svgHbo from "./site/hbo.svg";
import svgCrunchyroll from "./site/crunchyroll.svg";
import imgSonyliv from "./site/sonyliv.webp";
import avFox from "./site/av-fox.webp";
import avPanda from "./site/av-panda.webp";
import avRobot from "./site/av-robot.webp";
import avUnicorn from "./site/av-unicorn.webp";
import imgOg from "./site/og.jpg";
import imgIcon512 from "./site/icon-512.png";
import imgFavicon48 from "./site/favicon-48.png";
import imgFavicon96 from "./site/favicon-96.png";
import imgFavicon192 from "./site/favicon-192.png";
import svgFavicon from "./site/favicon.svg";
import imgOgSquare from "./site/og-square.jpg";
import imgAppleTouch from "./site/apple-touch-icon.png";
import fontInter from "./site/inter-latin.woff2";
import fontMono from "./site/jbmono-latin.woff2";
import fontsLicense from "./site/fonts-license.txt";

const HTML = "text/html; charset=utf-8";
// link-preview (Open Graph / Twitter) image tags, injected so a recopy of the Hark build keeps them
const OG_TAGS = `<meta property="og:image" content="https://netparty.tech/og.jpg" />
<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="NetParty: watch together, in sync on Netflix, Prime Video, YouTube, HBO Max, Crunchyroll, SonyLIV, JioHotstar and other video sites" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:image" content="https://netparty.tech/og.jpg" />
`;
const withOg = (html) => (/og:image/.test(html) ? html : html.replace(/<\/head>/i, OG_TAGS + "</head>"));

// SEO layer, applied at load so a recopy of the Hark build keeps it: keyword title and
// description, canonical, robots, icons, alt text, and JSON-LD built from the visible FAQ.
const SEO_TITLE = "NetParty: Free Watch Party for Netflix, Prime Video, YouTube, HBO Max, Crunchyroll & SonyLIV";
const SEO_DESC = "Watch Netflix, Prime Video, YouTube, HBO Max, Crunchyroll, SonyLIV, JioHotstar and videos on most other sites together in sync. Free watch party extension with encrypted chat, voice and video chat. No sign-up.";
const stripTags = (h) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
function withSeo(html) {
  const faq = [...html.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/gi)]
    .map((m) => ({ "@type": "Question", name: stripTags(m[1]), acceptedAnswer: { "@type": "Answer", text: stripTags(m[2]) } }));
  const graph = [
    { "@type": "WebSite", "@id": "https://netparty.tech/#website", url: "https://netparty.tech/", name: "NetParty", alternateName: ["NetParty Watch Party", "NetParty extension"], inLanguage: "en" },
    { "@type": "WebPage", "@id": "https://netparty.tech/#webpage", url: "https://netparty.tech/", name: SEO_TITLE, isPartOf: { "@id": "https://netparty.tech/#website" },
      primaryImageOfPage: { "@type": "ImageObject", url: "https://netparty.tech/og.jpg", width: 1200, height: 630 } },
    { "@type": "Organization", "@id": "https://netparty.tech/#org", name: "NetParty", url: "https://netparty.tech/",
      logo: "https://netparty.tech/icon-512.png", email: "support@netparty.tech", sameAs: ["https://github.com/velvetthunder15/netparty"] },
    { "@type": "SoftwareApplication", name: "NetParty", url: "https://netparty.tech/", description: SEO_DESC,
      applicationCategory: "BrowserApplication", operatingSystem: "Windows, macOS, Linux, ChromeOS",
      image: ["https://netparty.tech/og.jpg", "https://netparty.tech/og-square.jpg"], publisher: { "@id": "https://netparty.tech/#org" },
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      featureList: "Synced play, pause and seek on Netflix, Prime Video, YouTube, HBO Max, Crunchyroll, SonyLIV and JioHotstar; sync videos on most other sites; waits when someone buffers; end-to-end encrypted chat; replies, reactions and mentions; voice and video chat with relay; HD avatars or your own photo; GIFs; host controls",
      license: "https://opensource.org/licenses/MIT" },
  ];
  if (faq.length) graph.push({ "@type": "FAQPage", mainEntity: faq });
  const ld = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  const head = `<link rel="canonical" href="https://netparty.tech/" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<meta property="og:site_name" content="NetParty" /><meta property="og:locale" content="en_US" />
<meta name="twitter:title" content="${SEO_TITLE}" /><meta name="twitter:description" content="${SEO_DESC}" />
<meta name="application-name" content="NetParty" /><meta name="apple-mobile-web-app-title" content="NetParty" />
<link rel="icon" href="/favicon.ico" sizes="48x48" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png" />
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<script type="application/ld+json">${ld}</script>
`;
  return html
    .replace(/<link rel="icon"[^>]*>\s*/gi, "")
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${SEO_TITLE}</title>`)
    .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${SEO_DESC}" />`)
    .replace(/<meta property="og:title"[^>]*>/i, `<meta property="og:title" content="${SEO_TITLE}" />`)
    .replace('<img src="netflix.svg" width="22" height="22" alt=""', '<img src="netflix.svg" width="22" height="22" alt="Netflix"')
    .replace('<img src="jiohotstar-star.webp" width="64" height="64" alt=""', '<img src="jiohotstar-star.webp" width="64" height="64" alt="JioHotstar"')
    .replace('<img src="youtube.svg" width="22" height="22" alt=""', '<img src="youtube.svg" width="22" height="22" alt="YouTube"')
    .replace('<img src="primevideo.svg" width="27" height="22" alt=""', '<img src="primevideo.svg" width="27" height="22" alt="Prime Video"')
    .replace('<img src="hbo.svg" width="22" height="22" alt=""', '<img src="hbo.svg" width="22" height="22" alt="HBO Max"')
    .replace('<img src="crunchyroll.svg" width="22" height="22" alt=""', '<img src="crunchyroll.svg" width="22" height="22" alt="Crunchyroll"')
    .replace('<img src="sonyliv.webp" width="22" height="22" alt=""', '<img src="sonyliv.webp" width="22" height="22" alt="SonyLIV"')
    .replace('<img src="still-neon.webp" width="800" height="447" loading="lazy" decoding="async" alt=""', '<img src="still-neon.webp" width="800" height="447" loading="lazy" decoding="async" alt="Friends chatting beside a synced video in NetParty"')
    .replace(/<\/head>/i, head + "</head>");
}
const ICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="48x48" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png" />
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
`;
const withPrivacySeo = (html) => html.replace(/<link rel="icon"[^>]*>\s*/gi, "").replace(/<\/head>/i,
  (/rel="canonical"/.test(html) ? "" : `<link rel="canonical" href="https://netparty.tech/privacy" />\n`) + `<meta property="og:site_name" content="NetParty" />\n` + ICON_LINKS + "</head>");
const ROBOTS = "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /download/\n\nSitemap: https://netparty.tech/sitemap.xml\n";
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://netparty.tech/</loc><lastmod>2026-11-06</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
<url><loc>https://netparty.tech/privacy</loc><lastmod>2026-11-06</lastmod><changefreq>monthly</changefreq><priority>0.3</priority></url>
</urlset>
`;
const siteIndexOg = withSeo(withOg(siteIndex));
const MAINTAIN_MS = 15 * 60 * 1000;
const SITE = {
  "/": [siteIndexOg, HTML],
  "/privacy": [withPrivacySeo(sitePrivacy), HTML],
  "/robots.txt": [ROBOTS, "text/plain; charset=utf-8"],
  "/sitemap.xml": [SITEMAP, "application/xml; charset=utf-8"],
  "/icon-512.png": [imgIcon512, "image/png"],
  "/favicon-48.png": [imgFavicon48, "image/png"],
  "/favicon.ico": [imgFavicon48, "image/png"],
  "/favicon-96.png": [imgFavicon96, "image/png"],
  "/favicon-192.png": [imgFavicon192, "image/png"],
  "/favicon.svg": [svgFavicon, "image/svg+xml"],
  "/og-square.jpg": [imgOgSquare, "image/jpeg"],
  "/apple-touch-icon.png": [imgAppleTouch, "image/png"],
  "/hark.css": [siteCss, "text/css; charset=utf-8"],
  "/hark-hero.css": [siteHeroCss, "text/css; charset=utf-8"],
  "/hark.js": [siteJs, "text/javascript; charset=utf-8"],
  "/still-space.webp": [imgSpace, "image/webp"],
  "/still-neon.webp": [imgNeon, "image/webp"],
  "/jiohotstar-star.webp": [imgJio, "image/webp"],
  "/netflix.svg": [svgNetflix, "image/svg+xml"],
  "/youtube.svg": [svgYoutube, "image/svg+xml"],
  "/primevideo.svg": [svgPrime, "image/svg+xml"],
  "/hbo.svg": [svgHbo, "image/svg+xml"],
  "/sonyliv.webp": [imgSonyliv, "image/webp"],
  "/crunchyroll.svg": [svgCrunchyroll, "image/svg+xml"],
  "/av-fox.webp": [avFox, "image/webp"],
  "/av-panda.webp": [avPanda, "image/webp"],
  "/av-robot.webp": [avRobot, "image/webp"],
  "/av-unicorn.webp": [avUnicorn, "image/webp"],
  "/og.jpg": [imgOg, "image/jpeg"],
  "/inter-latin.woff2": [fontInter, "font/woff2"],
  "/jbmono-latin.woff2": [fontMono, "font/woff2"],
  "/fonts-license.txt": [fontsLicense, "text/plain; charset=utf-8"],
};

// Security headers for the landing site. Inline <script> blocks are allowed only by
// their SHA-256 hash, so the CSP follows the page automatically after a recopy.
const BASE_SECURITY = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
};
const siteCsp = new Map();
async function cspFor(html) {
  if (siteCsp.has(html)) return siteCsp.get(html);
  const hashes = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1])));
    let bin = "";
    for (const b of d) bin += String.fromCharCode(b);
    hashes.push(`'sha256-${btoa(bin)}'`);
  }
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
  siteCsp.set(html, csp);
  return csp;
}
function withSecurity(res, extra = {}) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...BASE_SECURITY, ...extra })) if (!h.has(k)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h, webSocket: res.webSocket });
}

// invite page browser line: point Edge users at the store listing (Firefox and Edge are on their stores; Opera not yet)
export class PartyHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // parties are mirrored to Durable Object storage so a restart (deploys, Cloudflare
    // moving the object) doesn't lose them; clients reconnect and rejoin on their own
    // (only encrypted chat, profiles and key checks are stored; see core.js). An alarm every
    // 15 minutes deletes parties that have been idle for nearly 6 hours.
    const kv = state.storage;
    this.kv = kv;
    this.ice = iceProvider(env);
    this.hub = createHub({
      iceServers: this.ice,
      store: {
        get: (id) => kv.get("room:" + id),
        put: async (id, obj) => {
          await kv.put("room:" + id, obj);
          await this.ensureAlarm();
        },
        del: (id) => kv.delete("room:" + id),
        list: async () => [...(await kv.list({ prefix: "room:" }))].map(([k, v]) => [k.slice(5), v]),
      },
    });
    this.ensureAlarm().catch(() => {});
  }

  async ensureAlarm() {
    if (this.alarmSet) return;
    this.alarmSet = true;
    if ((await this.kv.getAlarm()) == null) await this.kv.setAlarm(Date.now() + MAINTAIN_MS);
  }

  async alarm() {
    this.alarmSet = false;
    await this.hub.maintain();
    const left = await this.kv.list({ prefix: "room:", limit: 1 });
    if (left.size || this.hub.rooms.size) await this.ensureAlarm();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const j = url.pathname.match(/^\/j\/([a-z0-9]{4,16})\/?$/i);
    if (j) {
      const room = await this.hub.findRoom(j[1]);
      return new Response(joinPage(room, j[1], { hasDownload: true }), {
        status: room ? 200 : 404,
        headers: await joinPageHeaders(),
      });
    }
    const live = url.pathname.match(/^\/live\/([a-z0-9]{4,16})$/i);
    if (live) {
      const room = await this.hub.findRoom(live[1]);
      return new Response(null, { status: room ? 204 : 404 });
    }
    if (url.pathname === "/health")
      return Response.json({ ok: true, rooms: this.hub.rooms.size, relay: this.ice.status.relay });
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("Not found.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" } });

    const [clientSide, serverSide] = Object.values(new WebSocketPair());
    serverSide.accept();
    const conn = this.hub.connect((s) => serverSide.send(s));
    serverSide.addEventListener("message", (e) => conn.message(e.data));
    const done = () => {
      conn.close();
      this.hub.sweep();
    };
    serverSide.addEventListener("close", done);
    serverSide.addEventListener("error", done);
    return new Response(null, { status: 101, webSocket: clientSide });
  }
}

// ---- GIF search proxy (KLIPY). Needs the Worker secret KLIPY_KEY; without it the
// endpoints answer 503 {error:"gifs_unavailable"} and the extension hides GIFs.
const gifLimit = makeLimiter({ max: 60, windowMs: 60_000 });
async function gifs(request, env, ctx, url) {
  const cors = corsHeaders(request.headers.get("Origin"));
  const json = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...cors, ...extra } });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
  const parsed = parseGifRequest(url);
  if (parsed.error) return json(parsed.status, { error: parsed.error });
  if (!env.KLIPY_KEY) return json(503, { error: "gifs_unavailable" }, { "cache-control": "no-store" });
  const country = /^[A-Z]{2}$/.test(request.cf?.country || "") ? request.cf.country : "";
  // edge cache, keyed on the normalized query (never on the key or the caller)
  const ck = new Request(`${url.origin}/__gif-cache/${parsed.kind}?q=${encodeURIComponent(parsed.q)}&pos=${encodeURIComponent(parsed.pos)}&c=${country}`);
  const cache = caches.default;
  const hit = await cache.match(ck);
  if (hit) return json(200, await hit.json(), { "cache-control": `public, max-age=${GIF_CACHE_SECONDS}`, "x-cache": "HIT" });
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  if (!gifLimit(ip)) return json(429, { error: "rate_limited" }, { "retry-after": "60" });
  const out = await gifSearch(parsed, { key: env.KLIPY_KEY, base: env.KLIPY_BASE, country });
  if (out.status === 200)
    ctx.waitUntil(cache.put(ck, new Response(JSON.stringify(out.body), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${GIF_CACHE_SECONDS}` } })));
  return json(out.status, out.body, { "cache-control": out.status === 200 ? `public, max-age=${GIF_CACHE_SECONDS}` : "no-store" });
}

export default {
  async fetch(request, env, ctx) {
    const stub = env.HUB.get(env.HUB.idFromName("global"));
    const url = new URL(request.url);
    if (url.hostname === "www.netparty.tech")
      return Response.redirect("https://netparty.tech" + url.pathname + url.search, 301);
    const isWs = request.headers.get("Upgrade") === "websocket";
    // one canonical origin: plain http goes to https in a single hop
    if (!isWs && url.protocol === "http:" && /(^|\.)netparty\.tech$/.test(url.hostname))
      return Response.redirect("https://netparty.tech" + url.pathname + url.search, 301);
    // old image names (pre-WebP) point at the new files
    const OLD_IMG = { "/still-space.jpg": "/still-space.webp", "/still-neon.jpg": "/still-neon.webp", "/jiohotstar-star.png": "/jiohotstar-star.webp" };
    if (!isWs && OLD_IMG[url.pathname]) return Response.redirect("https://netparty.tech" + OLD_IMG[url.pathname], 301);
    if (!isWs && url.pathname.startsWith("/api/gifs/")) return gifs(request, env, ctx, url);
    if (!isWs && (url.pathname === "/index.html" || url.pathname === "/privacy.html" || url.pathname === "/privacy/"))
      return Response.redirect("https://netparty.tech" + (url.pathname === "/index.html" ? "/" : "/privacy") + url.search, 301);
    if (!isWs && (request.method === "GET" || request.method === "HEAD")) {
      const page = SITE[url.pathname];
      if (page) {
        const headers = { "content-type": page[1], "cache-control": page[1] === HTML ? "public, max-age=300" : page[1] === "font/woff2" ? "public, max-age=31536000, immutable" : "public, max-age=86400" };
        if (page[1] === HTML) headers["content-security-policy"] = await cspFor(page[0]);
        if (page[1] === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
        return withSecurity(new Response(request.method === "HEAD" ? null : page[0], { headers }));
      }
      if (url.pathname === "/download/netparty-extension.zip")
        return withSecurity(new Response(extensionZip, {
          headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="netparty-extension.zip"', "cache-control": "public, max-age=300" },
        }));
    }
    // invite pages also offer the zip from a live party's invite page
    const dl = url.pathname.match(/^\/j\/([a-z0-9]{4,16})\/netparty\.zip$/i);
    if (dl) {
      const live = await stub.fetch(new Request(`${url.origin}/live/${dl[1]}`));
      if (live.status !== 204) return new Response("Not available.\n", { status: 404 });
      return new Response(extensionZip, {
        headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="netparty.zip"', "cache-control": "no-store" },
      });
    }
    return stub.fetch(request);
  },
};
