// Снимок каталога для публичного сайта.
//
// Зачем файл, а не запрос из браузера: Apps Script отвечает 5–8 секунд, и
// витрина, которая столько думает, не витрина. Снимок лежит статикой рядом с
// сайтом, открывается мгновенно и переживает недоступность бэкенда.
//
// Наличие на даты снимком не берём — оно меняется каждый час. Его сайт
// спрашивает живым запросом, и только когда человек выбрал даты.
//
//   node site/build-catalog.js            — собрать site/catalog.json
//   node site/build-catalog.js --print    — показать, ничего не записывая
//
// Фото из колонки «Фото» таблицы Models (решение владельца, 6 октября 2026):
// ссылка https скачивается и приводится к 800x800 через site/photos.py
// (нужны python3 и Pillow). Качаем, только если файла ещё нет или ссылка в
// таблице сменилась с прошлой сборки. Моделям без ссылки ничего не меняется:
// источник — папка site/photos, и убранная из таблицы ссылка файл не удаляет.

const fs = require("fs");
const os = require("os");
const dns = require("dns").promises;
const net = require("net");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "catalog.json");

// Адрес Apps Script живёт в настройках Worker (UPSTREAM_URL): в app/js/config.js
// теперь адрес самого воркера. Идём в Apps Script напрямую, поэтому ask() ниже
// с ручным редиректом остаётся в силе. Это копия appsScriptUrl() из
// apps-script/deploy.js: подключать тот файл нельзя — он тянет за собой OAuth
// и сразу выполняет команду, а пять строк дешевле общей зависимости.
function backendUrl() {
  const place = "worker/wrangler.toml";
  const conf = fs.readFileSync(path.join(REPO, place), "utf8");
  const m = conf.match(/UPSTREAM_URL\s*=\s*"(https:\/\/script\.google\.com\/macros\/s\/[^"]+\/exec)"/);
  if (!m) throw new Error("В " + place + " не нашёлся UPSTREAM_URL с адресом Apps Script");
  return m[1];
}

// Apps Script отвечает редиректом на script.googleusercontent.com, и второй
// запрос надо сделать самому: автоматический не везде доходит.
async function ask(endpoint, payload) {
  const first = await fetch(backendUrl(), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ endpoint, payload }),
  });
  // Без перенаправления ответ уже в первом запросе. Повторить его по тому же
  // адресу нельзя: второй запрос — GET, и отвечает doGet, а не doPost.
  // Так же сделано в verify() в apps-script/deploy.js.
  const location = first.headers.get("location");
  const res = location
    ? await fetch(location, { headers: { "User-Agent": "Mozilla/5.0" } })
    : first;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error("Бэкенд ответил не JSON: " + text.slice(0, 120));
  }
  if (!data.ok) throw new Error(data.error || "Бэкенд отказал");
  return data.data;
}

// --- Фото по ссылке из таблицы ---

const PHOTO_TIMEOUT_MS = 30000;
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const PHOTO_MAX_REDIRECTS = 5;
// Только то, что умеет site/photos.py.
const PHOTO_EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };

const isHttps = (v) => {
  try { return new URL(String(v)).protocol === "https:"; } catch { return false; }
};

// Ссылка «поделиться» с Google Drive отдаёт страницу, а не картинку: берём
// прямую выдачу файла по тому же id.
function directUrl(url) {
  const u = new URL(url);
  if (u.hostname === "drive.google.com") {
    const id = (u.pathname.match(/\/file\/d\/([\w-]+)/) || [])[1] || u.searchParams.get("id");
    if (id) return "https://drive.google.com/uc?export=download&id=" + id;
  }
  return url;
}

function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateIp(mapped[1]);
    return low === "::" || low === "::1" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// Ссылку вводит человек в таблице, а скачивает его машина: во внутреннюю
// сеть и на localhost ходить нельзя. DNS проверяем сами — имя может вести на
// частный адрес. Цена: между проверкой и запросом имя могут подменить, для
// ручной сборки на ноутбуке это принимаем.
async function checkHost(host, allowLocal) {
  if (allowLocal) return;
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    throw new Error("адрес ведёт во внутреннюю сеть: " + host);
  }
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) {
    throw new Error("адрес ведёт во внутреннюю сеть: " + host);
  }
}

async function fetchImage(url, opts) {
  const signal = AbortSignal.timeout(PHOTO_TIMEOUT_MS);
  let cur = directUrl(url);
  for (let hop = 0; ; hop++) {
    const u = new URL(cur);
    if (u.protocol !== "https:" && !(opts.allowLocal && u.protocol === "http:")) {
      throw new Error("только https: " + cur);
    }
    await checkHost(u.hostname, opts.allowLocal);
    const res = await fetch(cur, { redirect: "manual", signal, headers: { "User-Agent": "Mozilla/5.0" } });
    const where = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && where) {
      if (hop >= PHOTO_MAX_REDIRECTS) throw new Error("больше " + PHOTO_MAX_REDIRECTS + " перенаправлений");
      cur = new URL(where, cur).href;
      continue;
    }
    if (!res.ok) throw new Error("ответ " + res.status);
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) throw new Error("это не картинка (" + (type || "тип не указан") + ")");
    if (!PHOTO_EXT[type]) throw new Error("формат " + type + " не поддерживается, нужен JPEG, PNG или WebP");
    if (Number(res.headers.get("content-length")) > PHOTO_MAX_BYTES) throw new Error("файл больше 8 МБ");
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > PHOTO_MAX_BYTES) throw new Error("файл больше 8 МБ");
      chunks.push(chunk);
    }
    return { buf: Buffer.concat(chunks), ext: PHOTO_EXT[type] };
  }
}

function needPillow() {
  const r = spawnSync("python3", ["-c", "import PIL"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error("Для фото из таблицы нужны python3 и Pillow. Поставьте: " +
      "python3 -m pip install Pillow (и python3, если его нет), затем повторите сборку.");
  }
}

// Один файл — один вызов photos.py: битая картинка не должна унести остальные.
async function downloadPhotos(todo, opts) {
  const done = new Set();
  if (!todo.length) return done;
  needPillow();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mifs-photos-"));
  try {
    for (const { key, url } of todo) {
      try {
        const { buf, ext } = await fetchImage(url, opts);
        const file = path.join(tmp, key + "." + ext);
        fs.writeFileSync(file, buf);
        const r = spawnSync("python3", [opts.photosPy, file], { encoding: "utf8" });
        if (r.status !== 0) throw new Error("photos.py: " + String(r.stderr || r.stdout).trim().split("\n").pop());
        if (!fs.existsSync(path.join(opts.photosDir, key + ".jpg"))) throw new Error("photos.py не создал файл");
        done.add(key);
        console.log("  фото " + key + ": скачано и приведено к 800x800");
      } catch (err) {
        console.error("  фото " + key + ": пропущено (" + err.message + "), прежний файл остаётся");
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return done;
}

async function build(live, opts) {
  // Пробелы и переносы внутри названия схлопываем: в таблице такие названия
  // есть, а строка заявки «N. Название: 0 (кол-во x 0)» разбирается построчно —
  // перенос разрывает её надвое, и позиция молча пропадает из заявки.
  const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
  // «Кабель BNC · 3 м» — вариант позиции «Кабель BNC»: на витрине одна
  // карточка с выбором длины. Отдельной колонки в таблице под это нет, поэтому
  // группа живёт в самом названии; модель и её ключ остаются своими, и
  // наличие, корзина и разбор заявки на складе ничего о группах не знают.
  const SEP = " · ";
  const models = (live.models || []).map((m) => {
    const name = clean(m.model_name);
    const out = {
      category: m.category,
      category_label: m.category_label,
      model_code: m.model_code,
      model_name: name,
      section: m.section || "",
      total: m.total,
    };
    if (isHttps(m.photo)) out.photo_src = String(m.photo).trim();
    const at = name.indexOf(SEP);
    if (at > 0 && at + SEP.length < name.length) {
      out.group = name.slice(0, at);
      out.variant = name.slice(at + SEP.length);
    }
    return out;
  });

  const categories = [];
  const seen = new Set();
  models.forEach((m) => {
    if (seen.has(m.category)) return;
    seen.add(m.category);
    categories.push({ code: m.category, label: m.category_label });
  });
  categories.sort((a, b) => a.label.localeCompare(b.label, "ru"));

  const photosDir = opts.photosDir;

  // Ссылки из таблицы: качаем только новое или изменившееся с прошлой сборки.
  let prev = {};
  try {
    JSON.parse(fs.readFileSync(opts.out, "utf8")).models.forEach((m) => {
      prev[m.category + "-" + m.model_code] = { src: m.photo_src, v: m.photo_v };
    });
  } catch { /* первой сборки или битого снимка достаточно, чтобы качать всё */ }
  const keyOf = (m) => m.category + "-" + m.model_code;
  const todo = models.filter((m) => m.photo_src).filter((m) => {
    const k = keyOf(m);
    return !fs.existsSync(path.join(photosDir, k + ".jpg")) || (prev[k] || {}).src !== m.photo_src;
  }).map((m) => ({ key: keyOf(m), url: m.photo_src }));
  let done = new Set();
  if (opts.print) {
    if (todo.length) console.log(`к скачиванию было бы: ${todo.length} (--print ничего не качает)`);
  } else {
    done = await downloadPhotos(todo, opts);
    const failed = new Set(todo.filter((t) => !done.has(t.key)).map((t) => t.key));
    models.forEach((m) => {
      const k = keyOf(m);
      if (!failed.has(k)) return;
      // Не вышло — остаётся прежнее состояние, чтобы следующая сборка попробовала снова.
      const was = prev[k] || {};
      if (was.src) { m.photo_src = was.src; if (was.v) m.photo_v = was.v; } else delete m.photo_src;
    });
  }
  // Версия снимка — по его содержимому, а не по ссылке: /photos/* кэшируется на
  // 7 дней под одним именем, и заменённый снимок (из таблицы или файлом в
  // папке) иначе неделю показывался бы старым — так и вышло 6 октября 2026,
  // когда телефон владельца держал фото прежней выкладки.
  models.forEach((m) => {
    const file = path.join(photosDir, keyOf(m) + ".jpg");
    if (fs.existsSync(file)) {
      m.photo_v = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
    } else {
      delete m.photo_v;
    }
  });

  // Какие фотографии есть на самом деле. Без этого списка витрина просила у
  // сервера картинку на каждую позицию и получала 404: восемьдесят пять
  // напрасных запросов в коридоре с плохим интернетом. Теперь <img> ставится
  // только там, где файл действительно лежит.
  const photos = fs.existsSync(photosDir)
    ? fs.readdirSync(photosDir)
        .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .map((f) => f.replace(/\.[^.]+$/, ""))
        .sort()
    : [];

  const snapshot = {
    built_at: new Date().toISOString(),
    categories,
    models,
    photos,
  };

  const json = JSON.stringify(snapshot);
  if (opts.print) {
    console.log(`моделей ${models.length}, категорий ${categories.length}, ` +
                `фотографий ${photos.length}, ` +
                `${(json.length / 1024).toFixed(1)} КБ`);
    console.log(JSON.stringify(models.slice(0, 5), null, 1));
    return;
  }
  fs.writeFileSync(opts.out, json);
  console.log(`снимок собран: моделей ${models.length}, категорий ` +
              `${categories.length}, фотографий ${photos.length}, ` +
              `${(json.length / 1024).toFixed(1)} КБ`);
  return snapshot;
}

module.exports = { build, fetchImage, privateIp, directUrl };

if (require.main === module) {
  (async () => {
    const live = await ask("/public/catalog", {});
    await build(live, {
      print: process.argv.includes("--print"),
      out: OUT,
      photosDir: path.join(__dirname, "photos"),
      photosPy: path.join(__dirname, "photos.py"),
    });
  })().catch((err) => { console.error("ОШИБКА:", err.message); process.exit(1); });
}
