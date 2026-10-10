const RepairScreen = (() => {
  const CACHE = "defects";
  let itemsById = {};
  let busy = false;
  // Решённые, но ещё не подтверждённые таблицей: список, пришедший с сервера
  // раньше записи, не должен вернуть их в «открытые».
  const pending = {};

  // Названия предметов берём из кэша каталога. Раньше этот экран запрашивал
  // весь каталог заново — второй запрос по 5–8 секунд на каждое открытие,
  // ради данных, которые уже лежали рядом. Нет в кэше — тянем один раз через
  // общий Cache.ensure (пригодится и каталогу).
  async function loadItemsMap() {
    let items;
    try {
      items = await Cache.ensure("equipment", "/equipment/list", { category: "all", status: "all" });
    } catch {
      items = [];
    }
    itemsById = Object.fromEntries(items.map((i) => [i.item_id, i]));
  }

  // То же, но только из того, что уже лежит: чтобы нарисовать дефекты сразу,
  // не дожидаясь каталога. Нет каталога — карточки покажут номер вместо
  // названия, а названия подставятся, когда он придёт.
  function itemsMapFromCache() {
    const items = Cache.items("equipment") || [];
    itemsById = Object.fromEntries(items.map((i) => [i.item_id, i]));
  }

  function drawRefreshRow() {
    renderRefreshRow("repair-refresh", CACHE, () => loadList({ force: true }), busy);
  }

  function render(defects) {
    const list = document.getElementById("repair-list");
    const status = segmentedValue("repair-filter-status");
    const shown = status === "all" ? defects : defects.filter((d) => d.status === status);

    if (!shown.length) {
      list.innerHTML = `<p class="empty">Дефектов нет</p>`;
      return;
    }
    // Начатые комментарии к решению переживают перерисовку: она бывает и от
    // соседней карточки, которую только что отметили решённой.
    const drafts = {};
    list.querySelectorAll("textarea[id^='resolution-']").forEach((t) => {
      if (t.value) drafts[t.id] = t.value;
    });
    list.innerHTML = shown
      .slice()
      .sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at))
      .map((d) => {
        const item = itemsById[d.item_id];
        const resolved = d.status === "Resolved";
        const resolveBlock = !resolved ? `
          <div class="section defect-form" style="margin-top:8px;">
            <textarea placeholder="Комментарий к решению" id="resolution-${d.defect_id}"></textarea>
            <button class="btn btn--secondary" data-resolve="${d.defect_id}" style="margin-top:6px;">Отметить решённым</button>
            <div id="resolve-error-${d.defect_id}"></div>
          </div>` : "";
        // Чем кончился дефект. Закрытый без объяснения — это вопрос «а что с ним
        // делали?», который потом задают вслух; данные для ответа приходят с
        // бэкенда и раньше просто не показывались.
        const resolvedBlock = resolved ? `
          <div class="card-sub">Решён: ${formatDate(d.resolved_at)}</div>
          <div class="card-sub">${d.resolution_notes
            ? escapeHtml(d.resolution_notes)
            : "Комментарий к решению не оставили"}</div>` : "";
        const reporter = d.reported_by_name
          ? ` · ${escapeHtml(d.reported_by_name)}` : "";
        return `
          <div class="card" data-defect-item="${escapeHtml(d.item_id)}">
            <div class="card-title">${escapeHtml(item ? item.name : d.item_id)} ${statusChip(d.status)}</div>
            <div class="card-sub">${escapeHtml(d.item_id)} · ${escapeHtml(STATUS_LABELS[d.severity] || d.severity)}</div>
            <div class="card-sub">${escapeHtml(d.description || "")}</div>
            <div class="card-sub">Заявлен: ${formatDate(d.reported_at)}${reporter}</div>
            ${resolvedBlock}
            ${resolveBlock}
          </div>`;
      }).join("");

    Object.keys(drafts).forEach((id) => {
      const t = document.getElementById(id);
      if (t) t.value = drafts[id];
    });
    list.querySelectorAll("[data-resolve]").forEach((btn) => {
      btn.addEventListener("click", () => confirmResolve(btn.dataset.resolve, btn));
    });
    // Карточка ведёт на предмет: из ремонта чаще всего нужно как раз это —
    // посмотреть историю вещи и решить, выдавать ли её дальше.
    list.querySelectorAll("[data-defect-item]").forEach((card) => {
      card.addEventListener("click", () => {
        Router.navigate("item", { itemId: card.dataset.defectItem });
      });
    });
    // Форма решения живёт внутри карточки, поэтому её клики наружу не пускаем:
    // иначе попытка напечатать комментарий уводила бы с экрана.
    list.querySelectorAll(".defect-form").forEach((form) => {
      form.addEventListener("click", (e) => e.stopPropagation());
    });
  }

  // Фильтр по статусу считается локально: дефекты кэшируются целиком, и
  // переключение фильтра не должно стоить нового запроса.
  async function loadList({ force = false } = {}) {
    const list = document.getElementById("repair-list");
    const cached = Cache.items(CACHE);

    if (cached && cached.length) {
      itemsMapFromCache();
      render(cached);
      // Каталога не было — тянем его, не задерживая показ дефектов.
      if (!Cache.items("equipment")) {
        loadItemsMap().then(() => {
          const now = Cache.items(CACHE);
          if (now && !isTyping("#repair-list")) render(now);
        });
      }
    }
    drawRefreshRow();

    if (!force && cached && cached.length && Cache.isFresh(CACHE)) return;

    if (!cached || !cached.length) list.innerHTML = skeleton(3);
    busy = true;
    drawRefreshRow();
    try {
      const [defects] = await Promise.all([
        Cache.load(CACHE, "/defects/list", { status: "all" }, { fresh: force }),
        loadItemsMap(),
      ]);
      Object.keys(pending).forEach((id) => Cache.patch(CACHE, "defect_id", id, pending[id]));
      // Пока шёл запрос, человек мог начать комментарий к решению —
      // перерисовка стёрла бы его на середине слова.
      if (!isTyping("#repair-list")) render(Cache.items(CACHE) || defects);
      showStaleNote("repair-refresh");
    } catch (err) {
      if (!cached || !cached.length) {
        list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      } else showStaleNote("repair-refresh", CACHE);
    } finally {
      busy = false;
      drawRefreshRow();
    }
  }

  // Решённый дефект возвращает вещь в выдачу — случайный тап по кнопке рядом с
  // полем комментария обходится дорого, поэтому спрашиваем (как confirmDelete в staff.js).
  function confirmResolve(defectId, btn) {
    const d = (Cache.items(CACHE) || []).find((x) => String(x.defect_id) === String(defectId));
    const item = d ? itemsById[d.item_id] : null;
    const name = d ? (item ? item.name : d.item_id) : "дефект";
    const sev = d ? (STATUS_LABELS[d.severity] || d.severity) : "";
    TG.confirmDestructive("Отметить решённым?",
      `${name}${sev ? " · " + sev : ""}. Если дефект снимал вещь с выдачи, она вернётся в каталог.`,
      "Решён", (yes) => { if (yes) resolveDefect(defectId, btn); });
  }

  // Оптимистично, как setSection в models.js: дефект уходит в «решённые»
  // сразу, а не через 6–12 секунд записи. Откажет таблица — возвращаем всё
  // как было и пишем причину прямо в карточке.
  async function resolveDefect(defectId, btn) {
    const notesEl = document.getElementById(`resolution-${defectId}`);
    const notes = notesEl ? notesEl.value.trim() : "";
    const before = Cache.items(CACHE) || [];
    const resolved = before.find((d) => String(d.defect_id) === String(defectId));
    const restore = busyButton(btn, "Отмечаем…");
    if (notesEl) notesEl.disabled = true;

    // Статус предмета тоже мог поменяться: из ремонта он выходит, когда
    // снимающих с выдачи дефектов не осталось. Считаем это по тому же
    // списку дефектов и правим одну строку каталога, а не весь каталог.
    let itemBefore = null;
    if (resolved) {
      const otherBlocking = before.some((d) =>
        String(d.item_id) === String(resolved.item_id) &&
        String(d.defect_id) !== String(defectId) &&
        d.status !== "Resolved" && ItemState.blocksRental(d.severity));
      itemBefore = (Cache.items("equipment") || [])
        .find((r) => String(r.item_id) === String(resolved.item_id)) || null;
      pending[defectId] = {
        status: "Resolved", resolution_notes: notes, resolved_at: new Date().toISOString(),
      };
      Cache.patch(CACHE, "defect_id", defectId, pending[defectId]);
      Cache.patch("equipment", "item_id", resolved.item_id,
        (row) => ItemState.afterResolve(row, otherBlocking));
      TG.hapticSuccess();
      render(Cache.items(CACHE) || []);
      showStatusLine("repair-status", "Дефект отмечен решённым", { before: "repair-list" });
    }

    try {
      await apiPost("/defect/resolve", { defect_id: Number(defectId), status: "Resolved", resolution_notes: notes });
      delete pending[defectId];
      if (!resolved) {
        // Дефекта нет в кэше — чей это предмет, не знаем: каталог помечаем
        // устаревшим, а список дефектов перечитываем.
        TG.hapticSuccess();
        Cache.stale("equipment");
        Cache.stale(CACHE);
        loadList();
      }
    } catch (err) {
      TG.hapticError();
      delete pending[defectId];
      if (resolved) {
        // Откат: дефект снова открыт, предмет — в прежнем статусе.
        Cache.patch(CACHE, "defect_id", defectId, {
          status: resolved.status, resolution_notes: resolved.resolution_notes || "",
          resolved_at: resolved.resolved_at || "",
        });
        if (itemBefore) {
          Cache.patch("equipment", "item_id", itemBefore.item_id, { status: itemBefore.status });
        }
        render(Cache.items(CACHE) || []);
        // Набранный комментарий возвращаем в поле: печатать заново никто не станет.
        const again = document.getElementById(`resolution-${defectId}`);
        if (again) again.value = notes;
        showStatusLine("repair-status", "");
        showBoxError(`resolve-error-${defectId}`, "Не отметилось: " + err.message);
      } else {
        restore();
        if (notesEl) notesEl.disabled = false;
        showBoxError(`resolve-error-${defectId}`, err.message);
      }
    }
  }

  function onShow() {
    loadList();
  }

  function init() {
    bindSegmented("repair-filter-status", () => {
      const cached = Cache.items(CACHE);
      if (cached) render(cached);   // фильтр — локально, без запроса
      else loadList();
    });
    Pull.register("repair", () => loadList({ force: true }));
    Router.register("repair", { onShow });
  }

  return { init };
})();
