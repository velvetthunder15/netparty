// Runs in Netflix's own page context so it can reach Netflix's player API.
// Setting <video>.currentTime directly makes Netflix throw error M7375,
// so seeking goes through netflix.appContext's videoPlayer instead.
(() => {
  if (window.__netpartyBridge) return;
  window.__netpartyBridge = true;

  const TAG = "netparty";

  function nfPlayer() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const sid = ids.find((s) => s.startsWith("watch")) || ids[ids.length - 1];
      return sid ? vp.getVideoPlayerBySessionId(sid) : null;
    } catch {
      return null;
    }
  }

  const video = () => document.querySelector("video");

  function status() {
    const p = nfPlayer();
    const v = video();
    if (!p && !v) return null;
    return {
      position: p ? p.getCurrentTime() : Math.round((v.currentTime || 0) * 1000),
      playing: p ? !p.isPaused() : !v.paused,
      buffering: v ? v.readyState < 3 && !v.paused : false,
      duration: p ? p.getDuration() : Math.round((v?.duration || 0) * 1000),
    };
  }

  function act(cmd) {
    const p = nfPlayer();
    const v = video();
    switch (cmd.action) {
      case "seek":
        if (p) p.seek(Math.max(0, Math.round(cmd.position)));
        else if (v) v.currentTime = cmd.position / 1000;
        break;
      case "play":
        if (p) p.play();
        else v?.play();
        break;
      case "pause":
        if (p) p.pause();
        else v?.pause();
        break;
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== TAG || e.data.dir !== "toPage") return;
    const { id, kind, payload } = e.data;
    let result = null;
    try {
      if (kind === "status") result = status();
      else if (kind === "act") act(payload);
    } catch (err) {
      result = { error: String(err) };
    }
    window.postMessage({ source: TAG, dir: "toContent", id, result }, "*");
  });

  window.postMessage({ source: TAG, dir: "toContent", kind: "ready" }, "*");
})();
