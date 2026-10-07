function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) +
    " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABELS = {
  Available: "Доступно", Rented: "В аренде", "In Repair": "В ремонте", Retired: "Списано",
  Open: "Открыт", Closed: "Закрыт", Resolved: "Решён",
  Minor: "Незначительный", Major: "Серьёзный", "Out of Service": "Не работает",
  // Статусы заказа. «Оформлен» — заказ есть, но техника ещё не выдана.
  New: "Оформлен", Issued: "Выдан", Returned: "Возвращён", Cancelled: "Отменён",
};

function statusBadgeClass(status) {
  const map = {
    Available: "badge--available", Rented: "badge--rented", "In Repair": "badge--in-repair",
    Retired: "badge--retired", Open: "badge--open", Closed: "badge--closed", Resolved: "badge--resolved",
    New: "badge--closed", Issued: "badge--rented", Returned: "badge--resolved", Cancelled: "badge--retired",
  };
  return map[status] || "badge--retired";
}

function statusBadge(status) {
  return `<span class="badge ${statusBadgeClass(status)}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

// Обычные состояния, которые в списке помечать незачем: ими описана почти
// каждая строка. Зелёное «ДОСТУПНО» на 628 позициях кричало о норме, и
// исключение — «в ремонте», «просрочен» — терялось среди этого крика.
const QUIET_STATUSES = ["Available", "Resolved", "Closed", "Returned"];

// Бейдж для длинного списка: у нормы его нет, у исключения он тот же самый.
// На экранах, где статус и есть ответ на вопрос («можно ли выдать?»), по
// -прежнему используется statusBadge() — там терять его нельзя.
function statusChip(status) {
  return QUIET_STATUSES.indexOf(status) === -1 ? statusBadge(status) : "";
}

// Действующий справочник категорий: с бэкенда, если он уже приходил, иначе
// запасной из CONFIG. Обёртка нужна, чтобы экраны не знали, откуда он взялся.
function categoryList() {
  try {
    const session = Auth.getSession();
    if (session && Array.isArray(session.categories) && session.categories.length) {
      return session.categories;
    }
  } catch {
    // до входа справочника ещё нет — это нормально
  }
  return CONFIG.CATEGORIES;
}

// Считается ли категория количеством (мешки, флаги, расходники) — у такой
// техники нет личного номера, и в каталоге одна строка описывает всю кучу.
function categoryByQty(code) {
  const c = categoryList().find((c) => c.code === code);
  return !!(c && c.by_qty);
}

// «21 из 25 свободно» — то, что нужно знать про кучу перед выдачей.
function qtyText(item) {
  const total = Number(item.qty || 1);
  const free = Number(item.qty_free !== undefined ? item.qty_free : total - Number(item.qty_out || 0));
  return `${free} из ${total} ${plural(total, "свободна", "свободно", "свободно")}`;
}

// Как называется роль для человека. Главный администратор — не отдельная
// роль в таблице, а отметка: удалить её нельзя, можно только передать.
function roleLabel(person) {
  if (!person) return "";
  if (person.is_owner) return "Главный администратор";
  return person.role === "Admin" ? "Администратор" : "Сотрудник склада";
}

function categoryLabel(code) {
  const c = categoryList().find((c) => c.code === code);
  return c ? c.label : code;
}

// Русское склонение по числу: 1 этикетка, 2 этикетки, 5 этикеток.
// Без этого получалось «2 этикеток».
function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function showBoxError(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = message ? `<div class="error-box">${escapeHtml(message)}</div>` : "";
}

// Печатает ли человек прямо сейчас внутри этого блока. Экраны показывают
// вчерашние данные сразу и обновляют их молча, когда придёт ответ; если в
// этот момент перерисовать экран, набранное на середине слова пропадёт.
function isTyping(containerSelector) {
  const el = document.activeElement;
  if (!el || !el.closest) return false;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
  return !!el.closest(containerSelector);
}

// Заглушки в форме будущих карточек вместо надписи «Загрузка…»: видно, что
// именно грузится, и экран не прыгает, когда данные приходят.
function skeleton(count = 4) {
  return `<div class="skeleton">` +
    `<div class="skeleton-card"></div>`.repeat(count) +
    `</div>`;
}

// Кнопка «занята»: сразу после нажатия, ещё до ответа таблицы (6–12 секунд на
// запись). Без этого кнопка выглядела нетронутой, и её жали второй раз —
// а «Отметить решённым» на ремонте не отзывалась вообще никак. Сделано как
// setSubmitting в scan.js: выключить, запомнить подпись, написать, что идёт.
// Занятой становится только нажатая кнопка — соседние остаются живыми.
//
// Возвращает restore(): вернуть кнопку как была (или с новой подписью).
// Повторный вызов restore безвреден, и кнопка, которую уже перерисовали,
// тоже: правим отцепленный элемент, никто его не увидит.
function busyButton(btn, text) {
  if (!btn) return () => {};
  const label = btn.classList.contains("btn--busy")
    ? (btn.dataset.label || btn.textContent)
    : btn.textContent;
  btn.dataset.label = label;
  btn.disabled = true;
  btn.classList.add("btn--busy");
  btn.setAttribute("aria-busy", "true");
  btn.textContent = text || "Сохраняем…";
  let done = false;
  return function restore(newText) {
    if (done) return;
    done = true;
    btn.disabled = false;
    btn.classList.remove("btn--busy");
    btn.removeAttribute("aria-busy");
    btn.textContent = newText || label;
    delete btn.dataset.label;
  };
}

// Строка «Сохранено» на месте действия вместо окна Telegram. Окно надо
// закрывать отдельным тапом, а после каждой удачной записи это лишний шаг;
// ошибки по-прежнему показываются в error-box (showBoxError) — их надо
// прочитать. Строка сама исчезает через несколько секунд.
//
// before — id элемента, перед которым завести место под строку, если его ещё
// нет в разметке: так экрану не нужна отдельная правка index.html.
function showStatusLine(target, text, { before } = {}) {
  const el = typeof target === "string"
    ? (before && text ? ensureSlot(target, before) : document.getElementById(target))
    : target;
  if (!el) return;
  clearTimeout(el._statusTimer);
  el.innerHTML = text
    ? `<div class="status-line" role="status">${escapeHtml(text)}</div>`
    : "";
  if (text) el._statusTimer = setTimeout(() => { el.innerHTML = ""; }, 5000);
}

// Место под строку состояния или ошибку: есть в разметке — оно, нет —
// заводим пустой блок перед beforeId.
function ensureSlot(id, beforeId) {
  let el = document.getElementById(id);
  if (el) return el;
  const anchor = document.getElementById(beforeId);
  if (!anchor || !anchor.parentNode) return null;
  el = document.createElement("div");
  el.id = id;
  anchor.parentNode.insertBefore(el, anchor);
  return el;
}

// Отдать картинку человеку и сказать, чем кончилось. Сам выбор пути — в
// QR.deliverCanvas: в браузере скачивание, внутри Telegram системный лист
// «Поделиться», а если его нет — картинка во весь экран.
// Кнопку на время блокируем, чтобы второй тап не открыл лист повторно.
async function saveImageFor(canvas, filename, title, btn) {
  const before = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Сохраняем…"; }
  try {
    const via = await QR.deliverCanvas(canvas, filename, title);
    if (via === "share" || via === "download" || via === "image") {
      TG.hapticSuccess();
    }
    return via;
  } catch (err) {
    TG.hapticError();
    TG.showAlert(err.message || "Не получилось сохранить картинку");
    return "error";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = before; }
  }
}

// Текст в буфер обмена. Сначала navigator.clipboard — но внутри Telegram он
// бывает закрыт (нет разрешения, не тот контекст), тогда старый путь: скрытое
// поле и execCommand("copy"). Вызывать из обработчика нажатия — иначе
// откажут оба. Возвращает true/false: что сказать человеку, решает экран.
async function copyText(text) {
  const value = String(text == null ? "" : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (ignored) {}
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch (ignored) {
    return false;
  } finally {
    area.remove();
  }
}

// --- Сегментированный контроль ---
// Значение живёт в разметке (класс на выбранной кнопке), а не в скрытом поле:
// скрытое поле рядом с видимыми кнопками — это два органа управления на одну
// настройку, и однажды они разъезжаются.
function segmentedValue(id) {
  const on = document.querySelector("#" + id + " .segmented-item--on");
  return on ? on.dataset.value : "";
}

function bindSegmented(id, onChange) {
  const box = document.getElementById(id);
  if (!box) return;
  box.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-item");
    if (!btn || btn.classList.contains("segmented-item--on")) return;
    box.querySelectorAll(".segmented-item").forEach((b) => {
      b.classList.remove("segmented-item--on");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("segmented-item--on");
    btn.setAttribute("aria-selected", "true");
    // Выбранный сегмент мог быть за краем прокрученной полосы.
    if (btn.scrollIntoView) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
    onChange(btn.dataset.value);
  });
}

// --- Смахивание строки списка ---
// Как в «Почте» на айфоне: строка едет за пальцем, из-под неё выходит кнопка
// действия. Чуть сдвинул — строка остаётся открытой, действие по нажатию на
// кнопку; дотянул до 60% ширины — действие срабатывает сразу, со щелчком
// вибрации в тот момент, когда порог пройден. Открыта не больше одной строки;
// нажатие мимо или прокрутка её закрывают.
//
// Вертикальную прокрутку не отнимаем: строкам дан touch-action: pan-y, а
// направление решаем после первых LOCK пикселей — пошло вверх-вниз, жест
// отдаём странице и больше в него не вмешиваемся. Мелкая дрожь пальца по
// горизонтали строку не сдвигает: до LOCK ничего не происходит вовсе.
//
// Подключение: SwipeRow.attach(list, { row: "[data-order-id]", actions }),
// где actions(row) отдаёт { leading, trailing } — действие слева (видно при
// смахивании вправо) и справа (при смахивании влево). Каждое — { label, icon,
// tone, onTrigger(row) }; нет действия — null, и в ту сторону строка лишь
// чуть подаётся и возвращается: пустую кнопку не показываем. onTrigger сам
// решает, что делать со строкой: SwipeRow.close(row) — вернуть на место,
// SwipeRow.dismiss(row, side) — увести и схлопнуть.
//
// Сделано на pointer-событиях: так же работает перетаскивание мышью, и
// смахивание можно проверить на компьютере.
const SwipeRow = (() => {
  const LOCK = 10;            // пикселей до решения «вбок или вдоль списка»
  const ACTION_W = 84;
  const OPEN_PART = 0.35;     // доля кнопки: сдвинул больше — строка остаётся открытой
  const FULL_PART = 0.6;      // доля строки: дотянул — действие срабатывает сразу
  const FLING = 0.35;         // пикселей в мс — быстрый взмах открывает и закрывает
  const MS = 230;
  const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";   // ease-out
  const SIGN = { leading: 1, trailing: -1 };

  let opened = null;          // { row, side } — открытая строка, не больше одной
  let swallow = false;        // проглотить следующий click (после жеста)
  let swallowTimer = null;
  let installed = false;

  function reduced() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }

  // Click после смахивания — не нажатие на строку. Мышь присылает его всегда,
  // палец — не всегда, поэтому флаг живёт недолго: иначе съел бы следующий
  // настоящий тап.
  function armSwallow() {
    swallow = true;
    clearTimeout(swallowTimer);
    swallowTimer = setTimeout(() => { swallow = false; }, 400);
  }

  function rubber(over, dim) {
    return (1 - 1 / (over * 0.55 / dim + 1)) * dim;
  }

  function stateOf(row, actionsFor) {
    const st = row._swipe || (row._swipe = { offset: 0, acts: {}, els: {} });
    if (actionsFor) st.acts = actionsFor(row) || {};
    ["leading", "trailing"].forEach((side) => {
      const act = st.acts[side];
      let el = st.els[side];
      if (act && !el) {
        el = document.createElement("button");
        el.type = "button";
        el.tabIndex = -1;
        el.dataset.swipeSide = side;
        row.appendChild(el);
        st.els[side] = el;
      }
      if (!el) return;
      el.hidden = !act;
      if (act) {
        el.className = `swipe-act swipe-act--${side} swipe-act--${act.tone || "default"}`;
        el.setAttribute("aria-label", act.label);
        el.innerHTML = `<span class="swipe-act-in">${act.icon || ""}<span>${escapeHtml(act.label)}</span></span>`;
      }
    });
    return st;
  }

  // Строку дальше ширины не тянем — дальше она пружинит; в сторону, где
  // действия нет, только чуть подаётся.
  function resist(st, offset, width) {
    const side = offset > 0 ? "leading" : "trailing";
    const abs = Math.abs(offset);
    const sign = Math.sign(offset);
    if (!st.acts[side]) return sign * rubber(abs, 24);
    return abs <= width ? offset : sign * (width + rubber(abs - width, 40));
  }

  function paint(row, offset, animate) {
    const st = row._swipe;
    if (!st) return;
    st.offset = offset;
    const motion = animate && !reduced();
    row.style.transition = motion ? `transform ${MS}ms ${EASE}` : "none";
    row.style.transform = offset ? `translate3d(${offset}px, 0, 0)` : "";
    Object.keys(st.els).forEach((side) => {
      const el = st.els[side];
      const mine = Math.sign(offset) === SIGN[side];
      el.style.transition = motion ? `width ${MS}ms ${EASE}` : "none";
      // Кнопка заполняет всё, что открылось: при долгом смахивании она
      // растягивается вслед за строкой, а не остаётся островком у края.
      el.style.width = (mine ? Math.max(ACTION_W, Math.abs(offset)) : ACTION_W) + "px";
      el.tabIndex = mine && offset ? 0 : -1;
    });
  }

  function openTo(row, side) {
    if (opened && opened.row !== row) close(opened.row);
    paint(row, SIGN[side] * ACTION_W, true);
    opened = { row, side };
  }

  function close(row) {
    if (!row || !row._swipe) return;
    if (opened && opened.row === row) opened = null;
    if (row._swipe.offset) paint(row, 0, true);
  }

  function fire(row, side) {
    const act = row._swipe && row._swipe.acts[side];
    if (opened && opened.row === row) opened = null;
    if (act && act.onTrigger) act.onTrigger(row);
    else close(row);
  }

  // Увести строку за край и схлопнуть по высоте — так уходит письмо в архив.
  // Промис — когда место под строкой уже закрылось и список можно перерисовать.
  function dismiss(row, side) {
    if (opened && opened.row === row) opened = null;
    return new Promise((resolve) => {
      if (reduced() || !row.isConnected) {
        row.style.display = "none";
        resolve();
        return;
      }
      stateOf(row);
      paint(row, SIGN[side] * row.offsetWidth, true);
      setTimeout(() => {
        row.style.height = row.offsetHeight + "px";
        row.style.minHeight = "0";
        void row.offsetHeight;   // зафиксировать высоту перед переходом
        row.style.transition += `, height ${MS}ms ${EASE}, padding ${MS}ms ${EASE}`;
        row.style.height = "0px";
        row.style.paddingTop = "0px";
        row.style.paddingBottom = "0px";
        setTimeout(resolve, MS);
      }, MS);
    });
  }

  // Подсказка: строка на миг приоткрывается и возвращается — видно, что под
  // ней что-то есть. Без анимации подсказка теряет смысл, поэтому при
  // «уменьшить движение» её нет.
  function peek(row, side, actionsFor) {
    if (reduced() || !row || !row.isConnected) return false;
    const st = stateOf(row, actionsFor);
    if (!st.acts[side]) return false;
    paint(row, SIGN[side] * 52, true);
    setTimeout(() => { if (!opened || opened.row !== row) paint(row, 0, true); }, MS + 450);
    return true;
  }

  // Общие слушатели — один раз на документ: «нажатие мимо закрывает»,
  // «прокрутка закрывает», «click после жеста не открывает строку».
  function install() {
    if (installed) return;
    installed = true;
    document.addEventListener("pointerdown", (e) => {
      swallow = false;
      if (!opened) return;
      const row = opened.row;
      if (!row.isConnected) { opened = null; return; }
      if (row.contains(e.target)) return;   // своя строка — решит жест
      // Тап по другой строке того же списка только закрывает открытую, как в
      // «Почте», — карточку не открывает.
      if (row.parentNode && row.parentNode.contains(e.target)) swallow = true;
      close(row);
    }, true);
    document.addEventListener("pointerup", () => {
      if (swallow) armSwallow();
    }, true);
    document.addEventListener("click", (e) => {
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    window.addEventListener("scroll", () => {
      if (opened) close(opened.row);
    }, { passive: true });
  }

  function attach(list, { row: selector, actions }) {
    install();
    list.classList.add("swipe-list");
    let g = null;   // текущий жест

    list.addEventListener("pointerdown", (e) => {
      g = null;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest(".swipe-act, input, select, textarea")) return;
      const row = e.target.closest(selector);
      if (!row || !list.contains(row)) return;
      const st = stateOf(row, actions);
      g = {
        row, st, id: e.pointerId, x0: e.clientX, y0: e.clientY, base: st.offset,
        axis: null, full: false, width: row.offsetWidth,
        lastX: e.clientX, lastT: e.timeStamp, v: 0,
      };
    });

    list.addEventListener("pointermove", (e) => {
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (!g.axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK) return;
        if (Math.abs(dx) <= Math.abs(dy)) { g = null; return; }   // это прокрутка
        g.axis = "x";
        if (opened && opened.row !== g.row) close(opened.row);
        try { g.row.setPointerCapture(e.pointerId); } catch (ignored) {}
        g.row.classList.add("swipe-dragging");
        try { window.getSelection().removeAllRanges(); } catch (ignored) {}
      }
      const dt = e.timeStamp - g.lastT;
      if (dt > 0) { g.v = (e.clientX - g.lastX) / dt; g.lastX = e.clientX; g.lastT = e.timeStamp; }
      const offset = resist(g.st, g.base + dx, g.width);
      const side = offset > 0 ? "leading" : "trailing";
      const full = !!g.st.acts[side] && Math.abs(offset) >= g.width * FULL_PART;
      if (full !== g.full) {
        g.full = full;
        TG.hapticTick();
      }
      paint(g.row, offset, false);
    });

    const end = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const gg = g;
      g = null;
      if (gg.axis !== "x") {
        // Тап по открытой строке закрывает её, а не открывает карточку.
        if (gg.base && e.type === "pointerup") { armSwallow(); close(gg.row); }
        return;
      }
      gg.row.classList.remove("swipe-dragging");
      armSwallow();
      const offset = gg.st.offset;
      const side = offset > 0 ? "leading" : "trailing";
      if (e.type === "pointercancel" || !offset || !gg.st.acts[side]) { close(gg.row); return; }
      if (gg.full) { fire(gg.row, side); return; }
      // Палец остановился перед тем, как отпустить, — скорости нет.
      const v = e.timeStamp - gg.lastT > 100 ? 0 : gg.v * SIGN[side];
      if (v < -FLING) { close(gg.row); return; }
      if (v > FLING || Math.abs(offset) >= ACTION_W * OPEN_PART) openTo(gg.row, side);
      else close(gg.row);
    };
    list.addEventListener("pointerup", end);
    list.addEventListener("pointercancel", end);

    // Нажатие на открытую кнопку. Ловим раньше обработчиков экрана: нажатие
    // на действие — не нажатие на строку.
    list.addEventListener("click", (e) => {
      const btn = e.target.closest(".swipe-act");
      if (!btn || !list.contains(btn)) return;
      e.stopPropagation();
      e.preventDefault();
      fire(btn.parentNode, btn.dataset.swipeSide);
    }, true);
  }

  return { attach, close, dismiss, peek };
})();

// --- Строка с отменой внизу экрана ---
// «Заказ в архиве · Отменить» — как в «Почте» и в Gmail. Одна на всё
// приложение: новая заменяет прежнюю. Ошибки сюда не кладём — их надо
// прочитать, и для них есть error-box; сюда — короткое «сделано, можно
// передумать» и отказ, который сам объясняет, что делать.
const Snackbar = (() => {
  let el = null;
  let timer = null;
  let seq = 0;

  function ensure() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "snackbar";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
    return el;
  }

  // Возвращает номер показа: hide(номер) спрячет строку, только если на
  // экране всё ещё она, а не уже следующая.
  function show(text, { action, onAction, ms = 5000 } = {}) {
    const box = ensure();
    const id = ++seq;
    clearTimeout(timer);
    box.innerHTML = `<span class="snackbar-text">${escapeHtml(text)}</span>` +
      (action ? `<button type="button" class="snackbar-btn">${escapeHtml(action)}</button>` : "");
    const btn = box.querySelector(".snackbar-btn");
    if (btn) {
      btn.addEventListener("click", () => {
        hide(id);
        if (onAction) onAction();
      });
    }
    box.classList.add("snackbar--on");
    document.body.classList.add("snackbar-on");
    timer = setTimeout(() => hide(id), ms);
    return id;
  }

  function hide(id) {
    if (!el || (id && id !== seq)) return;
    clearTimeout(timer);
    el.classList.remove("snackbar--on");
    document.body.classList.remove("snackbar-on");
  }

  return { show, hide };
})();


// Подготовка снимка (экраны «Модели» и «My rent») — как site/photos.py: срезать однотонные поля, вписать
// предмет в 704×704 (поле 48), по центру белого 800×800, JPEG. На сайте
// витрина рассчитана на такой кадр; без обработки фото с разным запасом по
// краям выглядели бы разномасштабными. Размер держим меньше ~300 КБ: запрос
// идёт через Worker и Apps Script, и толстое тело им в тягость.
const PHOTO_SIZE = 800, PHOTO_PAD = 48, PHOTO_MAX_BYTES = 300 * 1024;

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (e) { /* старый WebView: падаем на <img> ниже */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Не удалось прочитать картинку"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// Рамка предмета: фон — цвет углов, если они сходятся, иначе белый; пятном
// считается пиксель, у которого сумма отличий по каналам > 30; пыль и тонкие
// рамки отсекаются сужением маски (5 подряд по обеим осям, как MinFilter(5)).
function subjectBox(canvas) {
  const scale = Math.min(1, 400 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const small = newCanvas(w, h);
  small.getContext("2d").drawImage(canvas, 0, 0, w, h);
  const d = small.getContext("2d").getImageData(0, 0, w, h).data;
  const px = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  const spread = [0, 1, 2].map((c) => Math.max(...corners.map((p) => p[c])) - Math.min(...corners.map((p) => p[c])));
  const bg = Math.max(...spread) <= 24 ? corners[0] : [255, 255, 255];
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = px(x, y);
    if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 30) on[y * w + x] = 1;
  }
  const R = 5;
  const run = (src, len, step, lines, lineStep) => {
    const out = new Uint8Array(src.length);
    for (let l = 0; l < lines; l++) {
      let streak = 0;
      for (let i = 0; i < len; i++) {
        streak = src[l * lineStep + i * step] ? streak + 1 : 0;
        if (streak >= R) for (let j = 0; j < R; j++) out[l * lineStep + (i - j) * step] = 1;
      }
    }
    return out;
  };
  const eroded = run(run(on, w, 1, h, w), h, w, w, 1);
  let l = w, t = h, r = -1, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!eroded[y * w + x]) continue;
    if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
  }
  const full = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  if (r < 0) return full;
  const pad = 3;
  const x0 = Math.max(l - pad, 0), y0 = Math.max(t - pad, 0);
  const x1 = Math.min(r + 1 + pad, w), y1 = Math.min(b + 1 + pad, h);
  // Почти весь кадр — фон не однотонный, обрезать нечего.
  if ((x1 - x0) * (y1 - y0) > 0.97 * w * h) return full;
  return { x: Math.floor(x0 / scale), y: Math.floor(y0 / scale),
           w: Math.min(canvas.width, Math.ceil((x1 - x0) / scale)),
           h: Math.min(canvas.height, Math.ceil((y1 - y0) / scale)) };
}

async function preparePhoto(file) {
  const bmp = await loadBitmap(file);
  const sw = bmp.width, sh = bmp.height;
  if (!sw || !sh) throw new Error("Не удалось прочитать картинку");
  // Огромные снимки с камеры сжимаем сразу: на телефоне 12 Мп в getImageData
  // не уложатся в память.
  const cap = Math.min(1, 1600 / Math.max(sw, sh));
  const src = newCanvas(Math.round(sw * cap), Math.round(sh * cap));
  const sctx = src.getContext("2d");
  // Белая подложка: прозрачность в JPEG иначе станет чёрной.
  sctx.fillStyle = "#fff";
  sctx.fillRect(0, 0, src.width, src.height);
  sctx.drawImage(bmp, 0, 0, src.width, src.height);
  if (bmp.close) bmp.close();

  const box = subjectBox(src);
  const fit = (PHOTO_SIZE - PHOTO_PAD * 2) / Math.max(box.w, box.h);
  const dw = Math.max(1, Math.round(box.w * fit)), dh = Math.max(1, Math.round(box.h * fit));
  const out = newCanvas(PHOTO_SIZE, PHOTO_SIZE);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, box.x, box.y, box.w, box.h,
    Math.floor((PHOTO_SIZE - dw) / 2), Math.floor((PHOTO_SIZE - dh) / 2), dw, dh);

  let quality = 0.85, url = out.toDataURL("image/jpeg", quality);
  while (url.length * 3 / 4 > PHOTO_MAX_BYTES && quality > 0.4) {
    quality -= 0.1;
    url = out.toDataURL("image/jpeg", quality);
  }
  return url;
}
