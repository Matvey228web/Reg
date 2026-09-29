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
globalThis.fetch = async (url, init) => {
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

console.log("\n== нажатия, которые не должны выбрасывать кэш ==");
// Поиск чата, проверка связи и пачка этикеток ничего в складе не меняют.
// Раньше они считались записью, и одно нажатие «Найти чат склада» стоило
// складу всего прогретого кэша — то есть следующего ожидания в таблице.
upstream.reply = listReply([{ item_id: "010101" }]);
await call("/equipment/list", { category: "all" }, "tok-1");
for (const harmless of ["/notify/chats", "/notify/test", "/labels/send", "/order/parse"]) {
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

console.log("\n" + (bad ? "❌ ПРОВАЛОВ: " + bad : "✅ Worker: проверки пройдены"));
process.exit(bad ? 1 : 0);
