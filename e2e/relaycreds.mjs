
// 2.2 relay credentials (fake Netflix, local server): every voiceJoin / voiceIce reply gets a fresh fake TURN entry
// (username u001, u002, …; the address is unreachable, so calls still connect over host candidates) and the
// content script logs which username each new peer connection uses. Checks: a call uses the credentials from
// voiceJoin; fresh credentials are not re-fetched for every call; after the socket drops, the voice rejoin saves
// the NEW credentials from its voiceJoin and the reconnect calls use them (2.1 kept the old ones).
import { launch, until, check, summary, out, sleep, tap, people } from "./lib.mjs";
const SITE = "https://www.netflix.com/watch/12345";
let n = 0;
const issued = []; // { conn, user }
const T = tap(8794, 8787, (dir, text, conn) => {
  if (dir !== "down" || !text.includes('"iceServers"')) return text;
  const m = JSON.parse(text);
  if (m.type !== "reply" || !Array.isArray(m.data?.iceServers)) return text;
  const user = "u" + String(++n).padStart(3, "0");
  issued.push({ conn, user });
  m.data.iceServers = [...m.data.iceServers, { urls: ["turn:127.0.0.1:9?transport=udp"], username: "1700000000:" + user, credential: "not-a-real-secret" }];
  return JSON.stringify(m);
});
const H = await launch("pw-rch", { name: "Chirag", extra: { serverUrl: T.url } });
const G = await launch("pw-rcg", { name: "Rahul", extra: { serverUrl: T.url } });
const hp = await H.ctx.newPage(), gp = await G.ctx.newPage();
const logs = { host: [], guest: [] };
for (const [p, k] of [[hp, "host"], [gp, "guest"]])
  p.on("console", (m) => {
    const t = m.text();
    if (/\[NetParty\] peer (call|answer) relay/.test(t)) logs[k].push({ t: Date.now(), kind: t.includes(" call ") ? "call" : "answer", user: t.trim().split(" ").pop() });
  });
await hp.goto(SITE);
await hp.waitForTimeout(2000);
const created = await H.sw.evaluate(async (url) => {
  const [t] = await chrome.tabs.query({ url: url + "*" });
  return chrome.tabs.sendMessage(t.id, { cmd: "create" });
}, SITE);
await gp.goto(created.invite);
await Promise.all([gp.waitForNavigation(), gp.click("a.btn")]);
check("both in the party", !!(await until(async () => (await people(hp)).length === 2, 20000)));
const sh = (p, fn) => p.evaluate((src) => new Function("return " + src)()(document.getElementById("netparty-root").shadowRoot), fn.toString());
const linked = (p) => sh(p, (r) => [...r.querySelectorAll(".np-person[data-link]")].map((x) => x.dataset.link).join());
await sh(hp, (r) => r.querySelector(".np-join-voice").click());
await sleep(700);
await sh(gp, (r) => r.querySelector(".np-join-voice").click());
check("voice connects", !!(await until(async () => (await linked(hp)) === "connected" && (await linked(gp)) === "connected", 20000)), JSON.stringify([await linked(hp), await linked(gp)]));
const gUser1 = issued.filter((x) => x.conn !== issued[0].conn).pop()?.user;
out("issued:", JSON.stringify(issued), "logs:", JSON.stringify(logs));
check("the guest's call uses the credentials from its voiceJoin", logs.guest.some((l) => l.kind === "call" && l.user === gUser1), JSON.stringify(logs.guest));
check("the host answers with the credentials from its own voiceJoin", logs.host.some((l) => l.kind === "answer" && l.user === issued[0].user), JSON.stringify(logs.host));
const iceAsks = () => T.frames.filter((f) => f.dir === "up" && f.text.includes('"type":"voiceIce"')).length;
check("fresh credentials: no extra voiceIce request for a call", iceAsks() === 0, String(iceAsks()));

// drop the guest's socket: it reconnects, rejoins the party and voice (voiceJoin -> new credentials)
const gConn = [...T.conns.keys()].pop();
const before = issued.length, logN = logs.guest.length;
T.conns.get(gConn)();
const re = await until(() => issued.length > before && logs.guest.length > logN && logs.guest.slice(logN).find((l) => l.kind === "call"), 25000);
const newUser = issued.slice(before).pop()?.user;
check("after the socket drops, the voice rejoin calls with the NEW credentials", !!re && re.user === newUser && newUser !== gUser1, JSON.stringify({ re, newUser, gUser1, issued }));
check("voice connects again", !!(await until(async () => (await linked(hp)) === "connected" && (await linked(gp)) === "connected", 25000)), JSON.stringify([await linked(hp), await linked(gp)]));
check("credentials never sent anywhere in a frame from the browser", !T.frames.some((f) => f.dir === "up" && /not-a-real-secret|1700000000:u/.test(f.text)));
T.close();
const f = summary("RELAY CREDENTIAL");
await H.ctx.close();
await G.ctx.close();
process.exit(f ? 1 : 0);
