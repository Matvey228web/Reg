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

console.log("\n== что нельзя класть в общий кэш ==");
upstream.calls = [];
upstream.reply = { ok: true, data: { me: { full_name: "Мария" } }, error: null, status: 200 };
await call("/settings/get", {}, "tok-1");
await call("/settings/get", {}, "tok-1");
ok("настройки не кэшируются — в них есть «кто вы»", upstream.calls.length === 2, upstream.calls);

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

console.log("\n" + (bad ? "❌ ПРОВАЛОВ: " + bad : "✅ Worker: проверки пройдены"));
process.exit(bad ? 1 : 0);
