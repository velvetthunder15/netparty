const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "wss://netparty.tech";
const SITE_RE = /^https:\/\/www\.(netflix|hotstar|jiohotstar|youtube)\.com\//;
const E = globalThis.NP_EMOJI;
let tabId = null;

const view = (name) => {
  for (const v of ["vOff", "vIdle", "vParty"]) $(v).classList.toggle("hidden", v !== name);
  $("vMe").classList.toggle("hidden", name === "vOff");
};
const setError = (t) => ($("error").textContent = t || "");

async function toTab(msg) {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) || {};
  } catch {
    return { error: "NetParty isn't running on this tab yet. Reload the page and try again." };
  }
}

// The full invite link (…/j/<code>#k=<key>) or a watch link (…?npParty=<code>#npKey=<key>):
// the code says which party, the key (in the #fragment) unlocks its end-to-end encrypted chat.
// A bare code has no key.
const NEED_LINK = "Paste the full invite link — the code alone can't unlock the encrypted chat.";
function parseInvite(s) {
  s = String(s || "").trim();
  const m = s.match(/\/j\/([a-z0-9]{4,16})(?=[/?#]|$)/i) || s.match(/[?&]npParty=([a-z0-9]{4,16})(?=[&#]|$)/i) || s.match(/^([a-z0-9]{4,16})$/i);
  if (!m) return null;
  const hash = s.includes("#") ? s.slice(s.indexOf("#") + 1) : "";
  const k = hash.split("&").map((p) => p.match(/^(?:k|npKey)=(.*)$/)).find(Boolean);
  const key = k && /^[A-Za-z0-9_-]{43}$/.test(k[1]) ? k[1] : null;
  return { code: m[1].toLowerCase(), key };
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
      : st.site === "YouTube"
        ? `Open a video on YouTube, or use the "Start a NetParty" button under it.`
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
  const inv = parseInvite($("code").value);
  if (!inv) return setError("That doesn't look like a NetParty invite link.");
  if (!inv.key) return setError(NEED_LINK);
  await saveName();
  run({ cmd: "join", roomId: inv.code, key: inv.key }, $("join"));
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

// ---- your picture
const emojiBtn = (e, cls, onclick, label) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls + " emo";
  b.textContent = e;
  b.title = label || e;
  b.setAttribute("aria-label", label || e);
  b.onclick = onclick;
  return b;
};
function showAvatar(a) {
  $("avatarBtn").textContent = a || "🙂";
  for (const b of $("avatarGrid").children) b.setAttribute("aria-selected", String(b.textContent === a));
}
$("avatarGrid").append(
  ...E.avatars.map((a) =>
    emojiBtn(a, "avatar-opt", async () => {
      await chrome.storage.sync.set({ avatar: a }); // an open party picks this up straight away
      showAvatar(a);
      $("avatarGrid").classList.add("hidden");
      $("avatarBtn").setAttribute("aria-expanded", "false");
    }, "Use " + a),
  ),
);
for (const b of $("avatarGrid").children) b.setAttribute("role", "option");
$("avatarBtn").onclick = () => {
  const hidden = $("avatarGrid").classList.toggle("hidden");
  $("avatarBtn").setAttribute("aria-expanded", String(!hidden));
};

// ---- chat settings: text size, 🎉 reactions
function showFont(f) {
  for (const b of document.querySelectorAll("[data-font]")) b.setAttribute("aria-checked", String(b.dataset.font === (f || "m")));
}
for (const b of document.querySelectorAll("[data-font]"))
  b.onclick = async () => {
    await chrome.storage.sync.set({ chatFont: b.dataset.font });
    showFont(b.dataset.font);
  };
let slots = E.reactions.slice();
let editing = -1;
function showSlots() {
  $("slots").replaceChildren(
    ...slots.map((e, i) => {
      const b = emojiBtn(e, "slot" + (i === editing ? " on" : ""), () => {
        editing = editing === i ? -1 : i;
        $("slotGrid").classList.toggle("hidden", editing < 0);
        showSlots();
      }, `Reaction ${i + 1}: ${e} (click to change)`);
      return b;
    }),
  );
}
const reactionChoices = [...new Set(E.categories.flatMap((c) => c.list))];
$("slotGrid").append(
  ...reactionChoices.map((e) =>
    emojiBtn(e, "emoji-opt", async () => {
      if (editing < 0) return;
      slots[editing] = e;
      editing = -1;
      $("slotGrid").classList.add("hidden");
      await chrome.storage.sync.set({ reactions: slots });
      showSlots();
    }),
  ),
);
$("slotReset").onclick = async () => {
  slots = E.reactions.slice();
  editing = -1;
  $("slotGrid").classList.add("hidden");
  await chrome.storage.sync.remove("reactions");
  showSlots();
};

(async () => {
  const { name, serverUrl, avatar, chatFont, reactions } = await chrome.storage.sync.get(["name", "serverUrl", "avatar", "chatFont", "reactions"]);
  $("name").value = name && !/^Guest \d+$/.test(name) ? name : "";
  $("server").value = serverUrl || DEFAULT_SERVER;
  showAvatar(avatar);
  showFont(chatFont);
  if (Array.isArray(reactions) && reactions.length === 5) slots = reactions.slice();
  showSlots();
  refresh();
})();
