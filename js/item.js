// Экран "Карточка предмета": статус, история выдач и дефектов, быстрый репорт дефекта.

const ItemScreen = (() => {
  let currentItemId = null;
  let ordersById = {};

  // Подписи к выдачам берём из кэша заказов. Раньше карточка на каждое открытие
  // запрашивала весь список клиентов — ещё 5–8 секунд ради одной строки текста.
  function loadOrdersMap() {
    const orders = Cache.items("orders") || [];
    ordersById = Object.fromEntries(orders.map((o) => [String(o.order_id), o]));
  }

  // Старые строки журнала сделаны по прежней модели «клиент/проект»: заказа у них
  // нет, и подменять его выдумкой нельзя — показываем как есть.
  function txLabel(tx) {
    const order = ordersById[String(tx.order_id || "")];
    if (order) {
      return `№${order.order_no}` + (order.student_name ? " · " + order.student_name : "");
    }
    if (tx.order_id) return `Заказ #${tx.order_id}`;
    if (tx.client_id) return `Клиент #${tx.client_id} (старая запись)`;
    return "Без заказа";
  }

  async function load() {
    const content = document.getElementById("item-content");
    document.getElementById("item-title").textContent = currentItemId;
    content.innerHTML = `<p class="empty">Загрузка…</p>`;
    try {
      const [item, history] = await Promise.all([
        apiPost("/item/lookup", { item_id: currentItemId }),
        apiPost("/item/history", { item_id: currentItemId }),
      ]);
      loadOrdersMap();
      render(item, history);
    } catch (err) {
      content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // Выдать и принять можно прямо отсюда: карточка — то место, где человек уже
  // стоит, а раньше за этим приходилось идти в «Скан» и вводить номер заново.
  // Сама форма одна и та же, поэтому просто открываем её с уже найденным
  // предметом, а не копируем сюда второй экземпляр логики.
  function itemActions(item) {
    const free = item.by_qty ? Number(item.qty_free || 0) > 0 : item.status === "Available";
    const out = item.by_qty ? Number(item.qty_out || 0) > 0 : item.status === "Rented";
    const blocked = item.status === "In Repair" || item.status === "Retired";
    if (blocked || (!free && !out)) return "";
    return `
      <div class="btn-row">
        ${free ? `<button class="btn" id="item-checkout">Выдать</button>` : ""}
        ${out ? `<button class="btn ${free ? "btn--secondary" : ""}" id="item-checkin">Принять</button>` : ""}
      </div>`;
  }

  function render(item, history) {
    document.getElementById("item-title").textContent = item.name;
    const content = document.getElementById("item-content");

    const txRows = (history.transactions || [])
      .slice()
      .sort((a, b) => new Date(b.checked_out_at) - new Date(a.checked_out_at))
      .map((t) => `
        <div class="card">
          <div class="card-title">${escapeHtml(txLabel(t))} ${statusChip(t.status)}</div>
          <div class="card-sub">Выдано: ${formatDate(t.checked_out_at)}${t.checked_in_at ? " · Принято: " + formatDate(t.checked_in_at) : ""}</div>
        </div>`).join("") || `<p class="empty">Пока не было выдач</p>`;

    const defectRows = (history.defects || [])
      .slice()
      .sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at))
      .map((d) => `
        <div class="card">
          <div class="card-title">${escapeHtml(STATUS_LABELS[d.severity] || d.severity)} ${statusChip(d.status)}</div>
          <div class="card-sub">${escapeHtml(d.description || "")}</div>
          <div class="card-sub">Заявлен: ${formatDate(d.reported_at)}</div>
        </div>`).join("") || `<p class="empty">Дефектов не было</p>`;

    content.innerHTML = `
      <div class="card">
        <div class="card-title">${statusBadge(item.status)}</div>
        <div class="card-sub">${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(item.item_id)}</div>
        ${item.by_qty ? `<div class="card-sub">На складе: ${escapeHtml(qtyText(item))}</div>` : ""}
        ${item.serial_number ? `<div class="card-sub">Заводской №: ${escapeHtml(item.serial_number)}</div>` : ""}
        ${item.inventory_number ? `<div class="card-sub">Инвентарный №: ${escapeHtml(item.inventory_number)}</div>` : ""}
        ${item.condition_notes ? `<div class="card-sub">${escapeHtml(item.condition_notes)}</div>` : ""}
      </div>

      <div class="section">
        <div class="section-title">${item.by_qty ? "QR-код полки" : "QR-код предмета"}</div>
        ${item.by_qty ? `<p class="hint">У штучных позиций личных номеров нет — этот код
        относится ко всей полке. Наклейте его на ящик: сканирование откроет остаток
        и форму выдачи количеством.</p>` : ""}
        <div class="qr-wrap">
          <canvas id="item-qr-canvas"></canvas>
          <div class="qr-id">${escapeHtml(item.item_id)}</div>
        </div>
        <div class="btn-row btn-row--equal">
          <button class="btn btn--secondary" id="item-qr-big">Этикетка крупно</button>
          <button class="btn btn--secondary" id="item-qr-download">Сохранить</button>
          <button class="btn btn--secondary" id="item-qr-label">Этикетка</button>
        </div>
        <p class="hint">Скачать файл напрямую из Telegram нельзя — это ограничение
        мессенджера. «Сохранить» откроет системный лист «Поделиться», а если его
        нет — картинку пришлёт бот в чат склада.</p>
      </div>

      <div class="section">
        <div class="section-title">История выдач</div>
        ${txRows}
      </div>

      <div class="section">
        <div class="section-title">История дефектов</div>
        ${defectRows}
      </div>

      <div class="section">
        ${itemActions(item)}
        <button class="btn btn--secondary" id="item-report-defect-toggle">Сообщить о дефекте</button>
        <div id="item-defect-form" style="display:none;">
          <div class="form-group">
          <div class="field field--stacked">
            <label for="item-defect-desc">Описание</label>
            <textarea id="item-defect-desc"></textarea>
          </div>
          <div class="field">
            <label for="item-defect-severity">Серьёзность</label>
            <select id="item-defect-severity">
              <option value="Minor">Незначительный — можно выдавать</option>
              <option value="Major">Серьёзный — снять с выдачи</option>
              <option value="Out of Service">Не работает — снять с выдачи</option>
            </select>
          </div>
          </div>
          <button class="btn" id="item-defect-submit">Сохранить дефект</button>
        </div>
      </div>
    `;

    // QR у импортированных позиций раньше получить было нельзя: генерация
    // жила только на экране создания новой позиции.
    const qrCanvas = document.getElementById("item-qr-canvas");
    QR.render(qrCanvas, item.item_id, 8);
    // Сохраняем и показываем этикетку, а не голый QR: наклеивают на вещь
    // именно её, и «сохранил картинку, а там один код» — это не то, что нужно.
    const dl = document.getElementById("item-qr-download");
    dl.addEventListener("click", () => saveImageFor(
      LabelsScreen.labelFor(item), LabelsScreen.labelFileName(item), item.name, dl));
    document.getElementById("item-qr-big").addEventListener("click", () => {
      // Тем же наложением, что на экране «Этикетки». Отсканировать вторым
      // телефоном по ней можно так же — QR внутри.
      QR.showImage(LabelsScreen.labelFor(item), item.name + " · " + item.item_id, "",
        () => saveImageFor(LabelsScreen.labelFor(item), LabelsScreen.labelFileName(item),
                           item.name, document.getElementById("qr-overlay-save")));
    });
    document.getElementById("item-qr-label").addEventListener("click", () => {
      Router.navigate("labels", { itemId: item.item_id });
    });

    const goScan = (mode) => Router.navigate("scan", { itemId: item.item_id, mode });
    const checkoutBtn = document.getElementById("item-checkout");
    if (checkoutBtn) checkoutBtn.addEventListener("click", () => goScan("checkout"));
    const checkinBtn = document.getElementById("item-checkin");
    if (checkinBtn) checkinBtn.addEventListener("click", () => goScan("checkin"));

    document.getElementById("item-report-defect-toggle").addEventListener("click", () => {
      const form = document.getElementById("item-defect-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("item-defect-submit").addEventListener("click", async () => {
      const description = document.getElementById("item-defect-desc").value.trim();
      if (!description) { TG.showAlert("Опишите дефект"); return; }
      const btn = document.getElementById("item-defect-submit");
      btn.disabled = true;
      try {
        await apiPost("/defect/report", {
          item_id: item.item_id,
          description,
          severity: document.getElementById("item-defect-severity").value,
        });
        TG.hapticSuccess();
        TG.showAlert("Дефект сохранён");
        Cache.clear("defects");
        Cache.clear("equipment");
        load();
      } catch (err) {
        TG.hapticError();
        TG.showAlert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function onShow(params) {
    currentItemId = params.itemId;
    load();
  }

  function init() {
    Router.register("item", { onShow });
  }

  return { init };
})();
