const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "wss://netparty.tech";
// the sites NetParty runs on (same list as the content scripts in manifest.json)
const PRIME_TLDS = ["com", "co.uk", "de", "co.jp", "in", "ca", "com.au", "fr", "it", "es", "com.br", "com.mx", "nl"];
function supportedSite(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (/^www\.(netflix|hotstar|jiohotstar|youtube|primevideo|crunchyroll|sonyliv)\.com$/.test(u.hostname)) return true;
  if (u.hostname === "play.hbomax.com" || u.hostname === "play.max.com") return true; // 2.2: HBO Max
  // 2.4: Hulu, Disney+, Paramount+, STARZ, Tubi
  if (/^www\.(hulu|disneyplus|paramountplus|starz)\.com$/.test(u.hostname) || /^(www\.)?tubitv\.com$/.test(u.hostname)) return true;
  return PRIME_TLDS.some((t) => u.hostname === "www.amazon." + t) && /^\/(gp\/video|Amazon-Video)\//.test(u.pathname);
}
// "Sync any video" (2.0): any other http(s) page can be synced after a click. A few pages never allow
// extensions to run on them.
function webPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (/^(chrome\.google\.com|chromewebstore\.google\.com|microsoftedge\.microsoft\.com|addons\.mozilla\.org|addons\.opera\.com)$/.test(u.hostname)) return false;
  return true;
}
const ANY_FILES = ["any-mode.js", "early.js", "emoji-data.js", "qr.js", "anyvideo.js", "content.js"];
const E = globalThis.NP_EMOJI;
let tabId = null;
let origin = null; // the current tab's site, on a page that isn't a supported service
let alwaysOn = false; // "Always allow on this site" is on for it
let pending = null; // { code, key } a party this tab can join (see pendingInvite)
let frameOrigin = null; // a cross-origin player that needs the user's OK
let lastCmd = null; // what to do once that player is reachable

const VIEWS = ["vOff", "vIdle", "vParty", "vAny", "vFrame"];
const view = (...names) => {
  for (const v of VIEWS) $(v).classList.toggle("hidden", !names.includes(v));
  $("vMe").classList.toggle("hidden", names.length === 1 && names[0] === "vOff");
  $("vOff").classList.toggle("compact", names.includes("vAny"));
  $("anyAlwaysRow").classList.toggle("hidden", !origin);
};
const setError = (t) => ($("error").textContent = t || "");
const setMsg = (t) => ($("anyMsg").textContent = t || "");

// frameId 0: the tab's main page (a video agent in a subframe never answers these)
async function toTab(msg) {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })) || {};
  } catch {
    return { error: "NetParty isn't running on this tab yet. Reload the page and try again." };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the permission pattern for a site: scheme + host, any port (Firefox's match patterns can't name a port)
const patternOf = (o) => {
  const u = new URL(o);
  return `${u.protocol}//${u.hostname}/*`;
};
const httpBase = (server) => String(server || DEFAULT_SERVER).replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");

// A party this tab can join: one whose key this tab already holds (after "Open host's page"), or an invite
// page (…/j/<code>#k=<key>) open in this browser, the most recently used first.
async function pendingInvite() {
  const all = await chrome.storage.session.get(null).catch(() => ({}));
  for (const [k, v] of Object.entries(all)) {
    const m = k.match(/^rk:(\d+):([a-z0-9]{4,16})$/);
    if (m && Number(m[1]) === tabId && /^[A-Za-z0-9_-]{43}$/.test(String(v))) return { code: m[2], key: v, from: "tab" };
  }
  const { serverUrl } = await chrome.storage.sync.get("serverUrl");
  const base = httpBase(serverUrl) + "/j/";
  const tabs = (await chrome.tabs.query({}).catch(() => [])).filter((t) => String(t.url || "").startsWith(base));
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const t of tabs) {
    const inv = parseInvite(t.url);
    if (inv?.key) return { ...inv, from: "invite" };
  }
  return null;
}

// The full invite link (…/j/<code>#k=<key>) or a watch link (…?npParty=<code>#npKey=<key>):
// the code says which party, the key (in the #fragment) unlocks its end-to-end encrypted chat.
// A bare code has no key.
const NEED_LINK = "Paste the full invite link — the code alone can't unlock the encrypted chat.";
function parseInvite(s) {
  s = String(s || "").trim();
  const m = s.match(/\/j\/([a-z0-9]{4,16})(?=[/?#]|$)/i) || s.match(/[?&]npParty=([a-z0-9]{4,16})(?=[&#]|$)/i) || s.match(/^([a-z0-9]{4,16})$/i);
  if (!m) return null;
  const hash = s.includes("#") ? s.slice(s.indexOf("#") + 1) : "";
  const k = hash.split("&").map((p) => p.match(/^(?:k|npKey)=(.*)$/)).find(Boolean);
  const key = k && /^[A-Za-z0-9_-]{43}$/.test(k[1]) ? k[1] : null;
  return { code: m[1].toLowerCase(), key };
}

// the host's switches (2.3: Lock the party) and what Leave does
function showHostRows(st) {
  $("hostRow").classList.toggle("hidden", !st.isHost);
  $("hostOnly").checked = st.hostOnly;
  $("lockRow").classList.toggle("hidden", !st.isHost);
  $("lockParty").checked = st.locked === true;
  $("leave").textContent = st.isHost ? "End the party for everyone" : "Leave party";
  if (!$("qrBox").classList.contains("hidden")) drawQr(st.invite);
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  origin = null;
  if (!supportedSite(tab?.url || "")) {
    if (!webPage(tab?.url || "")) return view("vOff");
    origin = new URL(tab.url).origin;
    return refreshAny();
  }
  const st = await toTab({ cmd: "status" });
  if (st.error) {
    view("vIdle");
    $("create").disabled = true;
    $("startHint").textContent = st.error;
    return;
  }
  if (st.roomId) {
    view("vParty");
    $("partyCode").textContent = st.roomId;
    const n = st.members.length;
    $("who").textContent = `${n} watching: ${st.members.join(", ")}${st.voice ? " · you're in voice" : ""}`;
    showHostRows(st);
    $("copy").dataset.link = st.invite || "";
  } else {
    view("vIdle");
    $("create").disabled = !st.onWatchPage;
    $("startHint").textContent = st.onWatchPage
      ? `Starts a party for what's playing on ${st.site}.`
      : st.site === "YouTube"
        ? `Open a video on YouTube, or use the "Start a NetParty" button under it.`
        : st.site === "Prime Video"
          ? `Open a title's page on Prime Video and press play, or use the "Start a NetParty" button next to Play.`
          : ["Netflix", "JioHotstar"].includes(st.site)
            ? `Open a title on ${st.site} and press play, or use the "Start a NetParty" button next to Play.`
            : `Open an episode or movie on ${st.site} and press play, then start the party here or with "Start a NetParty" on the player.`;
    // 2.4: connect to the server now, so Start a party doesn't wait for it
    if (st.onWatchPage) toTab({ cmd: "warm" });
  }
}

// ---- any other website
async function refreshAny() {
  const { anyOrigins } = await chrome.storage.local.get("anyOrigins");
  alwaysOn = Array.isArray(anyOrigins) && anyOrigins.includes(origin) && (await chrome.permissions.contains({ origins: [patternOf(origin)] }).catch(() => false));
  $("anyAlways").checked = alwaysOn;
  pending = await pendingInvite();
  const st = await toTab({ cmd: "status" });
  if (!st.error && st.any) {
    if (st.roomId) {
      view("vParty");
      $("partyCode").textContent = st.roomId;
      $("who").textContent = `${st.members.length} watching: ${st.members.join(", ")}${st.voice ? " · you're in voice" : ""}`;
      showHostRows(st);
      $("copy").dataset.link = st.invite || "";
      // a player in a cross-origin frame the user has already allowed: bring its agent in
      if (!st.video && st.frameHint) await frameReady(st.frameHint, false);
      return;
    }
    if (st.picking) setMsg("Click the video you want to watch together on the page.");
  }
  showAnyIdle();
}
function showAnyIdle() {
  view("vAny", "vOff");
  $("anyJoinBox").classList.toggle("hidden", !pending);
  $("anyJoinHint").textContent = pending ? `Party ${pending.code}` + (pending.from === "invite" ? " (from the invite you opened)" : "") : "";
  $("anyStart").className = pending ? "ghost" : "primary";
  $("anyCode").classList.toggle("hidden", !!pending);
}

// The NetParty scripts go into this tab only now, after the click (activeTab). Already running (a site the
// user allowed, or a second click) -> nothing to do.
async function injectAny() {
  const st = await toTab({ cmd: "status" });
  if (!st.error) return st;
  await chrome.scripting.executeScript({ target: { tabId }, files: ANY_FILES });
  for (let t = 0; t < 6000; t += 150) {
    const s2 = await toTab({ cmd: "status" });
    if (!s2.error && s2.booted) return s2;
    await sleep(150);
  }
  throw new Error("NetParty couldn't start on this page. Reload it and try again.");
}

// "Always allow on this site": asked for right when the box is ticked (browsers only show the permission
// prompt for a click). Returns a promise for whether it's on.
function askAlways() {
  if (!origin || alwaysOn) return Promise.resolve(alwaysOn);
  // the background registers the site even if this popup closes while the browser asks
  chrome.storage.session.set({ ["anyWant:" + patternOf(origin)]: { origin, ts: Date.now() } }).catch(() => {});
  return chrome.permissions.request({ origins: [patternOf(origin)] }).then(
    async (ok) => {
      if (ok) {
        await chrome.runtime.sendMessage({ cmd: "anyAllow", origin }).catch(() => {});
        alwaysOn = true;
      } else $("anyAlways").checked = false;
      return ok;
    },
    () => (($("anyAlways").checked = false), false),
  );
}

// Start (create) or join a party on this tab
function anyGo(cmd, btn) {
  setError("");
  setMsg("");
  (async () => {
    if (btn) btn.disabled = true;
    try {
      await saveName();
      await injectAny();
      await doAny(cmd);
    } catch (e) {
      setError(e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  })();
}
async function doAny(cmd) {
  lastCmd = cmd;
  const res = await toTab(cmd);
  if (res.error) return setError(res.error === "No video found on this page." ? "No video found on this page. Play the video first, or open the page it's on." : res.error);
  if (res.needFrame) return askFrame(res.needFrame);
  if (res.picking) {
    setMsg("Click the video you want to watch together on the page.");
    return;
  }
  if (res.invite && cmd.cmd === "create") {
    await navigator.clipboard.writeText(res.invite).catch(() => {});
    $("copy").textContent = "Invite link copied ✓";
  }
  await refreshAny();
}

// ---- the video is inside a player from another site (cross-origin iframe)
function askFrame(o) {
  frameOrigin = o;
  let host = o;
  try {
    host = new URL(o).host;
  } catch {}
  $("frameLead").textContent = `The video is in a player from ${host}. Allow NetParty on ${host} to sync it?`;
  $("frameAllow").textContent = "Allow " + host;
  view("vFrame");
}
// bring the agent into the tab's frames we're allowed in, then wait for the video to show up
async function frameReady(o, retry = true) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["any-mode.js", "anyvideo.js"] }).catch(() => {});
  const r = await toTab({ cmd: "findVideo" });
  if (!r.ok) {
    setError(`NetParty couldn't find the video in the player from ${new URL(o).host}.`);
    return false;
  }
  if (retry && lastCmd) await doAny(lastCmd);
  else await refreshAny();
  return true;
}
$("frameAllow").onclick = () => {
  setError("");
  const o = frameOrigin;
  const ask = chrome.permissions.request({ origins: [patternOf(o)] }); // inside the click
  (async () => {
    let ok = false;
    try {
      ok = await ask;
    } catch {}
    if (!ok) {
      let host = o;
      try {
        host = new URL(o).host;
      } catch {}
      setError(`NetParty can't reach the video without access to ${host}, so this video can't be synced.`);
      return;
    }
    await frameReady(o);
  })();
};

$("anyStart").onclick = () => anyGo({ cmd: "create" }, $("anyStart"));
$("anyJoin").onclick = () => pending && anyGo({ cmd: "join", roomId: pending.code, key: pending.key }, $("anyJoin"));
$("anyCodeGo").onclick = () => {
  const inv = parseInvite($("anyCodeIn").value);
  if (!inv) return setError("That doesn't look like a NetParty invite link.");
  if (!inv.key) return setError(NEED_LINK);
  anyGo({ cmd: "join", roomId: inv.code, key: inv.key }, $("anyCodeGo"));
};
$("anyCodeIn").addEventListener("keydown", (e) => e.key === "Enter" && $("anyCodeGo").click());
$("anyAlways").onchange = () => {
  setMsg("");
  if ($("anyAlways").checked) {
    // inside the click: the browser asks the user for this one site
    askAlways().then((ok) =>
      setMsg(ok ? "NetParty now starts on this site by itself, so reloading keeps your party." : "NetParty didn't get access to this site, so it runs on a tab only after you click Sync this tab or Join."),
    );
    return;
  }
  if (!alwaysOn) return;
  (async () => {
    await chrome.runtime.sendMessage({ cmd: "anyForget", origin }).catch(() => {});
    alwaysOn = false;
    setMsg("NetParty no longer starts on this site by itself.");
  })();
};

async function run(msg, btn) {
  setError("");
  if (btn) btn.disabled = true;
  const res = await toTab(msg);
  if (btn) btn.disabled = false;
  if (res.error) setError(res.error);
  await refresh();
  return res;
}

async function saveName() {
  const name = $("name").value.trim();
  if (name) await chrome.storage.sync.set({ name });
}

$("create").onclick = async () => {
  await saveName();
  const res = await run({ cmd: "create" }, $("create"));
  if (res.invite) {
    await navigator.clipboard.writeText(res.invite).catch(() => {});
    $("copy").textContent = "Invite link copied ✓";
  }
};
$("join").onclick = async () => {
  const inv = parseInvite($("code").value);
  if (!inv) return setError("That doesn't look like a NetParty invite link.");
  if (!inv.key) return setError(NEED_LINK);
  await saveName();
  run({ cmd: "join", roomId: inv.code, key: inv.key }, $("join"));
};
$("code").addEventListener("keydown", (e) => e.key === "Enter" && $("join").click());
$("leave").onclick = () => run({ cmd: "leave" });
$("chat").onclick = async () => {
  await toTab({ cmd: "showChat" });
  window.close();
};
$("copy").onclick = async () => {
  await navigator.clipboard.writeText($("copy").dataset.link || "");
  $("copy").textContent = "Copied ✓";
  setTimeout(() => ($("copy").textContent = "Copy invite link"), 1500);
};
$("hostOnly").onchange = () => run({ cmd: "hostOnly", value: $("hostOnly").checked });
$("lockParty").onchange = () => run({ cmd: "lock", value: $("lockParty").checked });

// ---- 2.3 Invite friends: copy the link and open the app's own start page (the link never goes into an address,
// so its key isn't sent to the app's servers), or show it as a QR code made right here
const SHARE_APPS = {
  whatsapp: ["WhatsApp", "https://web.whatsapp.com/"],
  discord: ["Discord", "https://discord.com/channels/@me"],
  instagram: ["Instagram", "https://www.instagram.com/direct/inbox/"],
};
let shareMsgT = 0;
const shareSay = (t) => {
  $("shareMsg").textContent = t;
  clearTimeout(shareMsgT);
  shareMsgT = setTimeout(() => ($("shareMsg").textContent = ""), 6000);
};
function drawQr(link) {
  return !!link && !!globalThis.NP_QR?.draw($("qr"), link, 5);
}
for (const b of document.querySelectorAll(".share-app[data-app]")) {
  if (b.dataset.app === "qr") continue;
  const [label, url] = SHARE_APPS[b.dataset.app];
  b.onclick = async () => {
    const link = $("copy").dataset.link || "";
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      return shareSay("Couldn't copy the link. Try again.");
    }
    shareSay(`Invite link copied. Paste it into a chat on ${label}.`);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    await chrome.tabs.create({ url, ...(tab ? { index: tab.index + 1, openerTabId: tab.id } : {}) }).catch(() => {});
  };
}
$("qrBtn").onclick = () => {
  const box = $("qrBox");
  const on = box.classList.contains("hidden");
  if (on && !drawQr($("copy").dataset.link)) return shareSay("This link is too long for a QR code. Copy it instead.");
  box.classList.toggle("hidden", !on);
  $("qrBtn").setAttribute("aria-pressed", String(on));
};
$("name").addEventListener("change", saveName);
for (const b of document.querySelectorAll("[data-open]")) b.onclick = () => chrome.tabs.update(tabId, { url: b.dataset.open });

$("save").onclick = async () => {
  let server = $("server").value.trim();
  if (server && !/^wss?:\/\//.test(server)) server = "wss://" + server.replace(/^https?:\/\//, "");
  await chrome.storage.sync.set({ serverUrl: server || DEFAULT_SERVER });
  $("server").value = server || DEFAULT_SERVER;
  $("save").textContent = "Saved ✓";
  setTimeout(() => ($("save").textContent = "Save"), 1200);
};

// ---- your picture
const emojiBtn = (e, cls, onclick, label) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls + " emo";
  b.textContent = e;
  b.title = label || e;
  b.setAttribute("aria-label", label || e);
  b.onclick = onclick;
  return b;
};
// 2.2: an HD picture ("av:<slug>", bundled file), an emoji, or your own photo (chrome.storage.local,
// uploaded from the chat panel's "Your profile"); picking from the grid replaces the photo
const HDS = E.hd || [];
let photo = null;
const picImg = (src) => {
  const i = document.createElement("img");
  i.src = src;
  i.alt = "";
  i.draggable = false;
  return i;
};
const hdOf = (a) => (typeof a === "string" && a.startsWith("av:") ? HDS.find((x) => "av:" + x.id === a) : null);
function showAvatar(a) {
  const btn = $("avatarBtn"), hd = hdOf(a);
  const okPhoto = typeof photo === "string" && /^data:image\/(webp|jpeg|png);base64,/.test(photo) ? photo : null;
  btn.classList.toggle("has-photo", !!okPhoto);
  btn.classList.toggle("has-hd", !okPhoto && !!hd);
  if (okPhoto) btn.replaceChildren(picImg(okPhoto));
  else if (hd) btn.replaceChildren(picImg("avatars/av-" + hd.id + ".webp"));
  else btn.textContent = a || "🙂";
  for (const b of $("avatarGrid").querySelectorAll("[data-avatar]")) b.setAttribute("aria-selected", String(!okPhoto && b.dataset.avatar === a));
}
async function pick(a) {
  await chrome.storage.sync.set({ avatar: a }); // an open party picks this up straight away
  if (photo) {
    photo = null;
    await chrome.storage.local.remove("avatarPhoto");
  }
  showAvatar(a);
  $("avatarGrid").classList.add("hidden");
  $("avatarBtn").setAttribute("aria-expanded", "false");
}
const subLabel = (t) => {
  const d = document.createElement("div");
  d.className = "avatar-sub";
  d.textContent = t;
  return d;
};
$("avatarGrid").append(
  ...HDS.map((x) => {
    const b = emojiBtn("", "avatar-opt hd", () => pick("av:" + x.id), "Use " + x.label);
    b.title = x.label;
    b.dataset.avatar = "av:" + x.id;
    b.replaceChildren(picImg("avatars/av-" + x.id + ".webp"));
    return b;
  }),
  subLabel("Emoji"),
  ...E.avatars.map((a) => {
    const b = emojiBtn(a, "avatar-opt", () => pick(a), "Use " + a);
    b.dataset.avatar = a;
    return b;
  }),
);
for (const b of $("avatarGrid").querySelectorAll("[data-avatar]")) b.setAttribute("role", "option");
$("avatarBtn").onclick = () => {
  const hidden = $("avatarGrid").classList.toggle("hidden");
  $("avatarBtn").setAttribute("aria-expanded", String(!hidden));
};

// ---- settings: theme (System follows the computer's light/dark setting), text size, 🎉 reactions
function showTheme(t) {
  const v = t === "light" || t === "dark" ? t : "system";
  if (v === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
  for (const b of document.querySelectorAll("[data-theme-opt]")) b.setAttribute("aria-checked", String(b.dataset.themeOpt === v));
}
for (const b of document.querySelectorAll("[data-theme-opt]"))
  b.onclick = async () => {
    const v = b.dataset.themeOpt;
    if (v === "system") await chrome.storage.sync.remove("theme");
    else await chrome.storage.sync.set({ theme: v });
    showTheme(v);
  };
function showFont(f) {
  for (const b of document.querySelectorAll("[data-font]")) b.setAttribute("aria-checked", String(b.dataset.font === (f || "m")));
}
for (const b of document.querySelectorAll("[data-font]"))
  b.onclick = async () => {
    await chrome.storage.sync.set({ chatFont: b.dataset.font });
    showFont(b.dataset.font);
  };
// 2.2 party and voice settings: on unless switched off (storage.sync { syncWait, dropPause, autoDuck: false })
const PREFS = ["syncWait", "dropPause", "autoDuck"];
for (const box of document.querySelectorAll("[data-pref]"))
  box.onchange = async () => {
    if (box.checked) await chrome.storage.sync.remove(box.dataset.pref);
    else await chrome.storage.sync.set({ [box.dataset.pref]: false });
  };
function showPrefs(p) {
  for (const box of document.querySelectorAll("[data-pref]")) box.checked = p[box.dataset.pref] !== false;
}
let slots = E.reactions.slice();
let editing = -1;
function showSlots() {
  $("slots").replaceChildren(
    ...slots.map((e, i) => {
      const b = emojiBtn(e, "slot" + (i === editing ? " on" : ""), () => {
        editing = editing === i ? -1 : i;
        $("slotGrid").classList.toggle("hidden", editing < 0);
        showSlots();
      }, `Reaction ${i + 1}: ${e} (click to change)`);
      return b;
    }),
  );
}
const reactionChoices = [...new Set(E.categories.flatMap((c) => c.list))];
$("slotGrid").append(
  ...reactionChoices.map((e) =>
    emojiBtn(e, "emoji-opt", async () => {
      if (editing < 0) return;
      slots[editing] = e;
      editing = -1;
      $("slotGrid").classList.add("hidden");
      await chrome.storage.sync.set({ reactions: slots });
      showSlots();
    }),
  ),
);
$("slotReset").onclick = async () => {
  slots = E.reactions.slice();
  editing = -1;
  $("slotGrid").classList.add("hidden");
  await chrome.storage.sync.remove("reactions");
  showSlots();
};

(async () => {
  const { name, serverUrl, avatar, chatFont, reactions, theme } = await chrome.storage.sync.get(["name", "serverUrl", "avatar", "chatFont", "reactions", "theme"]);
  photo = (await chrome.storage.local.get("avatarPhoto")).avatarPhoto || null;
  showTheme(theme);
  $("name").value = name && !/^Guest \d+$/.test(name) ? name : "";
  $("server").value = serverUrl || DEFAULT_SERVER;
  showAvatar(avatar);
  showFont(chatFont);
  if (Array.isArray(reactions) && reactions.length === 5) slots = reactions.slice();
  showSlots();
  showPrefs(await chrome.storage.sync.get(PREFS));
  refresh();
  showNews();
})();

// ---- 2.4: a newer version is out (until this browser runs it), or what's new in the one just installed (once)
async function showNews() {
  const info = await chrome.runtime.sendMessage({ cmd: "updateInfo" }).catch(() => null);
  if (!info) return;
  if (info.update) {
    $("vUpdate").classList.remove("hidden");
    $("updTitle").textContent = `NetParty ${info.update.version} is out`;
    $("updNotes").textContent = info.update.notes?.length ? "New: " + info.update.notes.join(" · ") : "Update to get the latest fixes.";
    $("updGo").textContent = info.update.ready ? "Restart to update" : "Update now";
    // the zip build: the new files go over the old ones, then a reload picks them up
    $("updReload").classList.toggle("hidden", info.kind !== "zip");
    $("updHint").textContent = info.kind === "zip" ? `You have ${info.version}. Unzip the download over your NetParty folder, then press Reload NetParty.` : `You have ${info.version}.`;
    return;
  }
  if (info.whatsNew?.items?.length) {
    $("vNews").classList.remove("hidden");
    $("newsTitle").textContent = `What's new in ${info.version}`;
    $("newsList").replaceChildren(...info.whatsNew.items.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
    chrome.runtime.sendMessage({ cmd: "whatsNewSeen", where: "popup" }).catch(() => {});
  }
}
$("updGo").onclick = async () => {
  $("updGo").disabled = true;
  $("updGo").textContent = "Updating…";
  const r = await chrome.runtime.sendMessage({ cmd: "updateNow" }).catch(() => null);
  $("updGo").disabled = false;
  if (r?.reloading) return;
  if (r?.zip) $("updGo").textContent = "Download again";
  else if (r?.pending) ($("updGo").textContent = "Downloading…"), ($("updHint").textContent = "The update finishes by itself in a moment.");
  else if (r?.opened === "store") ($("updGo").textContent = "Update now"), ($("updHint").textContent = "Update NetParty on the store page that just opened.");
  else $("updGo").textContent = "Try again";
};
$("updReload").onclick = () => chrome.runtime.reload();
$("newsOk").onclick = () => $("vNews").classList.add("hidden");
