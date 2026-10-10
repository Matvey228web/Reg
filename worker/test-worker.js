// Проверка Worker без Cloudflare: KV и сеть подменяются заглушками, а сам
// worker/src/index.js берётся настоящий.
//
// Главное, что здесь проверяется, — не «кэш работает», а два свойства, без
// которых кэш опаснее отсутствия кэша: он никогда не отдаёт данные тому, чей
// токен не подтверждён, и он никогда не переживает запись.

import worker from "./src/index.js";

let bad = 0;
const ok = (label, cond, extra) => {
  if (!cond) bad++;
  console.log((cond ? "  ok   " : "  FAIL ") + label + (cond ? "" : "  → " + JSON.stringify(extra)));
};

// ---- заглушки ----

function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      const row = store.get(key);
      if (!row) return null;
      if (row.expires && row.expires < Date.now()) { store.delete(key); return null; }
      return row.value;
    },
    async put(key, value, opts) {
      store.set(key, {
        value,
        expires: opts && opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0,
      });
    },
    async delete(key) { store.delete(key); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

const ctx = { waitUntil: (p) => promises.push(p) };
let promises = [];
const settle = async () => { await Promise.all(promises); promises = []; };

let upstream = { calls: [], reply: null };
// Что Worker отправил в Telegram. Отдельно от вызовов таблицы: это разные
// адреса и разные тела, и путать их — значит не заметить, что бот промолчал.
let tg = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.telegram.org/")) {
    tg.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const body = JSON.parse(init.body);
  upstream.calls.push(body.endpoint);
  const reply = typeof upstream.reply === "function" ? upstream.reply(body) : upstream.reply;
  return new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
};

const env = { CACHE: makeKV(), UPSTREAM_URL: "https://example.invalid/exec", CACHE_ENABLED: "1" };

const call = async (endpoint, payload, token, extra) => {
  const res = await worker.fetch(new Request("https://api.invalid/", {
    method: "POST",
    body: JSON.stringify({ endpoint, token, payload, ...(extra || {}) }),
  }), env, ctx);
  const data = await res.json();
  await settle();
  return { data, cache: res.headers.get("X-Mifs-Cache") };
};

const listReply = (items) => ({ ok: true, data: items, error: null, status: 200 });

// ---- проверки ----

console.log("== чтение кэшируется, но только для подтверждённого токена ==");
upstream.reply = listReply([{ item_id: "010101" }]);
upstream.calls = [];

// Токен ещё никто не подтверждал: первый запрос обязан уйти в таблицу.
let r = await call("/equipment/list", { category: "all" }, "tok-1");
ok("первый запрос идёт в таблицу", upstream.calls.length === 1 && r.cache === "miss", r.cache);
ok("ответ вернулся целиком", r.data.data.length === 1, r.data);

r = await call("/equipment/list", { category: "all" }, "tok-1");
ok("второй — из кэша, без запроса", upstream.calls.length === 1 && r.cache === "hit", {
  calls: upstream.calls, cache: r.cache,
});

// Чужой токен кэш не видит: Apps Script его ещё не подтверждал.
upstream.reply = { ok: false, data: null, error: "Требуется вход", status: 401 };
r = await call("/equipment/list", { category: "all" }, "поддельный");
ok("неподтверждённый токен кэш не получает", upstream.calls.length === 2, upstream.calls);
ok("и получает отказ таблицы, а не данные", r.data.status === 401, r.data);
ok("после отказа токен не считается подтверждённым",
   (await env.CACHE.get("sess:поддельный")) === null);

console.log("\n== разные запросы не смешиваются ==");
upstream.reply = listReply([{ item_id: "030101" }]);
r = await call("/equipment/list", { category: "LGT" }, "tok-1");
ok("другой фильтр — свой кэш", r.cache === "miss" && r.data.data[0].item_id === "030101", r);
r = await call("/equipment/list", { category: "all" }, "tok-1");
ok("а прежний остался нетронутым", r.cache === "hit" && r.data.data[0].item_id === "010101", r);

console.log("\n== любая запись сбрасывает кэш ==");
const before = upstream.calls.length;
upstream.reply = { ok: true, data: { item_id: "010102" }, error: null, status: 200 };
await call("/item/create", { category: "CAM" }, "tok-1");
upstream.reply = listReply([{ item_id: "010101" }, { item_id: "010102" }]);
r = await call("/equipment/list", { category: "all" }, "tok-1");
ok("после создания предмета каталог перечитан",
   r.cache === "miss" && r.data.data.length === 2, r);
ok("выдача тоже сбрасывает", await (async () => {
  upstream.reply = { ok: true, data: {}, error: null, status: 200 };
  await call("/transaction/checkout", { item_id: "010101" }, "tok-1");
  upstream.reply = listReply([{ item_id: "010101", status: "Rented" }]);
  const after = await call("/equipment/list", { category: "all" }, "tok-1");
  return after.cache === "miss";
})());
ok("а неудачная запись — нет", await (async () => {
  upstream.reply = listReply([{ item_id: "010101", status: "Rented" }]);
  await call("/equipment/list", { category: "all" }, "tok-1");          // прогрели
  upstream.reply = { ok: false, data: null, error: "Предмет уже выдан", status: 409 };
  await call("/transaction/checkout", { item_id: "010101" }, "tok-1");  // отказ
  upstream.reply = listReply([{ item_id: "010101", status: "Rented" }]);
  const after = await call("/equipment/list", { category: "all" }, "tok-1");
  return after.cache === "hit";
})(), "отказ таблицы не должен выбрасывать прогретый кэш");

console.log("\n== личный ответ кэшируется каждому свой ==");
// В настройках есть «кто вы», поэтому общий кэш им не годится. Но и мимо
// кэша их пускать нельзя: это самый медленный экран. Ключ получает отпечаток
// токена — свой у каждого.
upstream.calls = [];
upstream.reply = { ok: true, data: { me: { full_name: "Мария" } }, error: null, status: 200 };
await call("/settings/get", {}, "tok-1");
let mine = await call("/settings/get", {}, "tok-1");
ok("своему — из кэша", mine.cache === "hit" && upstream.calls.length === 1, upstream.calls);

// Второй сотрудник входит со своим токеном: Worker обязан пойти в таблицу, а
// не показать ему ответ, собранный для первого.
await env.CACHE.put("sess:tok-2", "1");
upstream.reply = { ok: true, data: { me: { full_name: "Иван" } }, error: null, status: 200 };
const other = await call("/settings/get", {}, "tok-2");
ok("чужому — не из кэша", other.cache === "miss", other.cache);
ok("и ответ его собственный", other.data.data.me.full_name === "Иван", other.data.data);
mine = await call("/settings/get", {}, "tok-1");
ok("а первому по-прежнему отдаётся его ответ",
   mine.cache === "hit" && mine.data.data.me.full_name === "Мария", mine.data.data);

upstream.calls = [];
const stranger = await call("/settings/get", {}, "чужой-неподтверждённый");
ok("без подтверждённого токена кэша не видно",
   stranger.cache === "miss" && upstream.calls.length === 1, stranger.cache);

console.log("\n== вход и принудительное обновление ==");
upstream.reply = { ok: true, data: { token: "свежий", full_name: "Мария" }, error: null, status: 200 };
await call("/auth/login", { login: "maria", pin: "0000" }, null);
ok("токен из входа сразу считается подтверждённым",
   (await env.CACHE.get("sess:свежий")) === "1");

upstream.reply = listReply([{ item_id: "010101" }]);
await call("/equipment/list", { category: "all" }, "свежий");
r = await call("/equipment/list", { category: "all" }, "свежий");
ok("кэш работает под новым токеном", r.cache === "hit", r.cache);
r = await call("/equipment/list", { category: "all" }, "свежий", { fresh: true });
ok("«Обновить» проходит мимо кэша", r.cache === "bypass", r.cache);

console.log("\n== выключатель и поведение при отказе ==");
env.CACHE_ENABLED = "0";
upstream.calls = [];
await call("/equipment/list", { category: "all" }, "свежий");
r = await call("/equipment/list", { category: "all" }, "свежий");
ok("с выключенным кэшем запросы идут напрямую",
   upstream.calls.length === 2 && r.cache === "bypass", { calls: upstream.calls, cache: r.cache });
env.CACHE_ENABLED = "1";

const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("connect timeout"); };
r = await call("/equipment/list", { category: "all" }, "неизвестный");
ok("недоступная таблица объясняет причину, а не молчит",
   r.data.ok === false && /Нет связи с таблицей/.test(r.data.error), r.data);
globalThis.fetch = savedFetch;

console.log("\n== публичная ручка токен не подтверждает ==");
// Сайт отвечает ok на любой токен: таблица его там не проверяет. Иначе
// выдуманный токен, пройдя через каталог, получал бы кэш складских списков.
upstream.reply = listReply([{ item_id: "010101" }]);
await call("/equipment/list", { category: "all" }, "tok-1");          // прогрели
upstream.reply = { ok: true, data: { models: [] }, error: null, status: 200 };
await call("/public/catalog", { from: "2026-10-05", to: "2026-10-06" }, "выдумка");
await call("/public/announcements", { probe: "токен" }, "выдумка");
ok("после публичных ручек токен не подтверждён",
   (await env.CACHE.get("sess:выдумка")) === null);
upstream.calls = [];
upstream.reply = { ok: false, data: null, error: "Требуется вход", status: 401 };
r = await call("/equipment/list", { category: "all" }, "выдумка");
ok("и кэш склада ему не достаётся", r.data.status === 401 && upstream.calls.length === 1, r.data);

console.log("\n== список сотрудников — у каждого свой ==");
// Таблица отдаёт его только админу. Общий ключ раздал бы ответ админа
// складмену мимо проверки роли.
await env.CACHE.put("sess:admin-1", "1");
await env.CACHE.put("sess:sklad-1", "1");
upstream.reply = listReply([{ login: "boss", role: "Admin" }]);
await call("/staff/list", {}, "admin-1");
r = await call("/staff/list", {}, "admin-1");
ok("админу — из кэша", r.cache === "hit", r.cache);
upstream.reply = { ok: false, data: null, error: "Только для администратора", status: 403 };
r = await call("/staff/list", {}, "sklad-1");
ok("складмену — не из кэша админа, а отказ таблицы", r.cache === "miss" && r.data.status === 403, r);

console.log("\n== запись без ответа таблицы тоже сбрасывает кэш ==");
// Таблица могла записать и не успеть ответить: исход неизвестен.
upstream.reply = listReply([{ item_id: "010101", status: "Available" }]);
await call("/equipment/list", { category: "all" }, "tok-1");
r = await call("/equipment/list", { category: "all" }, "tok-1");
ok("прогрето", r.cache === "hit", r.cache);
const savedDown = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("connect reset"); };
r = await call("/transaction/checkout", { item_id: "010101" }, "tok-1");
globalThis.fetch = savedDown;
ok("запись получила 502", r.data.status === 502, r.data);
r = await call("/equipment/list", { category: "all" }, "tok-1");
ok("и после неё каталог перечитан", r.cache === "miss", r.cache);

console.log("\n== чтение, начатое до записи, не ложится в новое поколение ==");
// Пока таблица отвечает на чтение, кто-то выдаёт вещь. Старый ответ не должен
// стать «свежим» кэшем под новым поколением.
upstream.reply = (body) => {
  if (body.endpoint === "/equipment/list") {
    // Запись успевает пройти, пока таблица собирает ответ на чтение.
    env.CACHE.store.set("gen", { value: String(Number(env.CACHE.store.get("gen")?.value || 0) + 1), expires: 0 });
    return listReply([{ item_id: "010101", status: "Available" }]);
  }
  return { ok: true, data: {}, error: null, status: 200 };
};
await call("/equipment/list", { category: "race" }, "tok-1");
upstream.reply = listReply([{ item_id: "010101", status: "Rented" }]);
r = await call("/equipment/list", { category: "race" }, "tok-1");
ok("следующее чтение идёт в таблицу", r.cache === "miss" && r.data.data[0].status === "Rented", r);

console.log("== заявка с сайта: отказ на месте, без таблицы ==");
const goodOrder = (no) => [
  "Заказ №" + no,
  "1. GreenBean HDV Elite-756: 0 (2 x 0)",
  "",
  "Информация о покупателе:",
  "Are_you_an_adult: Да",
  "Full_name_minor: Петров Пётр Петрович",
  "Phone_minors: +7 999 000 11 22",
].join("\n");

const qKeys = () => [...env.CACHE.store.keys()].filter((k) => k.startsWith("q:"));
const deadKeys = () => [...env.CACHE.store.keys()].filter((k) => k.startsWith("dead:"));

upstream.calls = [];
upstream.reply = { ok: true, data: { order_id: 1 }, error: null, status: 200 };

r = await call("/public/order", { raw_text: "" });
ok("пустая заявка отклонена", r.data.ok === false && r.data.status === 400, r.data);
r = await call("/public/order", { raw_text: goodOrder("1").replace(/^Заказ.*\n/, "") });
ok("без номера отклонена", r.data.ok === false && /номера/.test(r.data.error), r.data);
r = await call("/public/order", { raw_text: goodOrder("2").replace(/^Full_name_minor.*\n/m, "") });
ok("без ФИО отклонена", r.data.ok === false && /ФИО/.test(r.data.error), r.data);
// Строка телефона в примере последняя, без перевода строки в конце.
r = await call("/public/order", { raw_text: goodOrder("3").replace(/^Phone_minors.*$/m, "") });
ok("без телефона отклонена", r.data.ok === false && /телефон/.test(r.data.error), r.data);
r = await call("/public/order", { raw_text: goodOrder("4"), trap: "я робот" });
ok("ловушка отсекает", r.data.ok === false, r.data);
ok("ни одна кривая заявка не ушла в таблицу", upstream.calls.length === 0, upstream.calls);
ok("и в очереди ничего не осталось", qKeys().length === 0, qKeys());

console.log("== годная заявка: ответ сразу, доставка потом ==");
upstream.calls = [];
r = await call("/public/order", { raw_text: goodOrder("260101-0001") });
ok("ответ успешный и с номером",
   r.data.ok === true && r.data.data.order_no === "260101-0001", r.data);
ok("заявка доставлена в таблицу", upstream.calls.includes("/public/order"), upstream.calls);
ok("из очереди убрана после успеха", qKeys().length === 0, qKeys());
{
  const genBefore = Number(await env.CACHE.get("gen")) || 0;
  await call("/public/order", { raw_text: goodOrder("260101-0011") });
  ok("доставленная заявка сбрасывает кэш (заказы, наличие)",
     (Number(await env.CACHE.get("gen")) || 0) > genBefore);
}

console.log("== повтор не плодит заявок ==");
// Ответ мгновенный, и кнопку жмут второй раз.
upstream.reply = (body) => ({ ok: false, data: null, error: "нет связи", status: 502 });
upstream.calls = [];
r = await call("/public/order", { raw_text: goodOrder("260101-0002") });
ok("первая принята", r.data.ok === true && r.data.data.repeat === false, r.data);
ok("осталась в очереди после отказа таблицы", qKeys().length === 1, qKeys());
const callsAfterFirst = upstream.calls.length;
r = await call("/public/order", { raw_text: goodOrder("260101-0002") });
ok("повтор отвечает тем же номером",
   r.data.ok === true && r.data.data.repeat === true &&
   r.data.data.order_no === "260101-0002", r.data);
ok("и второй записи в очереди нет", qKeys().length === 1, qKeys());
ok("повтор таблицу не трогает", upstream.calls.length === callsAfterFirst, upstream.calls);

console.log("== cron добирает застрявшее ==");
upstream.reply = { ok: true, data: { order_id: 2 }, error: null, status: 200 };
upstream.calls = [];
await worker.scheduled({}, env, ctx);
await settle();
ok("cron дослал заявку", upstream.calls.includes("/public/order"), upstream.calls);
ok("очередь опустела", qKeys().length === 0, qKeys());
ok("в ящик неудач ничего не легло", deadKeys().length === 0, deadKeys());

console.log("== отказ по существу не повторяем бесконечно ==");
upstream.reply = { ok: false, data: null, error: "Приём заявок с сайта выключен", status: 403 };
upstream.calls = [];
r = await call("/public/order", { raw_text: goodOrder("260101-0003") });
ok("студенту ответили успехом (заявка принята нами)", r.data.ok === true, r.data);
ok("из очереди убрана", qKeys().length === 0, qKeys());
ok("но видна в ящике неудач, а не потеряна", deadKeys().length === 1, deadKeys());

console.log("== 409 — не доставка, а конфликт номера ==");
// Таблица отвечает 409, только когда номер уже занят ДРУГИМ текстом. Считать
// это доставкой — значит молча выбросить заявку.
upstream.reply = { ok: false, data: null, error: "Заявка с таким номером уже есть", status: 409 };
upstream.calls = [];
r = await call("/public/order", { raw_text: goodOrder("260101-0005") });
ok("студенту ответили успехом", r.data.ok === true, r.data);
ok("409 не остался в очереди", qKeys().length === 0, qKeys());
ok("а лёг в ящик неудач", deadKeys().includes("dead:260101-0005"), deadKeys());
ok("и с причиной от таблицы",
   /уже есть/.test(JSON.parse(env.CACHE.store.get("dead:260101-0005").value).error),
   env.CACHE.store.get("dead:260101-0005"));

console.log("== тот же номер с другим текстом заменяет заявку в очереди ==");
// Вкладку не перезагрузили, номер остался прежним, а корзина другая.
let sentText = [];
upstream.reply = (body) => {
  sentText.push(body.payload && body.payload.raw_text);
  return { ok: false, data: null, error: "нет связи", status: 502 };
};
const textA = goodOrder("260101-0006");
const textB = textA.replace("GreenBean HDV Elite-756", "Aputure LS 300d");
r = await call("/public/order", { raw_text: textA });
ok("первая версия принята", r.data.ok === true && r.data.data.repeat === false, r.data);
const storedText = () => JSON.parse(env.CACHE.store.get("q:260101-0006").value).payload.raw_text;
ok("и лежит в очереди", storedText() === textA);
const triesQ = () => JSON.parse(env.CACHE.store.get("q:260101-0006").value).tries;
await worker.scheduled({}, env, ctx);
await settle();
ok("старая версия успела накопить попытки", triesQ() === 2, triesQ());

sentText = [];
r = await call("/public/order", { raw_text: textB });
ok("другой текст — не повтор", r.data.ok === true && r.data.data.repeat === false, r.data);
ok("в очереди одна запись", qKeys().length === 1, qKeys());
ok("и в ней новый текст", storedText() === textB, storedText());
// Счёт начат заново: ноль при записи и одна неудачная попытка сразу после.
ok("попытки обнулены", triesQ() === 1, triesQ());
ok("новую версию сразу пробовали доставить", sentText.length === 1 && sentText[0] === textB, sentText);

sentText = [];
r = await call("/public/order", { raw_text: textB });
ok("тот же текст ещё раз — повтор", r.data.data.repeat === true, r.data);
ok("и таблицу не трогает", sentText.length === 0, sentText);
ok("очередь не изменилась", storedText() === textB, storedText());

upstream.reply = (body) => {
  sentText.push(body.payload && body.payload.raw_text);
  return { ok: true, data: { order_id: 4 }, error: null, status: 200 };
};
sentText = [];
await worker.scheduled({}, env, ctx);
await settle();
ok("cron дослал именно новую версию", sentText.length === 1 && sentText[0] === textB, sentText);
ok("очередь опустела", qKeys().length === 0, qKeys());

// Испорченная запись в очереди — не повод отвечать «повтор» и терять заявку.
await env.CACHE.put("q:260101-0007", "не json");
upstream.reply = { ok: false, data: null, error: "нет связи", status: 502 };
r = await call("/public/order", { raw_text: goodOrder("260101-0007") });
ok("испорченная запись перезаписана", r.data.data.repeat === false &&
   JSON.parse(env.CACHE.store.get("q:260101-0007").value).payload.raw_text === goodOrder("260101-0007"),
   env.CACHE.store.get("q:260101-0007"));
upstream.reply = { ok: true, data: { order_id: 5 }, error: null, status: 200 };
await worker.scheduled({}, env, ctx);
await settle();
ok("и доставлена", qKeys().length === 0, qKeys());

console.log("== таблица ответила не JSON ==");
// Настоящий случай: Apps Script раз в несколько запросов отдаёт страницу
// ошибки Google вместо ответа.
const savedOk = globalThis.fetch;
globalThis.fetch = async () => new Response("<!DOCTYPE html><html>Page Not Found",
  { headers: { "Content-Type": "text/html" } });
r = await call("/public/order", { raw_text: goodOrder("260101-0004") });
ok("заявка всё равно принята", r.data.ok === true, r.data);
ok("и осталась в очереди, а не пропала", qKeys().length === 1, qKeys());
globalThis.fetch = savedOk;
upstream.reply = { ok: true, data: { order_id: 3 }, error: null, status: 200 };
await worker.scheduled({}, env, ctx);
await settle();
ok("cron её дослал", qKeys().length === 0, qKeys());

console.log("== наличие на даты кэшируется без токена ==");
upstream.reply = { ok: true, data: { models: [], orders_open: 1 }, error: null, status: 200 };
upstream.calls = [];
r = await call("/public/catalog", { from: "2026-10-01", to: "2026-10-02" });
ok("первый запрос идёт в таблицу", r.cache === "miss", r.cache);
r = await call("/public/catalog", { from: "2026-10-01", to: "2026-10-02" });
ok("второй — из кэша, хотя токена нет", r.cache === "hit" && upstream.calls.length === 1,
   { cache: r.cache, calls: upstream.calls });

console.log("== объявления для сайта: кэш без токена и сброс на записи ==");
upstream.reply = { ok: true, data: { items: [{ id: "a1", title: "График", lines: ["строка"] }] }, error: null, status: 200 };
upstream.calls = [];
r = await call("/public/announcements", {});
ok("первый запрос идёт в таблицу", r.cache === "miss", r.cache);
r = await call("/public/announcements", {});
ok("второй — из кэша, хотя токена нет", r.cache === "hit" && upstream.calls.length === 1,
   { cache: r.cache, calls: upstream.calls });
// Таблица отвечает по адресу: фоновая сборка спрашивает публичный список, а не запись.
let annItems = [];
upstream.reply = (b) => b.endpoint === "/public/announcements"
  ? { ok: true, data: { items: annItems }, error: null, status: 200 }
  : { ok: true, data: { announcement_id: "2", changed: true }, error: null, status: 200 };
await call("/announcement/remove", { announcement_id: "1" }, "tok-1");
r = await call("/public/announcements", {});
ok("после снятия объявления сайт видит новый список, а не снятое",
   r.data.data.items.length === 0, r.data);

console.log("== свежей копии нет — отдаём долгую сразу, свежую догоняем ==");
annItems = [{ id: "a5", title: "Новое", lines: ["x"] }];
await call("/announcement/save", { title: "Новое", text: "x" }, "tok-1");
r = await call("/public/announcements", {});
ok("после записи копия уже собрана в фоне", r.data.data.items[0].id === "a5", r.data);
for (const k of [...env.CACHE.store.keys()]) if (k.startsWith("c:")) env.CACHE.store.delete(k);
annItems = [{ id: "a6", title: "Позже", lines: ["x"] }];
upstream.calls = [];
r = await call("/public/announcements", {});
ok("ответ мгновенный из долгой копии (старый)", r.cache === "stale" && r.data.data.items[0].id === "a5",
   { cache: r.cache, d: r.data });
ok("а в фоне таблицу спросили", upstream.calls.includes("/public/announcements"), upstream.calls);
r = await call("/public/announcements", {});
ok("следующий ответ уже свежий", r.cache === "hit" && r.data.data.items[0].id === "a6", { c: r.cache, d: r.data });

console.log("== переименование и фото модели сбрасывают кэш каталога ==");
let catName = "Старое";
upstream.reply = (b) => b.endpoint === "/public/catalog"
  ? { ok: true, data: { models: [{ model_name: catName }], orders_open: 0 }, error: null, status: 200 }
  : { ok: true, data: { model_name: catName }, error: null, status: 200 };
await call("/public/catalog", { from: "2026-11-01", to: "2026-11-02" });
catName = "Новое";
await call("/models/rename", { category: "CAM", model_code: "01", model_name: "Новое" }, "tok-1");
// Долгая копия каталога привязана к поколению: после записи первый же
// посетитель получает новое имя, а не копию «до записи».
r = await call("/public/catalog", { from: "2026-11-01", to: "2026-11-02" });
ok("после /models/rename первый посетитель не получает ни свежую, ни долгую старую копию",
   r.cache !== "hit" && r.cache !== "stale", r.cache);
ok("и сразу видит новое имя", r.data.data.models[0].model_name === "Новое", r.data);
await call("/models/photo", { category: "CAM", model_code: "01", image: "" }, "tok-1");
r = await call("/public/catalog", { from: "2026-11-01", to: "2026-11-02" });
ok("после /models/photo каталог спрошен заново", r.cache !== "hit" && r.cache !== "stale", r.cache);
for (const [ep, pl] of [["/item/update", { item_id: "010101" }], ["/model/move", { category: "CAM" }],
                        ["/category/save", { category: "CAM" }]]) {
  catName = "До " + ep;
  await call("/public/catalog", { from: "2026-11-01", to: "2026-11-02" });
  catName = "После " + ep;
  await call(ep, pl, "tok-1");
  r = await call("/public/catalog", { from: "2026-11-01", to: "2026-11-02" });
  ok(ep + ": после записи нет старой копии", r.data.data.models[0].model_name === catName, r.data);
}

console.log("\n== нажатия, которые не должны выбрасывать кэш ==");
// Поиск чата, проверка связи и пачка этикеток ничего в складе не меняют.
// Раньше они считались записью, и одно нажатие «Найти чат склада» стоило
// складу всего прогретого кэша — то есть следующего ожидания в таблице.
upstream.reply = listReply([{ item_id: "010101" }]);
await call("/equipment/list", { category: "all" }, "tok-1");
for (const harmless of ["/notify/chats", "/notify/hello", "/notify/test",
                        "/notify/webhook", "/labels/send", "/order/parse"]) {
  upstream.reply = { ok: true, data: { message: "готово" }, error: null, status: 200 };
  await call(harmless, {}, "tok-1");
  upstream.reply = listReply([{ item_id: "010101" }]);
  const after = await call("/equipment/list", { category: "all" }, "tok-1");
  ok(harmless + " кэш не выбрасывает", after.cache === "hit", after.cache);
}

// А настоящая запись — выбрасывает, иначе склад показывал бы выданное свободным.
upstream.reply = { ok: true, data: { ok: true }, error: null, status: 200 };
await call("/item/numbers", { item_id: "010101", serial_number: "SN-1" }, "tok-1");
upstream.reply = listReply([{ item_id: "010101", serial_number: "SN-1" }]);
const afterWrite = await call("/equipment/list", { category: "all" }, "tok-1");
ok("а правка предмета — выбрасывает", afterWrite.cache === "miss", afterWrite.cache);

console.log("\n== вебхук Telegram ==");
// Опрос getUpdates отдавал события один раз и не дольше суток; пустой список
// выглядел как «бота нет в чате» при живом боте. Теперь Telegram присылает
// события сам, и Worker их помнит.
env.TELEGRAM_BOT_TOKEN = "123:ABC";
const secret = [...new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode("123:ABC")))]
  .slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");

const hook = async (update, opts) => {
  const o = opts || {};
  const res = await worker.fetch(new Request("https://api.invalid/tg/" +
    (o.path === undefined ? secret : o.path), {
    method: o.method || "POST",
    headers: o.header === null ? {}
      : { "X-Telegram-Bot-Api-Secret-Token": o.header === undefined ? secret : o.header },
    // GET с телом Request не принимает, а нам и не нужно: проверяется, что по
    // адресу вебхука отвечает только POST.
    body: (o.method || "POST") === "GET" ? undefined : JSON.stringify(update),
  }), env, ctx);
  await settle();
  return res;
};
const chatKeys = () => [...env.CACHE.store.keys()].filter((k) => k.startsWith("chat:"));

const groupMsg = (text) => ({
  message: {
    chat: { id: -1009876543210, title: "Тестовый чат склада", type: "supergroup" },
    date: 1790000000,
    text,
  },
});

let res = await hook(groupMsg("/id"));
ok("обновление принято", res.status === 200, res.status);
ok("чат запомнен", chatKeys().includes("chat:-1009876543210"), chatKeys());
ok("и бот ответил в тот же чат",
   tg.length === 1 && String(tg[0].body.chat_id) === "-1009876543210", tg);
ok("в ответе — номер чата, которого в Telegram не посмотреть",
   /-1009876543210/.test(tg[0].body.text), tg[0].body.text);

tg = [];
await hook(groupMsg("/id@mifs_rent_bot"));
ok("команда с именем бота тоже понята", tg.length === 1, tg);

tg = [];
await hook(groupMsg("а когда привезут штатив?"));
ok("на обычные сообщения бот не отвечает", tg.length === 0, tg);
ok("но чат всё равно помнит", chatKeys().length === 1, chatKeys());

tg = [];
await hook({
  my_chat_member: {
    chat: { id: -100111, title: "Ещё один чат", type: "group" },
    date: 1790000100,
    old_chat_member: { status: "left" },
    new_chat_member: { status: "member" },
  },
});
ok("добавление в группу — тоже повод поздороваться", tg.length === 1, tg);
ok("и второй чат запомнен", chatKeys().length === 2, chatKeys());

tg = [];
await hook({
  my_chat_member: {
    chat: { id: -100111, title: "Ещё один чат", type: "group" },
    date: 1790000200,
    old_chat_member: { status: "member" },
    new_chat_member: { status: "administrator" },
  },
});
ok("а выдача прав — не повод писать снова", tg.length === 0, tg);

// Адрес неугадываем, и заголовок сверяется тоже: иначе кто угодно мог бы
// присылать нам «обновления» и говорить в чат складa от имени бота.
ok("чужой адрес — 404", (await hook(groupMsg("/id"), { path: "0".repeat(32) })).status === 404);
ok("без заголовка — 404", (await hook(groupMsg("/id"), { header: null })).status === 404);
ok("с чужим заголовком — 404",
   (await hook(groupMsg("/id"), { header: "0".repeat(32) })).status === 404);
ok("GET по адресу вебхука — 404", (await hook(groupMsg("/id"), { method: "GET" })).status === 404);
env.TELEGRAM_BOT_TOKEN = "";
ok("без токена адреса не существует", (await hook(groupMsg("/id"))).status === 404);
env.TELEGRAM_BOT_TOKEN = "123:ABC";

// Испорченное тело не должно копить очередь повторов у Telegram.
const broken = await worker.fetch(new Request("https://api.invalid/tg/" + secret, {
  method: "POST",
  headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
  body: "не json",
}), env, ctx);
ok("нечитаемое обновление не просит повторить", broken.status === 200, broken.status);

console.log("\n== поиск чата берёт чаты у Worker ==");
// Таблица при включённом вебхуке отдаёт пустой список: getUpdates ей запрещён.
// Имя бота и права остаются за ней — их Worker не знает.
upstream.reply = {
  ok: true,
  data: { chats: [], current: "", bot: { username: "mifs_rent_bot" },
          command: "/id@mifs_rent_bot", webhook: true, hint: "Пока ни одного чата." },
  error: null, status: 200,
};
const found = await call("/notify/chats", {}, "tok-1");
ok("чаты подставлены из памяти Worker", found.data.data.chats.length === 2,
   found.data.data.chats);
ok("самый свежий сверху",
   String(found.data.data.chats[0].chat_id) === "-100111", found.data.data.chats);
ok("имя бота от таблицы сохранилось",
   found.data.data.bot.username === "mifs_rent_bot", found.data.data.bot);
ok("подсказка «пусто» убрана — чаты-то есть", !found.data.data.hint, found.data.data.hint);

// Тот же чат из двух источников — одна строка, а не две.
upstream.reply = {
  ok: true,
  data: { chats: [{ chat_id: "-100111", title: "Ещё один чат", type: "group",
                    at: "2020-01-01T00:00:00.000Z" }],
          current: "", bot: {}, command: "/id", hint: "" },
  error: null, status: 200,
};
const merged = await call("/notify/chats", {}, "tok-1");
ok("совпадающие чаты не дублируются", merged.data.data.chats.length === 2,
   merged.data.data.chats);

upstream.reply = listReply([{ item_id: "010101" }]);
const afterHook = await call("/equipment/list", { category: "all" }, "tok-1");
ok("вебхук прогретый кэш не выбросил", afterHook.cache === "hit", afterHook.cache);

console.log("\n== /id в теме форума ==");
// В форуме ответ без номера темы уходит в «Общее» — спросивший его не увидит.
const topicMsg = (text) => ({
  message: {
    chat: { id: -1009876543210, title: "Тестовый чат склада", type: "supergroup", is_forum: true },
    date: 1790000300,
    message_thread_id: 42,
    is_topic_message: true,
    text,
  },
});
tg = [];
await hook(topicMsg("/id"));
ok("ответ ушёл в ту же тему", tg.length === 1 && tg[0].body.message_thread_id === 42, tg);
ok("и в тексте номер темы", /Эта тема: 42/.test(tg[0].body.text), tg[0].body.text);
tg = [];
await hook(groupMsg("/id"));
ok("вне темы номер темы не передаётся",
   tg.length === 1 && !("message_thread_id" in tg[0].body), tg);
ok("и строки про тему нет", !/Эта тема/.test(tg[0].body.text), tg[0].body.text);
ok("о дефектах бот не пишет", !/дефект/i.test(tg[0].body.text), tg[0].body.text);
ok("а пишет о заявках с сайта и актах",
   /заявках с сайта/.test(tg[0].body.text) && /акт/.test(tg[0].body.text), tg[0].body.text);

console.log("\n== лишних записей в KV нет ==");
// На бесплатном тарифе записей около тысячи в сутки на всё.
const kvPuts = [];
const realPut = env.CACHE.put;
env.CACHE.put = async (key, value, opts) => { kvPuts.push(key); return realPut(key, value, opts); };
const putsOf = (prefix) => kvPuts.filter((k) => k.startsWith(prefix));

kvPuts.length = 0;
await hook(groupMsg("просто сообщение"));
await hook(groupMsg("ещё одно"));
ok("тот же чат повторно не переписывается", putsOf("chat:").length === 0, kvPuts);
await hook({ message: { chat: { id: -1009876543210, title: "Склад (новое имя)", type: "supergroup" },
                        date: 1790000400, text: "x" } });
ok("а переименованный — переписывается", putsOf("chat:").length === 1, kvPuts);
kvPuts.length = 0;
await hook({ message: { chat: { id: -1009876543210, title: "Склад (новое имя)", type: "supergroup" },
                        date: 1790000400 + 8 * 24 * 3600, text: "x" } });
ok("и запись старше недели — тоже, чтобы срок продлился", putsOf("chat:").length === 1, kvPuts);

kvPuts.length = 0;
await env.CACHE.delete("sess:tok-3");
upstream.reply = { ok: true, data: {}, error: null, status: 200 };
await call("/notify/hello", {}, "tok-3");
ok("новый токен запоминается", putsOf("sess:").length === 1, kvPuts);
await call("/notify/hello", {}, "tok-3");
await call("/item/create", { category: "CAM" }, "tok-3");
ok("уже известный не переписывается (запись)", putsOf("sess:").length === 1, kvPuts);
upstream.reply = listReply([{ item_id: "777777" }]);
await call("/equipment/list", { category: "sess-test" }, "tok-3");
ok("и на промахе кэша тоже", putsOf("sess:").length === 1, kvPuts);
upstream.reply = { ok: true, data: { token: "tok-4" }, error: null, status: 200 };
await call("/auth/login", { login: "x", pin: "0" }, null);
ok("вход по-прежнему запоминает новый токен", (await env.CACHE.get("sess:tok-4")) === "1");
env.CACHE.put = realPut;

console.log("\n== cron переживает испорченную запись ==");
for (const k of deadKeys()) env.CACHE.store.delete(k);
await env.CACHE.put("q:260101-0008", "{не json");
upstream.reply = { ok: false, data: null, error: "нет связи", status: 502 };
r = await call("/public/order", { raw_text: goodOrder("260101-0009") });
// Испорченная запись идёт в списке раньше годной.
upstream.reply = { ok: true, data: { order_id: 9 }, error: null, status: 200 };
upstream.calls = [];
let cronFailed = null;
try { await worker.scheduled({}, env, ctx); await settle(); } catch (err) { cronFailed = err; }
ok("cron не упал", cronFailed === null, String(cronFailed));
ok("годная заявка после испорченной доставлена",
   !env.CACHE.store.has("q:260101-0009") && upstream.calls.includes("/public/order"), qKeys());
ok("испорченная ушла из очереди", !env.CACHE.store.has("q:260101-0008"), qKeys());
const buried = env.CACHE.store.get("dead:260101-0008");
ok("и лежит в ящике неудач с причиной",
   buried && /испорчена/.test(JSON.parse(buried.value).error) &&
   JSON.parse(buried.value).raw === "{не json", buried);

console.log("\n== таблица молчит дольше срока ==");
const savedSlow = globalThis.fetch;
globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
});
env.UPSTREAM_TIMEOUT_MS = "50";
const t0 = Date.now();
r = await call("/equipment/list", { category: "all" }, "никто");
ok("ответ пришёл по сроку, а не завис", Date.now() - t0 < 2000, Date.now() - t0);
ok("в обычном конверте 502",
   r.data.ok === false && r.data.status === 502 && r.data.data === null &&
   /не ответила/.test(r.data.error), r.data);
ok("и помечен как ошибка", r.cache === "error", r.cache);
r = await call("/public/order", { raw_text: goodOrder("260101-0010") });
ok("заявка при молчании таблицы остаётся в очереди",
   r.data.ok === true && env.CACHE.store.has("q:260101-0010"), qKeys());
delete env.UPSTREAM_TIMEOUT_MS;
globalThis.fetch = savedSlow;

console.log("\n== /health ==");
for (const k of [...qKeys(), ...deadKeys()]) env.CACHE.store.delete(k);
await env.CACHE.put("q:1", JSON.stringify({ payload: {}, tries: 0, at: 1 }));
await env.CACHE.put("q:2", JSON.stringify({ payload: {}, tries: 0, at: 2 }));
await env.CACHE.put("dead:3", JSON.stringify({ error: "x", at: Date.UTC(2026, 8, 2) }));
await env.CACHE.put("dead:4", JSON.stringify({ error: "x", at: Date.UTC(2026, 8, 1) }));
const lists = [];
const realList = env.CACHE.list;
env.CACHE.list = async (o) => { lists.push(o.prefix); return realList(o); };
upstream.calls = [];
tg = [];
const hres = await worker.fetch(new Request("https://api.invalid/health"), env, ctx);
const h = await hres.json();
env.CACHE.list = realList;
ok("счёт очереди и ящика неудач", h.ok === true && h.queue === 2 && h.dead === 2, h);
ok("самая старая неудача", h.oldest_dead_at === "2026-09-01T00:00:00.000Z", h);
ok("две операции list, без таблицы и Telegram",
   lists.length === 2 && upstream.calls.length === 0 && tg.length === 0, { lists, calls: upstream.calls });
ok("с заголовками CORS", hres.headers.get("Access-Control-Allow-Origin") === "*");
for (const k of ["q:1", "q:2", "dead:3", "dead:4"]) env.CACHE.store.delete(k);
const hEmpty = await (await worker.fetch(new Request("https://api.invalid/health"), env, ctx)).json();
ok("пустой ящик — даты нет", hEmpty.queue === 0 && hEmpty.dead === 0 && hEmpty.oldest_dead_at === null, hEmpty);

console.log("\n== My rent: диалог в личном чате ==");
const myCats = [{ code: "CAM", label: "Камера" }, { code: "LGT", label: "Свет" }];
let myState = { submitted: null, decided: null, decideReply: null };
upstream.reply = (body) => {
  if (body.endpoint === "/public/my") return { ok: true, data: { categories: myCats, items: [] }, error: null, status: 200 };
  if (body.endpoint === "/myrent/submit") {
    myState.submitted = body.payload;
    return myState.submitFail ? { ok: false, data: null, error: "сбой", status: 502 }
      : { ok: true, data: { id: "S-0001", status: "approved" }, error: null, status: 200 };
  }
  if (body.endpoint === "/myrent/takedown") {
    myState.takedown = body.payload;
    return myState.takedownReply || { ok: true, data: { id: body.payload.id, status: "removed", repeat: false }, error: null, status: 200 };
  }
  if (body.endpoint === "/myrent/decide") {
    myState.decided = body.payload;
    return myState.decideReply || { ok: true, data: { id: body.payload.id, status: "approved", repeat: false }, error: null, status: 200 };
  }
  return listReply([]);
};
upstream.calls = [];
tg = [];

const student = { id: 777, username: "ivan_s", first_name: "Иван" };
const priv = (extra) => ({ message: { chat: { id: 777, type: "private" }, from: student, date: 1790001000, ...extra } });
const press = (data, extra) => ({ callback_query: { id: "cb1", from: student, data,
  message: { message_id: 5, chat: { id: 777, type: "private" } }, ...(extra || {}) } });
const lastTg = (m) => [...tg].reverse().find((x) => x.method === m);
const dlg = () => env.CACHE.store.get("dlg:777") && JSON.parse(env.CACHE.store.get("dlg:777").value);

await hook(priv({ text: "/start" }));
ok("приветствие с кнопкой «My rent»",
   tg.length === 1 && tg[0].body.reply_markup.keyboard[0][0].text === "My rent", tg);
ok("личный чат студента не попал в список чатов склада", !chatKeys().includes("chat:777"), chatKeys());

tg = [];
await hook(priv({ text: "My rent" }));
// Кнопки по две в ряд: семнадцать столбиком уходят за экран телефона.
ok("кнопки категорий берутся из /public/my",
   lastTg("sendMessage").body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).join() === "myc:CAM,myc:LGT", tg);
ok("шаг — категория", dlg().step === "category", dlg());

await hook(press("myc:LGT"));
ok("ответ на нажатие дан всегда", tg.some((x) => x.method === "answerCallbackQuery"), tg);
ok("после категории — название", dlg().step === "title" && dlg().category === "LGT", dlg());

tg = [];
await hook(priv({ text: "x".repeat(81) }));
ok("длинное название — подсказка, шаг прежний", dlg().step === "title" && tg.length === 1, dlg());
await hook(priv({ text: "Aputure <300d>" }));
await hook(priv({ text: "-" }));
ok("описание «-» пропущено", dlg().step === "price" && dlg().description === "", dlg());

tg = [];
await hook(priv({ text: "много" }));
ok("плохая цена — подсказка, шаг прежний", dlg().step === "price" && tg.length === 1, dlg());
await hook(priv({ text: "-5" }));
await hook(priv({ text: "1500.5" }));
ok("отрицательная и дробная цены не приняты", dlg().step === "price", dlg());
await hook(priv({ text: "3000" }));
ok("цена принята", dlg().step === "photo" && dlg().price === 3000, dlg());

tg = [];
await hook(priv({ text: "вот фото" }));
ok("текст вместо фото — подсказка", dlg().step === "photo", dlg());
await hook(priv({ photo: [{ file_id: "small", file_size: 10 }, { file_id: "big", file_size: 900 }] }));
ok("взят самый большой размер", dlg().photo_file_id === "big" && dlg().step === "preview", dlg());
const pv = lastTg("sendPhoto");
ok("предпросмотр — фото с подписью как на сайте",
   pv && pv.body.photo === "big" && pv.body.parse_mode === "HTML" &&
   /<b>Aputure &lt;300d&gt;<\/b>/.test(pv.body.caption) && /3 000 ₽\/сутки/.test(pv.body.caption) &&
   /@ivan_s/.test(pv.body.caption) && /Свет/.test(pv.body.caption), pv);
ok("под карточкой три кнопки",
   pv.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).join() === "mys:send,mys:again,mys:cancel", pv);
ok("главная кнопка — «Опубликовать», модерации нет",
   pv.body.reply_markup.inline_keyboard[0][0].text === "Опубликовать" &&
   !/модерац/i.test(JSON.stringify(tg)), pv);

// Сбой таблицы: состояние остаётся, можно нажать ещё раз.
myState.submitFail = true;
tg = [];
await hook(press("mys:send"));
ok("при сбое состояние сохранено", dlg() && dlg().step === "preview", dlg());
ok("студенту сказано нажать позже", /ещё раз/.test(lastTg("sendMessage").body.text), tg);
myState.submitFail = false;
tg = []; upstream.calls = [];
await hook(press("mys:send"));
ok("submit ушёл с ключом бота и полями",
   myState.submitted && myState.submitted.bot_key === secret && myState.submitted.tg_id === 777 &&
   myState.submitted.tg_username === "ivan_s" && myState.submitted.category === "LGT" &&
   myState.submitted.price === 3000 && myState.submitted.photo_file_id === "big" &&
   myState.submitted.title === "Aputure <300d>", myState.submitted);
ok("после успеха состояние стёрто", dlg() === null || dlg() === undefined, dlg());
ok("сказано, что опубликовано, и про 15 октября",
   /Опубликовано в разделе My rent/.test(lastTg("sendMessage").body.text) &&
   /15 октября/.test(lastTg("sendMessage").body.text) && !/модерац/.test(lastTg("sendMessage").body.text), tg);
ok("публикация сразу сбрасывает /public/my", upstream.calls.includes("/public/my"), upstream.calls);

console.log("\n== My rent: «Договорная», отмена, без ника ==");
await hook(priv({ text: "/myrent" }));
await hook(press("myc:CAM"));
await hook(priv({ text: "Sony FX3" }));
await hook(priv({ text: "Body" }));
await hook(press("myp:neg"));
ok("«Договорная» — цена пустая", dlg().step === "photo" && dlg().price === null, dlg());
await hook(priv({ document: { file_id: "doc1", mime_type: "image/png" } }));
ok("документ-картинка принят", dlg().step === "preview" && dlg().photo_kind === "document", dlg());
ok("в карточке «Договорная»", /Договорная/.test(lastTg("sendDocument").body.caption), tg);
await hook(press("mys:again"));
ok("«Заново» — снова категория", dlg().step === "category", dlg());
tg = [];
await hook(priv({ text: "/cancel" }));
ok("/cancel стирает диалог", !dlg(), dlg());
ok("и отвечает", tg.length === 1 && /Отменено/.test(tg[0].body.text), tg);

// Кнопка из чужого чата диалог не двигает.
await hook(priv({ text: "/myrent" }));
tg = [];
await hook(press("myc:CAM", { message: { message_id: 6, chat: { id: -100500, type: "supergroup" } } }));
ok("кнопка диалога из группы только отвечена", dlg().step === "category" && tg.length === 1 &&
   tg[0].method === "answerCallbackQuery", tg);
await hook(priv({ text: "/cancel" }));

const noNick = { id: 888, first_name: "Без ника" };
tg = []; upstream.calls = [];
await hook({ message: { chat: { id: 888, type: "private" }, from: noNick, date: 1, text: "My rent" } });
ok("без ника — объяснение и никакого диалога",
   tg.length === 1 && /ник/.test(tg[0].body.text) && !env.CACHE.store.has("dlg:888"), tg);

console.log("\n== My rent: группы и /id как раньше ==");
tg = [];
await hook(groupMsg("/start"));
ok("в группе /start — прежнее приветствие с номером чата",
   tg.length === 1 && /-1009876543210/.test(tg[0].body.text) && !tg[0].body.reply_markup, tg);
tg = [];
await hook(priv({ text: "/id" }));
ok("/id в личном чате работает", tg.length === 1 && /Этот чат: 777/.test(tg[0].body.text), tg);

console.log("\n== My rent: модерация и /public/my ==");
upstream.calls = [];
// Категории для кнопок уже прогрели кэш — это тот же ключ, что у сайта.
ok("диалог прогрел общий кэш /public/my", [...env.CACHE.store.keys()].some((k) => k.includes(":/public/my:")));
for (const k of [...env.CACHE.store.keys()]) if (k.includes("/public/my")) env.CACHE.store.delete(k);
let pub = await call("/public/my", {}, "");
ok("/public/my — публичное чтение: первый промах", pub.cache === "miss", pub.cache);
pub = await call("/public/my", {}, "");
ok("второй — из кэша без токена", pub.cache === "hit", pub.cache);
ok("долгая копия лежит", [...env.CACHE.store.keys()].some((k) => k.startsWith("stale:/public/my:")));

upstream.calls = []; tg = [];
const mod = (data) => ({ callback_query: { id: "cb2", from: { id: 5, username: "sklad" }, data,
  message: { message_id: 9, chat: { id: -100500, type: "supergroup" } } } });
await hook(mod("myr:a:S-0001"));
ok("decide вызван с ключом, id, решением, кто и из какого чата",
   myState.decided && myState.decided.bot_key === secret && myState.decided.id === "S-0001" &&
   myState.decided.decision === "approve" && myState.decided.by === "@sklad" &&
   myState.decided.chat_id === -100500, myState.decided);
ok("на нажатие отвечено", tg.some((x) => x.method === "answerCallbackQuery" && /Одобрено/.test(x.body.text)), tg);
ok("старая кнопка не вызвала снятие", !myState.takedown, myState.takedown);
ok("кэш /public/my сброшен и собран заново",
   upstream.calls.includes("/myrent/decide") && upstream.calls.includes("/public/my"), upstream.calls);
upstream.calls = [];
pub = await call("/public/my", {}, "");
ok("следующее чтение — снова из кэша, но уже свежего", pub.cache === "hit" && upstream.calls.length === 0, { c: pub.cache, u: upstream.calls });

myState.decideReply = { ok: true, data: { id: "S-0001", status: "approved", repeat: true }, error: null, status: 200 };
upstream.calls = []; tg = [];
await hook(mod("myr:r:S-0001"));
ok("повторное решение — «уже», кэш не трогается",
   /Уже/.test(lastTg("answerCallbackQuery").body.text) && !upstream.calls.includes("/public/my"), { tg, c: upstream.calls });
myState.decideReply = { ok: false, data: null, error: "Чат не тот", status: 403 };
tg = [];
await hook(mod("myr:a:S-0001"));
ok("отказ таблицы показан модератору", /Чат не тот/.test(lastTg("answerCallbackQuery").body.text), tg);

// Кнопка «Снять» на информационной карточке в чате склада.
myState.decideReply = null;
upstream.calls = []; tg = [];
await hook(mod("myr:x:S-0005"));
ok("takedown вызван с ключом, id, кто и из какого чата",
   myState.takedown && myState.takedown.bot_key === secret && myState.takedown.id === "S-0005" &&
   myState.takedown.by === "@sklad" && myState.takedown.chat_id === -100500 &&
   !upstream.calls.includes("/myrent/decide"), myState.takedown);
ok("на нажатие отвечено, кэш /public/my сброшен",
   /Снято/.test(lastTg("answerCallbackQuery").body.text) && upstream.calls.includes("/public/my"), { tg, c: upstream.calls });
myState.takedownReply = { ok: true, data: { id: "S-0005", status: "removed", repeat: true }, error: null, status: 200 };
upstream.calls = []; tg = [];
await hook(mod("myr:x:S-0005"));
ok("повторное снятие — «уже», кэш не трогается",
   /Уже/.test(lastTg("answerCallbackQuery").body.text) && !upstream.calls.includes("/public/my"), { tg, c: upstream.calls });
myState.takedownReply = { ok: false, data: null, error: "Чат не тот", status: 403 };
tg = [];
await hook(mod("myr:x:S-0005"));
ok("отказ снятия показан в ответе на нажатие", /Чат не тот/.test(lastTg("answerCallbackQuery").body.text), tg);
myState.takedownReply = null;

console.log("\n== My rent: «Мои объявления», правка, снятие, возврат ==");
const mineItems = [
  { id: "S-0004", status: "approved", category: "LGT", category_label: "Свет", title: "Nanlite <60>", description: "Комплект", price: 1500, price_text: "", photo_file_id: "f4" },
  { id: "S-0003", status: "pending", category: "CAM", category_label: "Камера", title: "Sony", description: "", price: null, price_text: "Договорная", photo_file_id: "f3" },
  { id: "S-0002", status: "rejected", category: "CAM", category_label: "Камера", title: "Canon", description: "", price: 900, price_text: "", photo_file_id: "f2" },
  { id: "S-0001", status: "removed", category: "AUD", category_label: "Звук", title: "Rode", description: "", price: 300, price_text: "", photo_file_id: "f1", removed_by: "author" },
  { id: "S-0005", status: "removed", removed_by: "admin", category: "AUD", category_label: "Звук", title: "Zoom", description: "", price: 200, price_text: "", photo_file_id: "f5" },
];
const prevReply = upstream.reply;
const my2 = { items: [], updated: null, removed: null, restored: null, restoreStatus: "approved", updateReply: null };
upstream.reply = (body) => {
  if (body.endpoint === "/myrent/mine") return { ok: true, data: { items: my2.items }, error: null, status: 200 };
  if (body.endpoint === "/myrent/update") {
    my2.updated = body.payload;
    return my2.updateReply || { ok: true, data: { id: body.payload.id, status: "approved" }, error: null, status: 200 };
  }
  if (body.endpoint === "/myrent/remove") {
    my2.removed = body.payload;
    return { ok: true, data: { id: body.payload.id, status: "removed", repeat: false }, error: null, status: 200 };
  }
  if (body.endpoint === "/myrent/restore") {
    my2.restored = body.payload;
    if (my2.restoreFail) return { ok: false, data: null, error: my2.restoreFail, status: 403 };
    return { ok: true, data: { id: body.payload.id, status: my2.restoreStatus, repeat: false }, error: null, status: 200 };
  }
  return prevReply(body);
};
const btns = (m) => m.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).join();
const cards = () => tg.filter((x) => x.method === "sendPhoto");

tg = [];
await hook(priv({ text: "Мои объявления" }));
ok("пустой список — подсказка нажать «My rent»",
   tg.length === 1 && /ажмите «My rent»/.test(tg[0].body.text), tg);

my2.items = mineItems;
tg = []; upstream.calls = [];
await hook(priv({ text: "/my" }));
const cs = cards();
ok("по сообщению на объявление, mine ушёл", cs.length === 5 && upstream.calls.includes("/myrent/mine"), tg);
ok("на сайте: Редактировать и Снять", btns(cs[0]) === "mye:S-0004,myx:S-0004", cs[0]);
ok("на модерации: Редактировать и Снять", btns(cs[1]) === "mye:S-0003,myx:S-0003", cs[1]);
ok("отклонено: Редактировать и Снять", btns(cs[2]) === "mye:S-0002,myx:S-0002", cs[2]);
ok("снято: только Выставить снова", btns(cs[3]) === "myo:S-0001", cs[3]);
ok("снято администратором: кнопок нет, статус так и назван",
   cs[4].body.reply_markup.inline_keyboard.length === 0 && /Статус: снято администратором/.test(cs[4].body.caption), cs[4]);
ok("в подписи статус и экранированный текст",
   /Статус: на сайте/.test(cs[0].body.caption) && /Nanlite &lt;60&gt;/.test(cs[0].body.caption) &&
   /Статус: снято/.test(cs[3].body.caption) && cs[0].body.photo === "f4", cs[0]);

// Правка названия и цены.
tg = [];
await hook(press("mye:S-0004"));
ok("правка: диалог в режиме edit, на нажатие отвечено",
   dlg().mode === "edit" && dlg().id === "S-0004" && dlg().step === "menu" &&
   tg.some((x) => x.method === "answerCallbackQuery"), dlg());
ok("меню полей с «Готово»", /myf:category/.test(btns(lastTg("sendPhoto"))) && /myf:done/.test(btns(lastTg("sendPhoto"))), tg);
await hook(press("myf:title"));
ok("спросили название", dlg().step === "title", dlg());
tg = [];
await hook(priv({ text: "x".repeat(81) }));
ok("проверка названия та же, что при создании", dlg().step === "title" && tg.length === 1, tg);
await hook(priv({ text: "Nanlite 60 новый" }));
ok("после названия — снова меню, правка в changes",
   dlg().step === "menu" && dlg().changes.title === "Nanlite 60 новый", dlg());
await hook(press("myf:price"));
await hook(priv({ text: "много" }));
ok("цена проверяется как при создании", dlg().step === "price", dlg());
await hook(priv({ text: "2500" }));
ok("цена принята, меню", dlg().step === "menu" && dlg().changes.price === 2500, dlg());
tg = [];
await hook(press("myf:done"));
ok("«Готово» — предпросмотр без слов о модерации, кнопка «Сохранить»",
   dlg().step === "preview" && !/модерац/.test(tg.find((x) => x.method === "sendMessage").body.text) &&
   lastTg("sendPhoto").body.reply_markup.inline_keyboard[0][0].text === "Сохранить", tg);
ok("в предпросмотре новые значения",
   /Nanlite 60 новый/.test(lastTg("sendPhoto").body.caption) && /2 500/.test(lastTg("sendPhoto").body.caption), tg);
upstream.calls = []; tg = [];
await hook(press("mys:send"));
ok("update ушёл только с изменёнными полями",
   my2.updated && my2.updated.bot_key === secret && my2.updated.tg_id === 777 && my2.updated.id === "S-0004" &&
   my2.updated.tg_username === "ivan_s" &&
   JSON.stringify(my2.updated.changes) === JSON.stringify({ title: "Nanlite 60 новый", price: 2500 }), my2.updated);
ok("после правки диалог стёрт, кэш /public/my сброшен",
   !dlg() && upstream.calls.includes("/public/my"), { d: dlg(), c: upstream.calls });
ok("сказано, что сохранено, без модерации",
   /Сохранено/.test(lastTg("sendMessage").body.text) && !/модерац/.test(lastTg("sendMessage").body.text), tg);

// Правка фото.
await hook(press("mye:S-0003"));
await hook(press("myf:photo"));
await hook(priv({ text: "не фото" }));
ok("вместо фото текст — шаг прежний", dlg().step === "photo", dlg());
await hook(priv({ photo: [{ file_id: "newph", file_size: 5 }] }));
ok("фото принято, меню", dlg().step === "menu" && dlg().changes.photo_file_id === "newph", dlg());
await hook(press("myf:done"));
my2.updated = null;
await hook(press("mys:send"));
ok("update только с фото", my2.updated && JSON.stringify(my2.updated.changes) === JSON.stringify({ photo_file_id: "newph" }), my2.updated);

// Категория в правке.
await hook(press("mye:S-0003"));
await hook(press("myf:category"));
await hook(press("myc:LGT"));
ok("категория в правке — тот же шаг, затем меню",
   dlg().step === "menu" && dlg().changes.category === "LGT" && dlg().mode === "edit", dlg());
await hook(priv({ text: "/cancel" }));

// Ничего не менялось.
await hook(press("mye:S-0002"));
await hook(press("myf:title"));
await hook(priv({ text: "Canon" }));
my2.updated = null; tg = [];
await hook(press("myf:done"));
ok("«Готово» без изменений — сказано, update не вызван, диалог жив",
   my2.updated === null && dlg().step === "menu" &&
   tg.some((x) => x.method === "sendMessage" && /ничего не изменили/.test(x.body.text)), tg);
ok("и на нажатие отвечено", tg.some((x) => x.method === "answerCallbackQuery" && /Ничего не изменилось/.test(x.body.text)), tg);
await hook(press("mys:cancel"));
ok("«Отмена» стирает правку", !dlg(), dlg());

// Снятие.
tg = []; upstream.calls = [];
await hook(press("myx:S-0004"));
ok("снятие: сначала вопрос, таблица не тронута",
   btns(lastTg("sendMessage")) === "myy:S-0004,myn:S-0004" && !my2.removed, tg);
await hook(press("myn:S-0004"));
ok("«Нет» — ничего не снято", !my2.removed, my2.removed);
tg = [];
await hook(press("myy:S-0004"));
ok("«Да, снять» — remove вызван, кэш сброшен",
   my2.removed && my2.removed.id === "S-0004" && my2.removed.tg_id === 777 &&
   my2.removed.bot_key === secret && upstream.calls.includes("/public/my"), { r: my2.removed, c: upstream.calls });
ok("на нажатие отвечено", tg.some((x) => x.method === "answerCallbackQuery"), tg);

// Возврат.
tg = []; upstream.calls = [];
await hook(press("myo:S-0001"));
ok("restore вызван сразу, кэш сброшен",
   my2.restored && my2.restored.id === "S-0001" && my2.restored.tg_id === 777 && upstream.calls.includes("/public/my"), my2.restored);
ok("сказано, что объявление на сайте", /на сайте/.test(lastTg("sendMessage").body.text), tg);

// Таблица отказала (снято администратором) — студент видит её текст.
my2.restoreFail = "Объявление снято администратором";
my2.restored = null; tg = []; upstream.calls = [];
await hook(press("myo:S-0005"));
ok("отказ возврата показан текстом таблицы и в ответе на нажатие",
   /снято администратором/.test(lastTg("answerCallbackQuery").body.text) &&
   /снято администратором/.test(lastTg("sendMessage").body.text) && !upstream.calls.includes("/public/my"), tg);
my2.restoreFail = null;

// Правка снятого администратором не начинается.
tg = [];
await hook(press("mye:S-0005"));
ok("правка снятого администратором не открывается", !dlg() && /администратором/.test(lastTg("answerCallbackQuery").body.text), tg);

// Админ из приложения: любая запись /myrent/admin/* обновляет копию /public/my.
console.log("\n== My rent: запись админа из приложения ==");
const prevReply2 = upstream.reply;
let pubItems = [{ key: "S-0004" }];
upstream.reply = (b) => b.endpoint === "/public/my"
  ? { ok: true, data: { categories: myCats, items: pubItems }, error: null, status: 200 }
  : b.endpoint === "/myrent/admin/list"
    ? { ok: true, data: { items: [], categories: myCats }, error: null, status: 200 }
    : b.endpoint.startsWith("/myrent/admin/")
      ? { ok: true, data: { id: "S-0004", status: "removed" }, error: null, status: 200 }
      : prevReply2(b);
await call("/public/my", {}, "");
pubItems = [];
upstream.calls = [];
await call("/myrent/admin/remove", { id: "S-0004" }, "tok-1");
await settle();
let seen = await call("/public/my", {}, "");
ok("после снятия админом сайт видит новый список", seen.data.data.items.length === 0 && seen.cache === "hit", seen);
ok("долгая копия пересобрана", upstream.calls.includes("/public/my"), upstream.calls);
pubItems = [{ key: "S-0004" }];
await call("/myrent/admin/restore", { id: "S-0004" }, "tok-1");
await settle();
seen = await call("/public/my", {}, "");
ok("после возврата админом объявление снова в списке", seen.data.data.items.length === 1, seen);
upstream.calls = [];
await call("/myrent/admin/list", {}, "tok-1");
await call("/myrent/admin/list", {}, "tok-1");
ok("список для админа кэшируется и копию /public/my не трогает",
   upstream.calls.filter((c) => c === "/myrent/admin/list").length === 1 && !upstream.calls.includes("/public/my"), upstream.calls);
upstream.reply = prevReply2;

// Чужие нажатия.
my2.removed = null; my2.restored = null; my2.updated = null;
tg = []; upstream.calls = [];
const groupMsgCb = { message_id: 7, chat: { id: -100500, type: "supergroup" } };
for (const d of ["myy:S-0004", "myo:S-0001", "mye:S-0004", "myx:S-0004", "myf:done"]) {
  await hook(press(d, { message: groupMsgCb }));
}
ok("кнопки студента из группы только отвечены",
   tg.length === 5 && tg.every((x) => x.method === "answerCallbackQuery") && !upstream.calls.length, tg);
tg = [];
const anotherStudent = { id: 999, username: "petr" };
for (const d of ["myy:S-0004", "myo:S-0001", "mye:S-0004", "mys:send"]) {
  await hook(press(d, { from: anotherStudent }));
}
ok("чужая кнопка в чате другого студента только отвечена",
   tg.length === 4 && tg.every((x) => x.method === "answerCallbackQuery") &&
   !my2.removed && !my2.restored && !upstream.calls.length, tg);
ok("KV диалога не появилось", !env.CACHE.store.has("dlg:999"));
upstream.reply = prevReply;

console.log("\n" + (bad ? "❌ ПРОВАЛОВ: " + bad : "✅ Worker: проверки пройдены"));
process.exit(bad ? 1 : 0);
