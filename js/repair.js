// Экран "Ремонт": доска дефектов с фильтром по статусу и возможностью закрыть дефект.

const RepairScreen = (() => {
  let itemsById = {};

  async function loadItemsMap() {
    try {
      const items = await apiPost("/equipment/list", {});
      itemsById = Object.fromEntries(items.map((i) => [i.item_id, i]));
    } catch {
      itemsById = {};
    }
  }

  async function loadList() {
    const list = document.getElementById("repair-list");
    list.innerHTML = `<p class="empty">Загрузка…</p>`;
    const status = document.getElementById("repair-filter-status").value;
    try {
      const [defects] = await Promise.all([apiPost("/defects/list", { status }), loadItemsMap()]);
      if (!defects.length) {
        list.innerHTML = `<p class="empty">Дефектов нет</p>`;
        return;
      }
      list.innerHTML = defects
        .slice()
        .sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at))
        .map((d) => {
          const item = itemsById[d.item_id];
          const resolveBlock = d.status !== "Resolved" ? `
            <div class="section" style="margin-top:8px;">
              <textarea placeholder="Комментарий к решению" id="resolution-${d.defect_id}"></textarea>
              <button class="btn btn--secondary" data-resolve="${d.defect_id}" style="margin-top:6px;">Отметить решённым</button>
            </div>` : "";
          return `
            <div class="card">
              <div class="card-title">${escapeHtml(item ? item.name : d.item_id)} ${statusBadge(d.status)}</div>
              <div class="card-sub">${escapeHtml(d.item_id)} · ${escapeHtml(STATUS_LABELS[d.severity] || d.severity)}</div>
              <div class="card-sub">${escapeHtml(d.description || "")}</div>
              <div class="card-sub">Заявлен: ${formatDate(d.reported_at)}</div>
              ${resolveBlock}
            </div>`;
        }).join("");

      list.querySelectorAll("[data-resolve]").forEach((btn) => {
        btn.addEventListener("click", () => resolveDefect(btn.dataset.resolve));
      });
    } catch (err) {
      list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  async function resolveDefect(defectId) {
    const notesEl = document.getElementById(`resolution-${defectId}`);
    const notes = notesEl ? notesEl.value.trim() : "";
    try {
      await apiPost("/defect/resolve", { defect_id: Number(defectId), status: "Resolved", resolution_notes: notes });
      TG.hapticSuccess();
      loadList();
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    }
  }

  function onShow() {
    loadList();
  }

  function init() {
    document.getElementById("repair-filter-status").addEventListener("change", loadList);
    Router.register("repair", { onShow });
  }

  return { init };
})();
