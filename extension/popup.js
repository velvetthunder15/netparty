const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle("hidden", !on);
let tabId = null;

async function toTab(msg) {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) || {};
  } catch {
    return { error: "Reload the tab and try again." };
  }
}

async function refresh() {
  $("error").textContent = "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const onNetflix = /^https:\/\/www\.(netflix|hotstar|jiohotstar)\.com\//.test(tab?.url || "");
  if (!onNetflix) {
    show("notNetflix", true);
    show("idle", false);
    show("inParty", false);
    return;
  }
  const st = await toTab({ cmd: "status" });
  if (st.error) return ($("error").textContent = st.error);
  show("notNetflix", !st.onWatchPage && !st.roomId);
  show("idle", st.onWatchPage && !st.roomId);
  show("inParty", !!st.roomId);
  if (st.roomId) {
    $("partyInfo").textContent = `Party ${st.roomId} · ${st.members} watching${st.voice ? " · in voice" : ""}`;
    $("invite").textContent = st.invite || "";
    show("hostRow", st.isHost);
    $("hostOnly").checked = st.hostOnly;
  }
}

async function run(msg) {
  $("error").textContent = "";
  const res = await toTab(msg);
  if (res.error) $("error").textContent = res.error;
  await refresh();
  return res;
}

$("create").onclick = async () => {
  const res = await run({ cmd: "create" });
  if (res.invite) await navigator.clipboard.writeText(res.invite).catch(() => {});
};
$("join").onclick = () => run({ cmd: "join", roomId: $("code").value });
$("leave").onclick = () => run({ cmd: "leave" });
$("chat").onclick = async () => {
  await toTab({ cmd: "showChat" });
  window.close();
};
$("copy").onclick = async () => {
  await navigator.clipboard.writeText($("invite").textContent);
  $("copy").textContent = "Copied!";
  setTimeout(() => ($("copy").textContent = "Copy invite link"), 1200);
};
$("hostOnly").onchange = () => run({ cmd: "hostOnly", value: $("hostOnly").checked });

$("save").onclick = async () => {
  const name = $("name").value.trim() || "Guest";
  let server = $("server").value.trim();
  if (server && !/^wss?:\/\//.test(server)) server = "wss://" + server.replace(/^https?:\/\//, "");
  await chrome.storage.sync.set({ name, serverUrl: server || "wss://netparty.chiragrasane15.workers.dev" });
  $("save").textContent = "Saved";
  setTimeout(() => ($("save").textContent = "Save"), 1000);
};

(async () => {
  const { name, serverUrl } = await chrome.storage.sync.get(["name", "serverUrl"]);
  $("name").value = name || "";
  $("server").value = serverUrl || "wss://netparty.chiragrasane15.workers.dev";
  refresh();
})();
