// Экран "Каталог": список оборудования с фильтрами и поиском + форма добавления
// нового предмета с QR.
//
// Про скорость. Бэкенд на Apps Script отвечает 5–8 секунд — это его потолок, а
// не наш код (замерено). Поэтому каталог держится в localStorage: экран
// рисуется мгновенно из кэша, свежие данные подтягиваются в фоне, а поиск и
// фильтры работают локально и не ждут сервер вообще.

const CatalogScreen = (() => {
  const CACHE_KEY = "mifs_catalog_cache_v1";
  const PAGE_SIZE = 50;

  let currentFilters = { category: "all", status: "all" };
  let allItems = [];      // весь каталог, как пришёл с сервера
  let shown = 0;          // сколько карточек уже отрисовано
  let searchQuery = "";
  let searchTimer = null;

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && Array.isArray(parsed.items) ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeCache(items) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ items, saved_at: Date.now() }));
    } catch {
      // переполнение хранилища не должно ломать экран
    }
  }

  // Точечное обновление кэша после выдачи, приёма или дефекта — чтобы не
  // перезапрашивать весь каталог из-за одной изменившейся позиции.
  function patchCached(itemId, patch) {
    const cache = readCache();
    if (!cache) return;
    const idx = cache.items.findIndex((i) => String(i.item_id) === String(itemId));
    if (idx === -1) return;
    cache.items[idx] = { ...cache.items[idx], ...patch };
    writeCache(cache.items);
  }

  function populateSelects() {
    const catSel = document.getElementById("catalog-filter-category");
    const statusSel = document.getElementById("catalog-filter-status");
    const newItemCat = document.getElementById("new-item-category");

    catSel.innerHTML = `<option value="all">Все категории</option>` +
      CONFIG.CATEGORIES.map((c) => `<option value="${c.code}">${escapeHtml(c.label)}</option>`).join("");

    statusSel.innerHTML = `
      <option value="all">Все статусы</option>
      <option value="Available">Доступно</option>
      <option value="Rented">В аренде</option>
      <option value="In Repair">В ремонте</option>
      <option value="Retired">Списано</option>`;

    newItemCat.innerHTML = CONFIG.CATEGORIES.map((c) => `<option value="${c.code}">${escapeHtml(c.label)}</option>`).join("");
  }

  // Справочник моделей выбранной категории: из него собирается номер XXYYZZ.
  async function loadModels() {
    const sel = document.getElementById("new-item-model");
    const category = document.getElementById("new-item-category").value;
    sel.innerHTML = `<option value="">Загрузка…</option>`;
    try {
      const models = await apiPost("/models/list", { category });
      sel.innerHTML = models.map((m) =>
        `<option value="${m.model_code}">${escapeHtml(m.model_name)}</option>`).join("") +
        `<option value="__new">+ Новая модель</option>`;
      if (!models.length) sel.value = "__new";
      toggleNewModel();
    } catch (err) {
      sel.innerHTML = `<option value="__new">+ Новая модель</option>`;
      toggleNewModel();
      showBoxError("catalog-add-error", err.message);
    }
  }

  function toggleNewModel() {
    const isNew = document.getElementById("new-item-model").value === "__new";
    document.getElementById("new-model-wrap").style.display = isNew ? "block" : "none";
  }

  function matches(item) {
    if (currentFilters.category !== "all" && item.category !== currentFilters.category) return false;
    if (currentFilters.status !== "all" && item.status !== currentFilters.status) return false;
    if (!searchQuery) return true;
    const haystack = [item.name, item.item_id, item.serial_number, item.inventory_number]
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.indexOf(searchQuery) !== -1;
  }

  function cardHtml(item) {
    return `
      <div class="card" data-item-id="${escapeHtml(item.item_id)}">
        <div class="card-title">${escapeHtml(item.name)} ${statusBadge(item.status)}</div>
        <div class="card-sub">${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(item.item_id)}${item.inventory_number ? " · инв. " + escapeHtml(item.inventory_number) : ""}</div>
      </div>`;
  }

  function bindCards(container) {
    container.querySelectorAll("[data-item-id]").forEach((el) => {
      if (el.dataset.bound) return;
      el.dataset.bound = "1";
      el.addEventListener("click", () => Router.navigate("item", { itemId: el.dataset.itemId }));
    });
  }

  // Рисуем порциями: 628 карточек разом создавать незачем, страница от этого
  // только тормозит.
  function render(reset = true) {
    const list = document.getElementById("catalog-list");
    const more = document.getElementById("catalog-more");
    const filtered = allItems.filter(matches);

    if (reset) {
      list.innerHTML = "";
      shown = 0;
    }
    if (!filtered.length) {
      list.innerHTML = `<p class="empty">Ничего не найдено</p>`;
      more.innerHTML = "";
      return;
    }

    const next = filtered.slice(shown, shown + PAGE_SIZE);
    list.insertAdjacentHTML("beforeend", next.map(cardHtml).join(""));
    shown += next.length;
    bindCards(list);

    more.innerHTML = shown < filtered.length
      ? `<button class="btn btn--secondary" id="catalog-more-btn">Показать ещё (${filtered.length - shown})</button>`
      : `<p class="hint">Показано ${filtered.length} из ${allItems.length}</p>`;
    const btn = document.getElementById("catalog-more-btn");
    if (btn) btn.addEventListener("click", () => render(false));
  }

  async function loadList({ useCache = true } = {}) {
    const list = document.getElementById("catalog-list");
    const cache = useCache ? readCache() : null;

    if (cache && cache.items.length) {
      allItems = cache.items;
      render();
    } else {
      list.innerHTML = skeleton(5);
      document.getElementById("catalog-more").innerHTML = "";
    }

    try {
      // С сервера берём каталог целиком один раз, а фильтры применяем локально:
      // при 5–8 с на запрос переспрашивать сервер на каждое переключение
      // фильтра означало бы ждать по восемь секунд на каждый тап.
      const items = await apiPost("/equipment/list", { category: "all", status: "all" });
      allItems = items;
      writeCache(items);
      render();
    } catch (err) {
      if (!allItems.length) {
        list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
        document.getElementById("catalog-more").innerHTML = "";
      } else {
        // кэш показан — не затираем его ошибкой, просто сообщаем
        showBoxError("catalog-add-error", "Не удалось обновить список: " + err.message);
      }
    }
  }

  function resetAddForm() {
    document.getElementById("catalog-add-form").style.display = "none";
    document.getElementById("catalog-qr-result").style.display = "none";
    document.getElementById("catalog-qr-result").innerHTML = "";
    document.getElementById("new-item-name").value = "";
    document.getElementById("new-model-wrap").style.display = "none";
    document.getElementById("new-item-serial").value = "";
    document.getElementById("new-item-inventory").value = "";
    document.getElementById("new-item-notes").value = "";
    showBoxError("catalog-add-error", "");
  }

  async function submitNewItem() {
    const category = document.getElementById("new-item-category").value;
    const modelChoice = document.getElementById("new-item-model").value;
    const name = document.getElementById("new-item-name").value.trim();
    const serial_number = document.getElementById("new-item-serial").value.trim();
    const inventory_number = document.getElementById("new-item-inventory").value.trim();
    const condition_notes = document.getElementById("new-item-notes").value.trim();
    showBoxError("catalog-add-error", "");
    if (!modelChoice) {
      showBoxError("catalog-add-error", "Выберите модель");
      return;
    }
    if (modelChoice === "__new" && !name) {
      showBoxError("catalog-add-error", "Укажите название новой модели");
      return;
    }
    const btn = document.getElementById("new-item-submit");
    btn.disabled = true;
    btn.textContent = "Создаём…";
    try {
      const payload = { category, serial_number, inventory_number, condition_notes };
      if (modelChoice === "__new") payload.model_name = name;
      else payload.model_code = Number(modelChoice);
      const { item_id } = await apiPost("/item/create", payload);
      TG.hapticSuccess();
      renderQrResult(item_id, name);
      document.getElementById("catalog-add-form").style.display = "none";
      loadModels();
      loadList({ useCache: false });
    } catch (err) {
      TG.hapticError();
      showBoxError("catalog-add-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Создать и получить QR";
    }
  }

  function renderQrResult(itemId, name) {
    const box = document.getElementById("catalog-qr-result");
    box.style.display = "block";
    box.innerHTML = `
      <h2>Готово: ${escapeHtml(itemId)}</h2>
      <div class="qr-wrap">
        <canvas id="new-item-qr-canvas"></canvas>
        <div class="qr-id">${escapeHtml(itemId)}</div>
      </div>
      <button class="btn" id="qr-download-btn">Скачать QR (PNG)</button>
      <p class="hint">Распечатать этикетку можно с компьютера, открыв сохранённый файл, либо переслав его себе через Telegram.</p>
    `;
    const canvas = document.getElementById("new-item-qr-canvas");
    QR.render(canvas, itemId, 8);
    document.getElementById("qr-download-btn").addEventListener("click", () => {
      QR.downloadCanvas(canvas, `${itemId}.png`);
    });
  }

  function onShow() {
    populateSelects();
    resetAddForm();
    loadList();
  }

  function init() {
    document.getElementById("catalog-filter-category").addEventListener("change", (e) => {
      currentFilters.category = e.target.value;
      render();
    });
    document.getElementById("catalog-filter-status").addEventListener("change", (e) => {
      currentFilters.status = e.target.value;
      render();
    });
    document.getElementById("catalog-search").addEventListener("input", (e) => {
      // небольшая пауза, чтобы не перерисовывать список на каждую букву
      clearTimeout(searchTimer);
      const value = e.target.value.trim().toLowerCase();
      searchTimer = setTimeout(() => {
        searchQuery = value;
        render();
      }, 120);
    });
    document.getElementById("catalog-add-toggle").addEventListener("click", () => {
      const form = document.getElementById("catalog-add-form");
      const opening = form.style.display === "none";
      form.style.display = opening ? "block" : "none";
      if (opening) loadModels();
    });
    document.getElementById("new-item-category").addEventListener("change", loadModels);
    document.getElementById("new-item-model").addEventListener("change", toggleNewModel);
    document.getElementById("new-item-submit").addEventListener("click", submitNewItem);
    Router.register("catalog", { onShow });
  }

  return { init, loadList, patchCached };
})();
