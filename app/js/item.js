// Экран "Карточка предмета": статус, история выдач и дефектов, быстрый репорт дефекта.

const ItemScreen = (() => {
  let currentItemId = null;
  let ordersById = {};
  let history = null;     // история выдач и дефектов показанного предмета
  let historySeq = 0;     // ответ на устаревший запрос истории не рисуем

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

  // Строка каталога годится для карточки: статус, количество и номера в ней
  // те же, что отдаёт /item/lookup. Нет только заметки о состоянии — список
  // её не возвращает.
  function cachedItem(itemId) {
    const row = (Cache.items("equipment") || []).find((i) => String(i.item_id) === String(itemId));
    return row ? { ...row, by_qty: categoryByQty(row.category) } : null;
  }

  async function load() {
    const content = document.getElementById("item-content");
    document.getElementById("item-title").textContent = currentItemId;
    history = null;
    const seq = ++historySeq;

    // Предмет есть в кэше каталога — рисуем карточку сразу, а за сетью идём
    // только за историей. Раньше открытие карточки стоило двух запросов по
    // 6–9 секунд, и один из них повторял то, что уже лежало в каталоге.
    const known = cachedItem(currentItemId);
    if (known) {
      loadOrdersMap();
      render(known);
      loadHistory(seq);
      return;
    }

    content.innerHTML = `<p class="empty">Загрузка…</p>`;
    try {
      const [item, data] = await Promise.all([
        apiPost("/item/lookup", { item_id: currentItemId }),
        apiPost("/item/history", { item_id: currentItemId }),
      ]);
      if (seq !== historySeq) return;
      loadOrdersMap();
      history = data;
      render(item);
    } catch (err) {
      if (seq !== historySeq) return;
      content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadHistory(seq) {
    try {
      const data = await apiPost("/item/history", { item_id: currentItemId });
      if (seq !== historySeq) return;
      history = data;
      renderHistory();
    } catch (err) {
      if (seq !== historySeq) return;
      ["item-tx-list", "item-defect-list"].forEach((id) => {
        const box = document.getElementById(id);
        if (box) box.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      });
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

  // Исправление номеров — администратору. Опечатку в заводском или
  // инвентарном номере находят уже после того, как вещь заведена и уехала в
  // таблицу, и до сих пор единственным выходом было править ячейку руками —
  // мимо всех проверок, в том числе проверки на дубль.
  //
  // Номер вещи (XXYYZZ) здесь не правится: он собран из категории и модели, и
  // меняется только переносом модели, вместе с перенумерацией.
  //
  // У позиций с учётом количеством формы нет вовсе: там одна строка на всю
  // полку, личных номеров у неё не бывает.
  function numbersForm(item) {
    const me = Auth.getSession() || {};
    if (me.role !== "Admin" || item.by_qty) return "";
    return `
      <button class="btn btn--secondary" id="item-numbers-toggle">Исправить номера</button>
      <div id="item-numbers-form" style="display:none;">
        <div class="form-group">
        <div class="field">
          <label for="item-serial">Заводской №</label>
          <input type="text" id="item-serial" value="${escapeHtml(item.serial_number || "")}"
                 placeholder="как на корпусе" autocapitalize="characters" autocorrect="off"
                 spellcheck="false" />
        </div>
        <div class="field">
          <label for="item-inventory">Инвентарный №</label>
          <input type="text" id="item-inventory" value="${escapeHtml(item.inventory_number || "")}"
                 placeholder="как в описи" autocapitalize="characters" autocorrect="off"
                 spellcheck="false" />
        </div>
        </div>
        <p class="hint">Номер вещи ${escapeHtml(item.item_id)} не изменится. Пустое поле
        стирает номер. Занятый номер система не примет: по ним ищут технику.</p>
        <div id="item-numbers-error"></div>
        <button class="btn" id="item-numbers-submit">Сохранить номера</button>
      </div>`;
  }

  function bindNumbers(item) {
    const toggle = document.getElementById("item-numbers-toggle");
    if (!toggle) return;
    toggle.addEventListener("click", () => {
      const form = document.getElementById("item-numbers-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("item-numbers-submit").addEventListener("click", async () => {
      const serial = document.getElementById("item-serial").value.trim();
      const inventory = document.getElementById("item-inventory").value.trim();
      // Сверяем здесь же: запрос к таблице — это 5–8 секунд, и тратить их,
      // чтобы услышать «ничего не изменилось», незачем.
      if (serial === String(item.serial_number || "") &&
          inventory === String(item.inventory_number || "")) {
        TG.showAlert("Номера не изменились");
        return;
      }
      const btn = document.getElementById("item-numbers-submit");
      btn.disabled = true;
      showBoxError("item-numbers-error", "");
      try {
        const res = await apiPost("/item/numbers", {
          item_id: item.item_id, serial_number: serial, inventory_number: inventory,
        });
        TG.hapticSuccess();
        // Каталог ищет и по этим номерам — правим прямо в кэше, чтобы поиск не
        // врал до следующего обновления и чтобы не перечитывать весь склад.
        Cache.patch("equipment", "item_id", item.item_id, {
          serial_number: res.serial_number, inventory_number: res.inventory_number,
        });
        TG.showAlert(numbersResultText(res));
        // Новые номера пришли в ответе — перерисовываем карточку из них, не
        // перечитывая предмет и историю.
        render({ ...item, serial_number: res.serial_number, inventory_number: res.inventory_number });
      } catch (err) {
        TG.hapticError();
        showBoxError("item-numbers-error", err.message);
        TG.showAlert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function numbersResultText(res) {
    const LABELS = { serial_number: "Заводской", inventory_number: "Инвентарный" };
    const lines = Object.keys(res.changed || {}).map((f) => {
      const c = res.changed[f];
      return LABELS[f] + " №: " + (c.was ? `${c.was} → ` : "") + (c.now || "стёрт");
    });
    return lines.length ? "Исправлено.\n\n" + lines.join("\n") : "Номера не изменились";
  }

  // История рисуется отдельно от карточки: когда карточка взята из кэша, она
  // приходит позже, и перерисовывать ради неё всю карточку значило бы стереть
  // начатое описание дефекта.
  function renderHistory() {
    const txBox = document.getElementById("item-tx-list");
    const defectBox = document.getElementById("item-defect-list");
    if (!txBox || !defectBox) return;
    if (!history) {
      txBox.innerHTML = skeleton(1);
      defectBox.innerHTML = skeleton(1);
      return;
    }

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

    txBox.innerHTML = txRows;
    defectBox.innerHTML = defectRows;
  }

  // Открытые дефекты для «Скана»: из ответа /item/lookup, а если карточка
  // взята из кэша — из загруженной истории. Пока истории нет, «Скан» найдёт
  // предмет сам.
  function knownForScan(item) {
    if (item.open_defects) return item;
    if (!history) return null;
    return { ...item, open_defects: (history.defects || []).filter((d) => d.status !== "Resolved") };
  }

  function render(item) {
    document.getElementById("item-title").textContent = item.name;
    const content = document.getElementById("item-content");

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
        ${item.by_qty ? `<p class="hint">Код относится ко всей полке — наклейте его на ящик.
        Сканирование откроет остаток и выдачу количеством.</p>` : ""}
        <div class="qr-wrap">
          <canvas id="item-qr-canvas"></canvas>
          <div class="qr-id">${escapeHtml(item.item_id)}</div>
        </div>
        <div class="btn-row btn-row--equal">
          <button class="btn btn--secondary" id="item-qr-big">Этикетка крупно</button>
          <button class="btn btn--secondary" id="item-qr-download">Сохранить</button>
          <button class="btn btn--secondary" id="item-qr-label">Этикетка</button>
        </div>
        <p class="hint">Из Telegram скачать нельзя: «Сохранить» откроет лист
        «Поделиться», а если его нет — покажет картинку во весь экран (удерживайте, чтобы сохранить).</p>
      </div>

      <div class="section">
        <div class="section-title">История выдач</div>
        <div id="item-tx-list"></div>
      </div>

      <div class="section">
        <div class="section-title">История дефектов</div>
        <div id="item-defect-list"></div>
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
        ${numbersForm(item)}
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

    // Предмет передаём целиком: «Скан» покажет его сразу, без второго поиска.
    const goScan = (mode) => {
      const known = knownForScan(item);
      Router.navigate("scan", known
        ? { itemId: item.item_id, mode, item: known }
        : { itemId: item.item_id, mode });
    };
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
        const severity = document.getElementById("item-defect-severity").value;
        const res = await apiPost("/defect/report", {
          item_id: item.item_id,
          description,
          severity,
        });
        TG.hapticSuccess();
        TG.showAlert("Дефект сохранён");
        Cache.clear("defects");
        // Статус предмета бэкенд вернул в ответе — правим одну строку каталога
        // и карточку, а не сбрасываем весь каталог и не перечитываем предмет.
        const changes = ItemState.afterDefect(item, severity, res && res.status);
        Cache.patch("equipment", "item_id", item.item_id, changes);
        const defect = {
          defect_id: res && res.defect_id, item_id: item.item_id, severity, description,
          status: "Open", reported_at: new Date().toISOString(),
        };
        const next = { ...item, ...changes };
        if (item.open_defects) next.open_defects = item.open_defects.concat([defect]);
        if (history) {
          history = { ...history, defects: (history.defects || []).concat([defect]) };
        } else {
          // История ещё в пути и может прийти без этого дефекта — просим заново.
          loadHistory(++historySeq);
        }
        render(next);
      } catch (err) {
        TG.hapticError();
        TG.showAlert(err.message);
      } finally {
        btn.disabled = false;
      }
    });

    bindNumbers(item);
    renderHistory();
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
