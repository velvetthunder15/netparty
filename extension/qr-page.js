// 2.3: qr.html, the QR code the chat panel's Invite → QR code opens. The background hands this page the tab's
// invite link (it only answers this page, never a content script), and it's drawn here, out of the site's reach.
(async () => {
  const tab = Number(new URLSearchParams(location.search).get("tab"));
  const msg = document.getElementById("msg");
  const r = Number.isInteger(tab) ? await chrome.runtime.sendMessage({ cmd: "qrLink", tab }).catch(() => null) : null;
  const ok = typeof r?.link === "string" && globalThis.NP_QR?.draw(document.getElementById("qr"), r.link, 8);
  if (ok) document.getElementById("box").hidden = false;
  else msg.textContent = "This party's invite link isn't available any more. Open Invite in the chat panel again.";
})();
