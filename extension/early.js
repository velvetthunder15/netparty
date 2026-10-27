// Runs at document_start, before the site's own scripts.
// 1) Saves an invite code (or a start request) from the URL before the site's router can rewrite it,
//    and takes the party's encryption key out of the URL #fragment before the site's scripts can see it.
// 2) Puts the first keyboard listener on window, so keystrokes typed into the
//    NetParty panel (chat box, GIF search, pickers) reach us and never reach the
//    site's hotkeys (space = pause, f = fullscreen, k/j/l on YouTube, etc.), which
//    otherwise swallow Enter in the chat box.
// 3) Same for clicks on links in chat, so the site can't cancel them.
(() => {
  if (window.__netpartyEarly) return;
  window.__netpartyEarly = true;
  try {
    const q = new URLSearchParams(location.search);
    const code = q.get("npParty");
    const okCode = !!code && /^[a-z0-9]{4,16}$/i.test(code);
    // The party's encryption key rides in the #fragment (…?npParty=<code>#npKey=<key>), which is
    // never sent to the site's servers. Take it out of the address bar right away, before any of
    // the site's own scripts run, and hand it to the extension only (content scripts share this
    // isolated world; the background keeps it in session storage for this tab).
    const frag = location.hash.slice(1);
    if (/(^|&)npKey=/.test(frag)) {
      let key = null;
      const keep = frag.split("&").filter((p) => (p.startsWith("npKey=") ? ((key = p.slice(6)), false) : !!p));
      history.replaceState(history.state, "", location.pathname + location.search + (keep.length ? "#" + keep.join("&") : ""));
      if (okCode) {
        const c = code.toLowerCase();
        const good = /^[A-Za-z0-9_-]{43}$/.test(key || "");
        window.__netpartyInviteKey = good ? { code: c, key } : { code: c, bad: true };
        if (good) chrome.runtime.sendMessage({ cmd: "roomKey", op: "set", code: c, key }).catch(() => {});
      }
    }
    if (okCode)
      sessionStorage.setItem("netpartyInvite", JSON.stringify({ code: code.toLowerCase(), ts: Date.now() }));
    // "Start a NetParty" on a title page: create the party once the player opens
    if (q.get("npStart") === "1") sessionStorage.setItem("netpartyStart", String(Date.now()));
  } catch {}

  const inPanel = (e) => e.composedPath().some((n) => n && n.id === "netparty-root");
  for (const type of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(
      type,
      (e) => {
        if (!inPanel(e)) return;
        // hand the key to the panel, then hide it from the page (typing still works:
        // stopping propagation doesn't cancel the browser's default text input)
        if (type === "keydown") window.__netpartyKey?.(e);
        e.stopImmediatePropagation();
      },
      true,
    );
  }
  // Links in chat: let the browser follow them. Stopping the click here, before any of
  // the site's own capture listeners, means the player can't swallow it or call
  // preventDefault (stopping propagation keeps the link's default action).
  for (const type of ["click", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup"]) {
    window.addEventListener(
      type,
      (e) => {
        if (!inPanel(e)) return;
        if (e.composedPath().some((n) => n && n.nodeType === 1 && n.matches?.("a.np-a[href]"))) e.stopImmediatePropagation();
      },
      true,
    );
  }
})();
