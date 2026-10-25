// NetParty content script (Netflix). Owns: the party connection, clock sync,
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
  const videoIdFromUrl = () => (location.pathname.match(/^\/watch\/(\d+)/) || [])[1] || null;
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

  async function createParty() {
    const vid = videoIdFromUrl();
    if (!vid) throw new Error("Open a Netflix title first, then start the party.");
    await ensureConnected();
    const st = (await bridge.status()) || { position: 0, playing: false };
    const snap = await net.request("create", {
      name: party.name,
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
    const snap = await net.request("join", { roomId, name: party.name });
    onJoined(snap);
    ui.system("You joined the party.");
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
    ui.show();
    ui.render();
  }

  const inviteLink = () =>
    party.roomId && party.state?.videoId
      ? `https://www.netflix.com/watch/${party.state.videoId}?npParty=${party.roomId}`
      : null;

  const canControl = () => !party.hostOnly || party.me === party.hostId;

  // -------------------------------------------------------- playback sync
  async function applyRemote(st, reason) {
    if (!st) return;
    const vid = videoIdFromUrl();
    if (st.videoId && vid !== st.videoId) {
      // different title/episode: follow the party
      sessionStorage.setItem("netpartyRoom", party.roomId);
      location.href = `https://www.netflix.com/watch/${st.videoId}?npParty=${party.roomId}`;
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
    const v = document.querySelector("video");
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
      if (vid && party.roomId && party.state && party.state.videoId !== vid && canControl()) {
        const state = { playing: true, position: 0, at: clock.serverNow(), videoId: vid, reason: "episode" };
        party.state = state;
        net.request("state", state).catch(() => {});
        ui.system("Moved the party to a new episode.");
      }
    }
    ui.mount();
  }
  new MutationObserver(() => watchPlayer()).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(watchPlayer, 1000);

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
            const snap = await net.request("join", { roomId: room, name: party.name });
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
      peerInfo: (id) => ({ ...(peerState.get(id) || {}), connected: peers.get(id)?.pc.connectionState === "connected" }),
      async join() {
        if (active || !party.roomId) return;
        try {
          localStream = await getMic();
        } catch (e) {
          ui.system("Microphone blocked. Allow mic access for netflix.com in the address bar, then try again.");
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
  const ui = (() => {
    let root, panel, membersEl, chatEl, input, statusEl, voiceBtn, muteBtn, toggleBtn;
    let open = false;
    let unread = 0;
    const stop = (e) => e.stopPropagation(); // keep keystrokes away from Netflix hotkeys

    function build() {
      toggleBtn = el("button", { class: "np-toggle", title: "NetParty", onclick: () => (open ? hide() : show()) }, "💬");
      statusEl = el("div", { class: "np-status" });
      membersEl = el("div", { class: "np-members" });
      chatEl = el("div", { class: "np-chat" });
      input = el("input", { class: "np-input", placeholder: "Say something…", maxlength: "500" });
      for (const evt of ["keydown", "keyup", "keypress"]) input.addEventListener(evt, stop, true);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) {
          net.request("chat", { text: input.value.trim() }).catch((err) => system(err.message));
          input.value = "";
        }
      });
      voiceBtn = el("button", { class: "np-btn", onclick: () => (voice.active ? voice.leave() : voice.join()) }, "🎙 Join voice");
      muteBtn = el("button", { class: "np-btn", onclick: () => voice.toggleMute() }, "Mute");
      const vol = el("input", { type: "range", min: "0", max: "1", step: "0.05", value: "1", class: "np-vol", title: "Voice volume" });
      vol.addEventListener("input", () => voice.setVolume(Number(vol.value)));
      const copyBtn = el("button", {
        class: "np-btn",
        onclick: async () => {
          const link = inviteLink();
          if (!link) return;
          await navigator.clipboard.writeText(link).catch(() => {});
          system("Invite link copied.");
        },
      }, "🔗 Copy invite");
      const leaveBtn = el("button", { class: "np-btn np-danger", onclick: () => leaveParty().then(hide) }, "Leave");
      panel = el(
        "div",
        { class: "np-panel" },
        el("div", { class: "np-head" }, el("strong", {}, "NetParty"), el("button", { class: "np-x", onclick: hide }, "×")),
        statusEl,
        el("div", { class: "np-row" }, copyBtn, leaveBtn),
        el("div", { class: "np-row" }, voiceBtn, muteBtn, vol),
        membersEl,
        chatEl,
        input,
      );
      for (const evt of ["keydown", "keyup", "keypress", "wheel", "click", "dblclick", "mousedown"]) panel.addEventListener(evt, stop);
      root = el("div", { id: "netparty-root" }, toggleBtn, panel);
      document.addEventListener("fullscreenchange", mount);
    }

    function mount() {
      if (!root) build();
      // Netflix fullscreens a container element; move the overlay inside it
      const host = document.fullscreenElement || document.body;
      if (host && root.parentElement !== host) host.append(root);
      root.style.display = party.roomId && videoIdFromUrl() ? "" : "none";
    }

    function show() {
      open = true;
      unread = 0;
      mount();
      root.classList.add("np-open");
      render();
    }
    function hide() {
      open = false;
      root?.classList.remove("np-open");
      render();
    }

    function render() {
      if (!root) return;
      mount();
      toggleBtn.textContent = unread ? `💬 ${unread}` : "💬";
      const st = party.state;
      statusEl.textContent = party.roomId
        ? `Party ${party.roomId} · ${party.members.length} watching${party.hostOnly ? " · host controls" : ""}${st ? " · " + (st.playing ? "▶" : "⏸") + " " + fmt(expectedPosition(st)) : ""}`
        : "Not in a party";
      voiceBtn.textContent = voice.active ? "Leave voice" : "🎙 Join voice";
      muteBtn.disabled = !voice.active;
      muteBtn.textContent = voice.muted ? "Unmute" : "Mute";
      membersEl.replaceChildren(
        ...party.members.map((m) => {
          const isMe = m.id === party.me;
          const info = isMe ? { muted: voice.muted, speaking: voice.speaking, connected: true } : voice.peerInfo(m.id);
          const inVoice = isMe ? voice.active : !!m.inVoice;
          const icon = !inVoice ? "" : info.muted ? " 🔇" : " 🎙";
          return el(
            "span",
            { class: "np-member" + (info.speaking && inVoice ? " np-speaking" : "") },
            (m.host ? "👑 " : "") + m.name + (isMe ? " (you)" : "") + icon,
          );
        }),
      );
    }

    function addLine(node) {
      if (!root) build();
      chatEl.append(node);
      while (chatEl.childElementCount > 300) chatEl.firstElementChild.remove();
      chatEl.scrollTop = chatEl.scrollHeight;
      if (!open) {
        unread++;
        render();
      }
    }

    function chat(d) {
      const mine = d.id === party.me;
      addLine(el("div", { class: "np-msg" + (mine ? " np-mine" : "") }, el("b", {}, d.name + ": "), d.text));
    }
    function system(text) {
      if (!root) build();
      chatEl.append(el("div", { class: "np-sys" }, text));
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    setInterval(() => party.roomId && open && render(), 1000);
    return { mount, show, hide, render, chat, system };
  })();

  // ------------------------------------------------ popup <-> content API
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.cmd) {
          case "status":
            return {
              onWatchPage: !!videoIdFromUrl(),
              roomId: party.roomId,
              members: party.members.length,
              invite: inviteLink(),
              hostOnly: party.hostOnly,
              isHost: party.me === party.hostId,
              voice: voice.active,
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
    const fromLink = params.get("npParty");
    const fromSession = sessionStorage.getItem("netpartyRoom");
    const room = fromLink || fromSession;
    if (fromLink) {
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
