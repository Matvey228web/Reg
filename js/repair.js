// Экран "Ремонт": доска дефектов с фильтром по статусу и возможностью закрыть дефект.

const RepairScreen = (() => {
  const CACHE = "defects";
  let itemsById = {};
  let busy = false;

  // Названия предметов берём из кэша каталога. Раньше этот экран запрашивал
  // весь каталог заново — второй запрос по 5–8 секунд на каждое открытие,
  // ради данных, которые уже лежали рядом.
  async function loadItemsMap() {
    let items = Cache.items("equipment");
    if (!items || !items.length) {
      try {
        items = await apiPost("/equipment/list", { category: "all", status: "all" });
        Cache.set("equipment", items);   // пригодится и каталогу
      } catch {
        items = [];
      }
    }
    itemsById = Object.fromEntries(items.map((i) => [i.item_id, i]));
  }

  function drawRefreshRow() {
    renderRefreshRow("repair-refresh", CACHE, () => loadList({ force: true }), busy);
  }

  function render(defects) {
    const list = document.getElementById("repair-list");
    const status = document.getElementById("repair-filter-status").value;
    const shown = status === "all" ? defects : defects.filter((d) => d.status === status);

    if (!shown.length) {
      list.innerHTML = `<p class="empty">Дефектов нет</p>`;
      return;
    }
    list.innerHTML = shown
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
  }

  // Фильтр по статусу считается локально: дефекты кэшируются целиком, и
  // переключение фильтра не должно стоить нового запроса.
  async function loadList({ force = false } = {}) {
    const list = document.getElementById("repair-list");
    const cached = Cache.items(CACHE);

    if (cached && cached.length) {
      await loadItemsMap();
      render(cached);
    }
    drawRefreshRow();

    if (!force && cached && cached.length && Cache.isFresh(CACHE)) return;

    if (!cached || !cached.length) list.innerHTML = skeleton(3);
    busy = true;
    drawRefreshRow();
    try {
      const [defects] = await Promise.all([
        apiPost("/defects/list", { status: "all" }),
        loadItemsMap(),
      ]);
      Cache.set(CACHE, defects);
      render(defects);
    } catch (err) {
      if (!cached || !cached.length) {
        list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      }
    } finally {
      busy = false;
      drawRefreshRow();
    }
  }

  async function resolveDefect(defectId) {
    const notesEl = document.getElementById(`resolution-${defectId}`);
    const notes = notesEl ? notesEl.value.trim() : "";
    try {
      await apiPost("/defect/resolve", { defect_id: Number(defectId), status: "Resolved", resolution_notes: notes });
      TG.hapticSuccess();
      // Свои изменения показываем сразу, не перезапрашивая весь список: статус
      // предмета в каталоге тоже мог поменяться, поэтому кэш каталога сбрасываем.
      Cache.patch(CACHE, "defect_id", defectId, { status: "Resolved", resolution_notes: notes });
      Cache.clear("equipment");
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
    document.getElementById("repair-filter-status").addEventListener("change", () => {
      const cached = Cache.items(CACHE);
      if (cached) render(cached);   // фильтр — локально, без запроса
      else loadList();
    });
    Router.register("repair", { onShow });
  }

  return { init };
})();
