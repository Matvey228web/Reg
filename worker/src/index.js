// Cloudflare Worker перед бэкендом в Google Apps Script.
//
// Зачем. Apps Script отвечает 5–8 секунд — это его потолок, а не наш код
// (замерено). Каталог на 628 позиций через это горлышко открывается медленнее,
// чем человек успевает передумать. Worker встаёт ПЕРЕД таблицей и отдаёт
// чтения из KV за доли секунды.
//
// Чего он НЕ делает: не хранит данные. Истина по-прежнему в таблице, её можно
// править руками, как раньше. KV — только кэш: протухает сам, сбрасывается на
// любой записи и в худшем случае просто пропускает запрос дальше.
//
// Отсюда главное свойство: Worker можно выключить в любой момент. Приложение
// продолжит работать, просто медленно, как до него.

const TTL = {
  // Правку руками в таблице приложение должно увидеть в разумный срок. Пять
  // минут — столько же, сколько кэш в браузере: два кэша с одним сроком
  // понятнее, чем два с разными.
  cache: 300,
  // Токен, который уже подтвердил Apps Script. Отозванный (выход, смена PIN,
  // увольнение) проживёт здесь не дольше этого срока — поэтому срок короткий.
  session: 300,
};

// Сколько ждём таблицу. Apps Script отвечает 4–18 секунд; если за полминуты
// ответа нет, его уже не будет, а держать соединение дальше — значит держать
// человека перед крутилкой. Для проверок срок подменяется переменной
// UPSTREAM_TIMEOUT_MS.
const UPSTREAM_TIMEOUT_MS = 30000;

// Чтения. Всё остальное считается записью и сбрасывает кэш целиком — так
// невозможно забыть дописать инвалидацию, когда появится новый эндпоинт.
// Ошибка в эту сторону стоит лишнего запроса, в обратную — выданной вещи,
// которая в приложении числится свободной.
const READS = new Set([
  "/equipment/list", "/models/list", "/item/lookup", "/item/history",
  "/orders/list", "/order/card", "/students/list", "/student/history",
  "/clients/list", "/client/history", "/defects/list", "/staff/list",
  "/inventory/list", "/settings/get",
  // Наличие на даты для сайта. Токена у посетителя нет, поэтому кэш здесь
  // общий — и это правильно: ответ у всех одинаковый.
  "/public/catalog",
]);

// Чтения, которые кэшируются без токена: их зовёт сайт, где никто не входит.
const PUBLIC_READS = new Set(["/public/catalog"]);

// Сколько раз пытаемся донести заявку до таблицы, прежде чем считать это
// нашей проблемой, а не случайным сбоем.
const DELIVER_TRIES = 10;

// Записи, которые кэша не касаются: ничего в складе не меняют. Разбор
// вставленного сообщения, отправка в Telegram, поиск чата, пачка этикеток —
// после них каталог и заказы те же, что были. Если считать их записями, то
// одно нажатие «Найти чат склада» выбрасывало бы весь прогретый кэш склада.
const HARMLESS = new Set([
  "/auth/login", "/notify/test", "/notify/hello",
  "/notify/chats", "/notify/webhook", "/order/parse", "/labels/send",
]);

// Ответы, которые зависят от того, КТО спрашивает: складмен не должен увидеть
// панель администратора, а админ — чужое имя. В общий кэш они не идут, но и
// мимо кэша не идут тоже: ключ получает ещё и отпечаток токена, то есть у
// каждого он свой. Иначе самый медленный экран — «Настройки» — остался бы
// медленным, а именно про него и спрашивают.
const PERSONAL = new Set(["/settings/get"]);

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // Обновления от Telegram. Отдельным адресом, а не эндпоинтом в конверте:
    // тело присылает Telegram, и оно не нашего формата. Заголовки CORS здесь
    // ни при чём — это сервер к серверу, без браузера.
    const path = new URL(request.url).pathname;
    if (path.startsWith("/tg/")) return telegramWebhook(request, env, ctx, path.slice(4));

    // Состояние очереди для внешней проверки доступности. Ни таблицу, ни
    // Telegram не трогает — только KV. Опрашивать не чаще раза в 15 минут:
    // каждый вызов — две операции list, а на бесплатном тарифе их около
    // тысячи в сутки на всё, включая cron.
    if (path === "/health" && request.method === "GET") return cors(await health(env));

    if (request.method !== "POST") {
      return cors(text("Mifs Rent API. Запросы принимаются через POST.", 200));
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return cors(json(envelope(false, "Некорректный запрос (не удалось разобрать JSON)", 400)));
    }

    const endpoint = String(body.endpoint || "");
    const token = body.token ? String(body.token) : "";

    // Заявка с сайта — единственное, что Worker делает сам, а не пересылает.
    // Apps Script отвечает 4–18 секунд и раз в несколько запросов отдаёт
    // страницу ошибки вместо ответа; студент не должен об это упираться.
    if (endpoint === "/public/order") return cors(await takeOrder(env, ctx, body.payload || {}));

    // Кэш отключается целиком одной переменной окружения: если что-то пойдёт
    // не так на складе, чинить это не должно требовать выкладки.
    const enabled = String(env.CACHE_ENABLED || "1") !== "0";
    const cacheable = enabled && READS.has(endpoint) && !body.fresh;
    // Личный ответ кладётся под своим ключом — по отпечатку токена. Общий
    // ответ (каталог, заказы) — под общим: он у всех одинаковый.
    const who = PERSONAL.has(endpoint) ? token : "";
    // Подтверждён ли токен — undefined, пока KV не спрашивали.
    let known;

    if (cacheable && PUBLIC_READS.has(endpoint)) {
      const key = await cacheKey(env, endpoint, body.payload, who);
      const hit = await env.CACHE.get(key);
      if (hit) return cors(json(JSON.parse(hit), { "X-Mifs-Cache": "hit" }));
    } else if (cacheable && token) {
      // Отдаём кэш только тому, чей токен Apps Script уже подтверждал: иначе
      // подделанный токен получил бы весь каталог, не заходя в систему.
      known = await env.CACHE.get("sess:" + token);
      if (known) {
        const key = await cacheKey(env, endpoint, body.payload, who);
        const hit = await env.CACHE.get(key);
        if (hit) return cors(json(JSON.parse(hit), { "X-Mifs-Cache": "hit" }));
      }
    }

    const upstream = await callUpstream(env, body);
    if (!upstream.ok) return cors(json(upstream.envelope, { "X-Mifs-Cache": "error" }));

    const answer = upstream.envelope;

    // Чаты Worker знает лучше таблицы: он их и запоминал, пока Telegram
    // присылал обновления. У таблицы остаётся то, чего Worker не знает, —
    // права того, кто спрашивает, и имя бота.
    if (endpoint === "/notify/chats" && answer.ok && answer.data) {
      const merged = mergeChats(await knownChats(env), answer.data.chats || []);
      if (merged.length) {
        answer.data.chats = merged;
        answer.data.hint = "";
      }
    }

    // Успешный ответ означает, что токен настоящий: Apps Script проверил его
    // сам. Запоминаем на короткий срок, чтобы следующий запрос ушёл в кэш.
    // Уже запомненный не переписываем: записей в KV на бесплатном тарифе
    // около тысячи в сутки, а чтений — в сто раз больше. Срок от этого не
    // продлевается — через пять минут токен просто подтвердится заново.
    if (token && answer.ok) {
      if (known === undefined) known = await env.CACHE.get("sess:" + token);
      if (!known) ctx.waitUntil(env.CACHE.put("sess:" + token, "1", { expirationTtl: TTL.session }));
    }
    // Вход выдаёт новый токен — он тоже настоящий, и первый же запрос после
    // входа должен попасть в кэш, а не ехать за ним в таблицу.
    if (endpoint === "/auth/login" && answer.ok && answer.data && answer.data.token) {
      ctx.waitUntil(env.CACHE.put("sess:" + answer.data.token, "1", { expirationTtl: TTL.session }));
    }

    if (enabled && !READS.has(endpoint) && !HARMLESS.has(endpoint) && answer.ok) {
      // Любая запись сбрасывает кэш. Не удалением ключей — их не перебрать
      // дёшево, — а сменой поколения: старые ключи просто перестают
      // существовать и истекают сами.
      ctx.waitUntil(bumpGeneration(env));
    }

    if (cacheable && answer.ok && (token || PUBLIC_READS.has(endpoint))) {
      const key = await cacheKey(env, endpoint, body.payload, who);
      ctx.waitUntil(env.CACHE.put(key, JSON.stringify(answer), { expirationTtl: TTL.cache }));
    }

    return cors(json(answer, { "X-Mifs-Cache": cacheable ? "miss" : "bypass" }));
  },

  // Добор очереди. Apps Script раз в несколько запросов отвечает страницей
  // ошибки вместо ответа — такая заявка и остаётся в очереди до следующего
  // захода сюда.
  async scheduled(event, env, ctx) {
    const list = await env.CACHE.list({ prefix: "q:" });
    for (const entry of list.keys) {
      // Одна испорченная запись не должна запирать всю очередь: иначе каждые
      // пять минут cron спотыкался бы об неё и не доходил до остальных.
      try {
        await deliver(env, entry.name);
      } catch (err) {
        await bury(env, entry.name, err);
      }
    }
  },
};

// ---- вебхук Telegram ----
//
// Раньше чаты искались опросом: приложение по кнопке спрашивало у Telegram
// getUpdates. У этого способа два врождённых изъяна — события живут не дольше
// суток, и любой второй опрос с offset забирает их себе навсегда (браузер,
// прошлый эксперимент, другой сервис на том же боте). Пустой список выглядел
// как «бота нет в чате», хотя бот был на месте.
//
// Теперь Telegram присылает события сам, Worker их запоминает, и бот отвечает
// на команды сразу — не дожидаясь, пока кто-нибудь откроет настройки.
//
// Обратимо: выключение вебхука возвращает прежний опрос, и ветка ниже просто
// перестаёт вызываться.

// Чат помнится месяц. Это подсказка для одной кнопки в настройках, а не
// данные: если протухнет — достаточно снова написать боту в чат.
const TG_CHAT_TTL = 60 * 60 * 24 * 30;

// Адрес вебхука — /tg/<отпечаток токена>. Отдельный секрет копировать между
// Cloudflare и Apps Script не нужно: обе стороны считают путь из токена бота,
// который у каждой и так есть. Свёртка односторонняя — по адресу токен не
// восстановить.
async function webhookPath(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token)));
  return [...new Uint8Array(digest)].slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function telegramWebhook(request, env, ctx, given) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "");
  // Токена нет — адреса не существует. Постороннему незачем знать даже того,
  // включён ли у нас вебхук, поэтому причина не называется.
  if (!token) return text("Not found", 404);

  const want = await webhookPath(token);
  const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (request.method !== "POST" || given !== want || header !== want) {
    return text("Not found", 404);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    // Отвечаем 200: повторять присылку нечего, разобрать это тело мы не
    // сможем и со второй попытки.
    return text("ok", 200);
  }

  // Telegram повторяет доставку, пока не получит 200, и копит очередь. Поэтому
  // отвечаем сразу, а работу делаем после ответа.
  ctx.waitUntil(handleUpdate(env, token, update));
  return text("ok", 200);
}

async function handleUpdate(env, token, update) {
  const msg = update.message || update.edited_message || update.channel_post ||
    update.my_chat_member;
  const chat = msg && msg.chat;
  if (!chat || !chat.id) return;

  const row = {
    chat_id: String(chat.id),
    title: String(chat.title ||
      [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
      chat.username || "без названия"),
    type: String(chat.type || ""),
    at: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
  };
  if (await chatChanged(env, row)) {
    await env.CACHE.put("chat:" + chat.id, JSON.stringify(row), { expirationTtl: TG_CHAT_TTL });
  }

  // В форуме ответ без номера темы уходит в «Общее», и человек, спросивший
  // /id в своей теме, его не увидит.
  const thread = msg.is_topic_message === true ? msg.message_thread_id : null;
  if (answerWanted(update)) await tgSend(token, chat.id, answerText(msg), thread);
}

// Каждое сообщение в чате — это не повод писать в KV: записей в сутки около
// тысячи на всё. Переписываем, только если чат новый, переименован, сменил
// тип или запись старше недели — последнее нужно, чтобы месячный срок
// хранения продлевался, пока в чате пишут.
const TG_CHAT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

async function chatChanged(env, row) {
  const raw = await env.CACHE.get("chat:" + row.chat_id);
  if (!raw) return true;
  let was;
  try { was = JSON.parse(raw); } catch { return true; }
  if (!was || was.title !== row.title || was.type !== row.type) return true;
  const age = Date.parse(row.at) - Date.parse(was.at);
  return !(age < TG_CHAT_REFRESH_MS);
}

// Отвечаем на команды и на своё появление в группе. На обычные сообщения — нет:
// бот в чате склада не собеседник, и вклиниваться в разговор он не должен.
function answerWanted(update) {
  const said = String((update.message || update.channel_post || {}).text || "").trim();
  if (/^\/(id|start|help)(@[\w_]+)?\b/i.test(said)) return true;

  const mine = update.my_chat_member;
  if (mine) {
    const now = String((mine.new_chat_member || {}).status || "");
    const was = String((mine.old_chat_member || {}).status || "");
    const inside = (s) => s === "member" || s === "administrator";
    return inside(now) && !inside(was);
  }
  return false;
}

// Ответ на команду — не то же, что приветствие в настроенном чате: здесь
// человек спрашивает «ты тут?», и главное в ответе — номер чата, который в
// Telegram на телефоне не посмотреть никак.
function answerText(msg) {
  const lines = [
    "Я бот склада Mifs Rent.",
    "",
    "Пишу сюда о новых заявках с сайта и актах сдачи-приёмки.",
    "",
    "Этот чат: " + msg.chat.id,
  ];
  if (msg.is_topic_message === true) lines.push("Эта тема: " + msg.message_thread_id);
  return lines.concat([
    "Осталось выбрать его в приложении: Настройки → Бот в Telegram → " +
      "Найти чат склада.",
  ]).join("\n");
}

async function tgSend(token, chatId, body, thread) {
  try {
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(chatId),
        text: body,
        disable_web_page_preview: true,
        ...(thread ? { message_thread_id: thread } : {}),
      }),
    });
  } catch {
    // Повторять нечего: 200 мы уже отдали. Человек напишет команду снова —
    // это дешевле, чем очередь повторов у Telegram из-за вежливого ответа.
  }
}

async function knownChats(env) {
  const list = await env.CACHE.list({ prefix: "chat:" });
  const out = [];
  for (const entry of list.keys) {
    const raw = await env.CACHE.get(entry.name);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Испорченную запись пропускаем: чат найдётся снова с первым сообщением.
    }
  }
  return out;
}

// Два источника: то, что запомнил Worker, и то, что успел вернуть опрос, пока
// вебхук не включён. Совпадения по номеру чата — одна строка, свежая дата
// побеждает. Сверху самое свежее: чат, в котором только что написали, человек
// и ищет.
function mergeChats(mine, theirs) {
  const byId = new Map();
  for (const chat of [...theirs, ...mine]) {
    const id = String((chat || {}).chat_id || "");
    if (!id) continue;
    const was = byId.get(id);
    if (!was || String(chat.at || "") > String(was.at || "")) byId.set(id, chat);
  }
  return [...byId.values()].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

// ---- заявка с сайта ----

// Проверяем на месте, не спрашивая таблицу: студент узнаёт об опечатке сразу,
// а не через двадцать секунд. Условия те же, что у бэкенда, — он всё равно
// проверит повторно, здесь мы только не гоняем зря мусор.
function checkOrder(payload) {
  if (String(payload.trap || "").trim()) return "Заявка не принята";
  const text = String(payload.raw_text || "");
  if (text.length < 20) return "Заявка пустая";
  if (text.length > 4000) return "Заявка слишком длинная";
  if (!/^\s*Заказ\s*№\s*\S+/im.test(text)) return "В заявке нет номера";

  const items = text.split(/\r?\n/).filter((l) => /^\s*\d+\s*[.)]\s*\S+.*:/.test(l));
  if (!items.length) return "В заявке нет ни одной позиции";
  if (items.length > 40) return "Слишком много позиций в одной заявке";

  if (!/^\s*Full_name(_minor|_adult)?\s*:\s*\S/im.test(text)) return "Укажите ФИО";
  if (!/^\s*Phone(_minors?|_adult)?\s*:\s*\S/im.test(text)) return "Укажите телефон";
  return "";
}

function orderNumber(text) {
  const m = String(text).match(/^\s*Заказ\s*№\s*(\S+)/im);
  return m ? m[1].trim() : "";
}

async function takeOrder(env, ctx, payload) {
  const wrong = checkOrder(payload);
  if (wrong) return json(envelope(false, wrong, 400));

  const no = orderNumber(payload.raw_text);
  const key = "q:" + no;

  // Ответ идёт мгновенно, и кнопку жмут второй раз. Повтор того же текста не
  // должен ни заводить вторую заявку, ни выглядеть отказом. Тот же номер с
  // другим текстом (студент поправил корзину, не перезагружая вкладку) —
  // новая версия заявки: перезаписываем ключ поверх, а не удаляем, чтобы
  // между удалением и записью заявка не пропала. Испорченная запись в
  // очереди считается «другим текстом» и тоже перезаписывается.
  const queued = await env.CACHE.get(key);
  if (queued) {
    let stored = null;
    try { stored = JSON.parse(queued); } catch { stored = null; }
    const same = stored && stored.payload &&
      String(stored.payload.raw_text || "") === String(payload.raw_text || "");
    if (same) {
      return json({ ok: true, data: { order_no: no, queued: true, repeat: true }, error: null, status: 200 });
    }
  }

  // Сначала в хранилище, потом ответ: пообещать «забронировано» и потерять
  // заявку хуже, чем ответить отказом.
  try {
    await env.CACHE.put(key, JSON.stringify({ payload, tries: 0, at: Date.now() }));
  } catch (err) {
    return json(envelope(false, "Не удалось принять заявку, попробуйте ещё раз", 503));
  }

  ctx.waitUntil(deliver(env, key));
  return json({ ok: true, data: { order_no: no, queued: true, repeat: false }, error: null, status: 200 });
}

// Доставка в таблицу. Удалось — из очереди убираем; не удалось — оставляем,
// добирает cron. Отказ по существу (ручка выключена, заявка кривая) повторять
// незачем: она не станет годной сама.
async function deliver(env, key) {
  const raw = await env.CACHE.get(key);
  if (!raw) return;
  const row = JSON.parse(raw);

  const res = await callUpstream(env, { endpoint: "/public/order", payload: row.payload });
  const answer = res.ok ? res.envelope : null;

  // Повтор того же текста таблица сама отвечает ok+repeat — это тоже «доставлено».
  if (answer && answer.ok) {
    await env.CACHE.delete(key);
    return;
  }
  // 400 и 403 — «так не бывает» и «приём выключен». 409 — номер в таблице уже
  // занят другим текстом: это не доставка, а конфликт, и сам он не
  // рассосётся. Ждать тут нечего, но и молча терять заявку нельзя:
  // перекладываем в отдельный ящик, чтобы её было видно глазами.
  if (answer && (answer.status === 400 || answer.status === 403 || answer.status === 409)) {
    await env.CACHE.put("dead:" + key.slice(2), JSON.stringify({
      ...row, error: answer.error, at: Date.now(),
    }));
    await env.CACHE.delete(key);
    return;
  }

  row.tries = (row.tries || 0) + 1;
  if (row.tries >= DELIVER_TRIES) {
    await env.CACHE.put("dead:" + key.slice(2), JSON.stringify({
      ...row, error: (answer && answer.error) || "таблица не ответила", at: Date.now(),
    }));
    await env.CACHE.delete(key);
    return;
  }
  await env.CACHE.put(key, JSON.stringify(row));
}

// Запись, которую deliver не смог даже разобрать, — в ящик неудач как есть,
// с причиной. Выбросить её нельзя: это чья-то заявка.
async function bury(env, key, err) {
  let raw = null;
  try { raw = await env.CACHE.get(key); } catch { raw = null; }
  try {
    await env.CACHE.put("dead:" + key.slice(2), JSON.stringify({
      raw, error: "запись в очереди испорчена: " + String((err && err.message) || err),
      at: Date.now(),
    }));
    await env.CACHE.delete(key);
  } catch {
    // KV недоступно — запись остаётся в очереди до следующего захода.
  }
}

// ---- состояние очереди ----

async function health(env) {
  try {
    const [queue, dead] = await Promise.all([
      env.CACHE.list({ prefix: "q:" }),
      env.CACHE.list({ prefix: "dead:" }),
    ]);
    // Дату берём из самих записей: ящик неудач обычно пуст или почти пуст,
    // а чтения KV в отличие от list дешёвые.
    let oldest = null;
    for (const entry of dead.keys) {
      let at = null;
      try { at = Number(JSON.parse(await env.CACHE.get(entry.name)).at) || null; } catch { at = null; }
      if (at && (oldest === null || at < oldest)) oldest = at;
    }
    return json({
      ok: true,
      queue: queue.keys.length,
      dead: dead.keys.length,
      oldest_dead_at: oldest === null ? null : new Date(oldest).toISOString(),
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: "KV недоступно: " + err.message }), {
      status: 503, headers: { "Content-Type": "application/json;charset=utf-8" },
    });
  }
}

// ---- обращение к таблице ----

async function callUpstream(env, body) {
  const limit = Number(env.UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), limit);
  try {
    return await askUpstream(env, body, abort.signal);
  } catch (err) {
    if (abort.signal.aborted) {
      return { ok: false, envelope: envelope(false,
        "Таблица не ответила за " + Math.round(limit / 1000) + " с, попробуйте ещё раз", 502) };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function askUpstream(env, body, signal) {
  let res;
  try {
    res = await fetch(env.UPSTREAM_URL, {
      signal,
      method: "POST",
      // Тот же «простой» тип, что шлёт приложение: Apps Script не отвечает на
      // preflight, и любой другой тип превратил бы запрос в OPTIONS.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "follow",
    });
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, envelope: envelope(false, "Нет связи с таблицей: " + err.message, 502) };
  }
  let parsed;
  try {
    parsed = await res.json();
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, envelope: envelope(false, "Таблица ответила не JSON", 502) };
  }
  return { ok: true, envelope: parsed };
}

// ---- кэш ----

// Поколение: одно число на весь склад. Любая запись увеличивает его, и все
// прежние ключи становятся недостижимыми. Раздельные поколения по разделам
// (каталог/заказы/дефекты) экономили бы запросы, но выдача меняет и то, и
// другое — выигрыш вышел бы мнимым, а способов ошибиться стало бы больше.
async function generation(env) {
  const value = await env.CACHE.get("gen");
  return value || "0";
}

async function bumpGeneration(env) {
  const current = Number(await generation(env)) || 0;
  await env.CACHE.put("gen", String(current + 1));
}

// who — пусто для общих ответов и токен для личных. Токен в ключ идёт
// отпечатком, а не как есть: ключи KV видны в панели Cloudflare, и раздавать
// там действующие токены незачем.
async function cacheKey(env, endpoint, payload, who) {
  const gen = await generation(env);
  const mine = who ? ":u" + (await hash(who)) : "";
  return "c:" + gen + ":" + endpoint + ":" +
    (await hash(JSON.stringify(payload || {}))) + mine;
}

async function hash(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- ответы ----

function envelope(ok, error, status) {
  return { ok, data: null, error, status };
}

function json(value, headers) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json;charset=utf-8", ...(headers || {}) },
  });
}

function text(value, status) {
  return new Response(value, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

// Приложение живёт на другом домене (Cloudflare Pages), поэтому заголовки
// нужны всегда. Звёздочка здесь не дыра: за данными всё равно нужен токен, а
// он лежит в теле запроса, а не в cookie, которую браузер подставил бы сам.
function cors(response) {
  const out = new Response(response.body, response);
  out.headers.set("Access-Control-Allow-Origin", "*");
  out.headers.set("Access-Control-Allow-Headers", "Content-Type");
  out.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return out;
}
