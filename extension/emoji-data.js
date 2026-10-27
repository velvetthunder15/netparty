// Emoji data shared by the content script, the popup and the background worker.
// Plain text emoji only (no images): each OS draws them with its own emoji font,
// so Mac users get Apple's emoji, Windows Segoe, Android/Linux Noto.
(() => {
  const split = (s) => s.trim().split(/\s+/);
  globalThis.NP_EMOJI = {
    // profile pictures (must match AVATARS in server/core.js)
    avatars: split(`🐶 🐱 🐼 🦊 🐨 🐸 🐵 🐧 🦄 🐯 🐰 🐻 🐮 🐷 🐙 🦁
      🍕 🍩 🍔 🌮 🍣 🧁 🍉 🍓 🍪 🥑 🍦 🍿`),
    reactions: ["😂", "😭", "💀", "🥰", "😱"], // default 🎉 tray
    categories: [
      {
        id: "smileys",
        icon: "😀",
        label: "Smileys",
        list: split(`😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔
          🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓
          🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬
          😈 👿 💀 ☠️ 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 🙈 🙉 🙊`),
      },
      {
        id: "people",
        icon: "👋",
        label: "People & gestures",
        list: split(`👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🙏
          💪 🫶 👀 👁️ 🧠 🫡 🤷 🤦 🙋 🙆 🙅 💁 🙇 🕺 💃 👯 🧟 🧛 🧙 🥷`),
      },
      {
        id: "animals",
        icon: "🐶",
        label: "Animals & nature",
        list: split(`🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🦄 🐝 🦋 🐌 🐢 🐍 🦖 🐙 🦀
          🐬 🐳 🦈 🐊 🦒 🐘 🦥 🌸 🌹 🌻 🌵 🌈 ⭐ 🌙 ☀️ ⚡ ❄️ 🔥 🌊`),
      },
      {
        id: "food",
        icon: "🍕",
        label: "Food & drink",
        list: split(`🍿 🍕 🍔 🍟 🌭 🌮 🌯 🥪 🍣 🍜 🍝 🍛 🥟 🍩 🍪 🎂 🧁 🍰 🍫 🍬 🍭 🍦 🍉 🍓 🍒 🍑 🥭 🍍
          🥑 🌶️ 🧀 🥐 🍳 🥤 🧋 ☕ 🍵 🍺 🍻 🥂 🍷 🍹`),
      },
      {
        id: "activities",
        icon: "🎉",
        label: "Activities & objects",
        list: split(`🎉 🎊 🎈 🎁 🏆 🥇 ⚽ 🏀 🏏 🎮 🎲 🎯 🎬 🎥 📺 🎧 🎤 🎵 🎶 🎸 🍀 💡 📱 💻 📸 🔔 💰 💎
          🚀 ✈️ 🚗 🏠 🎃 🎄 🧨 ✨`),
      },
      {
        id: "symbols",
        icon: "❤️",
        label: "Symbols",
        list: split(`❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 💬 💭 💤
          ✅ ❌ ❓ ❗ ⚠️ 🚫 🔞 🆗 🆒 🆕 🆙 🔴 🟢 🔵 ⬆️ ⬇️ 🔁`),
      },
    ],
  };
})();
