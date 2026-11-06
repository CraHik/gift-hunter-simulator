
const express = require("express");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
const SECRET = process.env.BOT_WEBHOOK_SECRET;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !WEB_APP_URL || !SECRET) {
  throw new Error("Не заданы переменные окружения");
}

const API = `https://api.telegram.org/bot${TOKEN}`;

async function telegram(method, data) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  const result = await response.json();
  if (!result.ok) console.error(result);
  return result;
}

app.get("/", (req, res) => {
  res.send("Gift Hunter Bot is running!");
});

app.post("/telegram-webhook", async (req, res) => {
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== SECRET) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  const message = req.body.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start" || text === "/help") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "🎁 Добро пожаловать в Gift Hunter Simulator!\n\nЗдесь ты можешь открывать виртуальные кейсы, собирать подарки и улучшать коллекцию.\n\nВсе монеты и подарки демонстрационные и не имеют реальной стоимости.",
      reply_markup: {
        inline_keyboard: [[
          {
            text: "🎁 Открыть симулятор",
            web_app: { url: WEB_APP_URL }
          }
        ]]
      }
    });
  }
});

async function start() {
  app.listen(PORT, async () => {
    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/telegram-webhook`;

    const result = await telegram("setWebhook", {
      url: webhookUrl,
      secret_token: SECRET
    });

    console.log("Webhook setup:", result);
  });
}

start();
