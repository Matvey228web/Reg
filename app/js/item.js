const ItemScreen = (() => {
  let currentItemId = null;
  let ordersById = {};
  let history = null;
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
    return "Без заказа (для склада)";
  }

  // Строка истории выдач. Слово «Открыт» — внутреннее имя статуса записи, и
  // красным оно читалось как поломка. Складу важно другое: на руках ли вещь,
  // не просрочена ли, кто выдал и кто принял. Срок — только у открытой:
  // у вернувшейся он уже ничего не значит.
  function txRowHtml(t) {
    const open = t.status === "Open";
    const due = t.expected_return_at ? new Date(t.expected_return_at) : null;
    const overdue = open && due && !isNaN(due) && due < new Date(new Date().toDateString());
    const chip = !open ? ""
      : overdue ? `<span class="badge badge--open">Просрочено</span>`
      : `<span class="badge badge--rented">На руках</span>`;
    const qty = Number(t.qty) > 1 ? ` · ${Number(t.qty)} шт.` : "";
    const who = (name) => (name ? escapeHtml(name) + " · " : "");
    const order = ordersById[String(t.order_id || "")];
    const lines = [`Выдал: ${who(t.staff_out_name)}${formatDate(t.checked_out_at)}${qty}`];
    if (open && t.expected_return_at) lines.push(`Вернуть до: ${escapeHtml(String(t.expected_return_at).slice(0, 10))}`);
    if (t.checked_in_at) lines.push(`Принял: ${who(t.staff_in_name)}${formatDate(t.checked_in_at)}`);
    // Выдача по заказу ведёт в его карточку — как строка списка «Заказы».
    return `
        <div class="card${order ? " card--link" : ""}"${order ? ` data-order-id="${escapeHtml(String(order.order_id))}"` : ""}>
          <div class="card-title">${escapeHtml(txLabel(t))} ${chip}</div>
          ${lines.map((l) => `<div class="card-sub">${l}</div>`).join("")}
        </div>`;
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
    // Пока карточки нет, править нечего — карандаш покажет render().
    document.getElementById("item-edit-toggle").style.display = "none";
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

  // Правка карточки — администратору, по карандашу в заголовке. Пришла на
  // место кнопки «Исправить номера» и сделана с неё же: те же поля формы, тот
  // же разбор ответа. Бэкенд — /item/update (handleItemUpdate в Code.gs), он
  // же и проверяет права: здесь только прячем то, что нажать всё равно нельзя.
  //
  // Галочка «ко всем вещам модели» правит то, что принадлежит модели, —
  // название и категорию. Номера, состояние и количество у каждой вещи свои,
  // поэтому с галочкой эти поля выключены.
  //
  // Категорию меняет только главный администратор: смена категории меняет
  // номер вещи (XXYYZZ начинается с категории), а значит, и наклейку.
  // Статус не правится: его ведут выдача, приём и дефекты.
  function editForm(item) {
    const me = Auth.getSession() || {};
    if (me.role !== "Admin") return "";
    const cats = categoryList().filter((c) => !!c.by_qty === !!item.by_qty);
    if (!cats.some((c) => c.code === item.category)) {
      cats.unshift({ code: item.category, label: categoryLabel(item.category) });
    }
    const minQty = Math.max(1, Number(item.qty_out || 0));
    return `
      <div id="item-edit-form" style="display:none;">
        <div class="form-group">
        <div class="field">
          <label for="item-edit-name">Название</label>
          <input type="text" id="item-edit-name" value="${escapeHtml(item.name || "")}" />
        </div>
        ${item.by_qty ? `
        <div class="field">
          <label for="item-edit-qty">Всего, шт.</label>
          <input type="number" id="item-edit-qty" inputmode="numeric" min="${minQty}" step="1"
                 value="${Number(item.qty || 1)}" />
        </div>` : `
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
        </div>`}
        <div class="field field--stacked">
          <label for="item-edit-notes">Состояние</label>
          <textarea id="item-edit-notes">${escapeHtml(item.condition_notes || "")}</textarea>
        </div>
        <div class="field">
          <label for="item-edit-category">Категория</label>
          <select id="item-edit-category" ${me.is_owner ? "" : "disabled"}>
            ${cats.map((c) => `<option value="${escapeHtml(c.code)}" ${c.code === item.category ? "selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
          </select>
        </div>
        <div class="toggle-row">
          <label for="item-edit-all">Применить ко всем вещам этой модели</label>
          <input type="checkbox" id="item-edit-all" />
        </div>
        </div>
        ${me.is_owner ? "" : `<p class="hint">Категорию меняет только главный администратор.</p>`}
        <p class="hint" id="item-edit-hint"></p>
        <div id="item-edit-error"></div>
        <button class="btn" id="item-edit-submit">Сохранить</button>
      </div>`;
  }

  // Подсказка и выключенные поля — от галочки. Без неё у полки категория не
  // меняется: строка у полки одна на модель, переносится только вся модель.
  function syncEdit(item) {
    const all = document.getElementById("item-edit-all").checked;
    ["item-serial", "item-inventory", "item-edit-notes", "item-edit-qty"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = all;
    });
    const me = Auth.getSession() || {};
    document.getElementById("item-edit-category").disabled = !me.is_owner || (!!item.by_qty && !all);
    document.getElementById("item-edit-hint").textContent = all
      ? "Название сменится в справочнике и у всех вещей модели, категория — у всей модели " +
        "с перенумерацией. Номера, состояние и количество у каждой вещи свои — с галочкой они не меняются."
      : (item.by_qty
        ? "Правится только эта позиция. Категорию полки меняют для всей модели — включите галочку."
        : "Правится только эта вещь. Пустое поле номера стирает номер; занятый номер система не примет.");
  }

  function bindEdit(item) {
    const form = document.getElementById("item-edit-form");
    if (!form) return;
    const all = document.getElementById("item-edit-all");
    all.addEventListener("change", () => syncEdit(item));
    syncEdit(item);
    document.getElementById("item-edit-submit").addEventListener("click", () => submitEdit(item));
  }

  function submitEdit(item) {
    showBoxError("item-edit-error", "");
    const all = document.getElementById("item-edit-all").checked;
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : null; };
    const body = { item_id: item.item_id };
    const name = val("item-edit-name");
    if (!name) { showBoxError("item-edit-error", "Название не может быть пустым"); return; }
    if (name !== String(item.name || "")) body.name = name;
    const category = val("item-edit-category");
    if (category && category !== item.category) body.category = category;
    if (all) {
      body.all_model = true;
    } else {
      const fields = { serial_number: "item-serial", inventory_number: "item-inventory",
                       condition_notes: "item-edit-notes" };
      Object.keys(fields).forEach((f) => {
        const v = val(fields[f]);
        if (v !== null && v !== String(item[f] || "")) body[f] = v;
      });
      const qtyRaw = val("item-edit-qty");
      if (qtyRaw !== null) {
        const qty = Number(qtyRaw);
        const min = Math.max(1, Number(item.qty_out || 0));
        if (!Number.isInteger(qty) || qty < min) {
          showBoxError("item-edit-error", Number(item.qty_out || 0) > qty
            ? `На руках сейчас ${Number(item.qty_out)} шт. — меньше этого количество не поставить.`
            : "Количество — целое число от одного");
          return;
        }
        if (qty !== Number(item.qty || 1)) body.qty = qty;
      }
    }
    // Сверяем здесь же: запрос к таблице — это 5–8 секунд, и тратить их,
    // чтобы услышать «ничего не изменилось», незачем.
    if (Object.keys(body).filter((k) => k !== "item_id" && k !== "all_model").length === 0) {
      showBoxError("item-edit-error", "Ничего не изменилось");
      return;
    }
    if (!body.category) { sendEdit(item, body); return; }
    TG.showConfirm(all
      ? "У всех вещей этой модели сменятся номера: старые наклейки с QR перестанут работать, " +
        "их нужно перепечатать. Продолжить?"
      : "У вещи сменится номер: старая наклейка с QR перестанет работать, её нужно перепечатать. Продолжить?",
    (yes) => { if (yes) sendEdit(item, body); });
  }

  async function sendEdit(item, body) {
    const restore = busyButton(document.getElementById("item-edit-submit"));
    showBoxError("item-edit-error", "");
    try {
      const res = await apiPost("/item/update", body);
      TG.hapticSuccess();
      const moved = res.item_id !== res.old_item_id;
      // Кэш каталога правим, а не сбрасываем: поиск идёт по названиям и
      // номерам, и до следующего обновления он не должен врать.
      if (moved && res.all_model) {
        // Перенумерована вся модель — как после /model/move в models.js:
        // правок слишком много. Каталог сбрасываем, а не помечаем устаревшим:
        // в нём старые номера, и тап по такой строке дал бы «не найдено».
        Cache.clear("equipment");
      } else {
        // Перенос одной вещи — та же строка под новым номером: patch по
        // старому номеру кладёт поверх неё строку из ответа вместе с item_id.
        Cache.patch("equipment", "item_id", res.old_item_id, res.item);
        if (res.all_model && body.name) {
          (Cache.items("equipment") || [])
            .filter((r) => r.category === item.category && String(r.model_code) === String(item.model_code))
            .forEach((r) => Cache.patch("equipment", "item_id", r.item_id, { name: res.item.name }));
        }
      }
      // Справочник моделей: название модели сменилось, или вещь переехала в
      // другую категорию (там завелась модель, здесь могла опустеть).
      if ((res.all_model && body.name) || body.category) Cache.stale("models");

      if (moved) {
        // Карточку открываем под новым номером: старого больше нет. Назад —
        // не на старый номер, поэтому replace, а не navigate.
        Router.replace("item", { itemId: res.item_id });
        TG.showConfirm(`Новый номер вещи — ${res.item_id}. Старая наклейка больше не работает. ` +
          "Напечатать новую этикетку?",
          (yes) => { if (yes) Router.navigate("labels", { itemId: res.item_id }); });
        return;
      }
      render({ ...item, ...res.item });
      // Что сохранилось — строкой над карточкой, а не окном, которое надо
      // закрывать. Ошибка осталась в error-box формы: она там и видна.
      showStatusLine("item-status", editResultText(res));
    } catch (err) {
      TG.hapticError();
      showBoxError("item-edit-error", err.message);
    } finally {
      restore();
    }
  }

  // Окно Telegram берёт 256 знаков — только то, что поменялось.
  function editResultText(res) {
    const LABELS = { name: "Название", serial_number: "Заводской №", inventory_number: "Инвентарный №",
                     condition_notes: "Состояние", qty: "Всего" };
    const lines = Object.keys(res.changed || {}).filter((f) => LABELS[f]).map((f) => {
      const c = res.changed[f];
      if (f === "condition_notes") return LABELS[f] + ": " + (c.now ? "обновлено" : "стёрто");
      return LABELS[f] + ": " + (c.now || "стёрт");
    });
    if (res.renamed) lines.push(`Переименовано вещей модели: ${res.renamed}`);
    return lines.length ? "Сохранено.\n\n" + lines.join("\n") : "Ничего не изменилось";
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
      .map(txRowHtml).join("") || `<p class="empty">Пока не было выдач</p>`;

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
    txBox.querySelectorAll("[data-order-id]").forEach((row) => {
      row.addEventListener("click", () => Router.navigate("order", { orderId: row.dataset.orderId }));
    });
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

    // Карандаш в заголовке — только администратору; форма правки открывается
    // над карточкой, прямо под ним.
    const me = Auth.getSession() || {};
    document.getElementById("item-edit-toggle").style.display = me.role === "Admin" ? "" : "none";

    content.innerHTML = `
      ${editForm(item)}
      <div id="item-status"></div>
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
          <button class="btn btn--secondary" id="item-qr-big">Крупно</button>
          <button class="btn btn--secondary" id="item-qr-download">Сохранить</button>
          <button class="btn btn--secondary" id="item-qr-label">Печать</button>
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
          <div id="item-defect-error"></div>
          <button class="btn" id="item-defect-submit">Сохранить дефект</button>
        </div>
        <div id="item-defect-status"></div>
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
    // Оптимистично, как resolveDefect в repair.js: дефект на карточке сразу,
    // запись в фоне. Откажет таблица — карточка и строка каталога как были,
    // описание возвращается в поле, причина под формой.
    document.getElementById("item-defect-submit").addEventListener("click", async () => {
      const description = document.getElementById("item-defect-desc").value.trim();
      if (!description) { showBoxError("item-defect-error", "Опишите дефект"); return; }
      showBoxError("item-defect-error", "");
      const severity = document.getElementById("item-defect-severity").value;
      const rowBefore = (Cache.items("equipment") || [])
        .find((r) => String(r.item_id) === String(item.item_id)) || null;
      const historyBefore = history;
      const changes = ItemState.afterDefect(item, severity);
      Cache.patch("equipment", "item_id", item.item_id, changes);
      const defect = {
        defect_id: "", item_id: item.item_id, severity, description,
        status: "Open", reported_at: new Date().toISOString(),
      };
      const next = { ...item, ...changes };
      if (item.open_defects) next.open_defects = item.open_defects.concat([defect]);
      if (history) history = { ...history, defects: (history.defects || []).concat([defect]) };
      TG.hapticSuccess();
      render(next);
      showStatusLine("item-defect-status", "Дефект сохранён" +
        (changes.status === "In Repair" ? " — вещь снята с выдачи" : ""));
      try {
        const res = await apiPost("/defect/report", {
          item_id: item.item_id,
          description,
          severity,
        });
        // Статус предмета бэкенд вернул в ответе — правим одну строку каталога,
        // а не сбрасываем весь каталог и не перечитываем предмет.
        if (res && res.status) {
          Cache.patch("equipment", "item_id", item.item_id, ItemState.afterDefect(item, severity, res.status));
        }
        if (!historyBefore) {
          // История ещё была в пути и может прийти без этого дефекта — просим заново.
          loadHistory(++historySeq);
        }
        // Доска «Ремонт»: дописываем дефект в её кэш, не трогая возраст, —
        // и помечаем устаревшим, чтобы она перечитала себя молча (названия,
        // кто заявил — это знает только сервер).
        const board = Cache.items("defects");
        if (board && res && res.defect_id) {
          Cache.replace("defects", board.concat([{ ...defect, defect_id: res.defect_id,
            reported_by_name: (Auth.getSession() || {}).full_name || "" }]));
        }
        Cache.stale("defects");
      } catch (err) {
        TG.hapticError();
        if (rowBefore) Cache.patch("equipment", "item_id", item.item_id, rowBefore);
        history = historyBefore;
        if (String(currentItemId) === String(item.item_id)) {
          render(item);
          document.getElementById("item-defect-form").style.display = "block";
          document.getElementById("item-defect-desc").value = description;
          document.getElementById("item-defect-severity").value = severity;
          showBoxError("item-defect-error", "Дефект не сохранился: " + err.message);
        }
      }
    });

    bindEdit(item);
    renderHistory();
  }

  function onShow(params) {
    currentItemId = params.itemId;
    load();
  }

  function init() {
    Router.register("item", { onShow });
    // Кнопка в заголовке живёт дольше карточки — слушатель вешаем один раз,
    // а форму ищем в момент нажатия.
    document.getElementById("item-edit-toggle").addEventListener("click", () => {
      const form = document.getElementById("item-edit-form");
      if (!form) return;
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
  }

  return { init };
})();
