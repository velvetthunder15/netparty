const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "wss://netparty.chiragrasane15.workers.dev";
const SITE_RE = /^https:\/\/www\.(netflix|hotstar|jiohotstar)\.com\//;
let tabId = null;

const view = (name) => {
  for (const v of ["vOff", "vIdle", "vParty"]) $(v).classList.toggle("hidden", v !== name);
};
const setError = (t) => ($("error").textContent = t || "");

async function toTab(msg) {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) || {};
  } catch {
    return { error: "NetParty isn't running on this tab yet. Reload the page and try again." };
  }
}

// accepts a party code, an invite link (…/j/<code>) or a watch link with ?npParty=<code>
function parseCode(s) {
  s = String(s || "").trim();
  const m = s.match(/\/j\/([a-z0-9]{4,16})/i) || s.match(/[?&]npParty=([a-z0-9]{4,16})/i) || s.match(/^([a-z0-9]{4,16})$/i);
  return m ? m[1].toLowerCase() : null;
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (!SITE_RE.test(tab?.url || "")) return view("vOff");
  const st = await toTab({ cmd: "status" });
  if (st.error) {
    view("vIdle");
    $("create").disabled = true;
    $("startHint").textContent = st.error;
    return;
  }
  if (st.roomId) {
    view("vParty");
    $("partyCode").textContent = st.roomId;
    const n = st.members.length;
    $("who").textContent = `${n} watching: ${st.members.join(", ")}${st.voice ? " · you're in voice" : ""}`;
    $("hostRow").classList.toggle("hidden", !st.isHost);
    $("hostOnly").checked = st.hostOnly;
    $("copy").dataset.link = st.invite || "";
  } else {
    view("vIdle");
    $("create").disabled = !st.onWatchPage;
    $("startHint").textContent = st.onWatchPage
      ? `Starts a party for what's playing on ${st.site}.`
      : `Open a title on ${st.site} and press play, or use the "Start a NetParty" button next to Play.`;
  }
}

async function run(msg, btn) {
  setError("");
  if (btn) btn.disabled = true;
  const res = await toTab(msg);
  if (btn) btn.disabled = false;
  if (res.error) setError(res.error);
  await refresh();
  return res;
}

async function saveName() {
  const name = $("name").value.trim();
  if (name) await chrome.storage.sync.set({ name });
}

$("create").onclick = async () => {
  await saveName();
  const res = await run({ cmd: "create" }, $("create"));
  if (res.invite) {
    await navigator.clipboard.writeText(res.invite).catch(() => {});
    $("copy").textContent = "Invite link copied ✓";
  }
};
$("join").onclick = async () => {
  const code = parseCode($("code").value);
  if (!code) return setError("That doesn't look like a NetParty link or code.");
  await saveName();
  run({ cmd: "join", roomId: code }, $("join"));
};
$("code").addEventListener("keydown", (e) => e.key === "Enter" && $("join").click());
$("leave").onclick = () => run({ cmd: "leave" });
$("chat").onclick = async () => {
  await toTab({ cmd: "showChat" });
  window.close();
};
$("copy").onclick = async () => {
  await navigator.clipboard.writeText($("copy").dataset.link || "");
  $("copy").textContent = "Copied ✓";
  setTimeout(() => ($("copy").textContent = "Copy invite link"), 1500);
};
$("hostOnly").onchange = () => run({ cmd: "hostOnly", value: $("hostOnly").checked });
$("name").addEventListener("change", saveName);
for (const b of document.querySelectorAll("[data-open]")) b.onclick = () => chrome.tabs.update(tabId, { url: b.dataset.open });

$("save").onclick = async () => {
  let server = $("server").value.trim();
  if (server && !/^wss?:\/\//.test(server)) server = "wss://" + server.replace(/^https?:\/\//, "");
  await chrome.storage.sync.set({ serverUrl: server || DEFAULT_SERVER });
  $("server").value = server || DEFAULT_SERVER;
  $("save").textContent = "Saved ✓";
  setTimeout(() => ($("save").textContent = "Save"), 1200);
};

(async () => {
  const { name, serverUrl } = await chrome.storage.sync.get(["name", "serverUrl"]);
  $("name").value = name && !/^Guest \d+$/.test(name) ? name : "";
  $("server").value = serverUrl || DEFAULT_SERVER;
  refresh();
})();
