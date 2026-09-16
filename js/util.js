// Общие мелкие хелперы, используемые на нескольких экранах.

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

// Заглушки в форме будущих карточек вместо надписи «Загрузка…»: видно, что
// именно грузится, и экран не прыгает, когда данные приходят.
function skeleton(count = 4) {
  return `<div class="skeleton">` +
    `<div class="skeleton-card"></div>`.repeat(count) +
    `</div>`;
}

// Отдать картинку человеку и сказать, чем кончилось. Сам выбор пути — в
// QR.deliverCanvas: в браузере скачивание, внутри Telegram системный лист
// «Поделиться», а если его нет — бот в чат склада.
// Кнопку на время блокируем: за ботом идёт запрос в таблицу на 5–8 секунд,
// и молчащая кнопка читается как зависшая.
async function saveImageFor(canvas, filename, title, btn) {
  const before = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Сохраняем…"; }
  try {
    const via = await QR.deliverCanvas(canvas, filename, title);
    if (via === "bot") {
      TG.hapticSuccess();
      TG.showAlert("Скачать напрямую из Telegram нельзя — картинку прислал бот в чат склада.");
    } else if (via === "share" || via === "download") {
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
