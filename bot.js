const TelegramBot = require("node-telegram-bot-api");


const TOKEN = process.env.TOKEN;
console.log("Token loaded:", TOKEN ? "YES" : "NO");


const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📦 Агент", callback_data: "menu_1" }],
      [{ text: "📋 Продавец", callback_data: "menu_2" }],
    ],
  },
};

const subMenu1 = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔗 Анкета 1", url: "https://docs.google.com/forms/d/e/1FAIpQLSeD_200PL2CF1L5ORSzbR4tDCwB1-Oo9ugy3xQO0BbuoBqosQ/viewform?pli=1" }],
      [{ text: "🔗 Анкета 2", url: "https://docs.google.com/forms/d/e/1FAIpQLScS2v4mJcXW1U6cMymh1tJ6XbFhH0x4W341o3JkG0h6R800pA/viewform?pli=1" }],
      [{ text: "⬅️ Назад", callback_data: "back_main" }],
    ]
  },
};

const subMenu2 = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔗 Анкета 1", url: "https://docs.google.com/forms/d/e/1FAIpQLSeD_200PL2CF1L5ORSzbR4tDCwB1-Oo9ugy3xQO0BbuoBqosQ/viewform?pli=1" }],
      [{ text: "🔗 Анкета 2", url: "https://docs.google.com/forms/d/e/1FAIpQLScS2v4mJcXW1U6cMymh1tJ6XbFhH0x4W341o3JkG0h6R800pA/viewform?pli=1" }],
      [{ text: "⬅️ Назад", callback_data: "back_main" }],
    ],
  },
};

// ─── /start command ───────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(
    chatId,
    "👋 Привет! Выбери анкету для заполнения:",
    mainMenu
  );
});

// ─── Callback queries (button presses) ───────────────────────────────────────

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  bot.answerCallbackQuery(query.id);

  if (data === "menu_1") {
    bot.editMessageText("📦 Выберите анкету:", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      ...subMenu1.reply_markup && { reply_markup: subMenu1.reply_markup },
    });
  }

  if (data === "menu_2") {
    bot.editMessageText("📋 Выберите анкету:", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      ...subMenu2.reply_markup && { reply_markup: subMenu2.reply_markup },
    });
  }

  if (data === "back_main") {
    bot.editMessageText("👋 Выберите анкету для заполнения:", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: mainMenu.reply_markup,
    });
  }
});

console.log("🤖 Bot is running...");
