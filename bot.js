const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLScypc5F06Gj_6Yze0qhLrWhM0I_tMnXSs1qSmdGNi6drbqnBA/viewform";
const STATE_FILE = path.join(__dirname, "state.json");

// ─── STATE MANAGEMENT ────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (e) { }
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getUserState(userId) {
  const state = loadState();
  return state[userId] || { step: "idle" };
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

// ─── MENUS ───────────────────────────────────────────────────────────────────

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📦 Агент", callback_data: "menu_1" }],
      [{ text: "📋 Продавець", callback_data: "menu_2" }],
    ],
  },
};

const subMenu1 = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📝 Заповнити анкету", callback_data: "start_flow" }],
      [{ text: "⬅️ Назад", callback_data: "back_main" }],
    ],
  },
};

const subMenu2 = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📝 Заповнити анкету", callback_data: "start_flow" }],
      [{ text: "⬅️ Назад", callback_data: "back_main" }],
    ],
  },
};

const donePhotoKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "✅ Готово, далі", callback_data: "done_photos" }],
    ],
  },
};

// ─── /start ──────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  clearUserState(msg.from.id);
  bot.sendMessage(chatId, "👋 Привіт! Виберіть вашу роль:", mainMenu);
});

// ─── CALLBACK QUERIES ────────────────────────────────────────────────────────

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const data = query.data;

  bot.answerCallbackQuery(query.id);

  if (data === "menu_1") {
    bot.editMessageText("📦 *Агент* — готові заповнити анкету?", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: subMenu1.reply_markup,
    });
  }

  if (data === "menu_2") {
    bot.editMessageText("📋 *Продавець* — готові заповнити анкету?", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: subMenu2.reply_markup,
    });
  }

  if (data === "back_main") {
    bot.editMessageText("👋 Виберіть вашу роль:", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: mainMenu.reply_markup,
    });
  }

  if (data === "start_flow") {
    setUserState(userId, { step: "waiting_location", photos: [] });
    bot.sendMessage(
      chatId,
      "📍 *Крок 1 з 2 — Геолокація*\n\nНадішліть вашу поточну геолокацію.\n\nНатисніть кнопку нижче 👇",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [[{ text: "📍 Надіслати геолокацію", request_location: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
  }

  if (data === "done_photos") {
    const userState = getUserState(userId);
    setUserState(userId, { step: "idle" });
    _sendFormLink(chatId, userId, userState.location, userState.photos || []);
  }
});

// ─── LOCATION ────────────────────────────────────────────────────────────────

bot.on("location", (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = getUserState(userId);

  if (userState.step !== "waiting_location") return;

  const { latitude, longitude } = msg.location;
  const mapsLink = `https://maps.google.com/?q=${latitude},${longitude}`;

  setUserState(userId, {
    step: "waiting_photos",
    location: { latitude, longitude, mapsLink },
    photos: [],
  });

  bot.sendMessage(
    chatId,
    "✅ Геолокацію отримано!\n\n📸 *Крок 2 з 2 — Фото*\n\nНадішліть фото обладнання (можна кілька).\nКоли закінчите — натисніть *Готово*.",
    { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
  );

  bot.sendMessage(chatId, "Надсилайте фото 👇", donePhotoKeyboard);
});

// ─── PHOTOS ──────────────────────────────────────────────────────────────────

bot.on("photo", (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = getUserState(userId);

  if (userState.step !== "waiting_photos") return;

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const photos = userState.photos || [];
  photos.push(fileId);

  setUserState(userId, { photos });

  bot.sendMessage(
    chatId,
    `📸 Фото ${photos.length} отримано! Надішліть ще або натисніть *Готово*.`,
    { parse_mode: "Markdown", ...donePhotoKeyboard }
  );
});

// ─── SEND FORM LINK ───────────────────────────────────────────────────────────

function _sendFormLink(chatId, userId, location, photos) {
  const locationText = location
    ? `📍 Геолокація: ${location.mapsLink}`
    : "📍 Геолокація: не надана";

  const photosText = photos.length > 0
    ? `📸 Фото отримано: ${photos.length} шт.`
    : "📸 Фото: не надані";

  bot.sendMessage(
    chatId,
    `✅ *Дякую!*\n\n${locationText}\n${photosText}\n\n📝 Тепер заповніть анкету:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📝 Відкрити анкету", url: FORM_URL }],
        ],
      },
    }
  );

  // Save session data
  const sessionData = {
    userId,
    timestamp: new Date().toISOString(),
    location: location || null,
    photos: photos || [],
  };

  const sessionsFile = path.join(__dirname, "sessions.json");
  let sessions = [];
  try {
    if (fs.existsSync(sessionsFile)) {
      sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    }
  } catch (e) { }
  sessions.push(sessionData);
  if (sessions.length > 200) sessions = sessions.slice(-200);
  fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
}

// ─── FALLBACK ────────────────────────────────────────────────────────────────

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = getUserState(userId);

  if (msg.location || msg.photo) return;

  if (userState.step === "waiting_location") {
    bot.sendMessage(chatId, "📍 Будь ласка, надішліть геолокацію за допомогою кнопки нижче.");
    return;
  }

  if (userState.step === "waiting_photos") {
    bot.sendMessage(chatId, "📸 Надішліть фото або натисніть *Готово*.", { parse_mode: "Markdown" });
    return;
  }

  if (msg.text && !msg.text.startsWith("/")) {
    bot.sendMessage(chatId, "👋 Виберіть вашу роль:", mainMenu);
  }
});

const http = require("http");
http.createServer((req, res) => res.end("ok")).listen(process.env.PORT || 3000);

console.log("🤖 Bot is running...");