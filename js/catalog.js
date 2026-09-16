// Экран "Каталог": список оборудования с фильтрами и поиском + форма добавления
// нового предмета с QR.
//
// Про скорость. Бэкенд на Apps Script отвечает 5–8 секунд — это его потолок, а
// не наш код (замерено). Поэтому список живёт в общем кэше (js/cache.js):
// экран рисуется мгновенно, поиск и фильтры считаются локально, а на сервер
// мы идём только когда кэша нет, он устарел или человек нажал «Обновить».

const CatalogScreen = (() => {
  const CACHE = "equipment";
  const PAGE_SIZE = 50;

  let currentFilters = { category: "all", status: "all" };
  let allItems = [];      // весь каталог, как пришёл с сервера
  let shown = 0;          // сколько карточек уже отрисовано
  let searchQuery = "";
  let searchTimer = null;
  let busy = false;

  function populateSelects() {
    const catSel = document.getElementById("catalog-filter-category");
    const statusSel = document.getElementById("catalog-filter-status");
    const newItemCat = document.getElementById("new-item-category");

    const cats = categoryList();
    catSel.innerHTML = `<option value="all">Все категории</option>` +
      cats.map((c) => `<option value="${c.code}">${escapeHtml(c.label)}</option>`).join("");

    statusSel.innerHTML = `
      <option value="all">Все статусы</option>
      <option value="Available">Доступно</option>
      <option value="Rented">В аренде</option>
      <option value="In Repair">В ремонте</option>
      <option value="Retired">Списано</option>`;

    newItemCat.innerHTML = cats.map((c) => `<option value="${c.code}">${escapeHtml(c.label)}</option>`).join("");
  }

  // Справочник моделей выбранной категории: из него собирается номер XXYYZZ.
  async function loadModels() {
    applyCategoryMode();
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

  // Поля формы зависят от способа учёта: у кучи мешков нет заводского номера,
  // зато есть количество; у камеры наоборот.
  function applyCategoryMode() {
    const category = document.getElementById("new-item-category").value;
    const bulk = categoryByQty(category);
    document.getElementById("new-item-qty-wrap").style.display = bulk ? "" : "none";
    document.getElementById("new-item-serial-wrap").style.display = bulk ? "none" : "";
    document.getElementById("new-item-inventory-wrap").style.display = bulk ? "none" : "";
    document.getElementById("new-item-submit").textContent =
      bulk ? "Добавить на склад" : "Создать и получить QR";
  }

  function matches(item) {
    if (currentFilters.category !== "all" && item.category !== currentFilters.category) return false;
    if (currentFilters.status !== "all" && item.status !== currentFilters.status) return false;
    if (!searchQuery) return true;
    // Ищем и по названию категории: «свет» должно находить осветители, даже
    // когда фильтр стоит на «всех». Номера сравниваем без пробелов и дефисов —
    // их диктуют и записывают по-разному.
    const haystack = [item.name, item.item_id, item.serial_number,
                      item.inventory_number, categoryLabel(item.category)]
      .filter(Boolean).join(" ").toLowerCase();
    if (haystack.indexOf(searchQuery) !== -1) return true;
    const digits = searchQuery.replace(/[\s\-]/g, "");
    if (!digits) return false;
    return [item.item_id, item.serial_number, item.inventory_number]
      .filter(Boolean).join(" ").toLowerCase().replace(/[\s\-]/g, "").indexOf(digits) !== -1;
  }

  function cardHtml(item) {
    // У штучных позиций важен не статус, а остаток: «в аренде» про кучу мешков
    // не говорит ничего, а «21 из 25 свободно» говорит всё.
    const bulk = categoryByQty(item.category);
    const meta = [categoryLabel(item.category), item.item_id];
    if (bulk) meta.push(qtyText(item));
    else if (item.inventory_number) meta.push("инв. " + item.inventory_number);
    return `
      <div class="card" data-item-id="${escapeHtml(item.item_id)}">
        <div class="card-title">${escapeHtml(item.name)} ${statusChip(item.status)}</div>
        <div class="card-sub">${escapeHtml(meta.join(" · "))}</div>
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

  function drawRefreshRow() {
    renderRefreshRow("catalog-refresh", CACHE, () => loadList({ force: true }), busy);
  }

  // force — нажали «Обновить». Без него на сервер идём только при отсутствии
  // кэша или когда он устарел: иначе каждое переключение вкладки снова стоило
  // бы 5–8 секунд ожидания.
  async function loadList({ force = false } = {}) {
    const list = document.getElementById("catalog-list");
    const cached = Cache.items(CACHE);

    if (cached && cached.length) {
      allItems = cached;
      render();
    }
    drawRefreshRow();

    if (!force && cached && cached.length && Cache.isFresh(CACHE)) return;

    if (!cached || !cached.length) {
      list.innerHTML = skeleton(5);
      document.getElementById("catalog-more").innerHTML = "";
    }
    busy = true;
    drawRefreshRow();
    try {
      // Каталог берём целиком один раз, фильтры применяем локально: спрашивать
      // сервер на каждое переключение фильтра значило бы ждать снова.
      const items = await apiPost("/equipment/list", { category: "all", status: "all" }, { fresh: force });
      allItems = items;
      Cache.set(CACHE, items);
      render();
    } catch (err) {
      if (!allItems.length) {
        list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
        document.getElementById("catalog-more").innerHTML = "";
      } else {
        // кэш показан — не затираем его ошибкой, просто сообщаем
        showBoxError("catalog-add-error", "Не удалось обновить список: " + err.message);
      }
    } finally {
      busy = false;
      drawRefreshRow();
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
      if (categoryByQty(category)) {
        payload.qty = Number(document.getElementById("new-item-qty").value) || 1;
        if (payload.qty < 1) {
          showBoxError("catalog-add-error", "Количество — целое число от одного");
          btn.disabled = false;
          btn.textContent = "Создать и получить QR";
          return;
        }
      }
      const { item_id } = await apiPost("/item/create", payload);
      TG.hapticSuccess();
      renderQrResult(item_id, name);
      document.getElementById("catalog-add-form").style.display = "none";
      loadModels();
      loadList({ force: true });
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
      <button class="btn" id="qr-download-btn">Сохранить QR</button>
      <p class="hint">Скачать файл напрямую из Telegram нельзя — это ограничение
      мессенджера. Кнопка откроет системный лист «Поделиться», а если его нет —
      картинку пришлёт бот в чат склада. Печатать этикетку удобнее с экрана
      «Этикетки».</p>
    `;
    const canvas = document.getElementById("new-item-qr-canvas");
    QR.render(canvas, itemId, 8);
    const dl = document.getElementById("qr-download-btn");
    dl.addEventListener("click", () => saveImageFor(canvas, `${itemId}.png`, itemId, dl));
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
    // Подсказки считаются по уже загруженному каталогу — без запросов.
    Suggest.attach("catalog-search", (q) => Suggest.equipment(allItems, q));
    document.getElementById("catalog-add-toggle").addEventListener("click", () => {
      const form = document.getElementById("catalog-add-form");
      const opening = form.style.display === "none";
      form.style.display = opening ? "block" : "none";
      if (opening) loadModels();
    });
    document.getElementById("catalog-labels-btn")
      .addEventListener("click", () => Router.navigate("labels"));
    document.getElementById("new-item-category").addEventListener("change", loadModels);
    document.getElementById("new-item-model").addEventListener("change", toggleNewModel);
    document.getElementById("new-item-submit").addEventListener("click", submitNewItem);
    Router.register("catalog", { onShow });
  }

  return { init, loadList };
})();
