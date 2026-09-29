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
  "/auth/login", "/notify/test", "/notify/hello", "/notify/overdue",
  "/notify/chats", "/order/parse", "/labels/send",
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

    if (cacheable && PUBLIC_READS.has(endpoint)) {
      const key = await cacheKey(env, endpoint, body.payload, who);
      const hit = await env.CACHE.get(key);
      if (hit) return cors(json(JSON.parse(hit), { "X-Mifs-Cache": "hit" }));
    } else if (cacheable && token) {
      // Отдаём кэш только тому, чей токен Apps Script уже подтверждал: иначе
      // подделанный токен получил бы весь каталог, не заходя в систему.
      const known = await env.CACHE.get("sess:" + token);
      if (known) {
        const key = await cacheKey(env, endpoint, body.payload, who);
        const hit = await env.CACHE.get(key);
        if (hit) return cors(json(JSON.parse(hit), { "X-Mifs-Cache": "hit" }));
      }
    }

    const upstream = await callUpstream(env, body);
    if (!upstream.ok) return cors(json(upstream.envelope, { "X-Mifs-Cache": "error" }));

    const answer = upstream.envelope;

    // Успешный ответ означает, что токен настоящий: Apps Script проверил его
    // сам. Запоминаем на короткий срок, чтобы следующий запрос ушёл в кэш.
    if (token && answer.ok) {
      ctx.waitUntil(env.CACHE.put("sess:" + token, "1", { expirationTtl: TTL.session }));
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
      await deliver(env, entry.name);
    }
  },
};

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

  // Ответ идёт мгновенно, и кнопку жмут второй раз. Повтор не должен ни
  // заводить вторую заявку, ни выглядеть отказом.
  const queued = await env.CACHE.get(key);
  if (queued) {
    return json({ ok: true, data: { order_no: no, queued: true, repeat: true }, error: null, status: 200 });
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

  if (answer && (answer.ok || answer.status === 409)) {
    await env.CACHE.delete(key);
    return;
  }
  // 400 и 403 — «так не бывает» и «приём выключен». Ждать тут нечего, но и
  // молча терять заявку нельзя: перекладываем в отдельный ящик, чтобы её
  // было видно глазами.
  if (answer && (answer.status === 400 || answer.status === 403)) {
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

// ---- обращение к таблице ----

async function callUpstream(env, body) {
  let res;
  try {
    res = await fetch(env.UPSTREAM_URL, {
      method: "POST",
      // Тот же «простой» тип, что шлёт приложение: Apps Script не отвечает на
      // preflight, и любой другой тип превратил бы запрос в OPTIONS.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "follow",
    });
  } catch (err) {
    return { ok: false, envelope: envelope(false, "Нет связи с таблицей: " + err.message, 502) };
  }
  let parsed;
  try {
    parsed = await res.json();
  } catch {
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
