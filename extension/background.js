// Background service worker: a thin pipe between each streaming tab and the
// party server. Living here (not in the page) keeps the socket clear of
// Netflix's page CSP. One WebSocket per connected tab port.
// Chrome 116+ keeps the worker alive while a WebSocket is active.

const DEFAULT_SERVER = "wss://netparty.chiragrasane15.workers.dev";

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { serverUrl, name } = await chrome.storage.sync.get(["serverUrl", "name"]);
  const patch = {};
  // builds before 1.0.1 defaulted to a local server; move those (and only those) to the hosted one
  if (!serverUrl || (reason === "update" && serverUrl === "ws://localhost:8787")) patch.serverUrl = DEFAULT_SERVER;
  if (!name) patch.name = "Guest " + Math.floor(100 + Math.random() * 900);
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "netparty-socket") return;
  let ws = null;
  let keepAlive = null;

  const close = () => {
    clearInterval(keepAlive);
    keepAlive = null;
    if (ws && ws.readyState <= 1) ws.close(1000);
    ws = null;
  };

  port.onMessage.addListener((msg) => {
    if (msg.cmd === "open") {
      close();
      try {
        ws = new WebSocket(msg.url);
      } catch (e) {
        port.postMessage({ evt: "error", error: String(e) });
        return;
      }
      ws.onopen = () => {
        port.postMessage({ evt: "open" });
        // traffic every 20s keeps the service worker from idling out
        keepAlive = setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 20_000);
      };
      ws.onmessage = (e) => port.postMessage({ evt: "message", data: e.data });
      ws.onerror = () => port.postMessage({ evt: "error", error: "socket error" });
      ws.onclose = (e) => {
        clearInterval(keepAlive);
        port.postMessage({ evt: "close", code: e.code });
      };
    } else if (msg.cmd === "send") {
      if (ws?.readyState === 1) ws.send(msg.data);
    } else if (msg.cmd === "close") {
      close();
    }
  });

  port.onDisconnect.addListener(close);
});
