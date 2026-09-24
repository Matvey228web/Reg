// Выкладка бэкенда в таблицу через Apps Script API — без ПК и без вставки руками.
//
// Порядок ровно тот же, что делался мышкой: положить содержимое проекта,
// создать версию, перевести СУЩЕСТВУЮЩЕЕ развёртывание на эту версию. Последнее
// важно: адрес /exec — это и есть идентификатор развёртывания, поэтому новое
// развёртывание сменило бы адрес, а приложение стучится в старый.
//
// Использование:
//   node apps-script/deploy.js show          — что сейчас в проекте (ничего не меняет)
//   node apps-script/deploy.js push [--yes]  — залить Code.gs, создать версию, обновить развёртывание
//   node apps-script/deploy.js verify        — спросить живой бэкенд, какие эндпоинты у него есть
//
// Доступ: файл с refresh-токеном, путь в GAS_TOKENS (по умолчанию ~/.gas-token.json).
// Как его получить — в DEPLOY.md. Токен в репозиторий не кладём никогда.
// Проект — GAS_SCRIPT_ID или значение по умолчанию ниже. Развёртывание берётся
// из js/config.js, чтобы не разойтись с тем, куда стучится приложение.

const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO = path.resolve(__dirname, "..");
const TOKENS = process.env.GAS_TOKENS ||
  path.join(process.env.HOME || "/root", ".gas-token.json");
// Script ID — не секрет: без токена он ничего не открывает. Держим здесь, чтобы
// выкладка была одной командой, а не квестом «найди идентификатор».
const DEFAULT_SCRIPT_ID = "1ZroQ0unRv6xw9R4t-xTrzhKBLQ-ymQGB4ayFI8YwVS28Cjy4H2niD2Bn";
const CLIENT_ID = "1072944905499-vm2v2i5dvn0a0d2o4ca36i1vge8cvbn0.apps.googleusercontent.com";
const CLIENT_SECRET = "v6V3fKV_zWU7iw1DrpO1rknX";

function scriptId() {
  return process.env.GAS_SCRIPT_ID || DEFAULT_SCRIPT_ID;
}

// Адрес веб-приложения хранится в одном месте — в конфиге фронтенда. Оттуда и
// берём идентификатор развёртывания, чтобы он не разошёлся с тем, куда
// приложение на самом деле стучится.
function deploymentId() {
  const conf = fs.readFileSync(path.join(REPO, "js/config.js"), "utf8");
  const m = conf.match(/macros\/s\/([^/]+)\//);
  if (!m) throw new Error("В js/config.js не нашёлся адрес /macros/s/<id>/exec");
  return m[1];
}

async function accessToken() {
  const t = JSON.parse(fs.readFileSync(TOKENS, "utf8"));
  // Access-токен живёт час; refresh — до отзыва. Обновляем всегда: проверять
  // expiry_date дороже, чем один запрос.
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: t.refresh_token, grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Не получен access_token: " + JSON.stringify(data));
  return data.access_token;
}

async function api(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Не JSON от API: " + text.slice(0, 200)); }
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}

const CONTENT = (id) => `https://script.googleapis.com/v1/projects/${id}/content`;

async function getContent(token) {
  return api(token, CONTENT(scriptId()));
}

async function show() {
  const token = await accessToken();
  const meta = await api(token, `https://script.googleapis.com/v1/projects/${scriptId()}`);
  console.log("проект:", meta.title, "| привязан к:", meta.parentId || "ничему (отдельный)");
  const content = await getContent(token);
  console.log("файлов:", content.files.length);
  content.files.forEach((f) => {
    console.log(`  ${f.name}.${f.type === "SERVER_JS" ? "gs" : f.type.toLowerCase()}` +
                ` — ${String(f.source || "").split("\n").length} строк`);
  });
  const deps = await api(token, `https://script.googleapis.com/v1/projects/${scriptId()}/deployments`);
  const mine = deploymentId();
  deps.deployments.forEach((d) => {
    const v = (d.deploymentConfig || {}).versionNumber;
    console.log(`  развёртывание ${d.deploymentId === mine ? "★ НАШЕ" : "      "} ` +
                `${d.deploymentId.slice(0, 16)}… версия ${v === undefined ? "HEAD" : v}`);
  });
  const found = deps.deployments.some((d) => d.deploymentId === mine);
  console.log(found ? "\n✅ развёртывание из config.js найдено в этом проекте"
                    : "\n❌ развёртывания из config.js в этом проекте НЕТ — значит это другой проект");
  return found;
}

// Показать, чем живой проект отличается от репозитория. Нужно перед каждой
// записью: в редакторе Apps Script правят руками, и один раз так уже
// случилось — в таблице оказалось «Мониторы и трансляция» вместо нашего
// «Мониторы и видеотракт». Выкладка без просмотра затёрла бы правку молча, и
// узнали бы об этом через месяц по чужому вопросу «а куда делось название».
function diffLines(remote, local) {
  const a = remote.split("\n"), b = local.split("\n");
  const setB = new Set(b), setA = new Set(a);
  const gone = a.filter((l) => l.trim() && !setB.has(l));
  const added = b.filter((l) => l.trim() && !setA.has(l));
  return { gone, added };
}

function reportDiff(remote, local) {
  const { gone, added } = diffLines(remote, local);
  if (!gone.length && !added.length) {
    console.log("живой код и репозиторий совпадают");
    return false;
  }
  console.log(`\nразличия: исчезнет строк ${gone.length}, появится ${added.length}`);
  const show = (list, mark) => list.slice(0, 12).forEach((l) => console.log("  " + mark + " " + l.trim().slice(0, 100)));
  if (gone.length) { console.log("\nисчезнет из таблицы (есть там, нет у нас):"); show(gone, "−"); }
  if (added.length) { console.log("\nпоявится в таблице (есть у нас, нет там):"); show(added, "+"); }
  if (gone.length > 12 || added.length > 12) console.log("  … показаны первые 12");
  return true;
}

async function push() {
  const token = await accessToken();
  const current = await getContent(token);

  // Заменяем только наш серверный файл, остальные оставляем как есть: в проекте
  // может лежать манифест appsscript.json и что-то ещё, чего у нас в репозитории
  // нет, а PUT content перезаписывает весь список целиком.
  const source = fs.readFileSync(path.join(REPO, "apps-script/Code.gs"), "utf8");
  const server = current.files.filter((f) => f.type === "SERVER_JS");
  if (server.length !== 1) {
    throw new Error("Ожидался ровно один .gs файл, а их " + server.length +
      ": " + server.map((f) => f.name).join(", ") + ". Останавливаюсь, чтобы не затереть чужое.");
  }
  const files = current.files.map((f) =>
    f.type === "SERVER_JS" ? { name: f.name, type: f.type, source } : f);

  const remote = String(server[0].source || "");
  // Забранную копию оставляем на диске: с ней можно сверяться и после выкладки,
  // и она же — единственный след того, что было в таблице до нас.
  const snapshot = path.join(os.tmpdir(), "remote-Code.gs");
  fs.writeFileSync(snapshot, remote);
  console.log("копия того, что было в таблице:", snapshot);
  const differs = reportDiff(remote, source);
  if (differs && !process.argv.includes("--yes")) {
    console.log("\nОстановился. Посмотрите различия выше: если строки в столбце «исчезнет»" +
      "\nправили руками в редакторе, их надо сначала перенести в репозиторий." +
      "\nКогда разобрались — повторите с --yes.");
    process.exit(2);
  }

  const before = remote.split("\n").length;
  console.log(`было ${before} строк → станет ${source.split("\n").length}`);

  await api(token, CONTENT(scriptId()), { method: "PUT", body: JSON.stringify({ files }) });
  console.log("содержимое залито");

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const version = await api(token, `https://script.googleapis.com/v1/projects/${scriptId()}/versions`,
    { method: "POST", body: JSON.stringify({ description: "Выложено из Claude Code " + stamp }) });
  console.log("создана версия", version.versionNumber);

  const dep = deploymentId();
  const updated = await api(token,
    `https://script.googleapis.com/v1/projects/${scriptId()}/deployments/${dep}`,
    { method: "PUT", body: JSON.stringify({ deploymentConfig: {
        scriptId: scriptId(), versionNumber: version.versionNumber,
        manifestFileName: "appsscript", description: "Склад Киноколледжа" } }) });
  const v = (updated.deploymentConfig || {}).versionNumber;
  console.log("развёртывание", dep.slice(0, 16) + "… переведено на версию", v);
  if (v !== version.versionNumber) throw new Error("Версия развёртывания не та, что создали");
  return version.versionNumber;
}

// Живой бэкенд отвечает через редирект на script.googleusercontent.com, и
// обычный fetch за ним не ходит с нужными заголовками — поэтому руками.
async function verify() {
  const conf = fs.readFileSync(path.join(REPO, "js/config.js"), "utf8");
  const url = conf.match(/(https:\/\/script\.google\.com[^"']+)/)[1];
  const probes = ["/item/numbers", "/model/move", "/labels/send", "/выдуманный"];
  for (const endpoint of probes) {
    const first = await fetch(url, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ endpoint, token: "проба", payload: {} }),
    });
    const location = first.headers.get("location");
    const res = await fetch(location, { headers: { "User-Agent": "Mozilla/5.0" } });
    const text = await res.text();
    let verdict = text.slice(0, 80);
    try {
      const data = JSON.parse(text);
      verdict = data.status + " " + data.error;
    } catch { /* пришёл не JSON — покажем как есть */ }
    console.log(`  ${endpoint.padEnd(16)} → ${verdict}`);
  }
}

const command = process.argv[2] || "show";
({ show, push, verify })[command]()
  .catch((err) => { console.error("ОШИБКА:", err.message); process.exit(1); });
