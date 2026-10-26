// NetParty content script (Netflix + JioHotstar). Owns: the party connection, clock sync,
// playback sync, text chat, voice chat (WebRTC mesh) and the in-page overlay.
(() => {
  if (window.__netpartyLoaded) return;
  window.__netpartyLoaded = true;

  const TAG = "netparty";
  const SEEK_THRESHOLD_MS = 1000; // apply a remote seek when we're this far off
  const DRIFT_THRESHOLD_MS = 2000; // periodic soft correction while playing
  const SUPPRESS_MS = 1200; // ignore our own player events after applying a remote action
  const log = (...a) => console.debug("[NetParty]", ...a);

  // ---------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  // ---- platforms. A party's videoId is the Netflix title id ("81234567") or
  // "hs:" + the JioHotstar watch path ("hs:/in/shows/<show>/<id>/<ep>/<id>/watch").
  const IS_HOTSTAR = /(^|\.)(jio)?hotstar\.com$/.test(location.hostname);
  const SITE_NAME = IS_HOTSTAR ? "JioHotstar" : "Netflix";
  const videoIdFromUrl = () => {
    if (!IS_HOTSTAR) return (location.pathname.match(/^\/watch\/(\d+)/) || [])[1] || null;
    const path = location.pathname.replace(/\/+$/, "");
    return /\/\d{5,}\/watch$/.test(path) ? "hs:" + path : null;
  };
  // compare by content id so slug or language-prefix differences don't matter
  const videoKey = (v) => (v && v.startsWith("hs:") ? "hs:" + (v.match(/(\d+)\/watch$/) || [])[1] : v);
  const sameVideo = (a, b) => videoKey(a) === videoKey(b);
  const watchUrl = (videoId, roomId) =>
    (videoId.startsWith("hs:") ? "https://www.hotstar.com" + videoId.slice(3) : `https://www.netflix.com/watch/${videoId}`) +
    `?npParty=${roomId}`;
  // the main player <video>: skip tiny previews/ads by preferring the largest one on screen
  const mainVideo = () => {
    const vids = [...document.querySelectorAll("video")];
    if (vids.length < 2) return vids[0] || null;
    const area = (v) => {
      const r = v.getBoundingClientRect();
      return r.width * r.height;
    };
    return vids.sort((a, b) => area(b) - area(a))[0];
  };
  const fmt = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    for (const k of kids) n.append(k);
    return n;
  };

  // ------------------------------------------------- page-context bridge
  const bridge = (() => {
    let seq = 0;
    const pending = new Map();
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("page.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).append(s);
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data?.source !== TAG || e.data.dir !== "toContent") return;
      const p = pending.get(e.data.id);
      if (p) {
        pending.delete(e.data.id);
        p(e.data.result);
      }
    });
    const call = (kind, payload) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        window.postMessage({ source: TAG, dir: "toPage", id, kind, payload }, "*");
        setTimeout(() => pending.has(id) && (pending.delete(id), resolve(null)), 1500);
      });
    return {
      status: () => call("status"),
      seek: (position) => call("act", { action: "seek", position }),
      play: () => call("act", { action: "play" }),
      pause: () => call("act", { action: "pause" }),
    };
  })();

  // ------------------------------------------------------- server socket
  const net = (() => {
    let port = null;
    let reqSeq = 0;
    const pending = new Map();
    const listeners = new Set();
    let open = false;
    let wantOpen = false;
    let retries = 0;
    let url = null;

    function connect() {
      port = chrome.runtime.connect({ name: "netparty-socket" });
      port.onMessage.addListener((m) => {
        if (m.evt === "open") {
          open = true;
          retries = 0;
          emit({ type: "_open" });
        } else if (m.evt === "message") {
          let msg;
          try {
            msg = JSON.parse(m.data);
          } catch {
            return;
          }
          if (msg.type === "reply") {
            const p = pending.get(msg.reqId);
            if (p) {
              pending.delete(msg.reqId);
              msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.data);
            }
          } else emit(msg);
        } else if (m.evt === "close" || m.evt === "error") {
          if (m.evt === "close") onLost();
        }
      });
      port.onDisconnect.addListener(() => {
        port = null;
        onLost();
      });
      port.postMessage({ cmd: "open", url });
    }

    function onLost() {
      const was = open;
      open = false;
      for (const p of pending.values()) p.reject(new Error("Connection lost"));
      pending.clear();
      if (was) emit({ type: "_closed" });
      if (!wantOpen) return;
      retries++;
      if (retries > 8) return emit({ type: "_failed" });
      const delay = Math.min(15000, 500 * 2 ** retries);
      setTimeout(() => {
        if (!wantOpen) return;
        try {
          port ? port.postMessage({ cmd: "open", url }) : connect();
        } catch {
          connect();
        }
      }, delay);
    }

    function emit(msg) {
      for (const fn of listeners) {
        try {
          fn(msg);
        } catch (e) {
          console.error(e);
        }
      }
    }

    return {
      get open() {
        return open;
      },
      start(serverUrl) {
        url = serverUrl;
        wantOpen = true;
        retries = 0;
        if (open) return;
        if (port) port.postMessage({ cmd: "open", url });
        else connect();
      },
      stop() {
        wantOpen = false;
        open = false;
        try {
          port?.postMessage({ cmd: "close" });
          port?.disconnect();
        } catch {}
        port = null;
      },
      request(type, data, timeout = 8000) {
        return new Promise((resolve, reject) => {
          if (!open || !port) return reject(new Error("Not connected"));
          const reqId = ++reqSeq;
          pending.set(reqId, { resolve, reject });
          port.postMessage({ cmd: "send", data: JSON.stringify({ type, reqId, data }) });
          setTimeout(() => pending.has(reqId) && (pending.delete(reqId), reject(new Error("Timed out"))), timeout);
        });
      },
      on(fn) {
        listeners.add(fn);
      },
      waitOpen(ms = 8000) {
        return new Promise((resolve, reject) => {
          if (open) return resolve();
          const t = setTimeout(() => (listeners.delete(fn), reject(new Error("Could not reach the party server"))), ms);
          const fn = (m) => {
            if (m.type === "_open") {
              clearTimeout(t);
              listeners.delete(fn);
              resolve();
            }
          };
          listeners.add(fn);
        });
      },
    };
  })();

  // ------------------------------------------------------------ clock sync
  // serverNow ≈ Date.now() + clock.offset
  const clock = {
    offset: 0,
    rtt: 0,
    async sync(samples = 5) {
      const offs = [], rtts = [];
      for (let i = 0; i < samples; i++) {
        const t0 = Date.now();
        try {
          const { serverTime } = await net.request("time", {}, 3000);
          const t1 = Date.now();
          rtts.push(t1 - t0);
          offs.push(serverTime + (t1 - t0) / 2 - t1);
        } catch {}
        await sleep(60);
      }
      if (offs.length) {
        this.offset = Math.round(median(offs));
        this.rtt = Math.round(median(rtts));
      }
      log("clock offset", this.offset, "rtt", this.rtt);
    },
    toLocal: (serverTs) => serverTs - clock.offset,
    serverNow: () => Date.now() + clock.offset,
  };

  // ----------------------------------------------------------- party state
  const party = {
    roomId: null,
    me: null,
    hostId: null,
    hostOnly: false,
    members: [],
    state: null, // { playing, position, at (server ms), videoId }
    name: "Guest",
    serverUrl: "wss://netparty.chiragrasane15.workers.dev",
    error: null,
  };
  let suppressUntil = 0;
  let lastLocalAction = 0;
  let videoEl = null;

  const expectedPosition = (st) =>
    st.position + (st.playing ? Math.max(0, Date.now() - clock.toLocal(st.at)) : 0);

  async function loadPrefs() {
    const p = await chrome.storage.sync.get(["serverUrl", "name"]);
    party.serverUrl = p.serverUrl || party.serverUrl;
    party.name = p.name || party.name;
  }

  chrome.storage.onChanged.addListener((ch) => {
    if (ch.name) {
      party.name = ch.name.newValue || "Guest";
      if (party.roomId) net.request("rename", { name: party.name }).catch(() => {});
    }
    if (ch.serverUrl) party.serverUrl = ch.serverUrl.newValue;
  });

  async function ensureConnected() {
    net.start(party.serverUrl);
    await net.waitOpen();
    await clock.sync();
  }

  // Stable id for this browser tab: survives reloads and episode changes, so the server
  // gives us our seat (and host role) back instead of treating us as a new person.
  const TAB_ID = (() => {
    let id = sessionStorage.getItem("netpartyCid");
    if (!/^[a-z0-9]{16}$/.test(id || "")) {
      const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
      id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => abc[b % 36]).join("");
      sessionStorage.setItem("netpartyCid", id);
    }
    return id;
  })();

  async function createParty() {
    const vid = videoIdFromUrl();
    if (!vid) throw new Error(`Open a ${SITE_NAME} title and press play first, then start the party.`);
    await ensureConnected();
    const st = (await bridge.status()) || { position: 0, playing: false };
    const snap = await net.request("create", {
      name: party.name,
      cid: TAB_ID,
      videoId: vid,
      playing: st.playing,
      position: st.position,
      at: clock.serverNow(),
    });
    onJoined(snap);
    ui.system("Party started. Share the invite link with friends.");
    return snap;
  }

  async function joinParty(roomId) {
    await ensureConnected();
    const snap = await net.request("join", { roomId, name: party.name, cid: TAB_ID });
    onJoined(snap);
    if (!snap.returning) ui.system("You joined the party.");
    await applyRemote(snap.state, "join");
    // came back after an episode change with voice on: reconnect voice too
    if (sessionStorage.getItem("netpartyVoice")) voice.join().catch(() => {});
    return snap;
  }

  async function leaveParty() {
    await voice.leave();
    try {
      await net.request("leave", {});
    } catch {}
    party.roomId = null;
    party.members = [];
    party.state = null;
    net.stop();
    sessionStorage.removeItem("netpartyRoom");
    ui.render();
  }

  function onJoined(snap) {
    party.roomId = snap.roomId;
    party.hostId = snap.hostId;
    party.hostOnly = snap.hostOnly;
    party.members = snap.members;
    party.state = snap.state;
    party.error = null;
    sessionStorage.setItem("netpartyRoom", snap.roomId);
    ui.loadHistory(snap.history || []);
    // keep the chat open/closed the way it was before a reload
    if (sessionStorage.getItem("netpartyPanel") === "closed") ui.mount();
    else ui.show();
    ui.render();
  }

  // Invite links go to the party server's join page, which tells friends without the
  // extension how to get it and sends everyone else straight to the right title.
  const joinPageBase = () => party.serverUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
  const inviteLink = () => (party.roomId ? `${joinPageBase()}/j/${party.roomId}` : null);
  const directLink = () =>
    party.roomId && party.state?.videoId ? watchUrl(party.state.videoId, party.roomId) : null;

  const canControl = () => !party.hostOnly || party.me === party.hostId;

  // -------------------------------------------------------- playback sync
  async function applyRemote(st, reason) {
    if (!st) return;
    const vid = videoIdFromUrl();
    if (st.videoId && !sameVideo(vid, st.videoId)) {
      // different title/episode: follow the party
      sessionStorage.setItem("netpartyRoom", party.roomId);
      location.href = watchUrl(st.videoId, party.roomId);
      return;
    }
    const cur = await bridge.status();
    if (!cur) return; // player not ready yet; watchPlayer() re-applies once it is
    suppressUntil = Date.now() + SUPPRESS_MS;
    const target = expectedPosition(st);
    if (Math.abs(target - cur.position) >= SEEK_THRESHOLD_MS) await bridge.seek(target);
    if (st.playing && !cur.playing) await bridge.play();
    if (!st.playing && cur.playing) await bridge.pause();
    suppressUntil = Date.now() + SUPPRESS_MS;
    log("applied remote", reason, st);
  }

  let sendTimer = null;
  function onLocalPlayerEvent(kind) {
    if (!party.roomId || Date.now() < suppressUntil) return;
    // coalesce bursts (Netflix fires pause+seeked+play when scrubbing)
    clearTimeout(sendTimer);
    sendTimer = setTimeout(async () => {
      const st = await bridge.status();
      if (!st || !party.roomId) return;
      if (!canControl()) {
        ui.system("Only the host can control playback.");
        return applyRemote(party.state, "revert");
      }
      lastLocalAction = Date.now();
      const state = {
        playing: st.playing,
        position: st.position,
        at: clock.serverNow(),
        videoId: videoIdFromUrl(),
        reason: kind,
      };
      party.state = state;
      net.request("state", state).catch((e) => ui.system(e.message));
    }, 250);
  }

  // periodic drift correction
  setInterval(async () => {
    if (!party.roomId || !party.state || !party.state.playing) return;
    if (Date.now() < suppressUntil || Date.now() - lastLocalAction < 4000) return;
    const cur = await bridge.status();
    if (!cur || cur.buffering) return;
    const drift = cur.position - expectedPosition(party.state);
    if (Math.abs(drift) > DRIFT_THRESHOLD_MS) {
      log("drift", drift, "correcting");
      applyRemote(party.state, "drift");
    }
  }, 3000);

  // attach to the <video> element and follow Netflix's SPA navigation
  let lastVideoId = videoIdFromUrl();
  function watchPlayer() {
    const v = mainVideo();
    if (v && v !== videoEl) {
      videoEl = v;
      for (const evt of ["play", "pause", "seeked"]) v.addEventListener(evt, () => onLocalPlayerEvent(evt));
      v.addEventListener("loadeddata", () => party.roomId && party.state && applyRemote(party.state, "loaded"), { once: true });
      if (party.roomId && party.state) setTimeout(() => applyRemote(party.state, "attach"), 800);
    }
    const vid = videoIdFromUrl();
    if (vid !== lastVideoId) {
      lastVideoId = vid;
      // we moved to another episode ourselves: take the party with us
      if (vid && party.roomId && party.state && !sameVideo(party.state.videoId, vid) && canControl()) {
        const state = { playing: true, position: 0, at: clock.serverNow(), videoId: vid, reason: "episode" };
        party.state = state;
        net.request("state", state).catch(() => {});
        ui.system("Moved the party to a new episode.");
      }
    }
    ui.mount();
    ui.dockCheck();
  }
  let watchQueued = false;
  new MutationObserver(() => {
    if (watchQueued) return;
    watchQueued = true;
    setTimeout(() => {
      watchQueued = false;
      watchPlayer();
    }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(watchPlayer, 2000);

  // ---------------------------------------------------- server messages
  net.on(async (msg) => {
    switch (msg.type) {
      case "welcome":
        party.me = msg.data.userId;
        break;
      case "state":
        party.state = msg.data;
        if (msg.data.reason && msg.data.byName) {
          const what = { play: "played", pause: "paused", seeked: "jumped to " + fmt(msg.data.position), episode: "changed the episode" }[msg.data.reason];
          if (what) ui.system(`${msg.data.byName} ${what}`);
        }
        applyRemote(msg.data, "remote");
        break;
      case "members":
        party.members = msg.data.members;
        party.hostId = msg.data.hostId;
        ui.render();
        break;
      case "settings":
        party.hostOnly = msg.data.hostOnly;
        ui.render();
        break;
      case "chat":
        ui.chat(msg.data);
        break;
      case "system":
        ui.system(msg.data.text);
        break;
      case "voice":
        voice.onVoiceEvent(msg.data);
        break;
      case "signal":
        voice.onSignal(msg.data.from, msg.data.payload);
        break;
      case "_closed":
        ui.system("Connection lost. Reconnecting…");
        break;
      case "_open":
        // reconnect: rejoin the same party with a fresh socket
        if (party.roomId && party.me) {
          const room = party.roomId;
          try {
            await clock.sync(3);
            const snap = await net.request("join", { roomId: room, name: party.name, cid: TAB_ID });
            onJoined(snap);
            ui.system("Reconnected.");
            applyRemote(snap.state, "rejoin");
            if (voice.active) voice.rejoin();
          } catch (e) {
            ui.system("Couldn't rejoin: " + e.message);
          }
        }
        break;
      case "_failed":
        ui.system("Couldn't reconnect to the party server.");
        break;
    }
  });

  // --------------------------------------------------------- voice chat
  const voice = (() => {
    let localStream = null;
    let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    const peers = new Map(); // id -> { pc, audio, pendingIce: [] }
    const peerState = new Map(); // id -> { muted, speaking }
    let muted = false;
    let speaking = false;
    let meter = null;
    let volume = 1;
    let active = false;

    async function getMic() {
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    }

    function makePeer(id) {
      const pc = new RTCPeerConnection({ iceServers });
      const audio = new Audio();
      audio.autoplay = true;
      audio.volume = volume;
      const entry = { pc, audio, pendingIce: [] };
      peers.set(id, entry);
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
        audio.play().catch(() => ui.system("Click anywhere on the page to hear voice chat."));
      };
      pc.onicecandidate = (e) => e.candidate && net.request("signal", { to: id, payload: { ice: e.candidate } }).catch(() => {});
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          ui.system("Voice link to " + nameOf(id) + " failed (network may block peer-to-peer; add a TURN server).");
        }
        ui.render();
      };
      return entry;
    }

    function closePeer(id) {
      const p = peers.get(id);
      if (!p) return;
      try {
        p.pc.close();
      } catch {}
      p.audio.srcObject = null;
      peers.delete(id);
      peerState.delete(id);
    }

    async function callPeer(id) {
      const { pc } = makePeer(id);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await net.request("signal", { to: id, payload: { sdp: pc.localDescription } });
    }

    function startMeter() {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(localStream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let quietSince = 0;
      const iv = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const b of buf) sum += ((b - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        let next = speaking;
        if (!muted && rms > 0.04) {
          next = true;
          quietSince = now;
        } else if (now - quietSince > 400) next = false;
        if (next !== speaking) {
          speaking = next;
          net.request("voiceState", { muted, speaking }).catch(() => {});
          ui.render();
        }
      }, 100);
      meter = { ctx, iv };
    }

    const nameOf = (id) => party.members.find((m) => m.id === id)?.name || "someone";

    return {
      get active() {
        return active;
      },
      get muted() {
        return muted;
      },
      get speaking() {
        return speaking;
      },
      get volume() {
        return volume;
      },
      peerInfo: (id) => ({ ...(peerState.get(id) || {}), connected: peers.get(id)?.pc.connectionState === "connected" }),
      async join() {
        if (active || !party.roomId) return;
        try {
          localStream = await getMic();
        } catch (e) {
          ui.system(`Microphone blocked. Allow mic access for ${location.hostname} in the address bar, then try again.`);
          return;
        }
        active = true;
        muted = false;
        sessionStorage.setItem("netpartyVoice", "1");
        startMeter();
        const res = await net.request("voiceJoin", {});
        if (res.iceServers?.length) iceServers = res.iceServers;
        // newcomer calls everyone already in voice (one side offers, so no glare)
        for (const id of res.peers) callPeer(id).catch((e) => log("call failed", e));
        ui.system("You joined voice chat. Headphones avoid echo.");
        ui.render();
      },
      async rejoin() {
        for (const id of [...peers.keys()]) closePeer(id);
        const res = await net.request("voiceJoin", {});
        for (const id of res.peers) callPeer(id).catch(() => {});
      },
      async leave() {
        sessionStorage.removeItem("netpartyVoice");
        if (!active) return;
        active = false;
        for (const id of [...peers.keys()]) closePeer(id);
        localStream?.getTracks().forEach((t) => t.stop());
        localStream = null;
        if (meter) {
          clearInterval(meter.iv);
          meter.ctx.close();
          meter = null;
        }
        speaking = false;
        try {
          await net.request("voiceLeave", {});
        } catch {}
        ui.render();
      },
      toggleMute() {
        if (!active) return;
        muted = !muted;
        localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
        if (muted) speaking = false;
        net.request("voiceState", { muted, speaking }).catch(() => {});
        ui.render();
      },
      setVolume(v) {
        volume = v;
        for (const p of peers.values()) p.audio.volume = v;
      },
      onVoiceEvent(d) {
        if (d.event === "join") {
          ui.system(`${nameOf(d.id)} joined voice`);
          peerState.set(d.id, { muted: false, speaking: false });
        } else if (d.event === "leave") {
          closePeer(d.id);
          peerState.delete(d.id);
        } else if (d.event === "state") {
          peerState.set(d.id, { muted: d.muted, speaking: d.speaking });
        }
        ui.render();
      },
      async onSignal(from, payload) {
        if (!active) return;
        let entry = peers.get(from);
        if (payload.sdp) {
          if (payload.sdp.type === "offer") {
            if (entry) closePeer(from);
            entry = makePeer(from);
            await entry.pc.setRemoteDescription(payload.sdp);
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
            await net.request("signal", { to: from, payload: { sdp: entry.pc.localDescription } });
          } else if (entry) {
            await entry.pc.setRemoteDescription(payload.sdp);
          }
          for (const c of entry?.pendingIce.splice(0) || []) await entry.pc.addIceCandidate(c).catch(() => {});
        } else if (payload.ice) {
          if (!entry || !entry.pc.remoteDescription) {
            if (!entry) return;
            entry.pendingIce.push(payload.ice);
          } else await entry.pc.addIceCandidate(payload.ice).catch(() => {});
        }
      },
    };
  })();

  // ------------------------------------------------------------------ UI
  // Lives in a shadow root so the streaming site's CSS can't break it.
  const ui = (() => {
    let host, shadow, root, panel, peopleEl, chatEl, input, sendBtn, codeEl, metaEl, voiceBox, toggleBtn, badge, toastEl;
    let open = false;
    let unread = 0;
    let toastTimer = 0;
    let peopleSig = "";

    const initials = (name) =>
      name
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase() || "?";
    const hue = (id) => [...String(id)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
    const svg = (d) => {
      const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      s.setAttribute("viewBox", "0 0 24 24");
      s.setAttribute("aria-hidden", "true");
      s.innerHTML = d;
      return s;
    };
    const ICON = {
      chat: '<path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/>',
      send: '<path fill="currentColor" d="M3 20.5 21 12 3 3.5v6.6l12 1.9-12 1.9z"/>',
      close: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/>',
      link: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
      mic: '<path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12z"/>',
      micOff: '<path fill="currentColor" d="M15 10.6V6a3 3 0 0 0-5.9-.8zM19 12h-2a5 5 0 0 1-.6 2.3l1.5 1.5A7 7 0 0 0 19 12zM4.3 3 3 4.3l6 6V12a3 3 0 0 0 4.5 2.6l1.6 1.6A5 5 0 0 1 7 12H5a7 7 0 0 0 6 6.9V21h2v-2.1a7 7 0 0 0 3.6-1.5l3.1 3.1 1.3-1.3z"/>',
      phoneOff: '<path fill="currentColor" d="M12 9c-1.6 0-3.1.3-4.6.7v3.1c0 .4-.2.7-.6.9-.9.4-1.7 1-2.4 1.6-.2.2-.4.3-.7.3s-.5-.1-.7-.3L.3 12.8a1 1 0 0 1 0-1.4C3.4 8.5 7.5 7 12 7s8.6 1.5 11.7 4.4a1 1 0 0 1 0 1.4L21 15.4c-.2.2-.4.3-.7.3s-.5-.1-.7-.3c-.7-.6-1.5-1.2-2.4-1.6-.4-.2-.6-.5-.6-.9V9.7C15.1 9.3 13.6 9 12 9z"/>',
      crown: '<path fill="currentColor" d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5z"/>',
    };
    const iconBtn = (icon, title, onclick, cls = "") =>
      el("button", { class: "np-icon " + cls, title, "aria-label": title, onclick }, svg(icon));

    function sendChat() {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      updateSend();
      net.request("chat", { text }).catch((err) => system("Message not sent: " + err.message));
      input.focus();
    }
    const updateSend = () => (sendBtn.disabled = !input.value.trim());

    // keys typed in the panel arrive here first (early.js), before the site's hotkeys
    window.__netpartyKey = (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey && shadow.activeElement === input) {
        e.preventDefault();
        sendChat();
      } else if (e.key === "Escape") hide();
    };

    function build() {
      host = el("div", { id: "netparty-root" });
      shadow = host.attachShadow({ mode: "open" });
      shadow.append(el("link", { rel: "stylesheet", href: chrome.runtime.getURL("overlay.css") }));

      badge = el("span", { class: "np-badge" });
      toggleBtn = el("button", { class: "np-toggle", title: "Party chat (NetParty)", onclick: () => (open ? hide() : show()) }, svg(ICON.chat), badge);
      toastEl = el("div", { class: "np-toast", onclick: show });

      codeEl = el("span", { class: "np-code" });
      metaEl = el("div", { class: "np-meta" });
      const copyBtn = el(
        "button",
        {
          class: "np-pill",
          onclick: async () => {
            const link = inviteLink();
            if (!link) return;
            await navigator.clipboard.writeText(link).catch(() => {});
            copyBtn.lastChild.textContent = "Copied!";
            setTimeout(() => (copyBtn.lastChild.textContent = "Copy invite"), 1500);
          },
        },
        svg(ICON.link),
        el("span", {}, "Copy invite"),
      );
      const head = el(
        "div",
        { class: "np-head" },
        el("div", { class: "np-title" }, el("div", { class: "np-brand" }, "NetParty ", codeEl), metaEl),
        iconBtn(ICON.close, "Hide chat (Esc)", hide, "np-close"),
      );

      peopleEl = el("div", { class: "np-people" });
      voiceBox = el("div", { class: "np-voice" });
      chatEl = el("div", { class: "np-chat", role: "log" });

      input = el("input", { class: "np-input", type: "text", placeholder: "Message the party…", maxlength: "500", autocomplete: "off" });
      input.addEventListener("input", updateSend);
      sendBtn = iconBtn(ICON.send, "Send (Enter)", sendChat, "np-send");
      sendBtn.disabled = true;
      const composer = el("form", { class: "np-composer", onsubmit: (e) => (e.preventDefault(), sendChat()) }, input, sendBtn);

      const leaveBtn = el("button", { class: "np-link-btn", onclick: () => confirm("Leave this party?") && leaveParty().then(hide) }, "Leave party");

      panel = el(
        "aside",
        { class: "np-panel" },
        head,
        el("div", { class: "np-actions" }, copyBtn, leaveBtn),
        el("div", { class: "np-section-label" }, "Watching"),
        peopleEl,
        voiceBox,
        chatEl,
        composer,
      );
      // keep clicks and scrolls inside the panel from reaching the player
      for (const evt of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "contextmenu"])
        panel.addEventListener(evt, (e) => e.stopPropagation());
      root = el("div", { class: "np-root" }, toggleBtn, toastEl, panel);
      shadow.append(root);
      document.addEventListener("fullscreenchange", () => {
        mount();
        dockCheck(true);
      });
    }

    // ---- split-screen dock: the site's player shrinks to make room for the chat column
    let pageStyle = null;
    let lastDockSig = "";
    const dockWidth = () => Math.round(Math.min(380, Math.max(300, innerWidth * 0.22)));
    function ensurePageStyle() {
      if (pageStyle?.isConnected) return;
      pageStyle = el("style", { id: "netparty-dock-style" });
      pageStyle.textContent = `
html.np-docked [data-np-shrink] {
  left: 0 !important; right: auto !important;
  width: calc(100% - var(--np-w)) !important; max-width: calc(100% - var(--np-w)) !important; min-width: 0 !important;
}`;
      (document.head || document.documentElement).append(pageStyle);
    }
    // Narrow exactly ONE element: the site's player box. The site then lays out the
    // video and its controls inside the smaller box itself, so nothing is cropped.
    // (Forcing widths on the <video> or its inner wrappers fights the player's own
    // sizing and crops the picture.)
    const PLAYER_BOX = {
      netflix: [".sizing-wrapper", ".watch-video--player-view", ".watch-video", "[data-uia=player]"],
      hotstar: [],
    };
    function playerBox() {
      for (const sel of PLAYER_BOX[IS_HOTSTAR ? "hotstar" : "netflix"] || []) {
        const n = document.querySelector(sel);
        if (n && n.getBoundingClientRect().width > 0) return n;
      }
      // generic: the outermost full-width ancestor of the video, below the page root
      const top = document.fullscreenElement || document.body;
      const v = mainVideo();
      let box = null;
      for (let n = v?.parentElement; n && n !== top && n !== document.documentElement; n = n.parentElement) {
        if (n === host) break;
        const r = n.getBoundingClientRect();
        const wide = n.hasAttribute("data-np-shrink") || (r.width >= innerWidth - 2 && r.left <= 1);
        if (wide) box = n;
      }
      return box;
    }
    function markShrinkTargets() {
      const box = playerBox();
      if (!box || box.hasAttribute("data-np-shrink")) return;
      for (const old of document.querySelectorAll("[data-np-shrink]")) old.removeAttribute("data-np-shrink");
      box.setAttribute("data-np-shrink", "");
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
    function dockCheck(force) {
      const docked = open && !!party.roomId && !!videoIdFromUrl();
      const w = dockWidth();
      const sig = [docked, w, !!document.fullscreenElement].join();
      const html = document.documentElement;
      if (docked) {
        ensurePageStyle();
        html.style.setProperty("--np-w", w + "px");
        host.style.setProperty("--np-w", w + "px");
        markShrinkTargets();
      }
      if (sig === lastDockSig && !force) return;
      lastDockSig = sig;
      html.classList.toggle("np-docked", docked);
      // let the player recompute its layout for the new size
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    }
    addEventListener("resize", (e) => {
      if (e.isTrusted) dockCheck();
    });

    function mount() {
      if (!host) build();
      // sites fullscreen a container element; the overlay must live inside it to stay visible
      const parent = document.fullscreenElement || document.body;
      if (parent && host.parentElement !== parent) parent.append(host);
      // only on a watch page; on Netflix's browse pages the party waits in the background
      host.style.display = party.roomId && videoIdFromUrl() ? "" : "none";
      if (!party.roomId && open) {
        open = false;
        root.classList.remove("np-open");
        dockCheck();
      }
    }

    function show() {
      open = true;
      sessionStorage.setItem("netpartyPanel", "open");
      unread = 0;
      mount();
      root.classList.add("np-open");
      toastEl.classList.remove("np-show");
      peopleSig = voiceBox.dataset.sig = "";
      render();
      dockCheck();
      setTimeout(() => input.focus(), 50);
    }
    function hide() {
      open = false;
      if (party.roomId) sessionStorage.setItem("netpartyPanel", "closed");
      root?.classList.remove("np-open");
      render();
      if (host) dockCheck();
    }

    function toast(name, text) {
      if (open) return;
      toastEl.replaceChildren(el("b", {}, name), " ", text.length > 80 ? text.slice(0, 80) + "…" : text);
      toastEl.classList.add("np-show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove("np-show"), 4000);
    }

    function render() {
      if (!host) return;
      mount();
      badge.textContent = unread > 9 ? "9+" : unread ? String(unread) : "";
      badge.style.display = unread ? "" : "none";
      codeEl.textContent = party.roomId ? "· " + party.roomId : "";
      const st = party.state;
      metaEl.textContent = st
        ? `${st.playing ? "▶ Playing" : "❚❚ Paused"} at ${fmt(expectedPosition(st))}${party.hostOnly ? " · host controls playback" : ""}`
        : "";

      const pSig = party.members
        .map((m) => {
          const isMe = m.id === party.me;
          const info = isMe ? { muted: voice.muted, speaking: voice.speaking } : voice.peerInfo(m.id);
          return [m.id, m.name, m.host, isMe ? voice.active : m.inVoice, info.muted, info.speaking].join(":");
        })
        .join("|");
      if (pSig !== peopleSig) {
      peopleSig = pSig;
      peopleEl.replaceChildren(
        ...party.members.map((m) => {
          const isMe = m.id === party.me;
          const info = isMe ? { muted: voice.muted, speaking: voice.speaking } : voice.peerInfo(m.id);
          const inVoice = isMe ? voice.active : !!m.inVoice;
          const avatar = el("div", { class: "np-avatar", style: `--h:${hue(m.id)}` }, initials(m.name));
          if (m.host) avatar.append(el("span", { class: "np-crown", title: "Host" }, svg(ICON.crown)));
          if (inVoice) avatar.append(el("span", { class: "np-mic" + (info.muted ? " np-off" : ""), title: info.muted ? "Muted" : "In voice" }, svg(info.muted ? ICON.micOff : ICON.mic)));
          return el(
            "div",
            { class: "np-person" + (inVoice && info.speaking && !info.muted ? " np-speaking" : ""), title: m.name + (m.host ? " (host)" : "") },
            avatar,
            el("div", { class: "np-pname" }, isMe ? "You" : m.name),
          );
        }),
      );
      }

      const inVoiceCount = party.members.filter((m) => (m.id === party.me ? voice.active : m.inVoice)).length;
      // only rebuild the voice bar when it changes (so the volume slider isn't replaced mid-drag)
      const sig = [voice.active, voice.muted, voice.speaking, inVoiceCount].join();
      if (sig === voiceBox.dataset.sig) return;
      voiceBox.dataset.sig = sig;
      if (!voice.active) {
        voiceBox.replaceChildren(
          el(
            "button",
            { class: "np-join-voice", onclick: () => voice.join() },
            svg(ICON.mic),
            el("span", {}, inVoiceCount ? `Join voice · ${inVoiceCount} talking` : "Join voice chat"),
          ),
        );
      } else {
        const vol = el("input", { type: "range", min: "0", max: "1", step: "0.05", class: "np-vol", title: "Friends' voice volume" });
        vol.value = String(voice.volume ?? 1);
        vol.addEventListener("input", () => voice.setVolume(Number(vol.value)));
        voiceBox.replaceChildren(
          el(
            "div",
            { class: "np-voice-bar" },
            el("button", { class: "np-round" + (voice.muted ? " np-muted" : ""), title: voice.muted ? "Unmute" : "Mute", onclick: () => voice.toggleMute() }, svg(voice.muted ? ICON.micOff : ICON.mic)),
            el("div", { class: "np-voice-label" }, voice.muted ? "You're muted" : voice.speaking ? "Speaking…" : "Voice on", el("small", {}, `${inVoiceCount} in voice`)),
            vol,
            el("button", { class: "np-round np-hang", title: "Leave voice", onclick: () => voice.leave() }, svg(ICON.phoneOff)),
          ),
        );
      }
    }

    function addLine(node) {
      if (!host) build();
      const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
      chatEl.append(node);
      while (chatEl.childElementCount > 200) chatEl.firstElementChild.remove();
      if (nearBottom || !open) chatEl.scrollTop = chatEl.scrollHeight;
    }

    function chat(d, replay = false) {
      const mine = d.id === party.me || (!!d.cid && d.cid === TAB_ID);
      const time = new Date(d.ts || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      addLine(
        el(
          "div",
          { class: "np-msg" + (mine ? " np-mine" : "") },
          mine ? "" : el("div", { class: "np-author", style: `--h:${hue(d.id)}` }, d.name),
          el("div", { class: "np-bubble" }, d.text, el("span", { class: "np-time" }, time)),
        ),
      );
      if (!open && !mine && !replay) {
        unread++;
        toast(d.name, d.text);
        render();
      }
    }
    function system(text) {
      addLine(el("div", { class: "np-sys" }, text));
    }
    // everything said in the party so far (the server keeps the last 150 lines)
    function loadHistory(list) {
      if (!host) build();
      chatEl.replaceChildren();
      for (const h of list) h.kind === "chat" ? chat(h, true) : system(h.text);
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    // the only thing that changes every second is the playback clock
    setInterval(() => {
      if (!party.roomId || !open || !metaEl) return;
      const st = party.state;
      metaEl.textContent = st
        ? `${st.playing ? "▶ Playing" : "❚❚ Paused"} at ${fmt(expectedPosition(st))}${party.hostOnly ? " · host controls playback" : ""}`
        : "";
    }, 1000);
    return { mount, show, hide, render, chat, system, loadHistory, dockCheck: () => host && dockCheck() };
  })();

  // ------------------------------------------------ popup <-> content API
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.cmd) {
          case "status":
            return {
              site: SITE_NAME,
              onWatchPage: !!videoIdFromUrl(),
              roomId: party.roomId,
              members: party.members.map((m) => m.name),
              invite: inviteLink(),
              hostOnly: party.hostOnly,
              isHost: party.me === party.hostId,
              voice: voice.active,
              chatOpen: false,
            };
          case "create":
            await createParty();
            return { ok: true, invite: inviteLink() };
          case "join":
            await joinParty(String(msg.roomId || "").trim().toLowerCase());
            return { ok: true };
          case "leave":
            await leaveParty();
            return { ok: true };
          case "hostOnly":
            await net.request("settings", { hostOnly: !!msg.value });
            return { ok: true };
          case "showChat":
            ui.show();
            return { ok: true };
        }
      } catch (e) {
        return { error: e.message };
      }
    })().then(sendResponse);
    return true;
  });

  // ------------------------------------------------------------- boot
  (async () => {
    await loadPrefs();
    const params = new URLSearchParams(location.search);
    // early.js saved the code at page start, in case the site's router dropped it since
    const fromLink = params.get("npParty") || sessionStorage.getItem("netpartyInvite");
    sessionStorage.removeItem("netpartyInvite");
    const fromSession = sessionStorage.getItem("netpartyRoom");
    const room = fromLink || fromSession;
    if (params.has("npParty")) {
      params.delete("npParty");
      const q = params.toString();
      history.replaceState(history.state, "", location.pathname + (q ? "?" + q : ""));
    }
    if (!room) return;
    // wait for the player before joining so the first sync lands
    for (let i = 0; i < 40 && !(await bridge.status()); i++) await sleep(500);
    try {
      await joinParty(room);
    } catch (e) {
      sessionStorage.removeItem("netpartyRoom");
      ui.mount();
      alert("NetParty: " + e.message);
    }
  })();
})();
