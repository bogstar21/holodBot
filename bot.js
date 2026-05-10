const TelegramBot = require("node-telegram-bot-api");
const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });


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
      [{ text: "🔗 Анкета 1", url: "https://docs.google.com/forms/d/e/1FAIpQLSfNmkjeiJjSx17Nt1_5hMKhIJ99Kh789Qhc4orsu22JZoadvg/viewform" }],
      [{ text: "🔗 Анкета 2", url: "https://docs.google.com/forms/d/e/1FAIpQLSfNmkjeiJjSx17Nt1_5hMKhIJ99Kh789Qhc4orsu22JZoadvg/viewform" }],
      [{ text: "⬅️ Назад", callback_data: "back_main" }],
    ]
  },
};

const subMenu2 = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔗 Анкета 1", url: "https://docs.google.com/forms/d/e/1FAIpQLSfNmkjeiJjSx17Nt1_5hMKhIJ99Kh789Qhc4orsu22JZoadvg/viewform" }],
      [{ text: "🔗 Анкета 2", url: "https://docs.google.com/forms/d/e/1FAIpQLSfNmkjeiJjSx17Nt1_5hMKhIJ99Kh789Qhc4orsu22JZoadvg/viewform" }],
      [{ text: "⬅️ Назад", callback_data: "back_main" }],
    ],
  },
};


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
