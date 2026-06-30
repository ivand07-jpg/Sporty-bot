const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

// ── CONFIG ─────────────────────────────────────────────────────────────────
const TOKEN = "8925561001:AAFyXqPClKaMp6ZQS1Pk-x5NKWgd2m_5Pag";
const SUPABASE_URL = "https://ygrkpkazodvjwfnpvdtl.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlncmtwa2F6b2R2andmbnB2ZHRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MDMxOTgsImV4cCI6MjA5ODM3OTE5OH0.R6puWxfTYL1VFj6V8rLDp1Z5O5x-BHnKho7_7DUMiiM";

const bot = new TelegramBot(TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── STATE (wizard sessions) ────────────────────────────────────────────────
const sessions = {}; // chatId -> { step, data }

// ── HELPERS ────────────────────────────────────────────────────────────────
const SPORTS = ["⚽ Футбол", "🏀 Баскетбол", "🎾 Теннис", "🏐 Волейбол", "🏑 Хоккей на траве", "🥊 Другой"];

function mainMenu(chatId, text = "Главное меню Sporty 🔥") {
  bot.sendMessage(chatId, text, {
    reply_markup: {
      keyboard: [
        ["🏟 Площадки", "🎮 Играть"],
        ["🏆 Рейтинг", "👤 Мой профиль"],
        ["📋 Активные игры"]
      ],
      resize_keyboard: true
    }
  });
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function getOrCreateUser(msg) {
  const tgId = msg.from.id.toString();
  const { data } = await supabase.from("users").select("*").eq("tg_id", tgId).single();
  if (data) return data;
  const { data: newUser } = await supabase.from("users").insert({
    tg_id: tgId,
    username: msg.from.username || "",
    full_name: `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim(),
    rating: 3.0,
    wins: 0,
    losses: 0
  }).select().single();
  return newUser;
}

// ── VENUES ─────────────────────────────────────────────────────────────────
async function showVenues(chatId) {
  const { data: venues, error } = await supabase.from("venues").select("*").order("name");
  if (error || !venues || venues.length === 0) {
    bot.sendMessage(chatId, "😔 Площадки пока не добавлены. Скоро появятся!", {
      reply_markup: { keyboard: [["🔙 Назад"]], resize_keyboard: true }
    });
    return;
  }
  for (const v of venues) {
    const text = `🏟 *${v.name}*\n📍 ${v.address}\n🏃 Вид спорта: ${v.sport || "Любой"}\n`;
    const opts = { parse_mode: "Markdown" };
    if (v.image_url) {
      await bot.sendPhoto(chatId, v.image_url, { caption: text, parse_mode: "Markdown" });
    } else {
      await bot.sendMessage(chatId, text, opts);
    }
  }
  bot.sendMessage(chatId, "Выбери площадку для игры через раздел 🎮 Играть", {
    reply_markup: { keyboard: [["🎮 Играть"], ["🔙 Назад"]], resize_keyboard: true }
  });
}

// ── CREATE GAME WIZARD ─────────────────────────────────────────────────────
async function startCreateGame(chatId, gameType) {
  const { data: venues } = await supabase.from("venues").select("id, name").order("name");
  sessions[chatId] = { step: "venue", data: { game_type: gameType }, venues: venues || [] };

  if (!venues || venues.length === 0) {
    sessions[chatId].step = "manual_venue";
    bot.sendMessage(chatId, "📍 Напиши адрес или название площадки:", {
      reply_markup: { keyboard: [["🔙 Отмена"]], resize_keyboard: true }
    });
    return;
  }

  const keys = venues.map(v => [v.name]);
  keys.push(["✏️ Ввести вручную", "🔙 Отмена"]);
  bot.sendMessage(chatId, "🏟 Выбери площадку:", {
    reply_markup: { keyboard: keys, resize_keyboard: true }
  });
}

// ── RATING ─────────────────────────────────────────────────────────────────
async function showRating(chatId) {
  const { data: users } = await supabase
    .from("users").select("full_name, username, rating, wins, losses, sport")
    .order("rating", { ascending: false }).limit(20);

  if (!users || users.length === 0) {
    bot.sendMessage(chatId, "🏆 Рейтинг пока пуст. Сыграй первую игру!", {
      reply_markup: { keyboard: [["🔙 Назад"]], resize_keyboard: true }
    });
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  let text = "🏆 *Рейтинг игроков Sporty*\n\n";
  users.forEach((u, i) => {
    const icon = medals[i] || `${i + 1}.`;
    const name = u.full_name || u.username || "Игрок";
    text += `${icon} *${name}* — ⭐ ${u.rating.toFixed(1)}\n`;
    text += `   🏆 ${u.wins}П / ${u.losses}П\n`;
  });

  bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "📨 Пригласить игрока в игру", callback_data: "invite_flow" }]]
    }
  });
}

// ── PROFILE ────────────────────────────────────────────────────────────────
async function showProfile(chatId, msg) {
  const user = await getOrCreateUser(msg);
  if (!user) { bot.sendMessage(chatId, "Ошибка загрузки профиля"); return; }

  const total = user.wins + user.losses;
  const winrate = total > 0 ? Math.round((user.wins / total) * 100) : 0;

  const { data: myGames } = await supabase
    .from("game_participants")
    .select("games(sport, venue_name, game_date, game_type, status)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(5);

  let text = `👤 *${user.full_name || user.username || "Игрок"}*\n\n`;
  text += `⭐ Рейтинг: *${user.rating.toFixed(1)}*\n`;
  text += `🏆 Побед: *${user.wins}*\n`;
  text += `❌ Поражений: *${user.losses}*\n`;
  text += `📊 Винрейт: *${winrate}%*\n`;

  if (myGames && myGames.length > 0) {
    text += `\n📋 *Последние игры:*\n`;
    myGames.forEach(gp => {
      const g = gp.games;
      if (g) text += `• ${g.sport} — ${g.venue_name} — ${formatDate(g.game_date)}\n`;
    });
  }

  bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

// ── ACTIVE GAMES ───────────────────────────────────────────────────────────
async function showActiveGames(chatId) {
  const { data: games } = await supabase
    .from("games")
    .select("*, game_participants(count)")
    .eq("status", "open")
    .order("game_date", { ascending: true });

  if (!games || games.length === 0) {
    bot.sendMessage(chatId, "😔 Нет активных игр. Создай первую!", {
      reply_markup: {
        keyboard: [["🎮 Играть"], ["🔙 Назад"]],
        resize_keyboard: true
      }
    });
    return;
  }

  bot.sendMessage(chatId, `🎮 *Активные игры (${games.length})*`, { parse_mode: "Markdown" });

  for (const g of games) {
    const count = g.game_participants?.[0]?.count || 0;
    const typeLabel = g.game_type === "rating" ? "⚡ На рейтинг" : "🤝 Без рейтинга";
    let text = `${typeLabel}\n`;
    text += `🏃 *${g.sport}*\n`;
    text += `🏟 ${g.venue_name}\n`;
    text += `📅 ${formatDate(g.game_date)}\n`;
    text += `👥 Участников: ${count}/${g.max_players || "∞"}\n`;
    if (g.min_rating) text += `⭐ Мин. рейтинг: ${g.min_rating}\n`;
    if (g.description) text += `📝 ${g.description}\n`;

    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Записаться", callback_data: `join_${g.id}` },
          { text: "❌ Отписаться", callback_data: `leave_${g.id}` }
        ]]
      }
    });
  }
}

// ── MESSAGE HANDLER ────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  const session = sessions[chatId];

  // ── WIZARD STEPS ──
  if (session) {
    // CANCEL
    if (text === "🔙 Отмена" || text === "🔙 Назад") {
      delete sessions[chatId];
      mainMenu(chatId, "Отменено.");
      return;
    }

    // VENUE step
    if (session.step === "venue") {
      const found = session.venues.find(v => v.name === text);
      if (found) {
        session.data.venue_id = found.id;
        session.data.venue_name = found.name;
      } else if (text === "✏️ Ввести вручную") {
        session.step = "manual_venue";
        bot.sendMessage(chatId, "📍 Напиши адрес или название места:", {
          reply_markup: { keyboard: [["🔙 Отмена"]], resize_keyboard: true }
        });
        return;
      } else {
        bot.sendMessage(chatId, "Пожалуйста, выбери площадку из списка.");
        return;
      }
      session.step = "sport";
      bot.sendMessage(chatId, "🏃 Выбери вид спорта:", {
        reply_markup: { keyboard: [...SPORTS.map(s => [s]), ["🔙 Отмена"]], resize_keyboard: true }
      });
      return;
    }

    if (session.step === "manual_venue") {
      session.data.venue_name = text;
      session.step = "sport";
      bot.sendMessage(chatId, "🏃 Выбери вид спорта:", {
        reply_markup: { keyboard: [...SPORTS.map(s => [s]), ["🔙 Отмена"]], resize_keyboard: true }
      });
      return;
    }

    // SPORT step
    if (session.step === "sport") {
      if (!SPORTS.includes(text)) { bot.sendMessage(chatId, "Выбери вид спорта из списка."); return; }
      session.data.sport = text.replace(/^[\u{1F300}-\u{1FFFF}\s]+/u, "").trim();
      session.step = "date";
      bot.sendMessage(chatId, "📅 Напиши дату и время игры\nПример: *28.07.2025 18:00*", {
        parse_mode: "Markdown",
        reply_markup: { keyboard: [["🔙 Отмена"]], resize_keyboard: true }
      });
      return;
    }

    // DATE step
    if (session.step === "date") {
      const parts = text.split(" ");
      if (parts.length < 2) {
        bot.sendMessage(chatId, "Формат: *28.07.2025 18:00*", { parse_mode: "Markdown" });
        return;
      }
      const [datePart, timePart] = parts;
      const [day, month, year] = datePart.split(".");
      const iso = `${year}-${month}-${day}T${timePart}:00`;
      if (isNaN(Date.parse(iso))) {
        bot.sendMessage(chatId, "Неверный формат. Пример: *28.07.2025 18:00*", { parse_mode: "Markdown" });
        return;
      }
      session.data.game_date = iso;
      session.step = "players";
      bot.sendMessage(chatId, "👥 Максимум игроков? (напиши число или пропусти):", {
        reply_markup: { keyboard: [["6", "10", "12", "Без ограничений"], ["🔙 Отмена"]], resize_keyboard: true }
      });
      return;
    }

    // PLAYERS step
    if (session.step === "players") {
      if (text === "Без ограничений") session.data.max_players = null;
      else if (!isNaN(parseInt(text))) session.data.max_players = parseInt(text);
      else { bot.sendMessage(chatId, "Введи число или нажми 'Без ограничений'"); return; }

      if (session.data.game_type === "rating") {
        session.step = "min_rating";
        bot.sendMessage(chatId, "⭐ Минимальный рейтинг для входа (1.0 – 5.0):", {
          reply_markup: { keyboard: [["1.0", "2.0", "3.0"], ["4.0", "5.0", "Без ограничений"], ["🔙 Отмена"]], resize_keyboard: true }
        });
      } else {
        session.step = "description";
        bot.sendMessage(chatId, "📝 Добавь описание (или пропусти):", {
          reply_markup: { keyboard: [["Пропустить", "🔙 Отмена"]], resize_keyboard: true }
        });
      }
      return;
    }

    // MIN RATING step
    if (session.step === "min_rating") {
      if (text === "Без ограничений") session.data.min_rating = null;
      else if (!isNaN(parseFloat(text))) session.data.min_rating = parseFloat(text);
      else { bot.sendMessage(chatId, "Введи число от 1.0 до 5.0"); return; }
      session.step = "description";
      bot.sendMessage(chatId, "📝 Добавь описание (или пропусти):", {
        reply_markup: { keyboard: [["Пропустить", "🔙 Отмена"]], resize_keyboard: true }
      });
      return;
    }

    // DESCRIPTION step
    if (session.step === "description") {
      if (text !== "Пропустить") session.data.description = text;
      // SAVE GAME
      const user = await getOrCreateUser(msg);
      const { data: game, error } = await supabase.from("games").insert({
        ...session.data,
        creator_id: user.id,
        status: "open"
      }).select().single();

      if (error || !game) {
        bot.sendMessage(chatId, "❌ Ошибка создания игры. Попробуй ещё раз.");
        delete sessions[chatId];
        mainMenu(chatId);
        return;
      }

      // Auto-join creator
      await supabase.from("game_participants").insert({ game_id: game.id, user_id: user.id });

      delete sessions[chatId];

      const typeLabel = game.game_type === "rating" ? "⚡ На рейтинг" : "🤝 Без рейтинга";
      let confirmText = `✅ *Игра создана!*\n\n`;
      confirmText += `${typeLabel}\n`;
      confirmText += `🏃 ${game.sport}\n`;
      confirmText += `🏟 ${game.venue_name}\n`;
      confirmText += `📅 ${formatDate(game.game_date)}\n`;
      if (game.max_players) confirmText += `👥 До ${game.max_players} игроков\n`;
      if (game.min_rating) confirmText += `⭐ Мин. рейтинг: ${game.min_rating}\n`;
      if (game.description) confirmText += `📝 ${game.description}\n`;
      confirmText += `\nПоделись ботом с друзьями: @Sporty_street_bot`;

      bot.sendMessage(chatId, confirmText, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "📋 Все активные игры", callback_data: "active_games" }]]
        }
      });
      return;
    }

    return;
  }

  // ── MAIN MENU ──
  if (text === "/start") {
    await getOrCreateUser(msg);
    bot.sendMessage(chatId,
      `🔥 Добро пожаловать в *Sporty*!\n\nЗдесь ты можешь:\n• Находить игроков для совместных игр\n• Создавать игры на рейтинг\n• Следить за своей статистикой\n\nВыбери раздел ниже 👇`,
      { parse_mode: "Markdown" }
    );
    mainMenu(chatId, "");
    return;
  }

  if (text === "🏟 Площадки") { showVenues(chatId); return; }
  if (text === "🏆 Рейтинг") { showRating(chatId); return; }
  if (text === "👤 Мой профиль") { showProfile(chatId, msg); return; }
  if (text === "📋 Активные игры") { showActiveGames(chatId); return; }
  if (text === "🔙 Назад") { mainMenu(chatId); return; }

  if (text === "🎮 Играть") {
    bot.sendMessage(chatId, "🎮 Выбери формат игры:", {
      reply_markup: {
        keyboard: [
          ["🤝 Без рейтинга", "⚡ На рейтинг"],
          ["📋 Активные игры"],
          ["🔙 Назад"]
        ],
        resize_keyboard: true
      }
    });
    return;
  }

  if (text === "🤝 Без рейтинга") { startCreateGame(chatId, "casual"); return; }
  if (text === "⚡ На рейтинг") { startCreateGame(chatId, "rating"); return; }
});

// ── CALLBACK HANDLER ───────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const msg = query.message;

  if (data === "active_games") {
    bot.answerCallbackQuery(query.id);
    showActiveGames(chatId);
    return;
  }

  if (data === "invite_flow") {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, "📨 Поделись ссылкой на бота с другом:\nt.me/Sporty_street_bot\n\nОн найдёт тебя через рейтинг и примет приглашение!");
    return;
  }

  if (data.startsWith("join_")) {
    const gameId = data.replace("join_", "");
    const fakeTgId = query.from.id.toString();
    const { data: user } = await supabase.from("users").select("*").eq("tg_id", fakeTgId).single();
    if (!user) {
      bot.answerCallbackQuery(query.id, { text: "Сначала напиши /start" });
      return;
    }
    const { data: game } = await supabase.from("games").select("*, game_participants(count)").eq("id", gameId).single();
    if (!game) { bot.answerCallbackQuery(query.id, { text: "Игра не найдена" }); return; }

    // Check min rating
    if (game.min_rating && user.rating < game.min_rating) {
      bot.answerCallbackQuery(query.id, { text: `❌ Твой рейтинг ${user.rating.toFixed(1)} ниже минимального ${game.min_rating}`, show_alert: true });
      return;
    }

    // Check capacity
    const count = game.game_participants?.[0]?.count || 0;
    if (game.max_players && count >= game.max_players) {
      bot.answerCallbackQuery(query.id, { text: "❌ Игра уже заполнена!", show_alert: true });
      return;
    }

    const { error } = await supabase.from("game_participants").upsert({ game_id: gameId, user_id: user.id }, { onConflict: "game_id,user_id" });
    if (error) {
      bot.answerCallbackQuery(query.id, { text: "Ты уже записан!" });
    } else {
      bot.answerCallbackQuery(query.id, { text: "✅ Ты записан на игру!", show_alert: true });
    }
    return;
  }

  if (data.startsWith("leave_")) {
    const gameId = data.replace("leave_", "");
    const tgId = query.from.id.toString();
    const { data: user } = await supabase.from("users").select("id").eq("tg_id", tgId).single();
    if (!user) { bot.answerCallbackQuery(query.id, { text: "Сначала напиши /start" }); return; }
    await supabase.from("game_participants").delete().eq("game_id", gameId).eq("user_id", user.id);
    bot.answerCallbackQuery(query.id, { text: "↩️ Ты отписан от игры", show_alert: true });
    return;
  }

  bot.answerCallbackQuery(query.id);
});

console.log("🏀 Sporty bot запущен!");
