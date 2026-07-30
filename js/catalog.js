// Экран "Каталог": список оборудования с фильтрами + форма добавления нового предмета с QR.

const CatalogScreen = (() => {
  let currentFilters = { category: "all", status: "all" };

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

  async function loadList() {
    const list = document.getElementById("catalog-list");
    list.innerHTML = `<p class="empty">Загрузка…</p>`;
    try {
      const items = await apiPost("/equipment/list", currentFilters);
      if (!items.length) {
        list.innerHTML = `<p class="empty">Ничего не найдено</p>`;
        return;
      }
      list.innerHTML = items.map((item) => `
        <div class="card" data-item-id="${escapeHtml(item.item_id)}">
          <div class="card-title">${escapeHtml(item.name)} ${statusBadge(item.status)}</div>
          <div class="card-sub">${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(item.item_id)}</div>
        </div>
      `).join("");
      list.querySelectorAll("[data-item-id]").forEach((el) => {
        el.addEventListener("click", () => Router.navigate("item", { itemId: el.dataset.itemId }));
      });
    } catch (err) {
      list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  function resetAddForm() {
    document.getElementById("catalog-add-form").style.display = "none";
    document.getElementById("catalog-qr-result").style.display = "none";
    document.getElementById("catalog-qr-result").innerHTML = "";
    document.getElementById("new-item-name").value = "";
    document.getElementById("new-item-serial").value = "";
    document.getElementById("new-item-notes").value = "";
    showBoxError("catalog-add-error", "");
  }

  async function submitNewItem() {
    const name = document.getElementById("new-item-name").value.trim();
    const category = document.getElementById("new-item-category").value;
    const serial_number = document.getElementById("new-item-serial").value.trim();
    const condition_notes = document.getElementById("new-item-notes").value.trim();
    showBoxError("catalog-add-error", "");
    if (!name) {
      showBoxError("catalog-add-error", "Укажите название оборудования");
      return;
    }
    const btn = document.getElementById("new-item-submit");
    btn.disabled = true;
    btn.textContent = "Создаём…";
    try {
      const { item_id } = await apiPost("/item/create", { name, category, serial_number, condition_notes });
      TG.hapticSuccess();
      renderQrResult(item_id, name);
      document.getElementById("catalog-add-form").style.display = "none";
      loadList();
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
      loadList();
    });
    document.getElementById("catalog-filter-status").addEventListener("change", (e) => {
      currentFilters.status = e.target.value;
      loadList();
    });
    document.getElementById("catalog-add-toggle").addEventListener("click", () => {
      const form = document.getElementById("catalog-add-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("new-item-submit").addEventListener("click", submitNewItem);
    Router.register("catalog", { onShow });
  }

  return { init, loadList };
})();
