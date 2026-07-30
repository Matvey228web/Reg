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
};

function statusBadgeClass(status) {
  const map = {
    Available: "badge--available", Rented: "badge--rented", "In Repair": "badge--in-repair",
    Retired: "badge--retired", Open: "badge--open", Closed: "badge--closed", Resolved: "badge--resolved",
  };
  return map[status] || "badge--retired";
}

function statusBadge(status) {
  return `<span class="badge ${statusBadgeClass(status)}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

function categoryLabel(code) {
  const c = CONFIG.CATEGORIES.find((c) => c.code === code);
  return c ? c.label : code;
}

function showBoxError(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = message ? `<div class="error-box">${escapeHtml(message)}</div>` : "";
}
