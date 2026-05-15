const TelegramBot = require("node-telegram-bot-api");
const fs          = require("fs");
const path        = require("path");
const http        = require("http");
const https       = require("https");
const { google }  = require("googleapis");

const TOKEN    = process.env.TOKEN;
const bot      = new TelegramBot(TOKEN, { polling: true });

const FORM_BASE_URL = "https://script.google.com/macros/s/AKfycbzGYQ80I62uqO0vZUENqfXENsSilujHYtDoGo3RabVZzlvoJL_ablgN7IjKOhQYo2pwWA/exec";
const GAS_URL       = FORM_BASE_URL; // same URL handles ?action=updateStatus
const SHEET_ID      = "137Dh42K-2VR_J6hPTkH65pWWP6Tl-QTYcTLVU-dhslg";
const USERS_SHEET   = "users";
const ADMIN_ID      = "180881678";
const ADMIN_IDS     = ["180881678", "1349356084"];
const STATE_FILE    = path.join(__dirname, "state.json");
const MAX_MESSAGES  = 4;

// ─── BUTTON → MODE MAP ───────────────────────────────────────────────────────
const BUTTON_MODES = {
  "📋 Візит":           "vst",
  "📦 Запит XO":       "xo_req",
  "⚠️ Виставити штраф":"fine_issue",
  "🔧 Виправити штраф":"fine_fix",
  "🚛 Дія логіста":    "logist_action",
};

// ─── KEYBOARDS ───────────────────────────────────────────────────────────────
function getMainKeyboard(role) {
  const rows = {
    admin: [
      [{ text: "📋 Візит" }, { text: "📦 Запит XO" }],
      [{ text: "⚠️ Виставити штраф" }, { text: "🔧 Виправити штраф" }],
      [{ text: "🚛 Дія логіста" }, { text: "🔄 Оновити довідники" }],
      [{ text: "🗑 Очистити чат" }],
    ],
    agent: [
      [{ text: "📋 Візит" }, { text: "📦 Запит XO" }],
      [{ text: "🔧 Виправити штраф" }],
      [{ text: "🗑 Очистити чат" }],
    ],
    superviser: [
      [{ text: "📋 Візит" }],
      [{ text: "🗑 Очистити чат" }],
    ],
    logist: [
      [{ text: "🚛 Дія логіста" }],
      [{ text: "🗑 Очистити чат" }],
    ],
    auditor: [
      [{ text: "📋 Візит" }, { text: "⚠️ Виставити штраф" }],
      [{ text: "🗑 Очистити чат" }],
    ],
  };
  const keyboard = rows[role];
  if (!keyboard) return null;
  return { keyboard, resize_keyboard: true, persistent: true };
}

const locationKeyboard = {
  keyboard: [[{ text: "📍 Надіслати геолокацію", request_location: true }]],
  resize_keyboard: true, one_time_keyboard: true,
};

const donePhotoKeyboard = {
  keyboard: [[{ text: "✅ Готово, далі" }]],
  resize_keyboard: true,
};

// ─── GOOGLE SHEETS AUTH ──────────────────────────────────────────────────────
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getUserData(userId) {
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${USERS_SHEET}!A2:E200`,
    });
    const row = (res.data.values || []).find(r => r[0]?.toString() === userId.toString());
    if (!row) return null;
    return {
      telegramId: row[0] || "",
      username:   row[1] || "",
      role:       (row[2] || "").toLowerCase().trim(),
      name:       row[3] || "",
      workId:     row[4] || "",
    };
  } catch (err) {
    console.error("getUserData error:", err.message);
    return null;
  }
}

async function getUserRole(userId) {
  const user = await getUserData(userId);
  return user ? user.role : null;
}

async function registerUser(userId, username) {
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${USERS_SHEET}!A2:E200`,
    });
    if ((res.data.values || []).find(r => r[0]?.toString() === userId.toString())) return "exists";
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${USERS_SHEET}!A:E`,
      valueInputOption: "RAW",
      resource: { values: [[userId.toString(), username || "", "pending", "", ""]] },
    });
    return "registered";
  } catch (err) {
    console.error("registerUser error:", err.message);
    return "error";
  }
}

// ─── SESSIONS ────────────────────────────────────────────────────────────────
const sessions = [];

function saveSession(data) {
  sessions.push(data);
  if (sessions.length > 500) sessions.splice(0, 1);
}

function getSessionByToken(token) {
  return sessions.find(s => s.token === token) || null;
}

function getLatestSession(minutes) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  return sessions
    .filter(s => new Date(s.timestamp).getTime() > cutoff)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null;
}

// ─── STATE ───────────────────────────────────────────────────────────────────
function loadState() {
  try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  return {};
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function getUserState(uid) { return loadState()[uid] || { step: "idle" }; }
function setUserState(uid, data) {
  const s = loadState();
  s[uid] = { ...s[uid], ...data };
  saveState(s);
}
function clearUserState(uid) {
  const s = loadState();
  delete s[uid];
  saveState(s);
}

// ─── CHAT CLEANUP ─────────────────────────────────────────────────────────────
async function trackAndClean(chatId, userId, msgId) {
  const state   = getUserState(userId);
  const history = state.messageHistory || [];
  history.push(msgId);
  while (history.length > MAX_MESSAGES) {
    bot.deleteMessage(chatId, history.shift()).catch(() => {});
  }
  setUserState(userId, { messageHistory: history });
}

async function sendAndClean(chatId, userId, text, opts = {}) {
  const sent = await bot.sendMessage(chatId, text, opts);
  await trackAndClean(chatId, userId, sent.message_id);
  return sent;
}

async function resetChat(chatId, userId) {
  const history = getUserState(userId).messageHistory || [];
  for (const id of history) bot.deleteMessage(chatId, id).catch(() => {});
  clearUserState(userId);
}

// ─── HTTPS HELPER ─────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  clearUserState(userId);
  const role = await getUserRole(userId);
  if (!role || role === "pending") {
    return sendAndClean(msg.chat.id, userId, "🔒 У вас немає доступу.\n\nНадішліть /register щоб запросити доступ.");
  }
  const kb = getMainKeyboard(role);
  sendAndClean(msg.chat.id, userId, "👋 Виберіть дію:", { reply_markup: kb });
});

// ─── /register ───────────────────────────────────────────────────────────────
bot.onText(/\/register/, async (msg) => {
  const userId   = msg.from.id;
  const username = msg.from.username ? "@" + msg.from.username : msg.from.first_name;
  await trackAndClean(msg.chat.id, userId, msg.message_id);

  const result = await registerUser(userId, username);
  if (result === "exists") {
    return sendAndClean(msg.chat.id, userId, "⏳ Ваш запит вже надіслано. Очікуйте підтвердження.");
  }
  if (result === "registered") {
    sendAndClean(msg.chat.id, userId, "✅ Запит надіслано! Адміністратор розгляне його найближчим часом.");
    ADMIN_IDS.forEach(id => bot.sendMessage(id,
      `🔔 *Новий запит на доступ*\n\n👤 ${username}\n🆔 ID: \`${userId}\`\n\nВстановіть роль у Users sheet (col C) та workId (col E).`,
      { parse_mode: "Markdown" }
    ));
    return;
  }
  sendAndClean(msg.chat.id, userId, "❌ Помилка реєстрації. Спробуйте пізніше.");
});

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const text   = msg.text || "";
  if (msg.location || msg.photo || text.startsWith("/")) return;

  const state = getUserState(userId);
  await trackAndClean(msg.chat.id, userId, msg.message_id);

  // Mid-flow guards
  if (state.step === "waiting_location") {
    return sendAndClean(msg.chat.id, userId, "📍 Будь ласка, надішліть геолокацію кнопкою нижче.");
  }
  if (state.step === "waiting_photos") {
    if (text === "✅ Готово, далі") {
      setUserState(userId, { step: "idle" });
      return _sendFormLink(msg.chat.id, userId, state.location, state.photos || [], state.role, state.mode);
    }
    return sendAndClean(msg.chat.id, userId, "📸 Надішліть фото або натисніть *Готово*.", { parse_mode: "Markdown" });
  }

  const role = await getUserRole(userId);
  if (!role || role === "pending") {
    return sendAndClean(msg.chat.id, userId, "🔒 Немає доступу. Надішліть /register.");
  }

  // Flow trigger buttons
  const mode = BUTTON_MODES[text];
  if (mode) {
    setUserState(userId, { step: "waiting_location", photos: [], role, mode });
    const sent = await bot.sendMessage(msg.chat.id,
      "📍 *Крок 1 з 2 — Геолокація*\n\nНадішліть поточну геолокацію 👇",
      { parse_mode: "Markdown", reply_markup: locationKeyboard }
    );
    return trackAndClean(msg.chat.id, userId, sent.message_id);
  }

  // Sync (admin)
  if (text === "🔄 Оновити довідники") {
    if (role !== "admin") return sendAndClean(msg.chat.id, userId, "🔒 Тільки для адміністраторів.");
    await sendAndClean(msg.chat.id, userId, "🔄 Оновлення...");
    try {
      await httpsGet(FORM_BASE_URL + "?action=sync");
      sendAndClean(msg.chat.id, userId, "✅ Довідники оновлено!");
    } catch {
      sendAndClean(msg.chat.id, userId, "❌ Не вдалося підключитись.");
    }
    return;
  }

  // Clear chat
  if (text === "🗑 Очистити чат") {
    await resetChat(msg.chat.id, userId);
    const sent = await bot.sendMessage(msg.chat.id, "🗑 Чат очищено. Виберіть дію:", {
      reply_markup: getMainKeyboard(role),
    });
    setUserState(userId, { messageHistory: [sent.message_id] });
    return;
  }

  // Fallback
  sendAndClean(msg.chat.id, userId, "👋 Виберіть дію:", { reply_markup: getMainKeyboard(role) });
});

// ─── LOCATION ────────────────────────────────────────────────────────────────
bot.on("location", async (msg) => {
  const userId = msg.from.id;
  const state  = getUserState(userId);
  if (state.step !== "waiting_location") return;

  await trackAndClean(msg.chat.id, userId, msg.message_id);
  const { latitude, longitude } = msg.location;

  setUserState(userId, {
    step: "waiting_photos",
    location: { latitude, longitude, mapsLink: `https://www.google.com/maps?q=${latitude},${longitude}` },
    photos: [],
  });

  sendAndClean(msg.chat.id, userId,
    "✅ Геолокацію отримано!\n\n📸 *Крок 2 з 2 — Фото*\n\nНадішліть фото. Коли закінчите — натисніть *Готово*.",
    { parse_mode: "Markdown", reply_markup: donePhotoKeyboard }
  );
});

// ─── PHOTOS ──────────────────────────────────────────────────────────────────
bot.on("photo", async (msg) => {
  const userId = msg.from.id;
  const state  = getUserState(userId);
  if (state.step !== "waiting_photos") return;

  await trackAndClean(msg.chat.id, userId, msg.message_id);
  const photos = state.photos || [];
  photos.push(msg.photo[msg.photo.length - 1].file_id);
  setUserState(userId, { photos });

  sendAndClean(msg.chat.id, userId,
    `📸 Фото ${photos.length} отримано! Надішліть ще або натисніть *Готово*.`,
    { parse_mode: "Markdown", reply_markup: donePhotoKeyboard }
  );
});

// ─── CALLBACK QUERIES (Approve/Reject XO, Confirm Fine Fix) ──────────────────
bot.on("callback_query", async (query) => {
  const parts  = query.data.split(":");
  const action = parts[0];
  const id     = parts[1];
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;

  let type, status, confirmText;
  if      (action === "approve_xo") { type = "xo";   status = "Approved"; confirmText = "✅ Схвалено"; }
  else if (action === "reject_xo")  { type = "xo";   status = "Rejected"; confirmText = "❌ Відхилено"; }
  else if (action === "fix_fine")   { type = "fine";  status = "Fixed";    confirmText = "✅ Виправлення підтверджено"; }
  else { return bot.answerCallbackQuery(query.id); }

  try {
    const url = `${GAS_URL}?action=updateStatus&type=${type}&id=${encodeURIComponent(id)}&status=${status}`;
    await httpsGet(url);

    // Remove inline buttons from supervisor's message
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: msgId }
    );

    // Toast notification to supervisor
    await bot.answerCallbackQuery(query.id, { text: confirmText, show_alert: false });

    // Append status to the message text
    const original = query.message.text || query.message.caption || "";
    await bot.editMessageText(original + `\n\n*${confirmText}*`, {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("callback_query error:", err.message);
    bot.answerCallbackQuery(query.id, { text: "❌ Помилка оновлення", show_alert: true });
  }
});

// ─── SEND FORM LINK ───────────────────────────────────────────────────────────
async function _sendFormLink(chatId, userId, location, photos, role, mode = "vst") {
  const token    = `${Date.now()}_${userId}`;
  const userData = await getUserData(userId);
  const username = userData?.username || "";

  const formLink =
    `${FORM_BASE_URL}?token=${token}&tid=${userId}&user=${encodeURIComponent(username)}&mode=${mode}`;

  const locationText = location ? `📍 ${location.mapsLink}` : "📍 Геолокація: не надана";
  const photosText   = photos.length ? `📸 Фото: ${photos.length} шт.` : "📸 Фото: не надані";

  await sendAndClean(chatId, userId,
    `✅ *Дякую!*\n\n${locationText}\n${photosText}\n\n📝 Тепер заповніть анкету:`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "📝 Відкрити анкету", url: formLink }]] },
    }
  );

  await sendAndClean(chatId, userId, "Після заповнення можна розпочати новий акт:", {
    reply_markup: getMainKeyboard(role),
  });

  saveSession({ userId, token, role, mode, username,
    timestamp: new Date().toISOString(), location: location || null, photos: photos || [] });
}

// ─── HTTP SERVER (session endpoint for GAS) ──────────────────────────────────
http.createServer((req, res) => {
  if (req.url.startsWith("/sessions/latest")) {
    const url    = new URL(req.url, "http://localhost:3000");
    const token  = url.searchParams.get("token");
    const mins   = parseInt(url.searchParams.get("minutes") || "30");
    const session = token ? getSessionByToken(token) : getLatestSession(mins);
    res.writeHead(session ? 200 : 404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(session || { error: "Not found" }));
  }
  res.writeHead(200);
  res.end("ok");
}).listen(process.env.PORT || 3000);

console.log("🤖 Bot is running...");
