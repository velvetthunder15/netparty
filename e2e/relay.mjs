import { browserOptions } from "./config.mjs";
import { chromium } from "playwright";
import fs from "node:fs";
const ice = JSON.parse(fs.readFileSync(process.env.ICE_FILE || "ice.json", "utf8"));
const b = await chromium.launch({ ...browserOptions(), args: ["--no-sandbox"] });
const p = await b.newPage();
for (const only of [null, "turns:", "turn:"]) {
  const servers = only ? ice.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => u.startsWith(only)) })).filter((s) => s.urls.length) : ice;
  const r = await p.evaluate(async (iceServers) => {
    const mk = () => new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
    const a = mk(), c = mk();
    a.onicecandidate = (e) => e.candidate && c.addIceCandidate(e.candidate);
    c.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const ch = a.createDataChannel("t");
    const got = new Promise((res) => (c.ondatachannel = (e) => (e.channel.onmessage = (m) => res(m.data))));
    await a.setLocalDescription(await a.createOffer()); await c.setRemoteDescription(a.localDescription);
    await c.setLocalDescription(await c.createAnswer()); await a.setRemoteDescription(c.localDescription);
    const opened = await Promise.race([new Promise((r) => (ch.onopen = () => r(true))), new Promise((r) => setTimeout(() => r(false), 15000))]);
    if (!opened) return { ok: false, state: a.iceConnectionState };
    ch.send("hello via relay");
    const msg = await got;
    const st = await a.getStats(); let type = "";
    st.forEach((x) => { if (x.type === "candidate-pair" && x.nominated) { const l = st.get(x.localCandidateId); type = l?.candidateType + "/" + l?.relayProtocol; } });
    return { ok: msg === "hello via relay", type };
  }, servers);
  console.log(only || "all", JSON.stringify(r));
}
await b.close();
