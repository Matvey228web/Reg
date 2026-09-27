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
  async function ensureItemsMap() {
    if (Cache.items("equipment")) return;
    try {
      const items = await apiPost("/equipment/list", { category: "all", status: "all" });
      Cache.set("equipment", items);
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

      <div class="section">
        <div class="section-title">Арендатор</div>
        <div class="card-sub">${escapeHtml(o.student_name || "—")}</div>
        ${o.student_phone ? `<div class="card-sub"><a href="tel:${escapeHtml(o.student_phone)}">${escapeHtml(o.student_phone)}</a></div>` : ""}
        ${o.student_tg ? `<div class="card-sub"><a href="https://t.me/${escapeHtml(String(o.student_tg).replace(/^@/, ""))}" target="_blank" rel="noopener">${escapeHtml(o.student_tg)}</a></div>` : ""}
        ${o.is_adult ? "" : `
          <div class="section-title" style="margin-top:10px;">Представитель (арендатор несовершеннолетний)</div>
          <div class="card-sub">${escapeHtml(o.guardian_name || "—")}</div>
          ${o.guardian_phone ? `<div class="card-sub"><a href="tel:${escapeHtml(o.guardian_phone)}">${escapeHtml(o.guardian_phone)}</a></div>` : ""}`}
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
    return `
      <div class="order-line">
        <div class="order-line-name">${escapeHtml(line.raw_name)}</div>
        <div class="order-line-qty">
          выдано ${line.issued_qty} из ${line.qty}${left ? "" : " · закрыта"}
          ${line.model_code ? "" : ` · <span class="order-line-warn">нет в каталоге</span>`}
        </div>
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
    document.querySelectorAll(".order-line-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        Router.navigate("scan", { itemId: btn.dataset.item, mode: "checkin" });
      });
    });
    const allBtn = document.getElementById("order-checkin-all");
    if (allBtn) allBtn.addEventListener("click", () => checkinAll(open));
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
        await apiPost("/transaction/checkin", { item_id: groups[i].item_id, qty: groups[i].qty });
        done += 1;
      } catch (err) {
        failed.push(itemName(groups[i].item_id) + ": " + err.message);
      }
    }
    Cache.clear("orders");
    Cache.clear("equipment");
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
    Router.register("order", { onShow });
  }

  return { init };
})();
