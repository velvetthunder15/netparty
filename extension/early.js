// Runs at document_start, before the site's own scripts.
// 1) Saves an invite code (or a start request) from the URL before the site's router can rewrite it.
// 2) Puts the first keyboard listener on window, so keystrokes typed into the
//    NetParty panel reach us and never reach the site's hotkeys (space = pause,
//    f = fullscreen, etc.), which otherwise swallow Enter in the chat box.
(() => {
  if (window.__netpartyEarly) return;
  window.__netpartyEarly = true;
  try {
    const q = new URLSearchParams(location.search);
    const code = q.get("npParty");
    if (code && /^[a-z0-9]{4,16}$/i.test(code))
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
})();
