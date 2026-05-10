const TelegramBot = require("node-telegram-bot-api");

// 🔑 Replace with your bot token from @BotFather
const TOKEN = process.env.BOT_TOKEN;

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── Menus ────────────────────────────────────────────────────────────────────

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📦 Button 1", callback_data: "menu_1" }],
      [{ text: "📋 Button 2", callback_data: "menu_2" }],
    ],
  },
};

const subMenu1 = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔗 Button 1.1", url: "https://your-link-1-1.com" }],
      [{ text: "🔗 Button 1.2", url: "https://your-link-1-2.com" }],
      [{ text: "⬅️ Back", callback_data: "back_main" }],
    ],
  },
};

const subMenu2 = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔗 Button 2.1", url: "https://your-link-2-1.com" }],
      [{ text: "🔗 Button 2.2", url: "https://your-link-2-2.com" }],
      [{ text: "⬅️ Back", callback_data: "back_main" }],
    ],
  },
};

// ─── /start command ───────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  // ✏️ Customize your welcome message here
  bot.sendMessage(
    chatId,
    "👋 Welcome! Please choose an option below:",
    mainMenu
  );
});

// ─── Callback queries (button presses) ───────────────────────────────────────

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // Always acknowledge the callback to remove the "loading" state
  bot.answerCallbackQuery(query.id);

  if (data === "menu_1") {
    bot.editMessageText("📦 *Button 1* — Choose a link:", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      ...subMenu1.reply_markup && { reply_markup: subMenu1.reply_markup },
    });
  }

  if (data === "menu_2") {
    bot.editMessageText("📋 *Button 2* — Choose a link:", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      ...subMenu2.reply_markup && { reply_markup: subMenu2.reply_markup },
    });
  }

  if (data === "back_main") {
    bot.editMessageText("👋 Welcome! Please choose an option below:", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: mainMenu.reply_markup,
    });
  }
});

console.log("🤖 Bot is running...");
