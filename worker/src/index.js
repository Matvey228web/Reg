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
  // Объявления склада: список для приложения и публичный для сайта. Запись
  // (/announcement/save, /announcement/remove) в чтения не входит и сама
  // сбрасывает кэш, так что снятое объявление исчезает с сайта сразу.
  "/announcements/list", "/public/announcements",
  // Объявления студентов (раздел My rent): тоже публичное чтение без токена.
  "/public/my",
]);

// Чтения, которые кэшируются без токена: их зовёт сайт, где никто не входит.
const PUBLIC_READS = new Set(["/public/catalog", "/public/announcements", "/public/my"]);

// Таблица отвечает от 7 до 30 секунд, а сайт ждёт объявления пять и сдаётся:
// после каждой записи и каждых пяти минут первому посетителю объявлений не
// видно вовсе. Поэтому у публичных чтений есть вторая, долгоживущая копия:
// когда свежей нет, отдаём её сразу, а свежую догоняем в фоне.
const STALE_TTL = 60 * 60 * 24 * 7;

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
// Сюда же — чтения, которые таблица отдаёт не всем вошедшим (requireAdmin):
// в общем кэше ответ админа достался бы складмену мимо проверки роли.
const PERSONAL = new Set(["/settings/get", "/staff/list"]);

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
    // Ключ берётся до похода в таблицу, по поколению на момент запроса. Иначе
    // чтение, начатое до чужой записи, легло бы под новое поколение уже
    // устаревшим ответом и прожило бы под ним пять минут.
    const key = cacheable ? await cacheKey(env, endpoint, body.payload, who) : "";

    if (cacheable && PUBLIC_READS.has(endpoint)) {
      const hit = await env.CACHE.get(key);
      if (hit) return cors(json(JSON.parse(hit), { "X-Mifs-Cache": "hit" }));
      const old = await env.CACHE.get(staleKey(endpoint, await hash(JSON.stringify(body.payload || {}))));
      if (old) {
        ctx.waitUntil(refreshPublic(env, endpoint, body.payload));
        return cors(json(JSON.parse(old), { "X-Mifs-Cache": "stale" }));
      }
    } else if (cacheable && token) {
      // Отдаём кэш только тому, чей токен Apps Script уже подтверждал: иначе
      // подделанный токен получил бы весь каталог, не заходя в систему.
      known = await env.CACHE.get("sess:" + token);
      if (known) {
        const hit = await env.CACHE.get(key);
        if (hit) return cors(json(JSON.parse(hit), { "X-Mifs-Cache": "hit" }));
      }
    }

    const write = enabled && !READS.has(endpoint) && !HARMLESS.has(endpoint);
    const upstream = await callUpstream(env, body);
    if (!upstream.ok) {
      // Таблица не ответила, но запись до неё могла дойти: исход неизвестен.
      // Лишний промах кэша дешевле вещи, которая числится свободной.
      if (write) await bumpGeneration(env);
      return cors(json(upstream.envelope, { "X-Mifs-Cache": "error" }));
    }

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
    // Только для ручек, где таблица токен проверяет: публичные отвечают ok на
    // любой, и выдуманный токен, пройдя через каталог сайта, получил бы кэш
    // складских списков.
    const checksToken = !endpoint.startsWith("/public/") && !endpoint.startsWith("/auth/");
    if (token && answer.ok && checksToken) {
      if (known === undefined) known = await env.CACHE.get("sess:" + token);
      if (!known) ctx.waitUntil(env.CACHE.put("sess:" + token, "1", { expirationTtl: TTL.session }));
    }
    // Вход выдаёт новый токен — он тоже настоящий, и первый же запрос после
    // входа должен попасть в кэш, а не ехать за ним в таблицу.
    if (endpoint === "/auth/login" && answer.ok && answer.data && answer.data.token) {
      ctx.waitUntil(env.CACHE.put("sess:" + answer.data.token, "1", { expirationTtl: TTL.session }));
    }

    if (write && answer.ok) {
      // Любая запись сбрасывает кэш. Не удалением ключей — их не перебрать
      // дёшево, — а сменой поколения: старые ключи просто перестают
      // существовать и истекают сами. До ответа, а не после: склад сразу
      // после выдачи перечитывает список и не должен попасть на старое.
      await bumpGeneration(env);
      // Снятое объявление не должно воскреснуть из долгой копии: её сносим и
      // сразу собираем новую, пока сайт ещё никто не спросил.
      if (endpoint.startsWith("/announcement/")) {
        ctx.waitUntil(env.CACHE.delete(staleKey("/public/announcements", await hash("{}")))
          .then(() => bumpGeneration(env))
          .then(() => refreshPublic(env, "/public/announcements", {})));
      }
    }

    if (cacheable && answer.ok && (token || PUBLIC_READS.has(endpoint))) {
      ctx.waitUntil(env.CACHE.put(key, JSON.stringify(answer), { expirationTtl: TTL.cache }));
      if (PUBLIC_READS.has(endpoint)) {
        ctx.waitUntil(env.CACHE.put(staleKey(endpoint, await hash(JSON.stringify(body.payload || {}))),
          JSON.stringify(answer), { expirationTtl: STALE_TTL }));
      }
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
  if (update.callback_query) return handleCallback(env, token, update.callback_query);

  const msg = update.message || update.edited_message || update.channel_post ||
    update.my_chat_member;
  const chat = msg && msg.chat;
  if (!chat || !chat.id) return;

  // Личные чаты — диалог «My rent». Группы идут прежним путём ниже, без
  // изменений. Личный чат студента в список «чатов склада» не запоминаем:
  // иначе настройки заполнились бы студентами. Исключение — /id: так
  // складмен находит свой личный чат.
  if (chat.type === "private" && update.message) {
    if (/^\/id(@[\w_]+)?\b/i.test(String(msg.text || "").trim())) {
      await rememberChat(env, chat, msg);
      await tgSend(token, chat.id, answerText(msg), null);
      return;
    }
    return privateMessage(env, token, msg);
  }

  await rememberChat(env, chat, msg);

  // В форуме ответ без номера темы уходит в «Общее», и человек, спросивший
  // /id в своей теме, его не увидит.
  const thread = msg.is_topic_message === true ? msg.message_thread_id : null;
  if (answerWanted(update)) await tgSend(token, chat.id, answerText(msg), thread);
}

async function rememberChat(env, chat, msg) {

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

// ---- «My rent»: объявление студента через бота ----
//
// Решение владельца 7 октября 2026: студент выставляет своё снаряжение в
// личном чате с ботом, склад одобряет кнопкой в своём чате. Диалог живёт в
// KV, а не в таблице: это черновик на сутки, не данные.

const DIALOG_TTL = 60 * 60 * 24;
const MYRENT_BUTTON = "My rent";
// Таблица на фото и модерацию тратит до 20 секунд; бюджет waitUntil — 30, и
// ещё нужен ответ студенту. Повтор безопасен: submit идемпотентен по фото, а
// decide на уже решённое отвечает repeat.
const MYRENT_UPSTREAM_MS = 20000;

const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function tgApi(token, method, body) {
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch {
    return null;
  }
}

const say = (token, chatId, textHtml, extra) =>
  tgApi(token, "sendMessage", {
    chat_id: String(chatId), text: textHtml, parse_mode: "HTML",
    disable_web_page_preview: true, ...(extra || {}),
  });

const MINE_BUTTON = "Мои объявления";
const menuKeyboard = {
  keyboard: [[{ text: MYRENT_BUTTON }, { text: MINE_BUTTON }]], resize_keyboard: true,
};

const STATUS_LABEL = {
  approved: "на сайте", pending: "на модерации", rejected: "отклонено", removed: "снято",
};

// Все вызовы таблицы от имени бота: ключ и длинный срок ожидания в одном месте.
async function botCall(env, token, endpoint, payload) {
  const res = await callUpstream({ ...env, UPSTREAM_TIMEOUT_MS: MYRENT_UPSTREAM_MS }, {
    endpoint, payload: { bot_key: await webhookPath(token), ...payload },
  });
  return res.envelope;
}

// Сайт должен увидеть перемену сразу: сносим свежую и долгую копии и собираем
// новую, пока сайт не спросил.
async function dropPublicMy(env) {
  await env.CACHE.delete(staleKey("/public/my", await hash("{}")));
  await bumpGeneration(env);
  await refreshPublic(env, "/public/my", {});
}

async function loadDialog(env, uid) {
  const raw = await env.CACHE.get("dlg:" + uid);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Пишем только при смене шага: записей в KV около тысячи в сутки на всё.
const saveDialog = (env, uid, state) =>
  env.CACHE.put("dlg:" + uid, JSON.stringify(state), { expirationTtl: DIALOG_TTL });

// Публичное чтение для самого Worker (категории для кнопок). Ходит тем же
// путём и в те же ключи, что и сайт, чтобы не плодить второй кэш.
async function readPublic(env, endpoint) {
  const key = await cacheKey(env, endpoint, {}, "");
  const hit = await env.CACHE.get(key);
  if (hit) return JSON.parse(hit);
  const old = await env.CACHE.get(staleKey(endpoint, await hash("{}")));
  if (old) return JSON.parse(old);
  const res = await callUpstream(env, { endpoint, payload: {} });
  if (!res.ok || !res.envelope.ok) return null;
  const value = JSON.stringify(res.envelope);
  await env.CACHE.put(key, value, { expirationTtl: TTL.cache });
  await env.CACHE.put(staleKey(endpoint, await hash("{}")), value, { expirationTtl: STALE_TTL });
  return res.envelope;
}

// Список категорий приходит из таблицы, копии в Worker нет: добавили
// категорию там — кнопка появилась без выкладки Worker.
async function myCategories(env) {
  const answer = await readPublic(env, "/public/my");
  const list = answer && answer.data && answer.data.categories;
  if (!Array.isArray(list) || !list.length) return null;
  return list.map((c) => typeof c === "string"
    ? { code: c, label: c }
    : { code: String(c.code), label: String(c.label || c.code) });
}

function priceText(price) {
  if (price === null || price === undefined) return "Договорная";
  return String(price).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽/сутки";
}

// Карточка как на сайте. Подпись фото у Telegram — до 1024 знаков, а
// экранирование раздувает текст, поэтому описание при нужде урезается.
function cardCaption(state, username, statusLine) {
  const build = (desc) => [
    "<b>" + esc(state.title) + "</b>",
    esc(state.category_label || state.category),
    desc ? esc(desc) : "",
    "<b>" + esc(priceText(state.price)) + "</b>",
    username ? "@" + esc(username) : "",
    statusLine ? "\n" + esc(statusLine) : "",
  ].filter(Boolean).join("\n");
  let desc = state.description || "";
  let out = build(desc);
  while (out.length > 1024 && desc) {
    desc = desc.slice(0, Math.max(0, desc.length - 50));
    out = build(desc ? desc + "…" : "");
  }
  return out;
}

const HELLO = [
  "Привет! Это бот склада Mifs Rent.",
  "",
  "Если хотите сдавать своё снаряжение другим студентам, нажмите «" + MYRENT_BUTTON + "» " +
    "(или /myrent): я задам несколько вопросов, покажу карточку и отправлю её на " +
    "модерацию. Свои объявления можно посмотреть, исправить и снять: «" + MINE_BUTTON +
    "» (или /my). Выйти можно в любой момент: /cancel.",
].join("\n");

async function startDialog(env, token, uid, chatId, username) {
  if (!username) {
    await say(token, chatId, "Чтобы с вами могли связаться, нужен ник в Telegram. " +
      "Задайте его в настройках Telegram (Настройки → Имя пользователя), " +
      "затем снова нажмите «" + MYRENT_BUTTON + "».");
    return;
  }
  const cats = await myCategories(env);
  if (!cats) {
    await say(token, chatId, "Сейчас не получается открыть список категорий, попробуйте позже.");
    return;
  }
  await saveDialog(env, uid, { step: "category" });
  await say(token, chatId, "Что вы сдаёте? Выберите категорию.", {
    reply_markup: { inline_keyboard: cats.map((c) => [{ text: c.label, callback_data: "myc:" + c.code }]) },
  });
}

// Правка пишется поверх исходных значений: так «что изменилось» считается
// сравнением, а не отслеживанием каждого нажатия.
const viewOf = (state) => state.mode === "edit" ? { ...state.draft, ...state.changes } : state;

// Файл-документ как фото не отправить, а карточка должна показать то, что
// получит модератор. Тип файла из таблицы (список «Мои объявления») мы не
// знаем, поэтому при отказе sendPhoto пробуем документ.
async function sendCard(token, chatId, view, caption, markup) {
  const body = { chat_id: String(chatId), caption, parse_mode: "HTML", reply_markup: markup };
  if (view.photo_kind !== "document") {
    const res = await tgApi(token, "sendPhoto", { ...body, photo: view.photo_file_id });
    if (res && res.ok) return res;
  }
  return tgApi(token, "sendDocument", { ...body, document: view.photo_file_id });
}

const EDIT_NOTE = "После правки объявление снова пройдёт модерацию и до одобрения " +
  "не будет видно на сайте.";

async function showPreview(token, chatId, state, username) {
  const edit = state.mode === "edit";
  await say(token, chatId, edit
    ? "Проверьте карточку. " + EDIT_NOTE
    : "Проверьте карточку. Так её увидят на сайте.");
  const markup = { inline_keyboard: edit ? [
    [{ text: "Отправить на модерацию", callback_data: "mys:send" }],
    [{ text: "К полям", callback_data: "myf:menu" }, { text: "Отмена", callback_data: "mys:cancel" }],
  ] : [
    [{ text: "Отправить на модерацию", callback_data: "mys:send" }],
    [{ text: "Заново", callback_data: "mys:again" }, { text: "Отмена", callback_data: "mys:cancel" }],
  ] };
  return sendCard(token, chatId, viewOf(state), cardCaption(viewOf(state), username), markup);
}

const EDIT_FIELD_BUTTONS = [
  [["category", "Категория"], ["title", "Название"]],
  [["description", "Описание"], ["price", "Цена"]],
  [["photo", "Фото"]],
];

async function showEditMenu(token, chatId, state, username) {
  const rows = EDIT_FIELD_BUTTONS.map((r) =>
    r.map(([f, label]) => ({ text: label, callback_data: "myf:" + f })));
  rows.push([{ text: "Готово", callback_data: "myf:done" }, { text: "Отмена", callback_data: "mys:cancel" }]);
  const view = viewOf(state);
  return sendCard(token, chatId, view,
    cardCaption(view, username, "Что изменить?"), { inline_keyboard: rows });
}

// Шаги диалога одни на создание и правку: вопрос и проверка не расходятся.
// take возвращает {set} или {error}; куда положить значение — решает applyStep.
const STEP_TAKE = {
  title: (said) => (!said || said.length > 80)
    ? { error: "Название — от 1 до 80 знаков." } : { set: { title: said } },
  description: (said) => {
    if (said.length > 600) return { error: "Описание — до 600 знаков, сейчас " + said.length + "." };
    if (!said) return { error: "Отправьте текст или «-», чтобы пропустить." };
    return { set: { description: said === "-" ? "" : said } };
  },
  price: (said) => (!/^\d{1,7}$/.test(said) || Number(said) > 1000000)
    ? { error: "Цена — целое число рублей от 0 до 1 000 000 или кнопка «Договорная»." }
    : { set: { price: Number(said) } },
  photo: (said, msg) => {
    const photo = pickPhoto(msg);
    return photo ? { set: { photo_file_id: photo.id, photo_kind: photo.kind } }
      : { error: "Нужна фотография: пришлите её как картинку." };
  },
};

const STEP_NEXT = { category: "title", title: "description", description: "price", price: "photo" };

// false — вопрос задать не удалось (нет списка категорий), шаг менять нельзя.
async function askStep(env, token, chatId, step, lead) {
  const pre = lead ? lead + "\n" : "";
  if (step === "category") {
    const cats = await myCategories(env);
    if (!cats) {
      await say(token, chatId, "Сейчас не получается открыть список категорий, попробуйте позже.");
      return false;
    }
    await say(token, chatId, "Что вы сдаёте? Выберите категорию.", {
      reply_markup: { inline_keyboard: cats.map((c) => [{ text: c.label, callback_data: "myc:" + c.code }]) },
    });
    return true;
  }
  if (step === "title") await say(token, chatId, pre + "Как называется? От 1 до 80 знаков.");
  else if (step === "description") {
    await say(token, chatId, "Опишите снаряжение: состояние, комплект, условия (до 600 знаков). " +
      "Если описание не нужно, отправьте «-».");
  } else if (step === "price") {
    await say(token, chatId, "Цена за сутки в рублях — числом, например 1500.", {
      reply_markup: { inline_keyboard: [[{ text: "Договорная", callback_data: "myp:neg" }]] },
    });
  } else if (step === "photo") await say(token, chatId, pre + "Пришлите фото снаряжения.");
  return true;
}

// Принятое значение: при создании ведёт к следующему шагу, при правке — назад
// в меню полей. Запись в KV одна на шаг.
async function applyStep(env, token, uid, chatId, state, set, username, lead) {
  if (state.mode === "edit") {
    Object.assign(state.changes, set);
    state.step = "menu";
    await saveDialog(env, uid, state);
    await showEditMenu(token, chatId, state, username);
    return;
  }
  Object.assign(state, set);
  const next = STEP_NEXT[state.step];
  state.step = next || "preview";
  await saveDialog(env, uid, state);
  if (next) await askStep(env, token, chatId, next, lead);
  else await showPreview(token, chatId, state, username);
}

const EDIT_FIELDS = ["category", "title", "description", "price", "photo_file_id"];

function editDiff(state) {
  const out = {};
  for (const f of EDIT_FIELDS) {
    if (f in state.changes && state.changes[f] !== state.draft[f]) out[f] = state.changes[f];
  }
  return out;
}

async function listMine(env, token, uid, chatId, username) {
  const ans = await botCall(env, token, "/myrent/mine", { tg_id: uid });
  if (!ans.ok) {
    await say(token, chatId, "Сейчас не получается открыть список, попробуйте позже.");
    return;
  }
  const items = (ans.data && ans.data.items) || [];
  if (!items.length) {
    await say(token, chatId, "У вас пока нет объявлений. Нажмите «" + MYRENT_BUTTON + "», чтобы выставить первое.");
    return;
  }
  for (const it of items) {
    const buttons = it.status === "removed"
      ? [{ text: "Выставить снова", callback_data: "myo:" + it.id }]
      : [{ text: "Редактировать", callback_data: "mye:" + it.id }, { text: "Снять", callback_data: "myx:" + it.id }];
    await sendCard(token, chatId, { photo_file_id: it.photo_file_id },
      cardCaption(it, username, "Статус: " + (STATUS_LABEL[it.status] || it.status)),
      { inline_keyboard: [buttons] });
  }
}

function pickPhoto(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const best = msg.photo.reduce((a, b) =>
      ((b.file_size || b.width * b.height || 0) >= (a.file_size || a.width * a.height || 0) ? b : a));
    return { id: best.file_id, kind: "photo" };
  }
  const d = msg.document;
  if (d && d.file_id && /^image\//i.test(String(d.mime_type || ""))) return { id: d.file_id, kind: "document" };
  return null;
}

async function privateMessage(env, token, msg) {
  const chatId = msg.chat.id;
  const uid = msg.from && msg.from.id;
  if (!uid) return;
  const said = String(msg.text || "").trim();
  const cmd = (said.match(/^\/(\w+)(@[\w_]+)?(\s|$)/) || [])[1];
  const lower = cmd ? cmd.toLowerCase() : "";

  if (lower === "start" || lower === "help") {
    await say(token, chatId, esc(HELLO), { reply_markup: menuKeyboard });
    return;
  }
  if (lower === "cancel") {
    if (await env.CACHE.get("dlg:" + uid)) await env.CACHE.delete("dlg:" + uid);
    await say(token, chatId, "Отменено. Начать заново: «" + MYRENT_BUTTON + "».", { reply_markup: menuKeyboard });
    return;
  }
  if (lower === "myrent" || said === MYRENT_BUTTON) {
    await startDialog(env, token, uid, chatId, msg.from.username);
    return;
  }
  if (lower === "my" || said === MINE_BUTTON) {
    await listMine(env, token, uid, chatId, msg.from.username);
    return;
  }

  const state = await loadDialog(env, uid);
  if (!state) {
    await say(token, chatId, "Чтобы выставить своё снаряжение, нажмите «" + MYRENT_BUTTON + "».", { reply_markup: menuKeyboard });
    return;
  }
  const hint = (t) => say(token, chatId, t + " Выйти: /cancel.");
  if (cmd) return hint("Эта команда сейчас не нужна.");

  const take = STEP_TAKE[state.step];
  if (take) {
    const got = take(said, msg);
    if (got.error) return hint(got.error);
    return applyStep(env, token, uid, chatId, state, got.set, msg.from.username);
  }
  if (state.step === "category") return hint("Выберите категорию кнопкой выше.");
  return hint("Нажмите кнопку под карточкой.");
}

// ---- нажатия на кнопки ----

async function handleCallback(env, token, cb) {
  const data = String(cb.data || "");
  const answer = (t) => tgApi(token, "answerCallbackQuery", {
    callback_query_id: cb.id, ...(t ? { text: String(t).slice(0, 190) } : {}),
  });
  const msg = cb.message;
  if (!msg || !msg.chat) return answer();

  // Модерация в чате склада. Какой чат настоящий, Worker не знает — это
  // проверяет таблица по chat_id сообщения с карточкой.
  const mod = data.match(/^myr:([ar]):([\w-]{1,32})$/);
  if (mod) {
    const by = cb.from && cb.from.username ? "@" + cb.from.username
      : String((cb.from && cb.from.first_name) || "склад");
    const ans = await botCall(env, token, "/myrent/decide", {
      id: mod[2], decision: mod[1] === "a" ? "approve" : "reject", by, chat_id: msg.chat.id,
    });
    if (!ans.ok) {
      return answer(ans.error || "Не получилось, нажмите ещё раз");
    }
    const d = ans.data || {};
    const word = d.status === "approved" ? "одобрено" : d.status === "rejected" ? "отклонено"
      : d.status === "removed" ? "снято автором" : "решено";
    if (d.repeat) return answer("Уже " + word);
    await answer(d.status === "approved" ? "Одобрено" : "Отклонено");
    await dropPublicMy(env);
    return;
  }

  // Кнопки студента живут только в личном чате того, кто их нажал: чужая
  // кнопка (из группы или пересланная) не должна менять чужие объявления.
  const m = data.match(/^(myc|myp|mys|mye|myx|myy|myn|myo|myf):(.*)$/);
  const uid = cb.from && cb.from.id;
  if (!m || !uid || msg.chat.type !== "private" || String(msg.chat.id) !== String(uid)) return answer();
  const chatId = msg.chat.id;
  const username = cb.from.username;
  const stale = () => answer("Диалог устарел. Начните заново: «" + MYRENT_BUTTON + "».");
  // Нажатую кнопку убираем: старые кнопки не должны перекидывать диалог назад.
  const dropButtons = () => tgApi(token, "editMessageReplyMarkup", {
    chat_id: String(chatId), message_id: msg.message_id, reply_markup: { inline_keyboard: [] },
  });
  const kind = m[1];

  // Кнопки списка «Мои объявления»: состояние диалога им не нужно.
  if (kind === "mye" || kind === "myx" || kind === "myy" || kind === "myn" || kind === "myo") {
    const id = m[2];
    if (!/^[\w-]{1,32}$/.test(id)) return answer();
    if (kind === "myx") {
      await answer();
      await say(token, chatId, "Снять объявление с сайта? Позже его можно выставить снова.", {
        reply_markup: { inline_keyboard: [[
          { text: "Да, снять", callback_data: "myy:" + id },
          { text: "Нет", callback_data: "myn:" + id },
        ]] },
      });
      return;
    }
    if (kind === "myn") {
      await answer();
      await dropButtons();
      await say(token, chatId, "Хорошо, объявление осталось как было.");
      return;
    }
    if (kind === "myy" || kind === "myo") {
      const ans = await botCall(env, token, kind === "myy" ? "/myrent/remove" : "/myrent/restore",
        { tg_id: uid, id });
      if (!ans.ok) return answer(ans.error || "Не получилось, нажмите ещё раз");
      const d = ans.data || {};
      await answer(kind === "myy" ? "Снято" : "Готово");
      await dropButtons();
      if (kind === "myy") {
        await say(token, chatId, "Объявление снято с сайта. Вернуть его можно в «" + MINE_BUTTON +
          "» кнопкой «Выставить снова».");
      } else {
        await say(token, chatId, d.status === "approved"
          ? "Объявление снова на сайте."
          : "Объявление отправлено на модерацию. Когда склад решит, я напишу сюда.");
      }
      if (!d.repeat) await dropPublicMy(env);
      return;
    }
    // mye: начать правку
    if (!username) return answer("Нужен ник в Telegram");
    const ans = await botCall(env, token, "/myrent/mine", { tg_id: uid });
    const it = ans.ok && ans.data && (ans.data.items || []).find((x) => x.id === id);
    if (!it) return answer(ans.ok ? "Объявление не найдено" : "Список недоступен, попробуйте позже");
    if (it.status === "removed") return answer("Сначала выставите объявление снова");
    await answer();
    const state = {
      mode: "edit", id, step: "menu", changes: {},
      draft: {
        category: it.category, category_label: it.category_label, title: it.title,
        description: it.description || "", price: it.price === undefined ? null : it.price,
        photo_file_id: it.photo_file_id,
      },
    };
    await saveDialog(env, uid, state);
    await showEditMenu(token, chatId, state, username);
    return;
  }

  const state = await loadDialog(env, uid);

  if (kind === "myc") {
    if (!state || state.step !== "category") return stale();
    const cats = await myCategories(env);
    if (!cats) return answer("Список категорий недоступен, попробуйте позже");
    const cat = cats.find((c) => c.code === m[2]);
    if (!cat) return answer("Такой категории нет");
    await answer();
    await dropButtons();
    await applyStep(env, token, uid, chatId, state,
      { category: cat.code, category_label: cat.label }, username,
      "Категория: " + esc(cat.label) + ".");
    return;
  }

  if (kind === "myp") {
    if (!state || state.step !== "price" || m[2] !== "neg") return stale();
    await answer();
    await dropButtons();
    await applyStep(env, token, uid, chatId, state, { price: null }, username, "Цена: договорная.");
    return;
  }

  if (kind === "myf") {
    if (!state || state.mode !== "edit") return stale();
    if (state.step !== "menu" && m[2] !== "menu") return stale();
    if (m[2] === "menu") {
      await answer();
      await dropButtons();
      state.step = "menu";
      await saveDialog(env, uid, state);
      await showEditMenu(token, chatId, state, username);
      return;
    }
    if (m[2] === "done") {
      if (!Object.keys(editDiff(state)).length) {
        await answer("Ничего не изменилось");
        await say(token, chatId, "Вы ничего не изменили. Выберите поле или нажмите «Отмена».");
        return;
      }
      await answer();
      await dropButtons();
      state.step = "preview";
      await saveDialog(env, uid, state);
      await showPreview(token, chatId, state, username);
      return;
    }
    if (!(m[2] in STEP_TAKE) && m[2] !== "category") return answer();
    await answer();
    if (!await askStep(env, token, chatId, m[2])) return;
    await dropButtons();
    state.step = m[2];
    await saveDialog(env, uid, state);
    return;
  }

  // mys
  if (m[2] === "cancel") {
    await answer("Отменено");
    await env.CACHE.delete("dlg:" + uid);
    await dropButtons();
    await say(token, chatId, "Отменено. Начать заново: «" + MYRENT_BUTTON + "».");
    return;
  }
  if (m[2] === "again" && state && state.mode !== "edit") {
    await answer();
    await dropButtons();
    await startDialog(env, token, uid, chatId, username);
    return;
  }
  if (m[2] !== "send" || !state || state.step !== "preview") return stale();
  if (!username) return answer("Нужен ник в Telegram");

  await answer("Отправляю…");
  if (state.mode === "edit") {
    const changes = editDiff(state);
    if (!Object.keys(changes).length) {
      await say(token, chatId, "Вы ничего не изменили, отправлять нечего.");
      return;
    }
    const ans = await botCall(env, token, "/myrent/update",
      { tg_id: uid, tg_username: username, id: state.id, changes });
    if (!ans.ok) {
      // Состояние не трогаем: студент нажмёт кнопку ещё раз, ввод заново не нужен.
      await say(token, chatId, "Не получилось отправить: " + esc(ans.error || "склад не отвечает") +
        ". Нажмите «Отправить на модерацию» ещё раз — правка сохранена.");
      return;
    }
    await env.CACHE.delete("dlg:" + uid);
    await dropButtons();
    const d = ans.data || {};
    await say(token, chatId, d.repeat
      ? "Изменений нет — объявление осталось как было."
      : "Правка отправлена на модерацию. " + EDIT_NOTE + " Когда склад решит, я напишу сюда.");
    if (!d.repeat) await dropPublicMy(env);
    return;
  }
  const ans = await botCall(env, token, "/myrent/submit", {
    tg_id: uid, tg_username: username,
    tg_name: [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" "),
    category: state.category, title: state.title, description: state.description || "",
    price: state.price === undefined ? null : state.price,
    photo_file_id: state.photo_file_id,
  });
  if (ans.ok) {
    await env.CACHE.delete("dlg:" + uid);
    await dropButtons();
    await say(token, chatId, "Отправлено на модерацию. Когда склад решит, я напишу сюда.");
    return;
  }
  // Состояние не трогаем: студент нажмёт кнопку ещё раз, ввод заново не нужен.
  await say(token, chatId, "Не получилось отправить: склад сейчас не отвечает. " +
    "Нажмите «Отправить на модерацию» ещё раз чуть позже — карточка сохранена.");
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
    // Заявка — запись в таблицу, как и любая другая: без этого список заказов
    // и наличие на сайте до пяти минут не знали бы о ней.
    await bumpGeneration(env);
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

function staleKey(endpoint, payloadHash) {
  return "stale:" + endpoint + ":" + payloadHash;
}

// Фоновое обновление публичного чтения: свежая копия под ключом текущего
// поколения плюс долгая. Упавшая таблица ничего не портит — остаётся прежняя.
async function refreshPublic(env, endpoint, payload) {
  const upstream = await callUpstream(env, { endpoint, payload: payload || {} });
  if (!upstream.ok || !upstream.envelope.ok) return;
  const value = JSON.stringify(upstream.envelope);
  await env.CACHE.put(await cacheKey(env, endpoint, payload, ""), value, { expirationTtl: TTL.cache });
  await env.CACHE.put(staleKey(endpoint, await hash(JSON.stringify(payload || {}))), value,
    { expirationTtl: STALE_TTL });
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
