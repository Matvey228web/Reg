// Экран «Карточка заказа».
//
// Раньше карточка раскрывалась гармошкой внутри списка: длинный заказ уезжал
// под соседние, «назад» к списку не было, а выдать по нему было нельзя —
// человек уходил на «Скан» и искал тот же заказ в выпадающем списке заново.
// Теперь это отдельный экран, и работа по заказу начинается прямо с него.

const OrderScreen = (() => {
  let currentOrderId = null;
  let card = null;        // последняя загруженная карточка
  let itemsById = {};
  let receiving = false;  // раскрыт ли режим приёма
  let receiveError = "";  // что не удалось принять — переживает перерисовку
  let busy = false;

  // Что сейчас в работе. Карточка перерисовывается целиком (свежие данные,
  // возврат со «Скана», соседняя операция), и состояние «Выдаём…» на самой
  // кнопке при этом терялось: строки снова становились нажимаемыми, а другие
  // вдруг показывали чужой прогресс. Поэтому «занято» живёт здесь, по ключу
  // строки, и render рисует кнопку из этих множеств.
  const issuing = new Set();     // line_no строк состава, по которым идёт выдача
  const checkingIn = new Set();  // item_id предметов, которые принимаем
  let checkinAllBusy = false;
  let opSeq = 0;                 // растёт с каждой операцией — см. load()
  let reloadPending = false;     // сверка с таблицей отложена до конца операций
  // Ошибка и итог — у своей строки, а не окном поверх: окно надо закрыть, и
  // на десятке позиций это лишний тап. Ключ — "issue:<line_no>" / "in:<item_id>".
  let lineErrors = {};
  let lineNotes = {};
  // Введённое в форме приёма (количество, дефект) — переживает перерисовку.
  let drafts = {};

  // Список устарел своей же записью — помечаем, а не выбрасываем (Cache.stale):
  // вкладка «Заказы» покажет его сразу и обновит молча. Сделано как markStale
  // в scan.js; без Cache.stale — сбросом, как раньше.
  function markStale(name) {
    if (Cache.stale) Cache.stale(name);
    else Cache.clear(name);
  }

  function idle() {
    return !issuing.size && !checkingIn.size && !checkinAllBusy;
  }

  // Названия предметов — из кэша каталога, как на других экранах: свой запрос
  // сюда добавил бы ещё 5–8 секунд ожидания.
  function itemName(itemId) {
    const item = itemsById[String(itemId)];
    return item ? item.name : String(itemId);
  }

  function loadItemsMap() {
    const items = Cache.items("equipment") || [];
    itemsById = Object.fromEntries(items.map((i) => [String(i.item_id), i]));
  }

  // Принимать «030101» вместо «OSTERRIG SIRIUS 100CM» человек не может. Если в
  // кэше каталога пусто (например, зашли сразу в «Заказы»), один раз тянем его
  // здесь — он всё равно нужен всем остальным экранам и останется в кэше.
  // Общий Cache.ensure: если «Ремонт» уже тянет каталог, ждём тот же запрос.
  async function ensureItemsMap() {
    if (Cache.items("equipment")) return;
    try {
      await Cache.ensure("equipment", "/equipment/list", { category: "all", status: "all" });
      loadItemsMap();
    } catch {
      // Не страшно: без названий покажем номера, карточка заказа важнее.
    }
  }

  function today() {
    return new Date().toISOString().substring(0, 10);
  }

  // Просрочка — производное состояние, а не статус в таблице: заказ просрочен,
  // пока техника на руках и дата возврата уже прошла.
  function isOverdue(order) {
    return order.status === "Issued" && order.return_date && order.return_date < today();
  }

  // Сколько штук по заказу уже отдано. Считаем именно штуки, а не строки: в
  // строке «SANDBAG BIG» их двадцать, и «закрыто 2 из 3 позиций» скрыло бы,
  // что половина заказа ещё лежит на складе.
  function issuedCount(items) {
    return (items || []).reduce((acc, line) => ({
      done: acc.done + Number(line.issued_qty || 0),
      total: acc.total + Number(line.qty || 0),
    }), { done: 0, total: 0 });
  }

  // Что сейчас на руках. Журнал хранит выдачи, а не остатки: у штучной позиции
  // их несколько, и закрыты они могут быть частично, поэтому складываем
  // незакрытое по каждому предмету.
  function openGroups(data) {
    const groups = [];
    const byItem = {};
    (data.transactions || []).forEach((t) => {
      if (t.status !== "Open") return;
      const left = Number(t.qty || 1) - Number(t.qty_in || 0);
      if (left <= 0) return;
      const key = String(t.item_id);
      if (!byItem[key]) {
        byItem[key] = { item_id: key, qty: 0, off_order: false };
        groups.push(byItem[key]);
      }
      byItem[key].qty += left;
      if (String(t.order_line) === "off-order") byItem[key].off_order = true;
    });
    return groups;
  }

  async function load({ force = false } = {}) {
    const content = document.getElementById("order-content");
    loadItemsMap();

    // Возврат со «Скана» не должен упираться в пустой экран на 5–8 секунд:
    // рисуем то, что уже знаем, и молча перезапрашиваем.
    if (card && String(card.order.order_id) === String(currentOrderId)) render(card);
    else content.innerHTML = skeleton(3);

    // Пока идёт выдача или приём, с таблицей не сверяемся: ответ мог уйти до
    // записи, и карточка откатилась бы назад. Сверка — когда всё закончится.
    if (card && !idle()) { reloadPending = true; return; }
    if (busy && !force) return;
    busy = true;
    const seq = opSeq;
    try {
      const [data] = await Promise.all([
        apiPost("/order/card", { order_id: Number(currentOrderId) }),
        ensureItemsMap(),
      ]);
      // За время запроса началась операция — этот ответ уже устарел.
      if (seq !== opSeq || !idle()) reloadPending = true;
      else {
        card = data;
        renderUnlessTyping();
      }
    } catch (err) {
      if (!card) content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    } finally {
      busy = false;
    }
    if (reloadPending && idle()) reconcile();
  }

  // Молчаливая сверка с таблицей после своей записи — только когда ничего не
  // в работе, иначе отложится и случится после последней операции.
  function reconcile() {
    if (!idle() || !currentOrderId) { reloadPending = true; return; }
    reloadPending = false;
    if (busy) { reloadPending = true; return; }
    load();
  }

  // Свежие данные не должны выдёргивать поле из-под пальцев: пока человек
  // пишет описание дефекта, карточку не перерисовываем — она возьмёт свежее
  // при следующей перерисовке. Перерисовать на выходе из поля нельзя: выход —
  // это и нажатие на «Принять», и кнопка исчезла бы из-под пальца.
  function renderUnlessTyping() {
    if (card && !isTyping("#order-content")) render(card);
  }

  // Контакт в карточке — сам текст, без кнопок рядом: нажатие на номер
  // копирует его, нажатие на ник открывает переписку.
  //
  // Звонить ссылкой tel: внутри Telegram ненадёжно: веб-вью клиента на части
  // телефонов молча её глотает. Копирование работает везде — номер в буфер,
  // дальше его можно вставить в звонилку. Если закрыт и буфер — окно с
  // номером, чтобы его прочитать.
  //
  // Ник открываем через TG.openTelegramLink, а не ссылкой t.me: та ушла бы в
  // браузер на страницу «Open in Telegram», и до чата осталось бы ещё два шага.
  function dialNumber(phone) {
    let num = String(phone || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
    if (/^8\d{10}$/.test(num)) num = "+7" + num.slice(1);
    else if (/^7\d{10}$/.test(num)) num = "+" + num;
    return num;
  }

  function contactRow(phone, tg) {
    const nick = String(tg || "").trim().replace(/^@/, "");
    const num = dialNumber(phone);
    return (num
      ? `<button class="contact-link" type="button" data-copy="${escapeHtml(num)}"
           aria-label="Скопировать номер">${escapeHtml(phone)}</button>`
      : "") + (nick
      ? `<button class="contact-link" type="button" data-tg="${escapeHtml(nick)}"
           aria-label="Написать в Telegram">@${escapeHtml(nick)}</button>`
      : "");
  }

  // Номер в буфер. Получилось — отклик и на две секунды «Скопировано» на месте
  // номера, без окна поверх. Нет — окно с самим номером.
  async function copyNumber(el) {
    const num = el.dataset.copy;
    if (await copyText(num)) {
      TG.hapticSuccess();
      if (!el._label) el._label = el.textContent;
      el.textContent = "Скопировано";
      clearTimeout(el._copyTimer);
      el._copyTimer = setTimeout(() => { el.textContent = el._label; }, 2000);
    } else {
      TG.hapticError();
      TG.showAlert("Скопировать не вышло. Номер: " + num);
    }
  }

  function render(data) {
    const o = data.order;
    const lines = (data.items || []).slice().sort((a, b) => a.line_no - b.line_no);
    const open = openGroups(data);
    const closed = (data.transactions || []).filter((t) => t.status !== "Open");
    const count = issuedCount(lines);
    const overdue = isOverdue(o);

    document.getElementById("order-title").textContent = "Заказ №" + o.order_no;
    document.getElementById("order-content").innerHTML = `
      <div class="card">
        <div class="card-title">
          ${statusBadge(o.status)}
          ${overdue ? `<span class="badge badge--open">Просрочен</span>` : ""}
        </div>
        <div class="card-sub">${escapeHtml(o.student_name || "—")}${o.is_adult ? "" : " · с представителем"}</div>
        <div class="card-sub">${escapeHtml((o.issue_date || "?") + " → " + (o.return_date || "?"))}${o.project ? " · " + escapeHtml(o.project) : ""}</div>
        ${count.total ? `
        <div class="progress-line">Выдано ${count.done} из ${count.total}</div>
        <div class="progress"><span style="width:${Math.round(100 * count.done / count.total)}%"></span></div>` : ""}
      </div>

      <div class="btn-row btn-row--equal">
        ${o.status === "Cancelled" ? "" : `<button class="btn" id="order-issue">Выдать по заказу</button>`}
        ${open.length ? `<button class="btn ${o.status === "Cancelled" || receiving ? "" : "btn--secondary"}" id="order-receive">${receiving ? "Скрыть приём" : "Принять по заказу"}</button>` : ""}
      </div>

      ${receiving ? receiveSectionHtml(open) : ""}

      ${o.act_url
        ? `<button class="btn btn--secondary" id="order-act"
                   data-url="${escapeHtml(o.act_url)}" style="margin-top:8px;">Открыть акт</button>`
        : `<p class="hint">Акта нет. Он собирается сам при появлении заказа —
             если его нет, значит в «Настройки → Акт сдачи-приёмки» ещё не
             создан шаблон.</p>`}

      <div id="order-archive-error"></div>
      ${o.archived_at
        ? `<button class="btn btn--secondary" id="order-archive"
                   data-back="1" style="margin-top:8px;">Вернуть из архива</button>
           <p class="hint">Заказ в архиве: в общем списке его не видно,
             но он цел — состав, даты, исходный текст.</p>`
        : `<button class="btn btn--secondary" id="order-archive"
                   style="margin-top:8px;">Убрать в архив</button>
           <p class="hint">Архив прячет заказ из списка, но ничего не стирает —
             мало ли что. Пока по заказу есть вещи на руках, убрать нельзя.</p>`}

      <div class="section">
        <div class="section-title">Арендатор</div>
        <div class="card-sub">${escapeHtml(o.student_name || "—")}</div>
        ${contactRow(o.student_phone, o.student_tg)}
        ${o.is_adult ? "" : `
          <div class="section-title" style="margin-top:10px;">Представитель (арендатор несовершеннолетний)</div>
          <div class="card-sub">${escapeHtml(o.guardian_name || "—")}</div>
          ${contactRow(o.guardian_phone, "")}`}
      </div>

      <div class="section">
        <div class="section-title">Состав заказа</div>
        ${lines.length ? lines.map(lineHtml).join("") : `<p class="hint">Состав не заполнен — выдача пойдёт как «вне заказа».</p>`}
        ${o.extra_input ? `<div class="order-extra">Дописано в заказе: ${escapeHtml(o.extra_input)}</div>` : ""}
      </div>

      ${open.length && !receiving ? `
      <div class="section">
        <div class="section-title">На руках сейчас</div>
        <div id="order-open-list">${open.map((g) => openRowHtml(g, false)).join("")}</div>
      </div>` : ""}

      ${closed.length ? `
      <div class="section">
        <div class="section-title">Уже вернули</div>
        ${closed.map((t) => `<div class="card-sub">${escapeHtml(itemName(t.item_id))} · ${formatDate(t.checked_in_at)}</div>`).join("")}
      </div>` : ""}

      <div class="section">
        ${o.request_code ? `<div class="card-sub">Код заявки: ${escapeHtml(o.request_code)}</div>` : ""}
        ${o.amount ? `<div class="card-sub">Сумма по заказу: ${escapeHtml(String(o.amount))} ${escapeHtml(o.currency || "")}</div>` : ""}
        ${o.source_url ? `<div class="card-sub"><a href="${escapeHtml(o.source_url)}" target="_blank" rel="noopener">Заказ на сайте</a></div>` : ""}
        <div class="card-sub">Оформил: ${escapeHtml(o.created_by_name || "—")} · ${formatDate(o.created_at)}</div>
      </div>

      ${o.raw_text ? `
      <details class="order-raw">
        <summary>Исходное сообщение о заказе</summary>
        <pre>${escapeHtml(o.raw_text)}</pre>
      </details>` : ""}`;

    wire(o, open);
  }

  // Приём по заказу — сразу под кнопками, а не под составом: раньше он
  // раскрывался внизу длинной карточки, экран не двигался, и нажатие на
  // «Принять по заказу» выглядело как ничего.
  function receiveSectionHtml(open) {
    const anyBusy = checkinAllBusy || checkingIn.size > 0;
    return `
      <div class="section" id="order-receive-section">
        <div class="section-title">На руках сейчас</div>
        ${open.length ? `
        <div id="order-open-list">${open.map((g) => openRowHtml(g, true)).join("")}</div>
        ${receiveError ? `<div class="error-box">${escapeHtml(receiveError)}</div>` : ""}
        <button class="btn" id="order-checkin-all" ${anyBusy ? "disabled" : ""}>${checkinAllBusy
          ? `Принимаем ${open.length} ${plural(open.length, "позицию", "позиции", "позиций")}…`
          : `Принять всё (${open.length})`}</button>
        <p class="hint">«Принять всё» — возврат без дефектов. Сломанное принимайте своей
          строкой с галочкой «Дефект».</p>` : `<p class="hint">Всё вернули — на руках ничего нет.</p>`}
      </div>`;
  }

  // Позиция на руках. В режиме приёма у каждой — своя форма приёма прямо
  // здесь, без повторного скана: предмет и так известен по заказу. Поля те же,
  // что у приёма на «Скане» (submitCheckin в scan.js): количество у штучных
  // позиций и дефект с описанием и серьёзностью — возврат со сломанной
  // техникой это главное, ради чего приём вообще смотрят глазами.
  function openRowHtml(group, withForm) {
    const id = String(group.item_id);
    const qty = group.qty > 1 ? ` · ${group.qty} шт` : "";
    const tail = group.off_order ? " · вне состава" : "";
    const head = `
        <div class="order-line-name">${escapeHtml(itemName(id))}</div>
        <div class="order-line-qty">${escapeHtml(id)}${qty}${tail}</div>`;
    if (!withForm) return `<div class="order-line">${head}</div>`;

    const busyNow = checkingIn.has(id);
    const d = draftFor(group);
    const err = lineErrors["in:" + id];
    const sel = (v) => (d.severity === v ? " selected" : "");
    return `
      <div class="order-line" data-item="${escapeHtml(id)}">
        ${head}
        ${err ? `<div class="error-box">${escapeHtml(err)}</div>` : ""}
        ${isByQty(group) ? `
        <div class="field" style="margin-top:8px;">
          <label for="oc-qty-${escapeHtml(id)}">Сколько принимаем</label>
          <input type="number" id="oc-qty-${escapeHtml(id)}" data-draft="qty" inputmode="numeric"
                 min="1" step="1" max="${group.qty}" value="${escapeHtml(String(d.qty))}"
                 ${busyNow ? "disabled" : ""} />
        </div>` : ""}
        <div class="toggle-row">
          <label for="oc-defect-${escapeHtml(id)}">Дефект</label>
          <input type="checkbox" id="oc-defect-${escapeHtml(id)}" data-draft="has_defect"
                 ${d.has_defect ? "checked" : ""} ${busyNow ? "disabled" : ""} />
        </div>
        <div class="oc-defect-fields" style="display:${d.has_defect ? "block" : "none"};">
          <div class="field field--stacked">
            <label for="oc-desc-${escapeHtml(id)}">Описание дефекта</label>
            <textarea id="oc-desc-${escapeHtml(id)}" data-draft="description"
                      ${busyNow ? "disabled" : ""}>${escapeHtml(d.description)}</textarea>
          </div>
          <div class="field">
            <label for="oc-sev-${escapeHtml(id)}">Серьёзность</label>
            <select id="oc-sev-${escapeHtml(id)}" data-draft="severity" ${busyNow ? "disabled" : ""}>
              <option value="Minor"${sel("Minor")}>Незначительный — можно выдавать</option>
              <option value="Major"${sel("Major")}>Серьёзный — снять с выдачи</option>
              <option value="Out of Service"${sel("Out of Service")}>Не работает — снять с выдачи</option>
            </select>
          </div>
        </div>
        <button class="btn btn--secondary order-checkin-line" type="button"
          data-item="${escapeHtml(id)}" ${busyNow || checkinAllBusy ? "disabled" : ""}>${busyNow ? "Принимаем…" : "Принять"}</button>
      </div>`;
  }

  // Штучная (количеством) позиция — по каталогу; если его нет в кэше, по тому,
  // что на руках больше одной.
  function isByQty(group) {
    const item = itemsById[String(group.item_id)];
    return item ? ItemState.byQty(item) : group.qty > 1;
  }

  function draftFor(group) {
    const id = String(group.item_id);
    if (!drafts[id]) {
      drafts[id] = { qty: group.qty, has_defect: false, description: "", severity: "Minor" };
    }
    return drafts[id];
  }

  function lineHtml(line) {
    const left = Math.max(0, line.qty - line.issued_qty);
    // Выдать без скана можно только то, что сопоставлено с моделью: иначе
    // система не знает, какую вещь брать со склада.
    const canIssue = left > 0 && !!line.model_code;
    const busyNow = issuing.has(Number(line.line_no));
    const err = lineErrors["issue:" + line.line_no];
    const note = lineNotes["issue:" + line.line_no];
    return `
      <div class="order-line">
        <div class="order-line-name">${escapeHtml(line.raw_name)}</div>
        <div class="order-line-qty">
          выдано ${line.issued_qty} из ${line.qty}${left ? "" : " · закрыта"}
          ${line.model_code ? "" : ` · <span class="order-line-warn">нет в каталоге</span>`}
        </div>
        ${err ? `<div class="error-box">${escapeHtml(err)}</div>` : ""}
        ${note ? `<p class="hint">${escapeHtml(note)}</p>` : ""}
        ${canIssue || busyNow ? `<button class="btn btn--secondary order-issue-line"
          data-line="${escapeHtml(String(line.line_no))}"
          ${busyNow ? "disabled" : ""}>${busyNow ? "Выдаём…" : "Выдать без скана"}</button>` : ""}
      </div>`;
  }

  function wire(order, open) {
    const issueBtn = document.getElementById("order-issue");
    if (issueBtn) {
      // Выдаём на том же экране «Скана», а не во второй его копии здесь:
      // поиск предмета, количество у штучных позиций, дефекты и разбор
      // устаревшей формы там уже работают и проверены.
      issueBtn.addEventListener("click", () => Router.navigate("scan", {
        orderId: order.order_id,
        orderNo: order.order_no,
        returnDate: order.return_date || "",
        studentName: order.student_name || "",
      }));
    }
    const receiveBtn = document.getElementById("order-receive");
    if (receiveBtn) {
      receiveBtn.addEventListener("click", () => {
        receiving = !receiving;
        if (!receiving) receiveError = "";
        render(card);
        // Форма приёма — сразу под кнопкой, но на коротком экране телефона
        // её начало может оказаться у нижнего края: подводим к ней.
        const box = receiving && document.getElementById("order-receive-section");
        if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    const actBtn = document.getElementById("order-act");
    // Ссылку открываем наружу: документ живёт в Google Docs, внутри
    // мини-приложения он не откроется.
    if (actBtn) actBtn.addEventListener("click", () => TG.openLink(actBtn.dataset.url));
    document.querySelectorAll(".order-issue-line").forEach((btn) => {
      btn.addEventListener("click", () => issueLine(order, Number(btn.dataset.line)));
    });
    const arcBtn = document.getElementById("order-archive");
    if (arcBtn) arcBtn.addEventListener("click", () => archiveOrder(order, arcBtn));
    const byId = new Map(open.map((g) => [String(g.item_id), g]));
    document.querySelectorAll(".order-checkin-line").forEach((btn) => {
      btn.addEventListener("click", () => {
        const group = byId.get(btn.dataset.item);
        if (group) checkinLine(group);
      });
    });
    const allBtn = document.getElementById("order-checkin-all");
    if (allBtn) allBtn.addEventListener("click", () => checkinAll(open));
  }

  // Выдача без сканирования. Сканер остаётся главным путём — он не даёт выдать
  // не то, — но когда этикетка не читается или заказ собран заранее, упираться
  // в скан значит стоять. Предметы выбирает бэкенд: свободные, той же модели.
  //
  // Отклик — сразу: строка встаёт в «Выдаём…» до ответа таблицы (6–9 секунд),
  // остальные строки при этом живые, их можно выдавать параллельно.
  async function issueLine(order, lineNo) {
    if (issuing.has(lineNo)) return;
    // Сколько выдастся, знает только бэкенд: свободных может быть меньше, чем
    // в строке. Поэтому обещать число в вопросе нельзя.
    const go = await new Promise((resolve) => TG.showConfirm(
      "Выдать без сканирования? Система возьмёт свободные предметы этой модели.",
      resolve));
    if (!go || issuing.has(lineNo)) return;

    const key = "issue:" + lineNo;
    delete lineErrors[key];
    delete lineNotes[key];
    issuing.add(lineNo);
    opSeq += 1;
    if (card) render(card);
    try {
      const res = await apiPost("/order/issue", {
        order_id: Number(order.order_id), line_no: lineNo,
      });
      TG.hapticSuccess();
      const ids = res.issued.map((i) => i.item_id).join(", ");
      lineNotes[key] = res.left
        ? `Выдано: ${ids}. Осталось по строке: ${res.left} — свободных больше нет.`
        : `Выдано: ${ids}`;
      // Какие предметы ушли и сколько, бэкенд назвал в ответе — правим их
      // строки в кэше каталога, а не сбрасываем его: иначе следующий экран
      // ждал бы весь склад заново.
      res.issued.forEach((i) => Cache.patch("equipment", "item_id", i.item_id,
        (row) => ItemState.afterCheckout(row, i.qty)));
      loadItemsMap();
      markStale("orders");     // в списке заказов поменялся статус
      // Карточку правим сразу, а сверяемся с таблицей уже молча: на какую
      // строку легла выдача, решает бэкенд (строк одной модели бывает
      // несколько), поэтому своя догадка здесь — только до сверки.
      if (card) card = issuedLocally(card, lineNo, res.issued);
    } catch (err) {
      TG.hapticError();
      lineErrors[key] = err.message;
    } finally {
      issuing.delete(lineNo);
    }
    if (card) render(card);
    reconcile();
  }

  // Выдача без скана, какой её увидит карточка после перечитывания: строка
  // состава закрыта на выданное, в «На руках» — выданные предметы.
  function issuedLocally(data, lineNo, issued) {
    const qty = issued.reduce((sum, i) => sum + Number(i.qty || 1), 0);
    return {
      ...data,
      order: { ...data.order, status: data.order.status === "New" ? "Issued" : data.order.status },
      items: (data.items || []).map((line) => Number(line.line_no) === lineNo
        ? { ...line, issued_qty: Number(line.issued_qty || 0) + qty } : line),
      transactions: (data.transactions || []).concat(issued.map((i) => ({
        item_id: i.item_id, qty: Number(i.qty || 1), qty_in: 0, status: "Open",
        order_line: String(lineNo), checked_out_at: new Date().toISOString(),
      }))),
    };
  }

  // Приём — зеркало issuedLocally и checkinUnderLock в Code.gs: выдачи по
  // предмету закрываются по очереди с ранней, строка состава освобождается на
  // принятое, а когда на руках ничего не осталось — заказ «Возвращён».
  function returnedLocally(data, itemId, qty) {
    let left = qty;
    const back = {};   // order_line → сколько вернулось по этой строке
    const now = new Date().toISOString();
    const transactions = (data.transactions || []).map((t) => {
      if (left <= 0 || t.status !== "Open" || String(t.item_id) !== String(itemId)) return t;
      const onHands = Number(t.qty || 1) - Number(t.qty_in || 0);
      const take = Math.min(onHands, left);
      if (take <= 0) return t;
      left -= take;
      back[String(t.order_line)] = (back[String(t.order_line)] || 0) + take;
      const qtyIn = Number(t.qty_in || 0) + take;
      return qtyIn >= Number(t.qty || 1)
        ? { ...t, qty_in: qtyIn, status: "Closed", checked_in_at: now }
        : { ...t, qty_in: qtyIn };
    });
    const stillOut = transactions.some((t) => t.status === "Open");
    return {
      ...data,
      order: { ...data.order, status: data.order.status === "Cancelled" ? "Cancelled"
        : stillOut ? "Issued" : "Returned" },
      items: (data.items || []).map((line) => back[String(line.line_no)]
        ? { ...line, issued_qty: Math.max(0, Number(line.issued_qty || 0) - back[String(line.line_no)]) }
        : line),
      transactions,
    };
  }

  // Приём одной позиции прямо в карточке — сделано как submitCheckin в
  // scan.js: тот же запрос /transaction/checkin и те же поля. Раньше кнопка
  // уводила на «Скан», а там — ещё один поиск предмета (6–9 секунд) и та же
  // форма: «отсканируй ещё раз» то, что и так известно по заказу.
  async function checkinLine(group) {
    const id = String(group.item_id);
    if (checkingIn.has(id) || checkinAllBusy) return;
    const key = "in:" + id;
    const d = draftFor(group);
    const byQty = isByQty(group);
    const qty = byQty ? Math.floor(Number(d.qty)) : 1;
    if (byQty && (!qty || qty < 1 || qty > group.qty)) {
      TG.hapticError();
      lineErrors[key] = `Сколько принимаем — целое число от 1 до ${group.qty}`;
      render(card);
      return;
    }
    const hasDefect = !!d.has_defect;
    const description = hasDefect ? String(d.description || "").trim() : null;
    const severity = hasDefect ? d.severity || "Minor" : null;

    delete lineErrors[key];
    receiveError = "";
    lineNotes = {};   // «Выдано: …» у строк состава после возврата уже неправда
    checkingIn.add(id);
    opSeq += 1;
    render(card);
    try {
      const res = await apiPost("/transaction/checkin", {
        item_id: id,
        qty,
        has_defect: hasDefect,
        defect_description: description,
        defect_severity: severity,
        notes: "",
      });
      TG.hapticSuccess();
      if (hasDefect) markStale("defects");     // в ремонте появилась запись
      markStale("orders");                     // заказ мог закрыться возвратом
      Cache.patch("equipment", "item_id", id,
        (row) => ItemState.afterCheckin(row, qty, severity, res && res.qty_out));
      loadItemsMap();
      delete drafts[id];
      card = returnedLocally(card, id, qty);
    } catch (err) {
      TG.hapticError();
      lineErrors[key] = err.message;
    } finally {
      checkingIn.delete(id);
    }
    render(card);
    reconcile();
  }

  // Архив, а не удаление: запись о договорённости не стирают. Возврат из
  // архива — та же кнопка, тем же запросом.
  async function archiveOrder(order, btn) {
    const back = btn.dataset.back === "1";
    if (!back) {
      const go = await new Promise((resolve) => TG.showConfirm(
        `Убрать заказ №${order.order_no} в архив? Из списка исчезнет, ` +
        "но сохранится целиком.", resolve));
      if (!go) return;
    }
    btn.disabled = true;
    btn.textContent = back ? "Возвращаем…" : "Убираем…";
    try {
      await apiPost("/order/archive", { order_id: Number(order.order_id), back });
      // Список заказов держится в кэше: без сброса убранный заказ остаётся на
      // экране, и человек жмёт «в архив» второй раз, думая, что не сработало.
      Cache.clear("orders");
      TG.hapticSuccess();
      if (back) {
        TG.showAlert("Заказ вернулся в список");
        await load({ force: true });
      } else {
        TG.showAlert("Заказ в архиве");
        Router.navigate("orders");
      }
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
      btn.disabled = false;
      btn.textContent = back ? "Вернуть из архива" : "Убрать в архив";
    }
  }

  // Приём всего заказа — одним запросом /transaction/checkin-batch: вход и
  // замок в таблице один на всю пачку, а не на каждую позицию (раньше было по
  // 6–9 секунд на штуку). Позиции закрываются независимо: сбой на одной не
  // отменяет остальные, ответ говорит про каждую — и ошибка встаёт у своей
  // строки, а принятые уходят из «На руках» сразу.
  async function checkinAll(groups) {
    if (checkinAllBusy || checkingIn.size || !groups.length) return;
    checkinAllBusy = true;
    opSeq += 1;
    receiveError = "";
    lineNotes = {};
    groups.forEach((g) => delete lineErrors["in:" + g.item_id]);
    render(card);
    const failed = [];
    let done = 0;
    try {
      const res = await apiPost("/transaction/checkin-batch", {
        order_id: Number(currentOrderId),
        items: groups.map(({ item_id, qty }) => ({ item_id, qty })),
      });
      const byId = new Map(groups.map((g) => [String(g.item_id), g]));
      ((res && res.results) || []).forEach((r) => {
        const g = byId.get(String(r.item_id));
        if (r.ok) {
          const qty = g ? g.qty : Number(r.qty || 1);
          // Принятое известно — правим строку каталога, а не сбрасываем весь.
          Cache.patch("equipment", "item_id", r.item_id,
            (row) => ItemState.afterCheckin(row, qty, null, r.qty_out));
          card = returnedLocally(card, r.item_id, qty);
          delete drafts[String(r.item_id)];
          done += 1;
        } else {
          lineErrors["in:" + r.item_id] = r.error;
          failed.push(itemName(r.item_id) + ": " + r.error);
        }
      });
    } catch (err) {
      failed.push(err.message);
    } finally {
      checkinAllBusy = false;
    }
    markStale("orders");
    loadItemsMap();
    if (failed.length) {
      TG.hapticError();
      receiveError = (done ? `Принято ${done}, не принято: ` : "Не принято: ") + failed.join("; ");
    } else {
      TG.hapticSuccess();
      receiving = false;
      TG.showAlert("Принято " + done + " " + plural(done, "позиция", "позиции", "позиций"));
    }
    render(card);
    reconcile();
  }

  function onShow(params) {
    if (params && params.orderId !== undefined && String(params.orderId) !== String(currentOrderId)) {
      currentOrderId = params.orderId;
      card = null;
      receiving = false;
      receiveError = "";
      lineErrors = {};
      lineNotes = {};
      drafts = {};
    }
    load();
  }

  function init() {
    // Нажатие на номер — копирование, на ник — переписка через Telegram.
    // Вешаем один раз: #order-content живёт всё время, а render за показ идёт
    // дважды (из кэша, потом свежий) — в wire слушатели копились бы.
    document.getElementById("order-content").addEventListener("click", (e) => {
      const copy = e.target.closest("[data-copy]");
      if (copy) { copyNumber(copy); return; }
      const chat = e.target.closest("[data-tg]");
      if (!chat) return;
      e.preventDefault();
      TG.openTelegramLink("https://t.me/" + encodeURIComponent(chat.dataset.tg));
    });
    // Форма приёма в строке: введённое запоминаем сразу, чтобы перерисовка
    // (ответ по соседней строке, свежие данные) его не стёрла.
    const remember = (e) => {
      const el = e.target;
      const field = el && el.dataset && el.dataset.draft;
      const row = field && el.closest(".order-line[data-item]");
      if (!row) return;
      const id = row.dataset.item;
      if (!drafts[id]) return;
      drafts[id][field] = el.type === "checkbox" ? el.checked : el.value;
      if (field === "has_defect") {
        const box = row.querySelector(".oc-defect-fields");
        if (box) box.style.display = el.checked ? "block" : "none";
      }
      delete lineErrors["in:" + id];
    };
    document.getElementById("order-content").addEventListener("input", remember);
    document.getElementById("order-content").addEventListener("change", remember);
    Router.register("order", { onShow });
  }

  return { init };
})();
