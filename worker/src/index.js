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
]);

// Записи, которые кэша не касаются: ничего в складе не меняют.
const HARMLESS = new Set(["/auth/login", "/notify/test", "/notify/overdue", "/order/parse"]);

// Ответы, которые зависят от того, КТО спрашивает: их нельзя класть в общий
// кэш, иначе складмен увидит панель администратора, а админ — чужое имя.
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

    // Кэш отключается целиком одной переменной окружения: если что-то пойдёт
    // не так на складе, чинить это не должно требовать выкладки.
    const enabled = String(env.CACHE_ENABLED || "1") !== "0";
    const cacheable = enabled && READS.has(endpoint) && !PERSONAL.has(endpoint) && !body.fresh;

    if (cacheable && token) {
      // Отдаём кэш только тому, чей токен Apps Script уже подтверждал: иначе
      // подделанный токен получил бы весь каталог, не заходя в систему.
      const known = await env.CACHE.get("sess:" + token);
      if (known) {
        const key = await cacheKey(env, endpoint, body.payload);
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

    if (cacheable && answer.ok) {
      const key = await cacheKey(env, endpoint, body.payload);
      ctx.waitUntil(env.CACHE.put(key, JSON.stringify(answer), { expirationTtl: TTL.cache }));
    }

    return cors(json(answer, { "X-Mifs-Cache": cacheable ? "miss" : "bypass" }));
  },
};

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

async function cacheKey(env, endpoint, payload) {
  const gen = await generation(env);
  return "c:" + gen + ":" + endpoint + ":" + (await hash(JSON.stringify(payload || {})));
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
