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
  const FRESH_MS = 5 * 60 * 1000;

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

  // Один объект вместо списка: так хранятся «Настройки» — там не строки, а
  // словарь с категориями, сроками и сводкой. Лежит в той же форме, что и
  // списки, поэтому возраст и свежесть считаются тем же кодом.
  function one(name) {
    const list = items(name);
    return list && list.length ? list[0] : null;
  }

  function setOne(name, value) {
    set(name, [value]);
  }

  function write(name, entry) {
    try {
      localStorage.setItem(key(name), JSON.stringify(entry));
    } catch {
      // переполнение хранилища не должно ломать экран
    }
  }

  // Новый список целиком — с сервера. Он и свежий, и не устаревший.
  // savedAt передают только правки (см. replace): поправленная запись не
  // делает свежим весь список, и «обновлено N минут назад» должно остаться
  // честным.
  function set(name, list, savedAt) {
    write(name, { items: list, saved_at: savedAt || Date.now() });
  }

  // Список поменяли своими руками (дописали строку, поправили цену) — кладём
  // его на место, не трогая ни возраст, ни отметку «устарел». Cache.set здесь
  // не годится: он объявил бы свежим весь список, хотя свежей стала одна строка.
  function replace(name, list) {
    const entry = get(name);
    if (!entry) return false;
    write(name, { ...entry, items: list });
    return true;
  }

  // «Устарел, но не выбрасывай». После своей записи, когда новое состояние
  // целиком не известно (заказ закрылся возвратом, появился дефект), раньше
  // звали Cache.clear — и следующий экран снова встречал человека скелетом на
  // 6–9 секунд. Теперь список остаётся: экран показывает его сразу, а свежий
  // тянет молча, потому что isFresh отвечает «нет».
  function stale(name) {
    const entry = get(name);
    if (entry) write(name, { ...entry, stale: true });
  }

  function age(name) {
    const entry = get(name);
    return entry ? Date.now() - entry.saved_at : null;
  }

  function isFresh(name) {
    const ms = age(name);
    if (ms === null || ms >= FRESH_MS) return false;
    const entry = get(name);
    return !(entry && entry.stale);
  }

  // Точечная правка: после своей же выдачи или приёма незачем перезапрашивать
  // весь список — достаточно поправить одну запись. Возраст списка не
  // меняется: остальные строки свежее от этого не стали.
  //
  // patchObject может быть функцией от строки — когда новое значение считается
  // от того, что лежит в кэше (например, «на руках стало на 3 больше»).
  function patch(name, idField, idValue, patchObject) {
    const entry = get(name);
    if (!entry) return false;
    const idx = entry.items.findIndex((row) => String(row[idField]) === String(idValue));
    if (idx === -1) return false;
    const row = entry.items[idx];
    const changes = typeof patchObject === "function" ? patchObject(row) : patchObject;
    entry.items[idx] = { ...row, ...changes };
    write(name, entry);   // возраст и отметка «устарел» — как были
    return true;
  }

  // «Подгрузи, если нет». Экран, которому нужен чужой список (названия из
  // каталога, заказы для выдачи), раньше говорил «откройте Каталог и
  // возвращайтесь» — теперь тянет его сам, один раз, и кладёт туда же, откуда
  // список потом прочитает его собственный экран. Сделано как ensureItemsMap
  // в order.js.
  //
  // Лежит в кэше — отдаём как есть, даже не свежее: экраны, которые так
  // подгружают, берут из списка названия и номера, и ждать ради них 5–8 секунд
  // при каждом открытии хуже, чем показать список пятиминутной давности. Свой
  // возраст список показывает на собственном экране, там же и «Обновить».
  //
  // Одновременные вызовы делят один запрос: «Ремонт» и карточка заказа могут
  // попросить каталог в одну и ту же секунду.
  const inflight = {};
  function ensure(name, endpoint, body) {
    const cached = items(name);
    if (cached) return Promise.resolve(cached);
    return load(name, endpoint, body);
  }

  // Сходить за списком и положить его в кэш. Запрос, который уже в пути,
  // не дублируем: открыл каталог, пока его подтягивала главная (warm), — ждём
  // тот же ответ, а не заводим второй на 6–9 секунд. fresh («Обновить»)
  // в чужой запрос не встаёт: человек жмёт кнопку именно потому, что не верит
  // тому, что уже грузится или лежит.
  function load(name, endpoint, body, { fresh = false } = {}) {
    if (inflight[name] && !fresh) return inflight[name];
    const request = apiPost(endpoint, body || {}, { fresh })
      .then((list) => { set(name, list); return list; })
      .finally(() => { if (inflight[name] === request) delete inflight[name]; });
    inflight[name] = request;
    return request;
  }

  // Подтянуть главные списки, пока человек смотрит на главную: к тому
  // моменту, как он откроет каталог или заказы, ответ уже будет. Через
  // setTimeout, а не requestIdleCallback — в WKWebView на iOS его нет.
  // Ошибки глотаем: это догадка наперёд, а не действие человека, и свою
  // ошибку экран покажет сам, когда его откроют.
  const WARM = [
    ["equipment", "/equipment/list", { category: "all", status: "all" }],
    ["orders", "/orders/list", { status: "all" }],
  ];
  function warm() {
    if (CONFIG.MOCK_MODE) return;
    setTimeout(() => {
      WARM.forEach(([name, endpoint, body]) => {
        if (!isFresh(name)) load(name, endpoint, body).catch(() => {});
      });
    }, 300);
  }

  function clear(name) {
    try {
      localStorage.removeItem(key(name));
    } catch {
      // нечего чистить
    }
  }

  // При выходе: в кэше заказы с ФИО и телефонами студентов, и телефон бывает
  // общий на смену — следующий вошедший не должен увидеть их до входа.
  function clearAll() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => localStorage.removeItem(k));
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

  return { items, one, get, set, setOne, replace, stale, age, ageText, isFresh, patch,
           ensure, load, warm, clear, clearAll, FRESH_MS };
})();

// Как своя запись меняет строку каталога. Повторяет правила Code.gs
// (checkoutUnderLock, handleTransactionCheckin, handleDefectReport,
// handleDefectResolve): после выдачи или приёма незачем ждать 6–9 секунд, пока
// склад перечитается, — новое состояние известно и так.
//
// Это догадка клиента, а не источник правды. Каждую запись по-прежнему
// проверяет бэкенд, поэтому устаревшая догадка кончится понятным отказом
// («предмет уже выдан»), а не неверной записью. Отказываться ради неё от
// запроса на запись нельзя.
//
// Работает и со строкой каталога, и с ответом /item/lookup: поля те же.
const ItemState = (() => {
  // То же правило, что defectBlocksRental в Code.gs.
  function blocksRental(severity) {
    return severity === "Major" || severity === "Out of Service";
  }

  // В ответе /item/lookup признак есть, в строке каталога — нет: там его
  // знает категория.
  function byQty(item) {
    return item.by_qty !== undefined ? !!item.by_qty : categoryByQty(item.category);
  }

  function qtyChanges(item, out, status) {
    return { qty_out: out, qty_free: Number(item.qty || 1) - out, status };
  }

  // Пока на складе что-то осталось, позиция количеством остаётся доступной.
  function afterCheckout(item, qty, transactionId) {
    if (byQty(item)) {
      const total = Number(item.qty || 1);
      const out = Number(item.qty_out || 0) + Math.max(1, Math.floor(Number(qty) || 1));
      return qtyChanges(item, out, out >= total ? "Rented" : "Available");
    }
    return { status: "Rented", current_transaction_id: transactionId || "" };
  }

  // qtyOutFromServer — остаток на руках из ответа приёма: бэкенд его
  // возвращает, и считать самим тогда незачем.
  function afterCheckin(item, qty, defectSeverity, qtyOutFromServer) {
    const repair = !!defectSeverity && blocksRental(defectSeverity);
    if (byQty(item)) {
      const total = Number(item.qty || 1);
      const out = qtyOutFromServer !== undefined && qtyOutFromServer !== null
        ? Number(qtyOutFromServer)
        : Math.max(0, Number(item.qty_out || 0) - Math.max(1, Math.floor(Number(qty) || 1)));
      return qtyChanges(item, out, repair ? "In Repair" : out >= total ? "Rented" : "Available");
    }
    return { status: repair ? "In Repair" : "Available", current_transaction_id: "" };
  }

  // Статус после заявки о дефекте бэкенд возвращает сам; своё правило — на
  // случай, если в ответе его нет.
  function afterDefect(item, severity, statusFromServer) {
    if (statusFromServer) return { status: statusFromServer };
    return blocksRental(severity) && item.status === "Available" ? { status: "In Repair" } : {};
  }

  // Из ремонта предмет выходит, только если снимающих с выдачи дефектов у
  // него больше не осталось.
  function afterResolve(item, otherBlocking) {
    return item.status === "In Repair" && !otherBlocking ? { status: "Available" } : {};
  }

  return { blocksRental, byQty, afterCheckout, afterCheckin, afterDefect, afterResolve };
})();

// Строка возраста данных — общая, чтобы все экраны выглядели и вели себя одинаково.

// Фоновое обновление не удалось, а на экране уже лежат данные из кэша: молча
// оставить их нельзя — человек примет вчерашнее за свежее. Строка встаёт над
// anchorId; since — когда данные получены (мс) или имя кэша; без него строка
// убирается (после удачного обновления).
function showStaleNote(anchorId, since) {
  const box = ensureSlot(anchorId + "-stale", anchorId);
  if (!box) return;
  if (since === undefined) { box.innerHTML = ""; return; }
  const entry = typeof since === "string" ? Cache.get(since) : null;
  const at = entry ? entry.saved_at : since;
  const t = at ? new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
  showBoxError(box.id, "Не удалось обновить" + (t ? "; показано от " + t : ""));
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
