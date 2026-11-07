
const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
const SECRET = process.env.BOT_WEBHOOK_SECRET;
const PORT = process.env.PORT || 3000;
const SITE_ORIGIN = "https://crahik.github.io";

if (!TOKEN || !WEB_APP_URL || !SECRET || !process.env.DATABASE_URL) {
  throw new Error("Не заданы необходимые переменные окружения");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Разрешаем запросы с GitHub Pages
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin === SITE_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", SITE_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(origin === SITE_ORIGIN ? 204 : 403);
  }

  next();
});

const API = `https://api.telegram.org/bot${TOKEN}`;

const gifts = [
  { id: "bear", name: "Plush Bear", rarity: 1, price: 300 },
  { id: "rose", name: "Rose", rarity: 1, price: 350 },
  { id: "cake", name: "Birthday Cake", rarity: 1, price: 400 },
  { id: "heart", name: "Heart", rarity: 2, price: 900 },
  { id: "diamond", name: "Diamond", rarity: 2, price: 1200 },
  { id: "rocket", name: "Rocket", rarity: 3, price: 3500 },
  { id: "crown", name: "Golden Crown", rarity: 3, price: 4500 },
  { id: "trophy", name: "Golden Trophy", rarity: 4, price: 12000 }
];

async function telegram(method, data) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return response.json();
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance INTEGER NOT NULL DEFAULT 10000,
      opened INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gift_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("PostgreSQL tables are ready");
}

function verifyTelegramData(initData) {
  if (!initData) throw new Error("Открой игру через Telegram");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("Некорректные данные Telegram");

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(calculatedHash, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Проверка Telegram не пройдена");
  }

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    throw new Error("Данные Telegram устарели. Перезапусти игру");
  }

  const user = JSON.parse(params.get("user") || "{}");
  if (!user.id) throw new Error("Не удалось определить игрока");

  return user;
}

async function auth(req, res, next) {
  try {
    req.user = verifyTelegramData(req.get("X-Telegram-Init-Data"));
    next();
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
}

async function ensureUser(user) {
  await pool.query(
    `INSERT INTO users (id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name`,
    [user.id, user.username || null, user.first_name || "Игрок"]
  );
}

async function getProfile(userId) {
  const result = await pool.query(
    "SELECT balance, opened FROM users WHERE id = $1",
    [userId]
  );

  const items = await pool.query(
    "SELECT gift_id FROM inventory WHERE user_id = $1 ORDER BY id",
    [userId]
  );

  return {
    balance: result.rows[0].balance,
    opened: result.rows[0].opened,
    inventory: items.rows.map(row => row.gift_id)
  };
}

function randomGift(rarity) {
  const available = gifts.filter(g => g.rarity === rarity);
  return available[Math.floor(Math.random() * available.length)];
}

function randomRarity() {
  const roll = Math.random() * 100;
  return roll < 55 ? 1 : roll < 85 ? 2 : roll < 98 ? 3 : 4;
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "error", database: "disconnected" });
  }
});

app.get("/", (req, res) => res.send("Gift Hunter Bot is running!"));

app.get("/api/me", auth, async (req, res) => {
  try {
    await ensureUser(req.user);
    res.json(await getProfile(req.user.id));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка загрузки профиля" });
  }
});

app.post("/api/case", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureUser(req.user);
    await client.query("BEGIN");

    const result = await client.query(
      "SELECT balance FROM users WHERE id = $1 FOR UPDATE",
      [req.user.id]
    );

    if (result.rows[0].balance < 1000) throw new Error("Недостаточно монет");

    const gift = randomGift(randomRarity());

    await client.query(
      "UPDATE users SET balance = balance - 1000, opened = opened + 1 WHERE id = $1",
      [req.user.id]
    );
    await client.query(
      "INSERT INTO inventory (user_id, gift_id) VALUES ($1, $2)",
      [req.user.id, gift.id]
    );
    await client.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'case', -1000, $2)",
      [req.user.id, gift.name]
    );

    await client.query("COMMIT");
    res.json({ gift, ...(await getProfile(req.user.id)) });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/buy", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureUser(req.user);
    const gift = gifts.find(g => g.id === req.body.giftId);
    if (!gift) throw new Error("Подарок не найден");

    await client.query("BEGIN");
    const result = await client.query(
      "SELECT balance FROM users WHERE id = $1 FOR UPDATE",
      [req.user.id]
    );
    if (result.rows[0].balance < gift.price) throw new Error("Недостаточно монет");

    await client.query(
      "UPDATE users SET balance = balance - $1 WHERE id = $2",
      [gift.price, req.user.id]
    );
    await client.query(
      "INSERT INTO inventory (user_id, gift_id) VALUES ($1, $2)",
      [req.user.id, gift.id]
    );
    await client.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'buy', $2, $3)",
      [req.user.id, -gift.price, gift.name]
    );

    await client.query("COMMIT");
    res.json(await getProfile(req.user.id));
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/craft", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureUser(req.user);
    const rarity = Number(req.body.rarity);
    if (![1, 2, 3].includes(rarity)) throw new Error("Неверная редкость");

    const gift = randomGift(rarity + 1);
    await client.query("BEGIN");

    const items = await client.query(
      "SELECT id, gift_id FROM inventory WHERE user_id = $1 ORDER BY id FOR UPDATE",
      [req.user.id]
    );

    const matching = items.rows.filter(row => {
      const item = gifts.find(g => g.id === row.gift_id);
      return item && item.rarity === rarity;
    });

    if (matching.length < 3) throw new Error("Нужно три подарка одной редкости");

    const ids = matching.slice(0, 3).map(item => item.id);

    await client.query(
      "DELETE FROM inventory WHERE user_id = $1 AND id = ANY($2::bigint[])",
      [req.user.id, ids]
    );
    await client.query(
      "INSERT INTO inventory (user_id, gift_id) VALUES ($1, $2)",
      [req.user.id, gift.id]
    );
    await client.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'craft', 0, $2)",
      [req.user.id, gift.name]
    );

    await client.query("COMMIT");
    res.json({ gift, ...(await getProfile(req.user.id)) });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/sell", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureUser(req.user);
    const gift = gifts.find(g => g.id === req.body.giftId);
    if (!gift) throw new Error("Подарок не найден");

    await client.query("BEGIN");
    const item = await client.query(
      "SELECT id FROM inventory WHERE user_id = $1 AND gift_id = $2 ORDER BY id LIMIT 1 FOR UPDATE",
      [req.user.id, gift.id]
    );
    if (!item.rowCount) throw new Error("Такого подарка нет в коллекции");

    const payout = Math.floor(gift.price * 0.7);
    await client.query("DELETE FROM inventory WHERE id = $1", [item.rows[0].id]);
    await client.query(
      "UPDATE users SET balance = balance + $1 WHERE id = $2",
      [payout, req.user.id]
    );
    await client.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'sell', $2, $3)",
      [req.user.id, payout, gift.name]
    );

    await client.query("COMMIT");
    res.json(await getProfile(req.user.id));
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/reset", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureUser(req.user);
    await client.query("BEGIN");
    await client.query("DELETE FROM inventory WHERE user_id = $1", [req.user.id]);
    await client.query("DELETE FROM transactions WHERE user_id = $1", [req.user.id]);
    await client.query(
      "UPDATE users SET balance = 10000, opened = 0 WHERE id = $1",
      [req.user.id]
    );
    await client.query("COMMIT");
    res.json(await getProfile(req.user.id));
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Не удалось сбросить прогресс" });
  } finally {
    client.release();
  }
});

app.post("/telegram-webhook", async (req, res) => {
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== SECRET) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);
  const message = req.body.message;
  if (!message || !message.text) return;

  if (["/start", "/help"].includes(message.text.trim())) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "🎁 Добро пожаловать в Gift Hunter Simulator!\n\nВсе монеты и подарки демонстрационные и не имеют реальной стоимости.",
      reply_markup: {
        inline_keyboard: [[{
          text: "🎁 Открыть симулятор",
          web_app: { url: WEB_APP_URL }
        }]]
      }
    });
  }
});

async function start() {
  await initializeDatabase();

  app.listen(PORT, async () => {
    console.log(`Server started on port ${PORT}`);

    if (process.env.RENDER_EXTERNAL_URL) {
      const result = await telegram("setWebhook", {
        url: `${process.env.RENDER_EXTERNAL_URL}/telegram-webhook`,
        secret_token: SECRET
      });
      console.log("Webhook setup:", result);
    }
  });
}

start().catch(error => {
  console.error("Startup error:", error);
  process.exit(1);
});
