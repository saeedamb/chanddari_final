const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PB_URL = process.env.POCKETBASE_URL;

// ===== Helpers for PocketBase =====
async function pbGet(collection, filter = "") {
  const url = `${PB_URL}/api/collections/${collection}/records?perPage=200${filter ? "&filter=" + encodeURIComponent(filter) : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PB GET error: ${res.status}`);
  return res.json();
}
async function getConfig(key) {
  const data = await pbGet("config", `key="${key}"`);
  return data.items.length ? data.items[0].value : null;
}
async function getMessage(key) {
  const data = await pbGet("messages", `key="${key}"`);
  return data.items.length ? data.items[0].text : "";
}
async function getUI() {
  const data = await pbGet("ui");
  const map = {};
  data.items.forEach(i => (map[i.key] = i.value));
  return map;
}
async function getProvinces() {
  const data = await pbGet("provinces");
  return data.items.map(i => i.name);
}

// ===== Telegram API =====
async function tg(method, payload) {
  const token = await getConfig("telegram_token");
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) console.error("TG error:", await res.text());
  return res.json().catch(() => ({}));
}
const sendMessage = (chat_id, text, reply_markup = null) =>
  tg("sendMessage", { chat_id, text, reply_markup });

// ===== In-memory state =====
const states = {}; // chatId -> step
function setState(id, step) { states[id] = step; }
function getState(id) { return states[id] || null; }
function clearState(id) { delete states[id]; }

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;
    const msg = update.message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    const state = getState(chatId);

    // --- /start ---
    if (text === "/start") {
      const welcome = await getMessage("welcome_start");
      const ui = await getUI();
      await sendMessage(chatId, welcome, {
        keyboard: [
          [ui.label_start],
          [ui.label_info, ui.label_status],
          [ui.label_about],
          [ui.label_channel, ui.label_support]
        ],
        resize_keyboard: true
      });
      clearState(chatId);
      return;
    }

    // --- Start Registration ---
    if (text === "📝 شروع ثبت‌نام") {
      setState(chatId, "NAME");
      return sendMessage(chatId, await getMessage("ask_fullname"));
    }

    if (state === "NAME") {
      if (!text.includes(" ")) {
        return sendMessage(chatId, await getMessage("name_invalid"));
      }
      setState(chatId, "COMPANY");
      return sendMessage(chatId, await getMessage("ask_company"));
    }

    if (state === "COMPANY") {
      setState(chatId, "PHONE");
      return sendMessage(chatId, await getMessage("ask_phone"));
    }

    if (state === "PHONE") {
      if (!/^09\d{9}$/.test(text)) {
        return sendMessage(chatId, await getMessage("phone_invalid"));
      }
      setState(chatId, "PROVINCE");
      const provinces = await getProvinces();
      return sendMessage(chatId, await getMessage("ask_province"), {
        keyboard: provinces.map(p => [{ text: p }]),
        resize_keyboard: true
      });
    }

    if (state === "PROVINCE") {
      setState(chatId, "EMAIL");
      return sendMessage(chatId, await getMessage("ask_email"));
    }

    if (state === "EMAIL") {
      if (!/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(text)) {
        return sendMessage(chatId, await getMessage("email_invalid"));
      }
      setState(chatId, "PLAN");
      return sendMessage(chatId, await getMessage("ask_plan"));
    }

    if (state === "PLAN") {
      // برای سادگی فقط پیام می‌زنیم
      return sendMessage(chatId, "🎯 نمایش پلن‌ها از PocketBase (plans_first) — بعداً کامل می‌کنیم.");
    }

    return sendMessage(chatId, await getMessage("invalid_option"));
  } catch (err) {
    console.error("Error:", err.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Bot is running...");
});
