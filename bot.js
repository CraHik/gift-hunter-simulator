
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
const SECRET = process.env.BOT_WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !WEB_APP_URL || !SECRET) {
  throw new Error("Не заданы переменные окружения бота");
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

const API = `https://api.telegram.org/bot${TOKEN}`;

async function telegram(method, data) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  const result = await response.json();

  if (!result.ok) {
    console.error("Telegram API error:", result);
  }

  return result;
}

// Проверка сервера и базы данных
app.get("/", async (req, res) => {
  res.send("Gift Hunter Bot is running!");
});

app.get("/health", async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        status: "warning",
        database: "DATABASE_URL не задана"
      });
    }

    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected"
    });
  } catch (error) {
    console.error("Database health check failed:", error.message);

    res.status(503).json({
      status: "error",
      database: "disconnected"
    });
  }
});

// Создание базовых таблиц
async function initializeDatabase() {
  if (!pool) {
    console.log("DATABASE_URL не задана. База пока не подключена.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance BIGINT NOT NULL DEFAULT 10000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gift_id TEXT NOT NULL,
      gift_name TEXT NOT NULL,
      rarity TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("PostgreSQL connected. Tables initialized.");
}

// Telegram webhook
app.post("/telegram-webhook", async (req, res) => {
  if (
    req.get("X-Telegram-Bot-Api-Secret-Token") !== SECRET
  ) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/start" || text === "/help") {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "🎁 Добро пожаловать в Gift Hunter Simulator!\n\n" +
          "Здесь ты можешь открывать виртуальные кейсы, " +
          "собирать подарки и улучшать коллекцию.\n\n" +
          "Все монеты и подарки демонстрационные " +
          "и не имеют реальной стоимости.",
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
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
});

// Запуск сервера
async function start() {
  try {
    await initializeDatabase();

    app.listen(PORT, async () => {
      console.log(`Server listening on port ${PORT}`);

      const renderUrl = process.env.RENDER_EXTERNAL_URL;

      if (!renderUrl) {
        console.error("RENDER_EXTERNAL_URL не задан");
        return;
      }

      const webhookUrl = `${renderUrl}/telegram-webhook`;

      const result = await telegram("setWebhook", {
        url: webhookUrl,
        secret_token: SECRET
      });

      console.log("Webhook setup:", result);
    });
  } catch (error) {
    console.error("Startup error:", error);
    process.exit(1);
  }
}

start();
