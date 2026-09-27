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

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "catalog.json");

function backendUrl() {
  const conf = fs.readFileSync(path.join(REPO, "app/js/config.js"), "utf8");
  const m = conf.match(/(https:\/\/script\.google\.com[^"']+)/);
  if (!m) throw new Error("В app/js/config.js не нашёлся адрес бэкенда");
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
  const location = first.headers.get("location");
  const res = await fetch(location || backendUrl(), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error("Бэкенд ответил не JSON: " + text.slice(0, 120));
  }
  if (!data.ok) throw new Error(data.error || "Бэкенд отказал");
  return data.data;
}

(async () => {
  const live = await ask("/public/catalog", {});
  const models = (live.models || []).map((m) => ({
    category: m.category,
    category_label: m.category_label,
    model_code: m.model_code,
    model_name: m.model_name,
    total: m.total,
  }));

  const categories = [];
  const seen = new Set();
  models.forEach((m) => {
    if (seen.has(m.category)) return;
    seen.add(m.category);
    categories.push({ code: m.category, label: m.category_label });
  });
  categories.sort((a, b) => a.label.localeCompare(b.label, "ru"));

  const snapshot = {
    built_at: new Date().toISOString(),
    categories,
    models,
  };

  const json = JSON.stringify(snapshot);
  if (process.argv.includes("--print")) {
    console.log(`моделей ${models.length}, категорий ${categories.length}, ` +
                `${(json.length / 1024).toFixed(1)} КБ`);
    console.log(JSON.stringify(models.slice(0, 5), null, 1));
    return;
  }
  fs.writeFileSync(OUT, json);
  console.log(`снимок собран: моделей ${models.length}, категорий ` +
              `${categories.length}, ${(json.length / 1024).toFixed(1)} КБ`);
})().catch((err) => { console.error("ОШИБКА:", err.message); process.exit(1); });
