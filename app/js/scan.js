// Экран "Сканировать": нативный QR-сканер Telegram → поиск предмета →
// оформление выдачи / приёма / дефекта в зависимости от текущего статуса.

const ScanScreen = (() => {
  let currentItem = null;
  let orders = [];
  let ordersError = "";       // заказы не загрузились — сказать, а не молчать
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
    // Пример в поле ввода возвращаем к общему: прошлый номер к новому обходу
    // отношения не имеет.
    document.getElementById("scan-manual-input").placeholder = "010101";
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
    box.innerHTML = `<p class="hint">Сканер доступен только в Telegram от версии 6.4. Введите номер руками — он
  написан на наклейке под QR.</p>`;
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
      // Статус мог измениться — поправим его в кэше каталога, чтобы список не
      // показывал устаревшее «Доступно» до следующего обновления.
      Cache.patch("equipment", "item_id", item.item_id, {
        status: item.status, qty_out: item.qty_out, qty_free: item.qty_free,
      });
      await showItem(item);
    } catch (err) {
      currentItem = null;
      result.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // Предмет уже известен — после поиска, с карточки предмета или после своей
  // же выдачи. Второй раз спрашивать о нём таблицу незачем: это ещё 6–9 секунд
  // у стойки, а новое состояние мы знаем и так (ItemState в cache.js).
  async function showItem(item) {
    currentItem = item;
    // Отсканированный номер становится примером в поле ввода — серым, как
    // подсказка. Наклейки затираются, и увидеть, что именно прочиталось, —
    // единственный способ заметить, что сканер взял соседний код.
    document.getElementById("scan-manual-input").placeholder = item.item_id;
    // Если пришли с карточки с намерением («Выдать»/«Принять»), открываем
    // сразу его — иначе человек жмёт ту же кнопку второй раз.
    if (preferredMode === "checkout" && canCheckout(item)) mode = "checkout";
    else if (preferredMode === "checkin" && canCheckin(item)) mode = "checkin";
    else mode = canCheckout(item) ? "checkout" : canCheckin(item) ? "checkin" : null;
    preferredMode = null;
    if (mode === "checkout") await loadOrders();
    renderItem();
  }

  // Своя запись прошла — правим предмет на экране и строку в кэше каталога
  // одним и тем же набором изменений. extra — то, что есть только в ответе
  // /item/lookup (открытые дефекты), в строку каталога оно не идёт.
  function applyLocal(changes, extra) {
    Cache.patch("equipment", "item_id", currentItem.item_id, changes);
    currentItem = { ...currentItem, ...changes, ...(extra || {}) };
  }

  // Дефект, который только что записали, — в список открытых на экране.
  function withDefect(defectId, severity, description) {
    return {
      open_defects: (currentItem.open_defects || []).concat([{
        defect_id: defectId, item_id: currentItem.item_id, severity,
        description, status: "Open",
      }]),
    };
  }

  // Заказы берём из общего кэша: на выдаче человек стоит у стойки, и лишние
  // 5–8 секунд здесь заметнее всего. Если кэша нет — запрашиваем один раз и
  // кладём туда же, откуда потом их прочитает вкладка «Заказы».
  async function loadOrders() {
    // Заказ уже выбран на его карточке — выбирать не из чего и грузить нечего.
    if (lockedOrder) { orders = []; return; }
    let all;
    ordersError = "";
    try {
      all = await Cache.ensure("orders", "/orders/list", { status: "all" });
    } catch (err) {
      all = [];
      ordersError = err.message;
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
      </div>
      <div class="btn-row">
        <button class="btn" id="scan-order-done" type="button">Готово</button>
        <button class="btn btn--secondary" id="scan-order-exit" type="button">Выйти</button>
      </div>
      <p class="hint">«Выйти» — к обычному скану без заказа. Выданное остаётся выданным.</p>`;
    // Выход из заказа — в шапке, как у сверки в inventory.js: иначе закончить
    // заход можно было только стрелкой «назад», о которой у стойки не думают.
    // «Готово» возвращает на карточку заказа, с которой сюда пришли (она лежит
    // в стеке под сканом и сама перечитается), — там счётчик «выдано N из M».
    document.getElementById("scan-order-done").addEventListener("click", () => {
      Router.back();
    });
    // «Выйти», а не «Отменить»: отменять здесь нечего — выдачи уже записаны.
    // Экран тот же, что по вкладке «Скан»: стек сброшен, заказа нет.
    document.getElementById("scan-order-exit").addEventListener("click", () => {
      Router.reset("scan");
    });
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
      // Заказ выбран на его карточке — список из одного пункта и поле срока,
      // которое всё равно подставлено из заказа, только отнимали тап и внимание.
      // Показываем их строками только для чтения — значения те же, что уходят
      // на сервер.
      const lockedWho = lockedOrder
        ? String(lockedOrder.studentName || "").split(" ").slice(0, 2).join(" ") : "";
      box.innerHTML = `
        <div class="section form-group">
          ${lockedOrder ? `
          <div class="field">
            <label for="scan-order-locked">Заказ</label>
            <input type="text" id="scan-order-locked" readonly tabindex="-1"
                   value="${escapeHtml("№" + lockedOrder.orderNo + (lockedWho ? " · " + lockedWho : ""))}" />
            <input type="hidden" id="scan-order" value="${escapeHtml(String(lockedOrder.orderId))}" />
          </div>` : `
          <div class="field">
            <label for="scan-order">Заказ</label>
            <select id="scan-order">
              <option value="">— выберите —</option>
              ${orders.map((o) => `<option value="${o.order_id}" data-return="${escapeHtml(o.return_date || "")}">${escapeHtml(orderLabel(o))}</option>`).join("")}
              <option value="none">Без заказа (для склада)</option>
            </select>
            ${ordersError ? `<p class="hint">Заказы не загрузились: ${escapeHtml(ordersError)}
            Выдать можно без заказа или открыть предмет заново.</p>`
            : orders.length ? "" : `<p class="hint">Активных заказов нет. Заведите его во вкладке «Заказы»
            или выдайте без заказа.</p>`}
          </div>`}
          ${currentItem.by_qty ? `
          <div class="field">
            <label for="scan-qty">Сколько выдаём</label>
            <input type="number" id="scan-qty" inputmode="numeric" min="1" step="1"
                   max="${Number(currentItem.qty_free || 1)}" value="1" />
            <p class="hint">${escapeHtml(qtyText(currentItem))}</p>
          </div>` : ""}
          ${lockedOrder ? `
          <div class="field">
            <label for="scan-return-date">Вернуть до</label>
            <input type="text" id="scan-return-date" readonly tabindex="-1"
                   value="${escapeHtml(lockedOrder.returnDate || "")}" placeholder="не указано в заказе" />
          </div>` : `
          <div class="field">
            <label for="scan-return-date">Ожидаемая дата возврата</label>
            <input type="date" id="scan-return-date" />
            <p class="hint">Подставляется из заказа; можно поправить.</p>
          </div>`}
          <div class="field field--stacked">
            <label for="scan-notes">Заметки</label>
            <textarea id="scan-notes"></textarea>
          </div>
        </div>`;
      // Срок возврата приходит из заказа — вводить его заново значит рано или
      // поздно ввести не то, что обещано студенту на сайте.
      if (!lockedOrder) {
        document.getElementById("scan-order").addEventListener("change", (e) => {
          const picked = e.target.selectedOptions[0];
          const date = picked ? picked.dataset.return : "";
          if (date) document.getElementById("scan-return-date").value = date;
        });
      }
      confirmButton("Подтвердить выдачу", submitCheckout);
    } else if (mode === "checkin") {
      box.innerHTML = `
        <div class="section form-group">
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
        </div>
        <div id="scan-defect-fields" class="form-group" style="display:none;">
            <div class="field field--stacked">
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
        <div class="form-group">
          <div class="field field--stacked">
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
        <div class="section form-group">
          <div class="field field--stacked">
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
      const qty = qtyField ? Number(qtyField.value) || 1 : 1;
      const result = await apiPost("/transaction/checkout", {
        item_id: currentItem.item_id,
        order_id: orderId,
        qty,
        expected_return_at: field("scan-return-date").value || null,
        notes: field("scan-notes").value.trim(),
      });
      // Без окон: вибрации и отметки в списке сеанса достаточно. Окно «Выдано»
      // после каждой позиции — лишний тап на десятке позиций подряд.
      TG.hapticSuccess();
      // Выдача вне состава заказа разрешена (акт пересобирается сам) — отмечаем
      // её в списке выданного за заход, а не останавливаем человека.
      const offOrder = !!(result && result.order_line === "off-order" && orderId);
      if (orderId) Cache.clear("orders");   // изменился статус и состав заказа
      // Что стало с предметом, известно без нового поиска: выдали столько-то.
      applyLocal(ItemState.afterCheckout(currentItem, qty, result && result.transaction_id));
      // Выдача по заказу — это подряд десяток позиций. Показывать после каждой
      // ту же карточку и ждать, пока человек сам нажмёт «сканировать», значит
      // добавить к каждой позиции лишний тап: сразу открываем сканер снова.
      if (lockedOrder) {
        // У штучных позиций важно, сколько ушло: «Кабель XLR — 4 шт».
        const qtyNote = currentItem.by_qty && qtyField ? " — " + qty + " шт" : "";
        session.push(currentItem.name + qtyNote + (offOrder ? " — сверх заявки" : ""));
        currentItem = null;
        mode = null;
        document.getElementById("scan-result").innerHTML = "";
        renderOrderBar();
        startScan(true);
        return;
      }
      await showItem(currentItem);
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
      const qty = qtyInField ? Number(qtyInField.value) || 1 : 1;
      const description = hasDefect ? field("scan-defect-desc").value.trim() : null;
      const severity = hasDefect ? field("scan-defect-severity").value : null;
      const res = await apiPost("/transaction/checkin", {
        item_id: currentItem.item_id,
        qty,
        has_defect: hasDefect,
        defect_description: description,
        defect_severity: severity,
        notes: field("scan-checkin-notes").value.trim(),
      });
      TG.hapticSuccess();
      TG.showAlert("Оборудование принято");
      if (hasDefect) Cache.clear("defects");   // в ремонте появилась запись
      Cache.clear("orders");                   // заказ мог закрыться возвратом
      applyLocal(ItemState.afterCheckin(currentItem, qty, severity, res && res.qty_out), {
        current_transaction: null,
        ...(hasDefect ? withDefect(res && res.defect_id, severity, description) : {}),
      });
      await showItem(currentItem);
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
      const severity = field("scan-standalone-severity").value;
      const res = await apiPost("/defect/report", {
        item_id: currentItem.item_id,
        description,
        severity,
      });
      TG.hapticSuccess();
      TG.showAlert("Дефект сохранён");
      Cache.clear("defects");
      // Показываем предмет заново, а не закрываем экран: человеку надо увидеть,
      // изменился ли статус — незначительный дефект выдачу не блокирует.
      // Новый статус бэкенд вернул в ответе, перечитывать предмет не нужно.
      applyLocal(ItemState.afterDefect(currentItem, severity, res && res.status),
        withDefect(res && res.defect_id, severity, description));
      await showItem(currentItem);
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
    // Карточка передаёт и сам предмет, раз уже знает его: второй поиск того
    // же номера — ещё 6–9 секунд ради того, что на экране уже было.
    if (params && params.itemId) {
      if (params.mode) preferredMode = params.mode;
      const known = params.item;
      // «Назад» на этот экран придёт с теми же params — тогда предмет мог
      // измениться, и честнее поискать его заново.
      delete params.item;
      if (known && String(known.item_id) === String(params.itemId)) {
        document.getElementById("scan-result").innerHTML = skeleton(2);
        showItem(known);
      } else {
        lookup(String(params.itemId));
      }
      return;
    }
    // Камера открывается сразу: на складе это главное действие. Повторный тап
    // по вкладке «Скан» снова приводит сюда же и открывает её заново — отдельная
    // кнопка для этого не нужна.
    startScan(true);
  }

  function init() {
    document.getElementById("scan-manual-submit").addEventListener("click", async () => {
      // На этикетке номер напечатан группами — «01 01 01»: так его диктуют и
      // набирают. Пробелы и дефисы при вводе поэтому просто выкидываем, иначе
      // человек вводит ровно то, что видит, и получает «предмет не найден».
      const val = document.getElementById("scan-manual-input").value.replace(/[\s\-]/g, "");
      if (!val) return;
      showBoxError("scan-error", "");
      await lookup(val);
    });
    Router.register("scan", { onShow });
  }

  return { init };
})();
