const ScanScreen = (() => {
  let currentItem = null;
  let orders = [];
  let ordersError = "";       // заказы не загрузились — сказать, а не молчать
  let ordersLoading = false;  // заказы тянутся в фоне, форма уже на экране
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
    if (QR.canCamera()) {
      box.innerHTML = "";
      hint.textContent = "Наведите камеру на QR — она открылась сама. " +
        "Чтобы открыть её снова, нажмите «Скан» в панели внизу.";
      return;
    }
    // На компьютере камеры у Telegram нет, зато есть сканер штрихкодов: он
    // печатает номер сам, куда бы ни стоял курсор.
    if (QR.isDesktop()) {
      box.innerHTML = "";
      hint.textContent = "Сканируйте QR сканером или введите номер с наклейки и нажмите Enter.";
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
    if (silent && !QR.canCamera()) { focusManual(); return; }
    QR.scan(async (code, error) => {
      if (error) {
        if (!silent) showBoxError("scan-error", error);
        return;
      }
      if (!code) return;
      await handleCode(code.trim());
    });
  }

  // На телефоне не фокусируем: всплывшая клавиатура закроет пол-экрана.
  function focusManual() {
    if (!QR.isDesktop()) return;
    const input = document.getElementById("scan-manual-input");
    if (input) input.focus({ preventScroll: true });
  }

  // Сканер штрихкодов присылает номера быстрее, чем таблица отвечает (6–9
  // секунд): второй номер, пришедший во время поиска первого, ждать не будет,
  // а перерисует экран под ногами у первого. Поэтому один за раз.
  let codeBusy = false;
  async function takeCode(code) {
    if (!code || codeBusy) return;
    codeBusy = true;
    showBoxError("scan-error", "");
    try {
      await handleCode(code);
    } finally {
      codeBusy = false;
    }
  }

  // Что делать с номером, который прочитали камерой или ввели руками.
  //
  // Выдача по заказу — подряд десяток позиций, и каждый запрос к таблице стоит
  // 6–9 секунд. Если предмет штучный, лежит в кэше каталога и там «Доступно»,
  // спрашивать о нём /item/lookup незачем: заказ, срок и пустые заметки — те же,
  // что ушли бы с кнопки «Выдать», — известны. Выдаём сразу, одним запросом.
  // Кэш здесь только догадка: бэкенд всё равно проверяет выдачу, и устаревшее
  // «Доступно» кончится его отказом на экране, а не неверной записью.
  //
  // Остальное идёт через поиск и форму, как раньше: позиция количеством (надо
  // спросить, сколько), предмета нет в кэше или он там не «Доступно» — тогда
  // человек должен увидеть карточку и причину.
  async function handleCode(itemId) {
    const row = lockedOrder ? cachedRow(itemId) : null;
    if (row && !ItemState.byQty(row) && row.status === "Available") {
      quickCheckout(row);
      return;
    }
    await lookup(itemId);
  }

  function cachedRow(itemId) {
    const list = Cache.items("equipment") || [];
    return list.find((r) => String(r.item_id) === String(itemId)) || null;
  }

  // Выдача без формы — сделано как submitCheckout, только поля берутся не из
  // формы, а из заказа: на экране их и так показывали только для чтения.
  // Сразу в список захода и за следующим — запрос в фоне (inBackground).
  function quickCheckout(row) {
    const orderId = Number(lockedOrder.orderId);
    const rowBefore = { ...row };
    TG.hapticSuccess();
    Cache.patch("equipment", "item_id", row.item_id, ItemState.afterCheckout(row, 1));
    const line = row.name || row.item_id;
    nextInOrder(line);
    inBackground(rowBefore, null, (row.name || row.item_id) + " (" + row.item_id + ") не выдан",
      () => apiPost("/transaction/checkout", {
        item_id: row.item_id,
        order_id: orderId,
        qty: 1,
        expected_return_at: lockedOrder.returnDate || null,
        notes: "",
      }),
      (res) => {
        markStale("orders");     // изменился статус и состав заказа
        Cache.patch("equipment", "item_id", row.item_id,
          ItemState.afterCheckout(rowBefore, 1, res && res.transaction_id));
        if (res && res.order_line === "off-order") renameInSession(line, line + " — сверх заявки");
      },
      () => dropFromSession(line));
  }

  // Запись в таблицу — в фоне: экран уже показал результат, а таблица отвечает
  // 6–9 секунд, и ждать её над каждым предметом у стойки незачем. Сделано как
  // confirmRemove в announcements.js: откажет — откатываем строку каталога и
  // открытый предмет. Отказ приходит, когда человек уже у следующего
  // предмета, поэтому причина встаёт в отдельный список над сканом: новый код
  // его не стирает, в отличие от scan-error.
  let failed = [];
  function inBackground(rowBefore, itemBefore, label, request, onOk, onFail) {
    request().then((res) => { if (onOk) onOk(res); }).catch((err) => {
      TG.hapticError();
      if (rowBefore) Cache.patch("equipment", "item_id", rowBefore.item_id, rowBefore);
      if (itemBefore && currentItem && String(currentItem.item_id) === String(itemBefore.item_id)) {
        showItem(itemBefore);
      }
      if (onFail) onFail();
      failed.push(label + ": " + formError(err));
      renderFailed();
    });
  }

  function renderFailed() {
    const box = document.getElementById("scan-failed");
    if (!failed.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="error-box">${failed.map(escapeHtml).join("<br>")}</div>
      <button class="btn btn--secondary" id="scan-failed-clear" type="button">Понятно</button>`;
    document.getElementById("scan-failed-clear").addEventListener("click", () => {
      failed = [];
      renderFailed();
    });
  }

  function dropFromSession(line) {
    const i = session.lastIndexOf(line);
    if (i !== -1) session.splice(i, 1);
    renderOrderBar();
  }

  function renameInSession(line, next) {
    const i = session.lastIndexOf(line);
    if (i !== -1) session[i] = next;
    renderOrderBar();
  }

  // Позиция по заказу выдана: в список захода и сразу за следующей.
  function nextInOrder(line) {
    session.push(line);
    currentItem = null;
    mode = null;
    document.getElementById("scan-result").innerHTML = "";
    renderOrderBar();
    startScan(true);
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
      showItem(item);
    } catch (err) {
      currentItem = null;
      result.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // Предмет уже известен — после поиска, с карточки предмета или после своей
  // же выдачи. Второй раз спрашивать о нём таблицу незачем: это ещё 6–9 секунд
  // у стойки, а новое состояние мы знаем и так (ItemState в cache.js).
  //
  // Рисуем сразу, ничего не дожидаясь: раньше здесь ждали список заказов, и
  // после приёма кнопка висела в «Отправляем…» ещё 5–8 секунд, хотя приём
  // давно записан. Заказы для выдачи подтягиваются в фоне (prepareOrders).
  function showItem(item) {
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
    if (mode === "checkout") prepareOrders();
    renderItem();
  }

  // Список устарел своей же записью: не выбрасываем его (Cache.stale), а
  // помечаем — следующий экран покажет его сразу и обновит молча. Без
  // Cache.stale — как раньше, сбросом.
  function markStale(name) {
    if (Cache.stale) Cache.stale(name);
    else Cache.clear(name);
  }

  // Заказы для формы выдачи — без ожидания. Лежат в кэше — берём оттуда сразу.
  // Нет — форма появляется с «загружаем заказы…» в списке, а сам список
  // встаёт на место, когда придёт, и только если человек всё ещё на этой форме.
  function prepareOrders() {
    if (lockedOrder) { orders = []; return; }
    const cached = Cache.items("orders");
    if (cached) {
      ordersError = "";
      orders = activeOrders(cached);
      return;
    }
    if (ordersLoading) return;
    ordersLoading = true;
    loadOrders().finally(() => {
      ordersLoading = false;
      if (currentItem && mode === "checkout") refreshOrderField();
    });
  }

  function activeOrders(all) {
    // Выдавать можно по заказу, который оформлен или уже частично выдан.
    return all.filter((o) => o.status === "New" || o.status === "Issued");
  }

  // Своя запись прошла — правим предмет на экране и строку в кэше каталога
  // одним и тем же набором изменений. extra — то, что есть только в ответе
  // /item/lookup (открытые дефекты), в строку каталога оно не идёт.
  function applyLocal(changes, extra) {
    Cache.patch("equipment", "item_id", currentItem.item_id, changes);
    currentItem = { ...currentItem, ...changes, ...(extra || {}) };
  }

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
    orders = activeOrders(all);
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
    document.getElementById("mode-checkout").addEventListener("click", () => {
      mode = "checkout"; prepareOrders(); renderItem();
    });
    // renderItem сам рисует форму — второй renderForm только перерисовывал её.
    document.getElementById("mode-checkin").addEventListener("click", () => { mode = "checkin"; renderItem(); });
    document.getElementById("mode-defect").addEventListener("click", () => { mode = "defect"; renderItem(); });
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
          <div class="field" id="scan-order-field">${orderFieldHtml()}</div>`}
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
            <input type="date" id="scan-return-date" required placeholder="не задано" />
            <p class="hint">Подставляется из заказа; можно поправить.</p>
          </div>`}
          <div class="field field--stacked">
            <label for="scan-notes">Заметки</label>
            <textarea id="scan-notes"></textarea>
          </div>
        </div>`;
      // Срок возврата приходит из заказа — вводить его заново значит рано или
      // поздно ввести не то, что обещано студенту на сайте.
      if (!lockedOrder) wireOrderField();
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

  // Поле «Заказ» в форме выдачи — отдельно, чтобы подставить список, когда он
  // догрузится в фоне, не трогая остальную форму (заметки, количество, срок).
  // В списке — только самые свежие заказы: за сезон открытых набирается
  // десятки, и на телефоне нужный тонул в длинной прокрутке. Выдают почти
  // всегда по тому, что оформили на днях. Порядок — как во вкладке «Заказы»
  // (orders.js): новые сверху. keepId — заказ, который уже выбран в поле:
  // если он старше шести последних, он остаётся в списке, а не пропадает.
  const ORDERS_SHOWN = 6;

  function shownOrders(keepId) {
    const sorted = orders.slice().sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || "")) ||
      Number(b.order_id) - Number(a.order_id));
    const top = sorted.slice(0, ORDERS_SHOWN);
    if (keepId && !top.some((o) => String(o.order_id) === String(keepId))) {
      const kept = sorted.find((o) => String(o.order_id) === String(keepId));
      if (kept) top.push(kept);
    }
    return top;
  }

  function orderFieldHtml(keepId) {
    return `
            <label for="scan-order">Заказ</label>
            <select id="scan-order">
              <option value="">${ordersLoading ? "загружаем заказы…" : "— выберите —"}</option>
              ${shownOrders(keepId).map((o) => `<option value="${o.order_id}" data-return="${escapeHtml(o.return_date || "")}">${escapeHtml(orderLabel(o))}</option>`).join("")}
              <option value="none">Без заказа (для склада)</option>
            </select>
            ${ordersLoading ? `<p class="hint">Список заказов подгружается — можно пока заполнить остальное.</p>`
            : ordersError ? `<p class="hint">Заказы не загрузились: ${escapeHtml(ordersError)}
            Выдать можно без заказа или открыть предмет заново.</p>`
            : orders.length ? "" : `<p class="hint">Активных заказов нет. Заведите его во вкладке «Заказы»
            или выдайте без заказа.</p>`}`;
  }

  function wireOrderField() {
    document.getElementById("scan-order").addEventListener("change", (e) => {
      const picked = e.target.selectedOptions[0];
      const date = picked ? picked.dataset.return : "";
      const dateField = document.getElementById("scan-return-date");
      if (date && dateField) dateField.value = date;
    });
  }

  // Заказы догрузились, а форма выдачи уже на экране: меняем только поле
  // заказа, сохранив выбор, если его успели сделать («Без заказа»).
  function refreshOrderField() {
    const box = document.getElementById("scan-order-field");
    if (!box || lockedOrder) return;
    const was = document.getElementById("scan-order").value;
    box.innerHTML = orderFieldHtml(was);
    const select = document.getElementById("scan-order");
    if (was && Array.from(select.options).some((o) => o.value === was)) select.value = was;
    wireOrderField();
  }

  // Подтверждение живёт в самой форме, а не в нативной кнопке Telegram.
  // Нативную было не видно в браузере, её нельзя было нажать из теста, и
  // проверялся у нас поэтому путь, которым на телефоне никто не ходит.
  // Обычная кнопка одинакова везде и видна там, где заканчивается форма.
  let lastSubmitAt = 0;
  function confirmButton(text, onSubmit) {
    const box = document.getElementById("mode-form");
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.id = "scan-confirm";
    btn.type = "button";
    btn.textContent = text;
    // Отклик мгновенный, и на месте «Выдать» тут же встаёт форма «Принять» —
    // второй тап по привычке принял бы только что выданное обратно.
    btn.addEventListener("click", () => {
      if (Date.now() - lastSubmitAt < 800) return;
      lastSubmitAt = Date.now();
      onSubmit();
    });
    box.appendChild(btn);
  }

  // Выдача, приём и дефект — оптимистично (inBackground): результат на экране
  // сразу, запрос в фоне. Без окон: вибрации и состояния предмета достаточно.
  function submitCheckout() {
    const picked = field("scan-order").value;
    // «Без заказа» выбирается сознательно: иначе выдача без заказа случалась бы
    // просто от того, что список не пролистали.
    if (!picked) { TG.showAlert("Выберите заказ или «Без заказа»"); return; }
    const orderId = picked === "none" ? null : Number(picked);
    const qtyField = document.getElementById("scan-qty");
    const qty = qtyField ? Number(qtyField.value) || 1 : 1;
    const item = currentItem;
    const rowBefore = cachedRow(item.item_id);
    const body = {
      item_id: item.item_id,
      order_id: orderId,
      qty,
      expected_return_at: field("scan-return-date").value || null,
      notes: field("scan-notes").value.trim(),
    };
    TG.hapticSuccess();
    applyLocal(ItemState.afterCheckout(item, qty));
    // У штучных позиций важно, сколько ушло: «Кабель XLR — 4 шт».
    const line = item.name + (item.by_qty && qtyField ? " — " + qty + " шт" : "");
    // Выдача по заказу — это подряд десяток позиций: сразу открываем сканер снова.
    if (lockedOrder) nextInOrder(line);
    else showItem(currentItem);
    inBackground(rowBefore && { ...rowBefore }, item, item.name + " (" + item.item_id + ") не выдан",
      () => apiPost("/transaction/checkout", body),
      (result) => {
        if (orderId) markStale("orders");     // изменился статус и состав заказа
        Cache.patch("equipment", "item_id", item.item_id,
          ItemState.afterCheckout(item, qty, result && result.transaction_id));
        // Выдача вне состава заказа разрешена (акт пересобирается сам) —
        // отмечаем её в списке выданного за заход, а не останавливаем человека.
        if (lockedOrder && result && result.order_line === "off-order" && orderId) {
          renameInSession(line, line + " — сверх заявки");
        }
      },
      () => { if (lockedOrder) dropFromSession(line); });
  }

  function submitCheckin() {
    const hasDefect = field("scan-has-defect").checked;
    const qtyInField = document.getElementById("scan-qty-in");
    const qty = qtyInField ? Number(qtyInField.value) || 1 : 1;
    const description = hasDefect ? field("scan-defect-desc").value.trim() : null;
    const severity = hasDefect ? field("scan-defect-severity").value : null;
    const item = currentItem;
    const rowBefore = cachedRow(item.item_id);
    const body = {
      item_id: item.item_id,
      qty,
      has_defect: hasDefect,
      defect_description: description,
      defect_severity: severity,
      notes: field("scan-checkin-notes").value.trim(),
    };
    TG.hapticSuccess();
    applyLocal(ItemState.afterCheckin(item, qty, severity), {
      current_transaction: null,
      ...(hasDefect ? withDefect("", severity, description) : {}),
    });
    showItem(currentItem);
    inBackground(rowBefore && { ...rowBefore }, item, item.name + " (" + item.item_id + ") не принят",
      () => apiPost("/transaction/checkin", body),
      (res) => {
        // Остаток на руках у штучных точнее знает таблица.
        Cache.patch("equipment", "item_id", item.item_id,
          ItemState.afterCheckin(item, qty, severity, res && res.qty_out));
        if (hasDefect) markStale("defects");     // в ремонте появилась запись
        markStale("orders");                     // заказ мог закрыться возвратом
      });
  }

  function submitDefect() {
    const description = field("scan-standalone-desc").value.trim();
    if (!description) { TG.showAlert("Опишите дефект"); return; }
    const severity = field("scan-standalone-severity").value;
    const item = currentItem;
    const rowBefore = cachedRow(item.item_id);
    TG.hapticSuccess();
    // Показываем предмет заново, а не закрываем экран: человеку надо увидеть,
    // изменился ли статус — незначительный дефект выдачу не блокирует.
    applyLocal(ItemState.afterDefect(item, severity), withDefect("", severity, description));
    showItem(currentItem);
    inBackground(rowBefore && { ...rowBefore }, item, "Дефект " + item.item_id + " не сохранён",
      () => apiPost("/defect/report", { item_id: item.item_id, description, severity }),
      (res) => {
        if (res && res.status) {
          Cache.patch("equipment", "item_id", item.item_id, ItemState.afterDefect(item, severity, res.status));
        }
        markStale("defects");
      });
  }

  function onShow(params) {
    reset();
    renderCameraState();
    renderFailed();   // отказ мог прийти, пока человек был на другом экране
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
    const input = document.getElementById("scan-manual-input");
    const submit = () => takeCode(QR.normalize(input.value));
    document.getElementById("scan-manual-submit").addEventListener("click", submit);
    // Enter от сканера сюда не доходит — его забирает QR.wedge, — так что
    // здесь только Enter, нажатый человеком.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      submit();
    });
    QR.wedge(takeCode, (target) => {
      if (!document.getElementById("screen-scan").classList.contains("screen--active")) return false;
      // В заметках и описании дефекта печатают текст — сканер там не ждём.
      return !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target === input;
    });
    Router.register("scan", { onShow });
  }

  return { init };
})();
