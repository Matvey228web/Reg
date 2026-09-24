// Общий кэш списков в localStorage: бэкенд отвечает 5–8 секунд, и без кэша
// каждое переключение вкладки стоило бы этого ожидания.
//
// Показываем то, что есть; на сервер идём, только когда кэша нет, он старше
// FRESH_MS или нажали «Обновить».
//
// Возраст данных экраны обязаны показывать: по двадцатиминутному «Доступно»
// человек пойдёт за техникой, которую уже выдали.

const Cache = (() => {
  const PREFIX = "mifs_cache_";
  const FRESH_MS = 5 * 60 * 1000;   // сколько считаем данные свежими

  function key(name) { return PREFIX + name; }

  function get(name) {
    try {
      const raw = localStorage.getItem(key(name));
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || !Array.isArray(parsed.items)) return null;
      return parsed;
    } catch {
      return null;   // побитый или недоступный кэш — как будто его нет
    }
  }

  function items(name) {
    const entry = get(name);
    return entry ? entry.items : null;
  }

  function set(name, list) {
    try {
      localStorage.setItem(key(name), JSON.stringify({ items: list, saved_at: Date.now() }));
    } catch {
      // переполнение хранилища не должно ломать экран
    }
  }

  function age(name) {
    const entry = get(name);
    return entry ? Date.now() - entry.saved_at : null;
  }

  function isFresh(name) {
    const ms = age(name);
    return ms !== null && ms < FRESH_MS;
  }

  // Точечная правка: после своей же выдачи или приёма незачем перезапрашивать
  // весь список — достаточно поправить одну запись.
  function patch(name, idField, idValue, patchObject) {
    const entry = get(name);
    if (!entry) return false;
    const idx = entry.items.findIndex((row) => String(row[idField]) === String(idValue));
    if (idx === -1) return false;
    entry.items[idx] = { ...entry.items[idx], ...patchObject };
    set(name, entry.items);
    return true;
  }

  function clear(name) {
    try {
      localStorage.removeItem(key(name));
    } catch {
      // нечего чистить
    }
  }

  function ageText(name) {
    const ms = age(name);
    if (ms === null) return "";
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "обновлено только что";
    if (minutes === 1) return "обновлено минуту назад";
    if (minutes < 5) return `обновлено ${minutes} минуты назад`;
    if (minutes < 60) return `обновлено ${minutes} минут назад`;
    const hours = Math.floor(minutes / 60);
    if (hours === 1) return "обновлено час назад";
    if (hours < 5) return `обновлено ${hours} часа назад`;
    return `обновлено ${hours} часов назад`;
  }

  return { items, get, set, age, ageText, isFresh, patch, clear, FRESH_MS };
})();

// Строка над списком: когда данные получены и кнопка обновления.
// Общая, чтобы все экраны выглядели и вели себя одинаково.
function refreshRowHtml(id) {
  return `<div class="refresh-row" id="${id}"></div>`;
}

function renderRefreshRow(id, cacheName, onRefresh, busy) {
  const row = document.getElementById(id);
  if (!row) return;
  const text = busy ? "обновляем…" : (Cache.ageText(cacheName) || "нет данных");
  row.innerHTML = `
    <span class="refresh-age">${escapeHtml(text)}</span>
    <button class="refresh-btn" type="button" ${busy ? "disabled" : ""}>Обновить</button>`;
  const btn = row.querySelector("button");
  if (btn && !busy) btn.addEventListener("click", onRefresh);
}
