// Экран "Сканировать": нативный QR-сканер Telegram → поиск предмета →
// оформление выдачи / приёма / дефекта в зависимости от текущего статуса.

const ScanScreen = (() => {
  let currentItem = null;
  let orders = [];
  let mode = null; // "checkout" | "checkin" | "defect"
  let preferredMode = null;   // с чем пришли с карточки предмета
  let lockedOrder = null;     // выдача по одному заказу: {orderId, orderNo, returnDate, studentName}
  let session = [];           // что уже выдано за этот заход

  function reset() {
    currentItem = null;
    mode = null;
    preferredMode = null;
    lockedOrder = null;
    session = [];
    document.getElementById("scan-order-bar").innerHTML = "";
    document.getElementById("scan-result").innerHTML = "";
    showBoxError("scan-error", "");
    // Форма ввода снова главная: предмета на экране нет.
    document.getElementById("scan-manual-wrap").classList.remove("scan-manual--tucked");
    TG.mainButton.hide();
  }

  // Кнопки «Сканировать» на экране нет: камера открывается при входе, а
  // повторный тап по вкладке «Скан» открывает её снова. Но там, где сканера
  // нет вовсе — старый клиент Telegram или обычный браузер, — молчание
  // выглядело бы поломкой, поэтому говорим об этом прямо.
  function renderCameraState() {
    const box = document.getElementById("scan-no-camera");
    const hint = document.getElementById("scan-manual-hint");
    if (TG.hasScanQr()) {
      box.innerHTML = "";
      hint.textContent = "Наведите камеру на QR — она открылась сама. " +
        "Чтобы открыть её снова, нажмите «Скан» в панели внизу.";
      return;
    }
    box.innerHTML = `<p class="hint">Сканер здесь недоступен: в обычном браузере
      его нет, а в Telegram он появляется начиная с версии 6.4. Введите номер
      с наклейки руками — он написан под QR.</p>`;
    hint.textContent = "";
  }

  // silent: при автозапуске не показываем ошибку «сканера нет» — в обычном
  // браузере его и не должно быть, там остаётся ручной ввод, и о его
  // отсутствии сказано отдельной строкой над полем.
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
      // Если пришли с карточки с намерением («Выдать»/«Принять»), открываем
      // сразу его — иначе человек жмёт ту же кнопку второй раз.
      if (preferredMode === "checkout" && canCheckout(item)) mode = "checkout";
      else if (preferredMode === "checkin" && canCheckin(item)) mode = "checkin";
      else mode = canCheckout(item) ? "checkout" : canCheckin(item) ? "checkin" : null;
      preferredMode = null;
      if (mode === "checkout") await loadOrders();
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
    // Заказ уже выбран на его карточке — выбирать не из чего и грузить нечего.
    if (lockedOrder) { orders = []; return; }
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

  // Шапка режима «выдача по заказу»: по какому заказу идёт работа и что уже
  // отсканировано за этот заход. Точного счётчика «выдано N из M» здесь нет
  // намеренно — держать его свежим значит после каждой позиции ждать ещё один
  // запрос к таблице. Счётчик живёт в карточке заказа, куда человек вернётся.
  function renderOrderBar() {
    const bar = document.getElementById("scan-order-bar");
    if (!lockedOrder) { bar.innerHTML = ""; return; }
    const who = String(lockedOrder.studentName || "").split(" ").slice(0, 2).join(" ");
    bar.innerHTML = `
      <div class="card">
        <div class="card-title">
          Выдача по заказу <span class="order-no"><span class="order-no-sign">№</span>${escapeHtml(lockedOrder.orderNo)}</span>
        </div>
        ${who ? `<div class="card-sub">${escapeHtml(who)}</div>` : ""}
        ${session.length
          ? `<div class="card-sub">В этот заход выдано: ${session.map(escapeHtml).join(", ")}</div>`
          : `<div class="card-sub">Сканируйте позиции заказа одну за другой.</div>`}
      </div>`;
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

  // Выключенная кнопка, которая молчит, — это «не работает» для человека у
  // стойки. Если выдать или принять нельзя, надо сказать почему и что делать.
  function unavailableHint(item) {
    const outText = [];
    if (!canCheckout(item)) {
      if (item.status === "In Repair") {
        outText.push("Выдать нельзя: предмет в ремонте. Закройте дефект в разделе «Ремонт».");
      } else if (item.status === "Retired") {
        outText.push("Выдать нельзя: предмет списан.");
      } else if (item.by_qty && Number(item.qty_free || 0) <= 0) {
        outText.push("Выдать нечего: все " + Number(item.qty || 0) + " на руках.");
      } else if (item.status === "Rented") {
        outText.push("Выдать нельзя: предмет уже на руках — сначала примите его.");
      }
    }
    if (!canCheckin(item)) {
      if (item.by_qty) outText.push("Принимать нечего: на руках ничего нет.");
      else if (item.status === "Available") outText.push("Принимать нечего: предмет и так на складе.");
      else if (item.status === "In Repair" || item.status === "Retired") {
        outText.push("Принять нельзя: предмет не числится выданным.");
      }
    }
    if (!outText.length) return "";
    return `<p class="hint">${outText.map(escapeHtml).join(" ")}</p>`;
  }

  // Поля читаем только так: пропавший элемент должен стать понятной ошибкой, а
  // не исключением, которое никто не ловит.
  function field(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error("stale-form:" + id);
    return el;
  }

  function formError(err) {
    return /^stale-form:/.test(String(err && err.message))
      ? "Форма устарела — отсканируйте предмет заново."
      : (err && err.message) || "Не получилось";
  }

  function renderItem() {
    // Предмет найден — главным стало подтверждение действия, а не поиск
    // следующего: убираем поле ввода на второй план, но не прячем совсем.
    document.getElementById("scan-manual-wrap").classList.add("scan-manual--tucked");
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
      ${unavailableHint(item)}
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
            ${lockedOrder ? `
            <select id="scan-order">
              <option value="${escapeHtml(String(lockedOrder.orderId))}" selected>${escapeHtml("№" + lockedOrder.orderNo)}</option>
            </select>
            <p class="hint">Выдача идёт по этому заказу. Чтобы выдать вне заказа,
            откройте «Скан» с вкладки внизу.</p>` : `
            <select id="scan-order">
              <option value="">— выберите —</option>
              ${orders.map((o) => `<option value="${o.order_id}" data-return="${escapeHtml(o.return_date || "")}">${escapeHtml(orderLabel(o))}</option>`).join("")}
              <option value="none">Без заказа (для склада)</option>
            </select>
            ${orders.length ? "" : `<p class="hint">Активных заказов нет. Заведите его во вкладке «Заказы»
            или выдайте без заказа.</p>`}`}
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
      // В списке из одного пункта события change не будет, а срок возврата всё
      // равно должен быть тем, что обещан студенту на сайте.
      if (lockedOrder && lockedOrder.returnDate) {
        document.getElementById("scan-return-date").value = lockedOrder.returnDate;
      }
      confirmButton("Подтвердить выдачу", submitCheckout);
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
      confirmButton("Подтвердить приём", submitCheckin);
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
      confirmButton("Сохранить дефект", submitDefect);
    } else {
      box.innerHTML = "";
    }
  }

  // Подтверждение живёт в самой форме, а не в нативной кнопке Telegram.
  // Нативную было не видно в браузере, её нельзя было нажать из теста, и
  // проверялся у нас поэтому путь, которым на телефоне никто не ходит.
  // Обычная кнопка одинакова везде и видна там, где заканчивается форма.
  function confirmButton(text, onSubmit) {
    const box = document.getElementById("mode-form");
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.id = "scan-confirm";
    btn.type = "button";
    btn.textContent = text;
    btn.addEventListener("click", onSubmit);
    box.appendChild(btn);
  }

  // Индикатор ожидания на той же кнопке: запрос к таблице идёт секунды, и без
  // этого человек жмёт второй раз.
  function setSubmitting(on, text) {
    const btn = document.getElementById("scan-confirm");
    if (!btn) return;
    btn.disabled = on;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = "Отправляем…";
    } else {
      btn.textContent = text || btn.dataset.label || btn.textContent;
    }
  }

  async function submitCheckout() {
    let orderId = null;
    try {
      const picked = field("scan-order").value;
      // «Без заказа» выбирается сознательно: иначе выдача без заказа случалась бы
      // просто от того, что список не пролистали.
      if (!picked) { TG.showAlert("Выберите заказ или «Без заказа»"); return; }
      orderId = picked === "none" ? null : Number(picked);
      setSubmitting(true);
      const qtyField = document.getElementById("scan-qty");
      const result = await apiPost("/transaction/checkout", {
        item_id: currentItem.item_id,
        order_id: orderId,
        qty: qtyField ? Number(qtyField.value) || 1 : 1,
        expected_return_at: field("scan-return-date").value || null,
        notes: field("scan-notes").value.trim(),
      });
      TG.hapticSuccess();
      // Выдача вне состава заказа разрешена (в заказе есть свободное поле, куда
      // технику дописывают руками), но человек должен об этом узнать сразу.
      TG.showAlert(result && result.order_line === "off-order" && orderId
        ? "Выдано. В составе заказа этой позиции нет — отмечено как «вне заказа»."
        : "Оборудование выдано");
      if (orderId) Cache.clear("orders");   // изменился статус и состав заказа
      // Выдача по заказу — это подряд десяток позиций. Показывать после каждой
      // ту же карточку и ждать, пока человек сам нажмёт «сканировать», значит
      // добавить к каждой позиции лишний тап: сразу открываем сканер снова.
      if (lockedOrder) {
        const qtyText = qtyField && Number(qtyField.value) > 1 ? " ×" + Number(qtyField.value) : "";
        session.push(currentItem.name + qtyText);
        currentItem = null;
        mode = null;
        document.getElementById("scan-result").innerHTML = "";
        renderOrderBar();
        startScan(true);
        return;
      }
      await lookup(currentItem.item_id);
    } catch (err) {
      TG.hapticError();
      TG.showAlert(formError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCheckin() {
    let hasDefect = false;
    try {
      hasDefect = field("scan-has-defect").checked;
      setSubmitting(true);
      const qtyInField = document.getElementById("scan-qty-in");
      await apiPost("/transaction/checkin", {
        item_id: currentItem.item_id,
        qty: qtyInField ? Number(qtyInField.value) || 1 : 1,
        has_defect: hasDefect,
        defect_description: hasDefect ? field("scan-defect-desc").value.trim() : null,
        defect_severity: hasDefect ? field("scan-defect-severity").value : null,
        notes: field("scan-checkin-notes").value.trim(),
      });
      TG.hapticSuccess();
      TG.showAlert("Оборудование принято");
      if (hasDefect) Cache.clear("defects");   // в ремонте появилась запись
      Cache.clear("orders");                   // заказ мог закрыться возвратом
      await lookup(currentItem.item_id);
    } catch (err) {
      TG.hapticError();
      TG.showAlert(formError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitDefect() {
    try {
      const description = field("scan-standalone-desc").value.trim();
      if (!description) { TG.showAlert("Опишите дефект"); return; }
      setSubmitting(true);
      await apiPost("/defect/report", {
        item_id: currentItem.item_id,
        description,
        severity: field("scan-standalone-severity").value,
      });
      TG.hapticSuccess();
      TG.showAlert("Дефект сохранён");
      Cache.clear("defects");
      // Перечитываем предмет, а не закрываем экран: человеку надо увидеть,
      // изменился ли статус — незначительный дефект выдачу не блокирует.
      await lookup(currentItem.item_id);
    } catch (err) {
      TG.hapticError();
      TG.showAlert(formError(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onShow(params) {
    reset();
    renderCameraState();
    // Пришли с карточки заказа: заказ выбран, дальше только сканируем позиции.
    if (params && params.orderId !== undefined && params.orderId !== null) {
      lockedOrder = {
        orderId: params.orderId,
        orderNo: params.orderNo || String(params.orderId),
        returnDate: params.returnDate || "",
        studentName: params.studentName || "",
      };
      preferredMode = "checkout";
      renderOrderBar();
      startScan(true);
      return;
    }
    // Пришли с карточки предмета: он уже выбран, сканировать нечего.
    if (params && params.itemId) {
      if (params.mode) preferredMode = params.mode;
      lookup(String(params.itemId));
      return;
    }
    // Камера открывается сразу: на складе это главное действие. Повторный тап
    // по вкладке «Скан» снова приводит сюда же и открывает её заново — отдельная
    // кнопка для этого не нужна.
    startScan(true);
  }

  function init() {
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
