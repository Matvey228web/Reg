// Экран "Сканировать": нативный QR-сканер Telegram → поиск предмета →
// оформление выдачи / приёма / дефекта в зависимости от текущего статуса.

const ScanScreen = (() => {
  let currentItem = null;
  let orders = [];
  let mode = null; // "checkout" | "checkin" | "defect"

  function reset() {
    currentItem = null;
    mode = null;
    document.getElementById("scan-result").innerHTML = "";
    // Пока предмет не найден, сканирование — главное действие экрана. Как только
    // он найден и открыта форма выдачи, главным становится «Подтвердить», а
    // сканирование уходит на второй план.
    const startBtn = document.getElementById("scan-start-btn");
    document.getElementById("scan-start-text").textContent = "Сканировать";
    startBtn.classList.remove("btn--secondary");
    showBoxError("scan-error", "");
    TG.mainButton.hide();
  }

  // silent: при автозапуске не показываем ошибку «сканера нет» — в обычном
  // браузере его и не должно быть, там работают ручной ввод и кнопка.
  async function startScan(silent) {
    showBoxError("scan-error", "");
    if (silent && !TG.hasScanQr()) return;
    QR.scan(async (code, error) => {
      if (error) {
        if (!silent) showBoxError("scan-error", error);
        return;
      }
      if (!code) return;
      await lookup(code.trim());
    });
  }

  async function lookup(itemId) {
    const result = document.getElementById("scan-result");
    result.innerHTML = skeleton(2);
    try {
      const item = await apiPost("/item/lookup", { item_id: itemId });
      currentItem = item;
      // Статус мог измениться — поправим его в кэше каталога, чтобы список не
      // показывал устаревшее «Доступно» до следующего обновления.
      Cache.patch("equipment", "item_id", item.item_id, { status: item.status });
      mode = canCheckout(item) ? "checkout" : canCheckin(item) ? "checkin" : null;
      if (mode === "checkout") await loadOrders();
      document.getElementById("scan-start-text").textContent = "Сканировать ещё раз";
      document.getElementById("scan-start-btn").classList.add("btn--secondary");
      renderItem();
    } catch (err) {
      currentItem = null;
      result.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // Заказы берём из общего кэша: на выдаче человек стоит у стойки, и лишние
  // 5–8 секунд здесь заметнее всего. Если кэша нет — запрашиваем один раз и
  // кладём туда же, откуда потом их прочитает вкладка «Заказы».
  async function loadOrders() {
    let all = Cache.items("orders");
    if (!all) {
      try {
        all = await apiPost("/orders/list", { status: "all" });
        Cache.set("orders", all);
      } catch {
        all = [];
      }
    }
    // Выдавать можно по заказу, который оформлен или уже частично выдан.
    orders = all.filter((o) => o.status === "New" || o.status === "Issued");
  }

  function orderLabel(order) {
    const who = String(order.student_name || "").split(" ").slice(0, 2).join(" ");
    const until = order.return_date ? " · до " + order.return_date : "";
    return `№${order.order_no} · ${who}${until}`;
  }

  // У штучной позиции статус описывает кучу целиком, а выдавать и принимать
  // можно, пока есть остаток или что-то на руках.
  function canCheckout(item) {
    if (item.by_qty) return Number(item.qty_free || 0) > 0 && item.status !== "In Repair" && item.status !== "Retired";
    return item.status === "Available";
  }
  function canCheckin(item) {
    if (item.by_qty) return Number(item.qty_out || 0) > 0;
    return item.status === "Rented";
  }

  function renderItem() {
    const result = document.getElementById("scan-result");
    const item = currentItem;
    const defectsHtml = item.open_defects && item.open_defects.length
      ? `<p class="hint">Открытые дефекты: ${item.open_defects.length}</p>` : "";

    const bulk = !!item.by_qty;
    result.innerHTML = `
      <div class="card">
        <div class="card-title">${escapeHtml(item.name)} ${statusBadge(item.status)}</div>
        <div class="card-sub">${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(item.item_id)}${bulk ? " · " + escapeHtml(qtyText(item)) : ""}</div>
      </div>
      ${defectsHtml}
      <div class="filters" style="margin-top:12px;">
        <button class="btn ${mode === "checkout" ? "" : "btn--secondary"}" id="mode-checkout" ${canCheckout(item) ? "" : "disabled"} style="width:auto;">Выдать</button>
        <button class="btn ${mode === "checkin" ? "" : "btn--secondary"}" id="mode-checkin" ${canCheckin(item) ? "" : "disabled"} style="width:auto;">Принять</button>
        <button class="btn ${mode === "defect" ? "" : "btn--secondary"}" id="mode-defect" style="width:auto;">Дефект</button>
      </div>
      <div id="mode-form"></div>
    `;
    document.getElementById("mode-checkout").addEventListener("click", async () => {
      mode = "checkout"; await loadOrders(); renderItem(); renderForm();
    });
    document.getElementById("mode-checkin").addEventListener("click", () => { mode = "checkin"; renderItem(); renderForm(); });
    document.getElementById("mode-defect").addEventListener("click", () => { mode = "defect"; renderItem(); renderForm(); });
    renderForm();
  }

  function renderForm() {
    const box = document.getElementById("mode-form");
    if (!box) return;
    if (mode === "checkout") {
      box.innerHTML = `
        <div class="section">
          <div class="field">
            <label for="scan-order">Заказ</label>
            <select id="scan-order">
              <option value="">— выберите —</option>
              ${orders.map((o) => `<option value="${o.order_id}" data-return="${escapeHtml(o.return_date || "")}">${escapeHtml(orderLabel(o))}</option>`).join("")}
              <option value="none">Без заказа (для склада)</option>
            </select>
            ${orders.length ? "" : `<p class="hint">Активных заказов нет. Заведите его во вкладке «Заказы»
            или выдайте без заказа.</p>`}
          </div>
          ${currentItem.by_qty ? `
          <div class="field">
            <label for="scan-qty">Сколько выдаём</label>
            <input type="number" id="scan-qty" inputmode="numeric" min="1" step="1"
                   max="${Number(currentItem.qty_free || 1)}" value="1" />
            <p class="hint">${escapeHtml(qtyText(currentItem))}</p>
          </div>` : ""}
          <div class="field">
            <label for="scan-return-date">Ожидаемая дата возврата</label>
            <input type="date" id="scan-return-date" />
            <p class="hint">Подставляется из заказа; можно поправить.</p>
          </div>
          <div class="field">
            <label for="scan-notes">Заметки</label>
            <textarea id="scan-notes"></textarea>
          </div>
        </div>`;
      // Срок возврата приходит из заказа — вводить его заново значит рано или
      // поздно ввести не то, что обещано студенту на сайте.
      document.getElementById("scan-order").addEventListener("change", (e) => {
        const picked = e.target.selectedOptions[0];
        const date = picked ? picked.dataset.return : "";
        if (date) document.getElementById("scan-return-date").value = date;
      });
      TG.mainButton.show("Подтвердить выдачу", submitCheckout);
    } else if (mode === "checkin") {
      box.innerHTML = `
        <div class="section">
          ${currentItem.by_qty ? `
          <div class="field">
            <label for="scan-qty-in">Сколько принимаем</label>
            <input type="number" id="scan-qty-in" inputmode="numeric" min="1" step="1"
                   max="${Number(currentItem.qty_out || 1)}" value="${Number(currentItem.qty_out || 1)}" />
            <p class="hint">На руках ${Number(currentItem.qty_out || 0)} ${plural(Number(currentItem.qty_out || 0), "штука", "штуки", "штук")}.</p>
          </div>` : ""}
          <div class="toggle-row">
            <label for="scan-has-defect">Обнаружен дефект?</label>
            <input type="checkbox" id="scan-has-defect" />
          </div>
          <div id="scan-defect-fields" style="display:none;">
            <div class="field">
              <label for="scan-defect-desc">Описание дефекта</label>
              <textarea id="scan-defect-desc"></textarea>
            </div>
            <div class="field">
              <label for="scan-defect-severity">Серьёзность</label>
              <select id="scan-defect-severity">
                <option value="Minor">Незначительный — можно выдавать</option>
                <option value="Major">Серьёзный — снять с выдачи</option>
                <option value="Out of Service">Не работает — снять с выдачи</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label for="scan-checkin-notes">Заметки</label>
            <textarea id="scan-checkin-notes"></textarea>
          </div>
        </div>`;
      document.getElementById("scan-has-defect").addEventListener("change", (e) => {
        document.getElementById("scan-defect-fields").style.display = e.target.checked ? "block" : "none";
      });
      TG.mainButton.show("Подтвердить приём", submitCheckin);
    } else if (mode === "defect") {
      box.innerHTML = `
        <div class="section">
          <div class="field">
            <label for="scan-standalone-desc">Описание дефекта</label>
            <textarea id="scan-standalone-desc"></textarea>
          </div>
          <div class="field">
            <label for="scan-standalone-severity">Серьёзность</label>
            <select id="scan-standalone-severity">
              <option value="Minor">Незначительный — можно выдавать</option>
              <option value="Major">Серьёзный — снять с выдачи</option>
              <option value="Out of Service">Не работает — снять с выдачи</option>
            </select>
          </div>
        </div>`;
      TG.mainButton.show("Сохранить дефект", submitDefect);
    } else {
      box.innerHTML = "";
      TG.mainButton.hide();
    }
  }

  async function submitCheckout() {
    const picked = document.getElementById("scan-order").value;
    // «Без заказа» выбирается сознательно: иначе выдача без заказа случалась бы
    // просто от того, что список не пролистали.
    if (!picked) { TG.showAlert("Выберите заказ или «Без заказа»"); return; }
    const orderId = picked === "none" ? null : Number(picked);
    TG.mainButton.setLoading(true);
    try {
      const qtyField = document.getElementById("scan-qty");
      const result = await apiPost("/transaction/checkout", {
        item_id: currentItem.item_id,
        order_id: orderId,
        qty: qtyField ? Number(qtyField.value) || 1 : 1,
        expected_return_at: document.getElementById("scan-return-date").value || null,
        notes: document.getElementById("scan-notes").value.trim(),
      });
      TG.hapticSuccess();
      // Выдача вне состава заказа разрешена (в заказе есть свободное поле, куда
      // технику дописывают руками), но человек должен об этом узнать сразу.
      TG.showAlert(result && result.order_line === "off-order" && orderId
        ? "Выдано. В составе заказа этой позиции нет — отмечено как «вне заказа»."
        : "Оборудование выдано");
      if (orderId) Cache.clear("orders");   // изменился статус и состав заказа
      await lookup(currentItem.item_id);
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    } finally {
      TG.mainButton.setLoading(false);
    }
  }

  async function submitCheckin() {
    const hasDefect = document.getElementById("scan-has-defect").checked;
    TG.mainButton.setLoading(true);
    try {
      const qtyInField = document.getElementById("scan-qty-in");
      await apiPost("/transaction/checkin", {
        item_id: currentItem.item_id,
        qty: qtyInField ? Number(qtyInField.value) || 1 : 1,
        has_defect: hasDefect,
        defect_description: hasDefect ? document.getElementById("scan-defect-desc").value.trim() : null,
        defect_severity: hasDefect ? document.getElementById("scan-defect-severity").value : null,
        notes: document.getElementById("scan-checkin-notes").value.trim(),
      });
      TG.hapticSuccess();
      TG.showAlert("Оборудование принято");
      if (hasDefect) Cache.clear("defects");   // в ремонте появилась запись
      Cache.clear("orders");                   // заказ мог закрыться возвратом
      await lookup(currentItem.item_id);
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    } finally {
      TG.mainButton.setLoading(false);
    }
  }

  async function submitDefect() {
    const description = document.getElementById("scan-standalone-desc").value.trim();
    if (!description) { TG.showAlert("Опишите дефект"); return; }
    TG.mainButton.setLoading(true);
    try {
      await apiPost("/defect/report", {
        item_id: currentItem.item_id,
        description,
        severity: document.getElementById("scan-standalone-severity").value,
      });
      TG.hapticSuccess();
      TG.showAlert("Дефект сохранён");
      Cache.clear("defects");
      // Перечитываем предмет, а не закрываем экран: человеку надо увидеть,
      // изменился ли статус — незначительный дефект выдачу не блокирует.
      await lookup(currentItem.item_id);
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    } finally {
      TG.mainButton.setLoading(false);
    }
  }

  function onShow() {
    reset();
    // Камера открывается сразу: на складе это главное действие, и лишний тап
    // по кнопке здесь только мешал.
    startScan(true);
  }

  function init() {
    document.getElementById("scan-start-btn").addEventListener("click", () => startScan(false));
    document.getElementById("scan-manual-submit").addEventListener("click", async () => {
      const val = document.getElementById("scan-manual-input").value.trim();
      if (!val) return;
      showBoxError("scan-error", "");
      await lookup(val);
    });
    Router.register("scan", { onShow });
  }

  return { init };
})();
