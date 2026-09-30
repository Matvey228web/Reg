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

    if (busy && !force) return;
    busy = true;
    try {
      const [data] = await Promise.all([
        apiPost("/order/card", { order_id: Number(currentOrderId) }),
        ensureItemsMap(),
      ]);
      card = data;
      render(data);
    } catch (err) {
      if (!card) content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    } finally {
      busy = false;
    }
  }

  // Телефон и ник остаются строками, как были, — но по ним можно нажать.
  //
  // Телефон — настоящая ссылка tel:, а не вызов из кода. Именно в этом была
  // поломка: WebView отдаёт номер телефону, когда по ссылке нажал человек, а
  // переход, сделанный скриптом, молча отбрасывает. Поэтому здесь ссылка и
  // никаких обработчиков на ней.
  //
  // Ник, наоборот, обработчиком: ссылка t.me открылась бы браузером на
  // странице «Open in Telegram», и до чата осталось бы ещё два нажатия.
  function contactRow(phone, tg) {
    const nick = String(tg || "").replace(/^@/, "");
    const num = String(phone || "").replace(/[^\d+]/g, "");
    return (phone
      ? `<div class="card-sub"><a class="tap-line" href="tel:${escapeHtml(num)}">${escapeHtml(phone)}</a></div>`
      : "") + (nick
      ? `<div class="card-sub"><a class="tap-line" href="https://t.me/${escapeHtml(nick)}"
             data-tg="${escapeHtml(nick)}">@${escapeHtml(nick)}</a></div>`
      : "");
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
        ${open.length ? `<button class="btn ${o.status === "Cancelled" ? "" : "btn--secondary"}" id="order-receive">Принять по заказу</button>` : ""}
      </div>

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

      ${open.length ? `
      <div class="section">
        <div class="section-title">На руках сейчас</div>
        <div id="order-open-list">${open.map((g) => openRowHtml(g, receiving)).join("")}</div>
        ${receiving ? `
        ${receiveError ? `<div class="error-box">${escapeHtml(receiveError)}</div>` : ""}
        <div id="order-checkin-status" class="hint"></div>
        <button class="btn" id="order-checkin-all">Принять всё (${open.length})</button>
        <p class="hint">Возврат без дефектов. Сломанное принимайте позицией отдельно — там есть
          форма дефекта.</p>` : ""}
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

  // Позиция на руках. В режиме приёма у каждой появляется своя кнопка: она
  // ведёт в ту же форму приёма, что и «Скан», — с галочкой дефекта. Второй
  // формы для дефекта заводить нельзя, возврат со сломанной техникой это
  // главное, ради чего приём вообще смотрят глазами.
  function openRowHtml(group, withButton) {
    const qty = group.qty > 1 ? ` · ${group.qty} шт` : "";
    const tail = group.off_order ? " · вне состава" : "";
    return `
      <div class="order-line">
        <div class="order-line-name">${escapeHtml(itemName(group.item_id))}</div>
        <div class="order-line-qty">${escapeHtml(group.item_id)}${qty}${tail}</div>
        ${withButton ? `<button class="btn btn--secondary order-line-btn"
          data-item="${escapeHtml(group.item_id)}">Принять</button>` : ""}
      </div>`;
  }

  function lineHtml(line) {
    const left = Math.max(0, line.qty - line.issued_qty);
    // Выдать без скана можно только то, что сопоставлено с моделью: иначе
    // система не знает, какую вещь брать со склада.
    const canIssue = left > 0 && !!line.model_code;
    return `
      <div class="order-line">
        <div class="order-line-name">${escapeHtml(line.raw_name)}</div>
        <div class="order-line-qty">
          выдано ${line.issued_qty} из ${line.qty}${left ? "" : " · закрыта"}
          ${line.model_code ? "" : ` · <span class="order-line-warn">нет в каталоге</span>`}
        </div>
        ${canIssue ? `<button class="btn btn--secondary order-issue-line"
          data-line="${escapeHtml(String(line.line_no))}"
          data-left="${escapeHtml(String(left))}">Выдать без скана</button>` : ""}
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
        render(card);
      });
    }
    const actBtn = document.getElementById("order-act");
    // Ссылку открываем наружу: документ живёт в Google Docs, внутри
    // мини-приложения он не откроется.
    if (actBtn) actBtn.addEventListener("click", () => TG.openLink(actBtn.dataset.url));
    document.querySelectorAll(".order-issue-line").forEach((btn) => {
      btn.addEventListener("click", () => issueLine(order, btn));
    });
    const arcBtn = document.getElementById("order-archive");
    if (arcBtn) arcBtn.addEventListener("click", () => archiveOrder(order, arcBtn));
    document.querySelectorAll(".order-line-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        Router.navigate("scan", { itemId: btn.dataset.item, mode: "checkin" });
      });
    });
    const allBtn = document.getElementById("order-checkin-all");
    if (allBtn) allBtn.addEventListener("click", () => checkinAll(open));
  }

  // Выдача без сканирования. Сканер остаётся главным путём — он не даёт выдать
  // не то, — но когда этикетка не читается или заказ собран заранее, упираться
  // в скан значит стоять. Предметы выбирает бэкенд: свободные, той же модели.
  async function issueLine(order, btn) {
    // Сколько выдастся, знает только бэкенд: свободных может быть меньше, чем
    // в строке. Поэтому обещать число в вопросе нельзя.
    const go = await new Promise((resolve) => TG.showConfirm(
      "Выдать без сканирования? Система возьмёт свободные предметы этой модели.",
      resolve));
    if (!go) return;

    btn.disabled = true;
    btn.textContent = "Выдаём…";
    try {
      const res = await apiPost("/order/issue", {
        order_id: Number(order.order_id), line_no: Number(btn.dataset.line),
      });
      TG.hapticSuccess();
      const ids = res.issued.map((i) => i.item_id).join(", ");
      TG.showAlert(res.left
        ? `Выдано: ${ids}. Осталось по строке: ${res.left} — свободных больше нет.`
        : `Выдано: ${ids}`);
      // Какие предметы ушли и сколько, бэкенд назвал в ответе — правим их
      // строки в кэше каталога, а не сбрасываем его: иначе следующий экран
      // ждал бы весь склад заново.
      res.issued.forEach((i) => Cache.patch("equipment", "item_id", i.item_id,
        (row) => ItemState.afterCheckout(row, i.qty)));
      loadItemsMap();
      Cache.clear("orders");   // в списке заказов поменялся статус
      // Карточку показываем сразу с выданным, а сверяемся с таблицей уже
      // молча: на какую строку легла выдача, решает бэкенд (строк одной модели
      // бывает несколько), поэтому своя догадка здесь — только до ответа.
      if (card) {
        render(issuedLocally(card, Number(btn.dataset.line), res.issued));
      }
      load();
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
      btn.disabled = false;
      btn.textContent = "Выдать без скана";
    }
  }

  // Выдача без скана, какой её увидит карточка после перечитывания: строка
  // состава закрыта на выданное, в «На руках» — выданные предметы.
  function issuedLocally(data, lineNo, issued) {
    const qty = issued.reduce((sum, i) => sum + Number(i.qty || 1), 0);
    card = {
      ...data,
      order: { ...data.order, status: data.order.status === "New" ? "Issued" : data.order.status },
      items: (data.items || []).map((line) => Number(line.line_no) === lineNo
        ? { ...line, issued_qty: Number(line.issued_qty || 0) + qty } : line),
      transactions: (data.transactions || []).concat(issued.map((i) => ({
        item_id: i.item_id, qty: Number(i.qty || 1), qty_in: 0, status: "Open",
        order_line: String(lineNo), checked_out_at: new Date().toISOString(),
      }))),
    };
    return card;
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

  // Приём всего заказа. Запросов столько же, сколько позиций: каждый приём
  // берёт в таблице свою блокировку, и складывать их в один вызов, не проверив
  // поведение повторного захвата, на пути возврата техники нельзя. Зато каждая
  // позиция закрывается независимо — сбой на одной не отменяет остальные.
  async function checkinAll(groups) {
    const btn = document.getElementById("order-checkin-all");
    const status = document.getElementById("order-checkin-status");
    if (!btn || !status) return;
    btn.disabled = true;
    receiveError = "";
    const failed = [];
    let done = 0;
    for (let i = 0; i < groups.length; i++) {
      status.textContent = `Принимаю ${i + 1} из ${groups.length}…`;
      try {
        const res = await apiPost("/transaction/checkin", { item_id: groups[i].item_id, qty: groups[i].qty });
        // Принятое известно — правим строку каталога, а не сбрасываем весь.
        Cache.patch("equipment", "item_id", groups[i].item_id,
          (row) => ItemState.afterCheckin(row, groups[i].qty, null, res && res.qty_out));
        done += 1;
      } catch (err) {
        failed.push(itemName(groups[i].item_id) + ": " + err.message);
      }
    }
    Cache.clear("orders");
    if (failed.length) {
      TG.hapticError();
      receiveError = "Не принято: " + failed.join("; ");
    } else {
      TG.hapticSuccess();
      TG.showAlert("Принято " + done + " " + plural(done, "позиция", "позиции", "позиций"));
      receiving = false;
    }
    await load({ force: true });
  }

  function onShow(params) {
    if (params && params.orderId !== undefined && String(params.orderId) !== String(currentOrderId)) {
      currentOrderId = params.orderId;
      card = null;
      receiving = false;
    }
    load();
  }

  function init() {
    // Ник — обработчиком, чтобы переписку открыл сам Telegram. Телефон здесь
    // не перехватываем: ссылка tel: должна уйти в систему как есть. Вешаем
    // один раз: #order-content живёт всё время, а render за показ идёт дважды
    // (из кэша, потом свежий) — в wire слушатели копились бы.
    document.getElementById("order-content").addEventListener("click", (e) => {
      const chat = e.target.closest("[data-tg]");
      if (!chat) return;
      e.preventDefault();
      TG.openTelegramLink("https://t.me/" + chat.dataset.tg);
    });
    Router.register("order", { onShow });
  }

  return { init };
})();
