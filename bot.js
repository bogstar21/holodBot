const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { google } = require("googleapis");

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const FORM_BASE_URL = "https://script.google.com/macros/s/AKfycbzGYQ80I62uqO0vZUENqfXENsSilujHYtDoGo3RabVZzlvoJL_ablgN7IjKOhQYo2pwWA/exec";
const STATE_FILE = path.join(__dirname, "state.json");
const SHEET_ID = "137Dh42K-2VR_J6hPTkH65pWWP6Tl-QTYcTLVU-dhslg";
const REFERENCES_SHEET = "users";
const ADMIN_ID = "180881678";
const ADMIN_IDS = ["180881678", "1349356084"];
const SYNC_URL = "https://script.google.com/macros/s/AKfycbzGYQ80I62uqO0vZUENqfXENsSilujHYtDoGo3RabVZzlvoJL_ablgN7IjKOhQYo2pwWA/exec?action=sync";
const MAX_MESSAGES = 4;

const CHANNELS = ["Визиты", "Аудит Ласунка", "Аудит Рудь_Найси", "XO", "Инфо продажи", "General"];
const ROLES = ["agent", "seller", "supervisor", "auditor", "logist"];

// ─── GOOGLE SHEETS AUTH ──────────────────────────────────────────────────────

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// ─── USER AUTHORIZATION ──────────────────────────────────────────────────────

async function getUserData(userId) {
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${REFERENCES_SHEET}!A2:F200`,
    });
    const rows = res.data.values || [];
    const row = rows.find(r => r[0] && r[0].toString() === userId.toString());
    if (!row) return null;
    return {
      telegramId: row[0] || "",
      username:   row[1] || "",
      role:       (row[2] || "").toLowerCase().trim(),
      name:       row[3] || "",
      workId:     row[4] || "",
      channel:    row[5] || "",
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
      range: `${REFERENCES_SHEET}!A2:F200`,
    });
    const rows = res.data.values || [];
    if (rows.find(r => r[0] && r[0].toString() === userId.toString())) return "exists";

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${REFERENCES_SHEET}!A:F`,
      valueInputOption: "RAW",
      resource: { values: [[userId.toString(), username || "", "pending", "", "", ""]] },
    });
    return "registered";
  } catch (err) {
    console.error("registerUser error:", err.message);
    return "error";
  }
}

// Write full user data after admin approval
async function approveUser(telegramId, username, role, name, workId, channel) {
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${REFERENCES_SHEET}!A2:F200`,
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] && r[0].toString() === telegramId.toString());
    if (rowIndex === -1) {
      // User not found — append new row
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${REFERENCES_SHEET}!A:F`,
        valueInputOption: "RAW",
        resource: { values: [[telegramId, username, role, name, workId, channel]] },
      });
    } else {
      // Update existing row (rowIndex + 2 because data starts at row 2)
      const sheetRow = rowIndex + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${REFERENCES_SHEET}!A${sheetRow}:F${sheetRow}`,
        valueInputOption: "RAW",
        resource: { values: [[telegramId, username, role, name, workId, channel]] },
      });
    }
    return true;
  } catch (err) {
    console.error("approveUser error:", err.message);
    return false;
  }
}

// ─── SESSIONS (in-memory) ────────────────────────────────────────────────────

const sessions = [];

function saveSession(sessionData) {
  sessions.push(sessionData);
  if (sessions.length > 500) sessions.splice(0, 1);
}

function getLatestSession(minutes) {
  const windowMs = minutes * 60 * 1000;
  const now = Date.now();
  return sessions
    .filter(s => now - new Date(s.timestamp).getTime() < windowMs)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null;
}

function getSessionByToken(token) {
  return sessions.find(s => s.token === token) || null;
}

// ─── PENDING REGISTRATIONS (in-memory) ───────────────────────────────────────
// Stores registration data while admin fills in details
// { [adminUserId]: { step, telegramId, username, name, workId, channel, role } }

const pendingApprovals = {};

// ─── STATE MANAGEMENT ────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {}
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getUserState(userId) {
  return loadState()[userId] || { step: "idle" };
}

function setUserState(userId, data) {
  const state = loadState();
  state[userId] = { ...state[userId], ...data };
  saveState(state);
}

function clearUserState(userId) {
  const state = loadState();
  delete state[userId];
  saveState(state);
}

// ─── CLEAN CHAT ───────────────────────────────────────────────────────────────

async function trackAndClean(chatId, userId, newMessageId) {
  const state = getUserState(userId);
  const history = state.messageHistory || [];
  history.push(newMessageId);
  while (history.length > MAX_MESSAGES) {
    const oldId = history.shift();
    bot.deleteMessage(chatId, oldId).catch(() => {});
  }
  setUserState(userId, { messageHistory: history });
}

async function sendAndClean(chatId, userId, text, options = {}) {
  const sent = await bot.sendMessage(chatId, text, options);
  await trackAndClean(chatId, userId, sent.message_id);
  return sent;
}

async function resetChat(chatId, userId, chatType) {
  if (chatType !== "private") return;
  const state = getUserState(userId);
  const history = state.messageHistory || [];
  for (const msgId of history) {
    bot.deleteMessage(chatId, msgId).catch(() => {});
  }
  if (history.length > 0) {
    const lastId = Math.max(...history);
    for (let i = lastId; i > lastId - 100; i--) {
      bot.deleteMessage(chatId, i).catch(() => {});
    }
  }
  clearUserState(userId);
}

// ─── KEYBOARDS ───────────────────────────────────────────────────────────────

function getMainKeyboard(role) {
  const kb = {
    admin:      [[{ text: "📦 Агент" }, { text: "📋 Продавець" }], [{ text: "🔄 Оновити довідники" }, { text: "🗑 Очистити чат" }]],
    agent:      [[{ text: "📦 Заповнити анкету" }], [{ text: "🗑 Очистити чат" }]],
    seller:     [[{ text: "📋 Заповнити анкету" }], [{ text: "🗑 Очистити чат" }]],
    supervisor: [[{ text: "📋 Заповнити анкету" }], [{ text: "🗑 Очистити чат" }]],
    superviser: [[{ text: "📋 Заповнити анкету" }], [{ text: "🗑 Очистити чат" }]],
    logist:     [[{ text: "🚛 Логістика: Анкета" }], [{ text: "🗑 Очистити чат" }]],
    auditor:    [[{ text: "🔍 Аудит: Анкета" }], [{ text: "🗑 Очистити чат" }]],
  };
  const rows = kb[role];
  if (!rows) return null;
  return { keyboard: rows, resize_keyboard: true, persistent: true };
}

const locationKeyboard = {
  keyboard: [[{ text: "📍 Надіслати геолокацію", request_location: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

const donePhotoKeyboard = {
  keyboard: [[{ text: "✅ Готово, далі" }]],
  resize_keyboard: true,
};

// ─── ADMIN REGISTRATION HELPERS ──────────────────────────────────────────────

function channelKeyboard() {
  const rows = [];
  for (let i = 0; i < CHANNELS.length; i += 3) {
    rows.push(CHANNELS.slice(i, i + 3).map(c => ({ text: c, callback_data: `reg_channel_${c}` })));
  }
  return { inline_keyboard: rows };
}

function roleKeyboard() {
  const rows = [];
  for (let i = 0; i < ROLES.length; i += 3) {
    rows.push(ROLES.slice(i, i + 3).map(r => ({ text: r, callback_data: `reg_role_${r}` })));
  }
  rows.push([{ text: "❌ Відхилити", callback_data: "reg_role_reject" }]);
  return { inline_keyboard: rows };
}

// ─── /start ──────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  clearUserState(userId);
  const role = await getUserRole(userId);
  if (!role || role === "pending") {
    return sendAndClean(msg.chat.id, userId, "🔒 У вас немає доступу.\n\nНадішліть /register щоб запросити доступ.");
  }
  sendAndClean(msg.chat.id, userId, "👋 Виберіть дію:", { reply_markup: getMainKeyboard(role) });
});

// ─── /register ───────────────────────────────────────────────────────────────

bot.onText(/\/register/, async (msg) => {
  const userId = msg.from.id;
  const username = msg.from.username ? "@" + msg.from.username : msg.from.first_name;
  await trackAndClean(msg.chat.id, userId, msg.message_id);

  const result = await registerUser(userId, username);

  if (result === "exists") {
    return sendAndClean(msg.chat.id, userId, "⏳ Ваш запит вже надіслано. Очікуйте підтвердження.");
  }

  if (result === "registered") {
    sendAndClean(msg.chat.id, userId, "✅ Запит надіслано! Адміністратор розгляне його найближчим часом.");

    // Notify both admins with interactive registration buttons
    ADMIN_IDS.forEach(adminId => {
      bot.sendMessage(
        adminId,
        `🔔 *Новий запит на доступ*\n\n👤 ${username}\n🆔 ID: \`${userId}\`\n\nНатисніть кнопку нижче щоб розпочати реєстрацію:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Зареєструвати", callback_data: `reg_start_${userId}_${username}` },
              { text: "❌ Відхилити", callback_data: `reg_reject_${userId}` },
            ]],
          },
        }
      );
    });
    return;
  }

  sendAndClean(msg.chat.id, userId, "❌ Помилка реєстрації. Спробуйте пізніше.");
});

// ─── CALLBACK QUERIES ────────────────────────────────────────────────────────

bot.on("callback_query", async (query) => {
  const adminId = query.from.id;
  const data = query.data;
  bot.answerCallbackQuery(query.id);

  // ── Start registration ───────────────────────────────────────────────────
  if (data.startsWith("reg_start_")) {
    const parts = data.replace("reg_start_", "").split("_");
    const newUserId = parts[0];
    const newUsername = parts.slice(1).join("_");

    pendingApprovals[adminId] = {
      step: "waiting_name",
      telegramId: newUserId,
      username: newUsername,
    };

    bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }).catch(() => {});

    bot.sendMessage(adminId,
      `📝 *Реєстрація ${newUsername}*\n\nКрок 1/4 — Введіть повне ім'я:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── Reject from notification button ──────────────────────────────────────
  if (data.startsWith("reg_reject_")) {
    const newUserId = data.replace("reg_reject_", "");
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }).catch(() => {});
    bot.sendMessage(adminId, "❌ Запит відхилено.");
    bot.sendMessage(newUserId, "❌ Ваш запит на доступ було відхилено.");
    delete pendingApprovals[adminId];
    return;
  }

  // ── Channel selected ──────────────────────────────────────────────────────
  if (data.startsWith("reg_channel_")) {
    const channel = data.replace("reg_channel_", "");
    if (!pendingApprovals[adminId]) return;

    pendingApprovals[adminId].channel = channel;
    pendingApprovals[adminId].step = "waiting_role";

    bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }).catch(() => {});

    bot.sendMessage(adminId,
      `✅ Канал: *${channel}*\n\nКрок 4/4 — Виберіть роль:`,
      { parse_mode: "Markdown", reply_markup: roleKeyboard() }
    );
    return;
  }

  // ── Role selected ─────────────────────────────────────────────────────────
  if (data.startsWith("reg_role_")) {
    const role = data.replace("reg_role_", "");
    if (!pendingApprovals[adminId]) return;

    bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }).catch(() => {});

    if (role === "reject") {
      bot.sendMessage(adminId, "❌ Реєстрацію відхилено.");
      bot.sendMessage(pendingApprovals[adminId].telegramId, "❌ Ваш запит на доступ було відхилено.");
      delete pendingApprovals[adminId];
      return;
    }

    const reg = pendingApprovals[adminId];
    const success = await approveUser(reg.telegramId, reg.username, role, reg.name, reg.workId, reg.channel);

    if (success) {
      bot.sendMessage(adminId,
        `✅ *Користувача зареєстровано!*\n\n👤 ${reg.username}\n🎭 Роль: ${role}\n📋 Ім'я: ${reg.name}\n🔢 Work ID: ${reg.workId}\n📣 Канал: ${reg.channel}`,
        { parse_mode: "Markdown" }
      );
      bot.sendMessage(reg.telegramId,
        `✅ *Доступ надано!*\n\nВітаємо, ${reg.name}!\nВаша роль: *${role}*\n\nНатисніть /start щоб розпочати.`,
        { parse_mode: "Markdown" }
      );
    } else {
      bot.sendMessage(adminId, "❌ Помилка запису в таблицю. Спробуйте ще раз.");
    }

    delete pendingApprovals[adminId];
    return;
  }
});

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const text = msg.text || "";
  if (msg.location || msg.photo || text.startsWith("/")) return;

  // ── Admin registration flow ───────────────────────────────────────────────
  if (pendingApprovals[userId]) {
    const reg = pendingApprovals[userId];

    if (reg.step === "waiting_name") {
      pendingApprovals[userId].name = text.trim();
      pendingApprovals[userId].step = "waiting_workid";
      bot.sendMessage(userId,
        `✅ Ім'я: *${text.trim()}*\n\nКрок 2/4 — Введіть Work ID:`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (reg.step === "waiting_workid") {
      pendingApprovals[userId].workId = text.trim();
      pendingApprovals[userId].step = "waiting_channel";
      bot.sendMessage(userId,
        `✅ Work ID: *${text.trim()}*\n\nКрок 3/4 — Виберіть канал:`,
        { parse_mode: "Markdown", reply_markup: channelKeyboard() }
      );
      return;
    }

    return; // Waiting for button press, ignore text
  }

  // ── Regular user flow ─────────────────────────────────────────────────────
  const state = getUserState(userId);
  await trackAndClean(msg.chat.id, userId, msg.message_id);

  if (state.step === "waiting_location") {
    return sendAndClean(msg.chat.id, userId, "📍 Будь ласка, надішліть геолокацію кнопкою нижче.");
  }

  if (state.step === "waiting_photos") {
    if (text === "✅ Готово, далі") {
      setUserState(userId, { step: "idle" });
      return _sendFormLink(msg.chat.id, userId, state.location, state.photos || [], state.role);
    }
    return sendAndClean(msg.chat.id, userId, "📸 Надішліть фото або натисніть *Готово*.", { parse_mode: "Markdown" });
  }

  const role = await getUserRole(userId);
  if (!role || role === "pending") {
    return sendAndClean(msg.chat.id, userId, "🔒 У вас немає доступу. Надішліть /register.");
  }

  const flowTriggers = ["Агент", "Продавець", "анкету", "Логістика", "Аудит"];
  if (flowTriggers.some(k => text.includes(k))) {
    setUserState(userId, { step: "waiting_location", photos: [], role });
    const sent = await bot.sendMessage(msg.chat.id,
      "📍 *Крок 1 з 2 — Геолокація*\n\nНадішліть вашу поточну геолокацію 👇",
      { parse_mode: "Markdown", reply_markup: locationKeyboard }
    );
    await trackAndClean(msg.chat.id, userId, sent.message_id);
    return;
  }

  if (text === "🔄 Оновити довідники") {
    if (role !== "admin") return sendAndClean(msg.chat.id, userId, "🔒 Тільки для адміністраторів.");
    await sendAndClean(msg.chat.id, userId, "🔄 Оновлення довідників...");
    https.get(SYNC_URL, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => sendAndClean(msg.chat.id, userId,
        body.trim() === "OK" ? "✅ Довідники оновлено!" : "❌ Помилка: " + body
      ));
    }).on("error", () => sendAndClean(msg.chat.id, userId, "❌ Не вдалося підключитись."));
    return;
  }

  if (text === "🗑 Очистити чат") {
    await resetChat(msg.chat.id, userId, msg.chat.type);
    const sent = await bot.sendMessage(msg.chat.id, "🗑 Чат очищено. Виберіть дію:", {
      reply_markup: getMainKeyboard(role),
    });
    setUserState(userId, { messageHistory: [sent.message_id] });
    return;
  }

  sendAndClean(msg.chat.id, userId, "👋 Виберіть дію:", { reply_markup: getMainKeyboard(role) });
});

// ─── LOCATION ────────────────────────────────────────────────────────────────

bot.on("location", async (msg) => {
  const userId = msg.from.id;
  const state = getUserState(userId);
  if (state.step !== "waiting_location") return;

  await trackAndClean(msg.chat.id, userId, msg.message_id);
  const { latitude, longitude } = msg.location;
  const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;

  setUserState(userId, {
    step: "waiting_photos",
    location: { latitude, longitude, mapsLink },
    photos: [],
  });

  sendAndClean(msg.chat.id, userId,
    "✅ Геолокацію отримано!\n\n📸 *Крок 2 з 2 — Фото*\n\nНадішліть фото обладнання.\nКоли закінчите — натисніть *Готово*.",
    { parse_mode: "Markdown", reply_markup: donePhotoKeyboard }
  );
});

// ─── PHOTOS ──────────────────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const userId = msg.from.id;
  const state = getUserState(userId);
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

// ─── SEND FORM LINK ───────────────────────────────────────────────────────────

async function _sendFormLink(chatId, userId, location, photos, role) {
  const token = `${Date.now()}_${userId}`;
  const userData = await getUserData(userId);
  const username = userData ? userData.username : "";
  const formLink = `${FORM_BASE_URL}?token=${token}&tid=${userId}&user=${encodeURIComponent(username)}`;

  const locationText = location ? `📍 ${location.mapsLink}` : "📍 Геолокація: не надана";
  const photosText = photos.length > 0 ? `📸 Фото: ${photos.length} шт.` : "📸 Фото: не надані";

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

  saveSession({
    userId,
    token,
    role,
    username,
    timestamp: new Date().toISOString(),
    location: location || null,
    photos: photos || [],
  });
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────

http.createServer((req, res) => {
  if (req.url.startsWith("/sessions/latest")) {
    const url = new URL(req.url, "http://localhost:3000");
    const token = url.searchParams.get("token");
    const minutes = parseInt(url.searchParams.get("minutes") || "30");
    const session = token ? getSessionByToken(token) : getLatestSession(minutes);
    res.writeHead(session ? 200 : 404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(session || { error: "Not found" }));
  }
  res.writeHead(200);
  res.end("ok");
}).listen(process.env.PORT || 3000);

console.log("🤖 Bot is running...");
