// Экран «Заказы» — журнал заявок с сайта брони.
//
// Заменил прежних «Клиентов». Прежняя модель была справочником «клиент/проект»,
// из которого выбирали при выдаче; на самом деле с сайта приходит заказ: свой
// номер, даты, состав позициями с количеством и — если арендатор
// несовершеннолетний — ещё и представитель. Справочник этого не держит.
//
// Ввод заказа — вставкой сообщения, которое бот сайта уже присылает в общий чат.
// Разбирает его бэкенд (/order/parse, без записи), человек смотрит, что
// распознано, и подтверждает. Печатать по полям то, что уже есть текстом, —
// работа на пустом месте, а вслепую сохранять чужие персональные данные нельзя.

const OrdersScreen = (() => {
  const CACHE = "orders";
  let busy = false;
  let expandedId = null;
  let draft = null;      // разобранный заказ, ждёт подтверждения
  let itemsById = {};

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

  function today() {
    return new Date().toISOString().substring(0, 10);
  }

  // Просрочка — производное состояние, а не статус в таблице: заказ просрочен,
  // пока техника на руках и дата возврата уже прошла.
  function isOverdue(order) {
    return order.status === "Issued" && order.return_date && order.return_date < today();
  }

  function drawRefreshRow() {
    renderRefreshRow("orders-refresh", CACHE, () => loadList({ force: true }), busy);
  }

  // ---- список ----

  function matches(order) {
    const status = document.getElementById("orders-filter-status").value;
    if (status === "overdue") {
      if (!isOverdue(order)) return false;
    } else if (status !== "all" && order.status !== status) {
      return false;
    }
    const q = document.getElementById("orders-search").value.trim().toLowerCase();
    if (!q) return true;
    // Ищем и по составу заказа: «найди, у кого сейчас OSTERRIG» — обычный вопрос
    // на складе, а состав до этого был виден только внутри карточки.
    const haystack = [order.order_no, order.student_name, order.student_phone,
                      order.student_tg, order.project, order.items_text]
      .filter(Boolean).join(" ").toLowerCase();
    if (haystack.indexOf(q) !== -1) return true;
    // Ник ищем и без «собаки»: в поиске её набирают через раз.
    if (q.charAt(0) === "@" && haystack.indexOf(q.slice(1)) !== -1) return true;
    // Телефон — по цифрам: +7, 8 и запись через скобки должны находить одно и то же.
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 4) {
      const phone = String(order.student_phone || "").replace(/\D/g, "");
      const local = phone.length === 11 ? phone.slice(1) : phone;
      if (local.indexOf(digits.length === 11 ? digits.slice(1) : digits) !== -1) return true;
    }
    return false;
  }

  function orderCardHtml(order) {
    const overdue = isOverdue(order);
    const parts = [];
    if (order.project) parts.push(escapeHtml(order.project));
    if (order.issue_date || order.return_date) {
      parts.push(escapeHtml((order.issue_date || "?") + " → " + (order.return_date || "?")));
    }
    if (order.issued_open) parts.push(`на руках ${order.issued_open}`);

    return `
      <div class="card" data-order-id="${order.order_id}">
        <div class="card-title">
          <span class="order-no"><span class="order-no-sign">№</span>${escapeHtml(order.order_no)}</span>
          ${statusBadge(order.status)}
          ${overdue ? `<span class="badge badge--open">Просрочен</span>` : ""}
        </div>
        <div class="card-sub">${escapeHtml(order.student_name || "—")}${order.is_adult ? "" : " · с представителем"}</div>
        <div class="card-sub">${parts.join(" · ")}</div>
        <div id="order-detail-${order.order_id}"></div>
      </div>`;
  }

  function render(orders) {
    const list = document.getElementById("orders-list");
    const visible = orders.filter(matches);
    if (!orders.length) {
      list.innerHTML = `<p class="empty">Заказов пока нет. Вставьте сообщение бота — оно разберётся само.</p>`;
      return;
    }
    if (!visible.length) {
      list.innerHTML = `<p class="empty">Под фильтры ничего не попало</p>`;
      return;
    }
    // Свежие сверху: склад работает с тем, что оформлено недавно.
    visible.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    list.innerHTML = visible.map(orderCardHtml).join("");
    list.querySelectorAll("[data-order-id]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("a, button, select, input")) return;
        toggleDetail(el.dataset.orderId);
      });
    });
  }

  async function loadList({ force = false } = {}) {
    const list = document.getElementById("orders-list");
    const cached = Cache.items(CACHE);
    loadItemsMap();

    if (cached && cached.length) render(cached);
    drawRefreshRow();

    if (!force && cached && cached.length && Cache.isFresh(CACHE)) return;

    if (!cached || !cached.length) list.innerHTML = skeleton(3);
    busy = true;
    drawRefreshRow();
    try {
      const orders = await apiPost("/orders/list", { status: "all" });
      Cache.set(CACHE, orders);
      render(orders);
    } catch (err) {
      if (!cached || !cached.length) {
        list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      }
    } finally {
      busy = false;
      drawRefreshRow();
    }
  }

  // ---- карточка заказа ----

  async function toggleDetail(orderId) {
    const box = document.getElementById(`order-detail-${orderId}`);
    if (!box) return;
    if (String(expandedId) === String(orderId)) {
      box.innerHTML = "";
      expandedId = null;
      return;
    }
    expandedId = orderId;
    box.innerHTML = `<p class="hint">Загрузка заказа…</p>`;
    try {
      const data = await apiPost("/order/card", { order_id: Number(orderId) });
      box.innerHTML = detailHtml(data);
    } catch (err) {
      box.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  function detailHtml(data) {
    const o = data.order;
    const lines = data.items.slice().sort((a, b) => a.line_no - b.line_no);
    const open = data.transactions.filter((t) => t.status === "Open");
    const closed = data.transactions.filter((t) => t.status !== "Open");

    return `
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
        ${open.map((t) => `<div class="card-sub">${escapeHtml(itemName(t.item_id))} · ${escapeHtml(String(t.item_id))}${String(t.order_line) === "off-order" ? " · вне состава" : ""}</div>`).join("")}
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

  // ---- ввод заказа ----

  function pasteFormHtml() {
    return `
      <h2>Новый заказ</h2>
      <div id="orders-add-error"></div>
      <div class="field">
        <label for="orders-paste">Сообщение бота о заказе</label>
        <textarea id="orders-paste" rows="6" placeholder="Заказ №1525686941&#10;1. GODOX OCTABOX 120: 0 (1 x 0.00)&#10;…"></textarea>
        <p class="hint">Скопируйте сообщение из чата целиком — номер, состав и данные
        разберутся сами. Сохранение произойдёт только после вашего подтверждения.</p>
      </div>
      <button class="btn" id="orders-parse-btn">Разобрать</button>
      <button class="btn btn--secondary" id="orders-manual-btn">Завести вручную</button>`;
  }

  function manualFormHtml() {
    return `
      <h2>Заказ вручную</h2>
      <div id="orders-add-error"></div>
      <p class="hint">Состав здесь не заполняется: выдача пойдёт как «вне заказа»,
      это нормально. Если сообщение бота есть — лучше вставить его.</p>
      <div class="field"><label for="mo-no">Номер заказа</label>
        <input id="mo-no" type="text" inputmode="numeric" /></div>
      <div class="field"><label for="mo-name">ФИО арендатора</label>
        <input id="mo-name" type="text" /></div>
      <div class="field"><label for="mo-phone">Телефон</label>
        <input id="mo-phone" type="tel" placeholder="+7…" /></div>
      <div class="field"><label for="mo-tg">Telegram</label>
        <input id="mo-tg" type="text" placeholder="@ник" /></div>
      <div class="toggle-row">
        <label for="mo-minor">Арендатор несовершеннолетний</label>
        <input id="mo-minor" type="checkbox" />
      </div>
      <div id="mo-guardian" style="display:none;">
        <div class="field"><label for="mo-gname">ФИО представителя</label>
          <input id="mo-gname" type="text" /></div>
        <div class="field"><label for="mo-gphone">Телефон представителя</label>
          <input id="mo-gphone" type="tel" /></div>
      </div>
      <div class="field"><label for="mo-issue">Дата выдачи</label>
        <input id="mo-issue" type="date" /></div>
      <div class="field"><label for="mo-return">Дата возврата</label>
        <input id="mo-return" type="date" /></div>
      <div class="field"><label for="mo-project">Проект</label>
        <input id="mo-project" type="text" /></div>
      <button class="btn" id="orders-manual-submit">Создать заказ</button>
      <button class="btn btn--secondary" id="orders-back-to-paste">← К вставке сообщения</button>`;
  }

  function confirmHtml(data) {
    const o = data.order;
    const unknown = Object.keys(data.fields || {}).filter(function (k) {
      // Поля, которые мы уже разложили по своим колонкам, второй раз показывать
      // незачем; всё остальное человек должен увидеть — форма на сайте меняется.
      return ["areyouanadult", "fullnameguardian", "phoneguardian", "fullnameminor",
              "phoneminors", "telegramminors", "dateofissue", "datecompletion",
              "typeandnameoftheproject", "input", "суммаплатежа", "кодзаявки"].indexOf(k) === -1;
    });

    return `
      <h2>Проверьте заказ</h2>
      <div id="orders-add-error"></div>
      ${data.already_exists ? `<div class="error-box">Заказ с этим номером уже заведён (№${data.already_exists}). Создать второй нельзя.</div>` : ""}
      ${data.warnings && data.warnings.length
        ? `<div class="order-warn">${data.warnings.map((w) => `<div>• ${escapeHtml(w)}</div>`).join("")}</div>`
        : ""}

      <div class="card">
        <div class="card-title"><span class="order-no"><span class="order-no-sign">№</span>${escapeHtml(o.order_no || "—")}</span></div>
        <div class="card-sub">${escapeHtml(o.student_name || "имя не распознано")}</div>
        <div class="card-sub">${escapeHtml(o.student_phone || "телефон не распознан")} ${escapeHtml(o.student_tg || "")}</div>
        ${o.is_adult === "FALSE" ? `<div class="card-sub">Представитель: ${escapeHtml(o.guardian_name || "—")} ${escapeHtml(o.guardian_phone || "")}</div>` : ""}
        <div class="card-sub">${escapeHtml(o.issue_date || "?")} → ${escapeHtml(o.return_date || "?")}${o.project ? " · " + escapeHtml(o.project) : ""}</div>
        ${o.extra_input ? `<div class="card-sub">Дописано: ${escapeHtml(o.extra_input)}</div>` : ""}
      </div>

      <div class="section-title">Состав — ${data.items.length} ${plural(data.items.length, "позиция", "позиции", "позиций")}</div>
      ${data.items.map(confirmLineHtml).join("")}

      ${unknown.length ? `
      <details class="order-raw">
        <summary>Прочие поля из заказа (${unknown.length})</summary>
        ${unknown.map((k) => `<div class="card-sub">${escapeHtml((data.raw_keys && data.raw_keys[k]) || k)}: ${escapeHtml(data.fields[k])}</div>`).join("")}
      </details>` : ""}

      <button class="btn" id="orders-confirm-btn" ${data.already_exists ? "disabled" : ""}>Создать заказ</button>
      <button class="btn btn--secondary" id="orders-cancel-btn">Отмена</button>`;
  }

  // Сопоставление строки с каталогом делает человек, если точного совпадения не
  // нашлось: ошибка здесь означает, что выдача спишется с чужой строки заказа.
  function confirmLineHtml(line, idx) {
    const options = [`<option value="">— нет в каталоге —</option>`].concat(
      (line.suggestions || []).map((s) =>
        `<option value="${escapeHtml(s.category)}|${escapeHtml(s.model_code)}">${escapeHtml(s.model_name)}</option>`));

    return `
      <div class="order-line">
        <div class="order-line-name">${escapeHtml(line.raw_name)}</div>
        <div class="order-line-qty">${line.qty} ${plural(line.qty, "шт", "шт", "шт")}${line.price ? " · " + escapeHtml(String(line.price)) + " за шт" : ""}</div>
        ${line.model_code
          ? `<div class="order-line-ok">сопоставлено с каталогом</div>`
          : `<select class="order-line-pick" data-line="${idx}">${options.join("")}</select>`}
      </div>`;
  }

  function showAdd(html) {
    const box = document.getElementById("orders-add");
    box.style.display = "block";
    box.innerHTML = html;
    wireAdd();
  }

  function hideAdd() {
    draft = null;
    const box = document.getElementById("orders-add");
    box.style.display = "none";
    box.innerHTML = "";
  }

  function wireAdd() {
    const on = (id, event, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, handler);
    };
    on("orders-parse-btn", "click", parsePasted);
    on("orders-manual-btn", "click", () => showAdd(manualFormHtml()));
    on("orders-back-to-paste", "click", () => showAdd(pasteFormHtml()));
    on("orders-manual-submit", "click", submitManual);
    on("orders-confirm-btn", "click", submitDraft);
    on("orders-cancel-btn", "click", () => showAdd(pasteFormHtml()));
    on("mo-minor", "change", (e) => {
      document.getElementById("mo-guardian").style.display = e.target.checked ? "block" : "none";
    });
  }

  async function parsePasted() {
    const text = document.getElementById("orders-paste").value;
    if (!text.trim()) {
      showBoxError("orders-add-error", "Вставьте сообщение о заказе");
      return;
    }
    const btn = document.getElementById("orders-parse-btn");
    btn.disabled = true;
    showBoxError("orders-add-error", "");
    try {
      const data = await apiPost("/order/parse", { text });
      draft = data;
      showAdd(confirmHtml(data));
    } catch (err) {
      showBoxError("orders-add-error", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function submitDraft() {
    if (!draft) return;
    // Подхватываем сопоставления, которые человек выбрал руками.
    document.querySelectorAll(".order-line-pick").forEach((sel) => {
      if (!sel.value) return;
      const [category, modelCode] = sel.value.split("|");
      const line = draft.items[Number(sel.dataset.line)];
      if (line) { line.category = category; line.model_code = modelCode; }
    });

    const btn = document.getElementById("orders-confirm-btn");
    btn.disabled = true;
    try {
      const payload = Object.assign({}, draft.order, { items: draft.items });
      const created = await apiPost("/order/create", payload);
      TG.hapticSuccess();
      TG.showAlert("Заказ " + draft.order.order_no + " заведён" +
        (created.student_created ? ". Арендатор добавлен впервые." : ""));
      Cache.clear(CACHE);
      hideAdd();
      loadList({ force: true });
    } catch (err) {
      TG.hapticError();
      showBoxError("orders-add-error", err.message);
      btn.disabled = false;
    }
  }

  async function submitManual() {
    const value = (id) => document.getElementById(id).value.trim();
    if (!value("mo-no")) { showBoxError("orders-add-error", "Укажите номер заказа"); return; }
    if (!value("mo-name")) { showBoxError("orders-add-error", "Укажите ФИО арендатора"); return; }
    const minor = document.getElementById("mo-minor").checked;

    const btn = document.getElementById("orders-manual-submit");
    btn.disabled = true;
    try {
      await apiPost("/order/create", {
        order_no: value("mo-no"),
        student_name: value("mo-name"),
        student_phone: value("mo-phone"),
        student_tg: value("mo-tg"),
        is_adult: minor ? "FALSE" : "TRUE",
        guardian_name: minor ? value("mo-gname") : "",
        guardian_phone: minor ? value("mo-gphone") : "",
        issue_date: value("mo-issue"),
        return_date: value("mo-return"),
        project: value("mo-project"),
        items: [],
      });
      TG.hapticSuccess();
      Cache.clear(CACHE);
      hideAdd();
      loadList({ force: true });
    } catch (err) {
      TG.hapticError();
      showBoxError("orders-add-error", err.message);
      btn.disabled = false;
    }
  }

  // ---- жизненный цикл ----

  function onShow() {
    expandedId = null;
    hideAdd();
    loadList();
  }

  function init() {
    document.getElementById("orders-add-toggle").addEventListener("click", () => {
      const box = document.getElementById("orders-add");
      if (box.style.display === "block") hideAdd();
      else showAdd(pasteFormHtml());
    });
    ["orders-filter-status", "orders-search"].forEach((id) => {
      const el = document.getElementById(id);
      const event = id === "orders-search" ? "input" : "change";
      el.addEventListener(event, () => {
        const cached = Cache.items(CACHE);
        if (cached) render(cached);
      });
    });
    Router.register("orders", { onShow });
  }

  return { init };
})();
