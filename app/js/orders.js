// Экран «Заказы» — журнал заявок с сайта брони. Заменил прежних «Клиентов»:
// с сайта приходит заказ со своим номером, датами, составом и представителем
// несовершеннолетнего — справочник «клиент/проект» этого не держал.
//
// Ввод — вставкой сообщения бота. Разбирает бэкенд (/order/parse, без записи),
// человек смотрит распознанное и подтверждает: вслепую сохранять чужие
// персональные данные нельзя.

const OrdersScreen = (() => {
  const CACHE = "orders";
  // Архив — отдельным списком и своим кэшем: /orders/list отдаёт его только по
  // archived: true, а в основном списке архивных нет. Открывается сегментом
  // «Архив» в фильтре; оттуда заказ смахиванием вправо возвращается.
  const ARCH = "orders_archived";

  function inArchive() {
    return segmentedValue("orders-filter-status") === "archived";
  }
  function source() {
    return inArchive() ? ARCH : CACHE;
  }
  let busy = false;
  let draft = null;      // разобранный заказ, ждёт подтверждения

  function today() {
    return new Date().toISOString().substring(0, 10);
  }

  // Просрочка — производное состояние, а не статус в таблице: заказ просрочен,
  // пока техника на руках и дата возврата уже прошла.
  function isOverdue(order) {
    return order.status === "Issued" && order.return_date && order.return_date < today();
  }

  function drawRefreshRow() {
    renderRefreshRow("orders-refresh", source(), () => loadList({ force: true }), busy);
  }

  // ---- список ----

  function matches(order) {
    const status = segmentedValue("orders-filter-status");
    if (status === "overdue") {
      if (!isOverdue(order)) return false;
    } else if (status !== "all" && status !== "archived" && order.status !== status) {
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

    // Статус у каждого заказа, и «Возвращён» тоже — statusBadge, а не
    // statusChip (решение владельца 6 октября): без бейджа строка читалась как
    // «статус неизвестен». В каталоге, где строк сотни, норма по-прежнему молчит.
    return `
      <div class="card" data-order-id="${order.order_id}">
        <div class="card-title">
          ${orderNoHtml(order)}
          ${statusBadge(order.status)}
          ${overdue ? `<span class="badge badge--open">Просрочен</span>` : ""}
        </div>
        <div class="card-sub">${escapeHtml(order.student_name || "—")}${order.is_adult ? "" : " · с представителем"}</div>
        <div class="card-sub">${parts.join(" · ")}</div>
      </div>`;
  }

  // Акт открывается нажатием на номер заказа: его смотрят перед выдачей,
  // стоя у полки, а отдельная кнопка «Акт» под каждой строкой занимала место.
  // Номер-ссылка окрашен как ссылка; нет акта — обычный номер, и сразу
  // видно, что шаблон не создан. Остальная строка открывает карточку, чат и
  // архив — смахиванием (rowActions ниже). Так же номер и ник — сами кнопки
  // в карточке заказа (order.js, contactRow).
  function orderNoHtml(order) {
    const no = `<span class="order-no-sign">№</span>${escapeHtml(order.order_no)}`;
    return order.act_url
      ? `<button class="order-no order-no--link" type="button" data-act-url="${escapeHtml(order.act_url)}"
           aria-label="Открыть акт заказа №${escapeHtml(order.order_no)}">${no}</button>`
      : `<span class="order-no">${no}</span>`;
  }

  // Один слушатель на список, и вешается он один раз — в init: элемент списка
  // живёт всё время, а перерисовка идёт на каждое нажатие клавиши в поиске.
  // Вешать здесь при каждом render значило копить слушатели, и одно нажатие
  // открывало бы акт столько раз, сколько было перерисовок.
  // Нажатие на кнопку карточку не открывает: каждая ветка выходит через return.
  // Кнопки смахивания сюда не доходят — их ловит SwipeRow раньше.
  function bindList(list) {
    list.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act-url]");
      if (act) { TG.openLink(act.dataset.actUrl); return; }
      if (e.target.closest("a, button, select, input")) return;
      const card = e.target.closest("[data-order-id]");
      if (card) Router.navigate("order", { orderId: card.dataset.orderId });
    });
  }

  // ---- смахивание строки: чат и архив ----
  // Как в «Почте»: влево — «Чат» (то, что раньше делала кнопка под строкой),
  // вправо — «В архив». Механика — SwipeRow в util.js, здесь только что
  // делать. Нет ника — нет и «Чата»: пустую кнопку не показываем, переписку
  // по телефону открыть нельзя. «В архив» — только администратору: бэкенд
  // (handleOrderArchive) остальным откажет.

  const UNDO_MS = 5000;
  const HINT_KEY = "mifs_hint_swipe_orders";
  let pending = null;    // { order, timer, snack } — убран из списка, запрос ещё не ушёл

  const ICON_CHAT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.3 9 9 0 0 1-3.9-.9L3 20l1.2-4.3A8 8 0 0 1 3 11.5 8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3z"/></svg>`;
  const ICON_ARCHIVE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/></svg>`;

  function tgOf(order) {
    return String(order.student_tg || "").trim().replace(/^@/, "");
  }

  function findOrder(orderId) {
    const all = (Cache.items(CACHE) || []).concat(Cache.items(ARCH) || []);
    return all.find((o) => String(o.order_id) === String(orderId)) || null;
  }

  function isAdmin() {
    const session = Auth.getSession();
    return !!session && session.role === "Admin";
  }

  function rowActions(row) {
    const order = findOrder(row.dataset.orderId);
    if (!order) return {};
    const tg = tgOf(order);
    return {
      trailing: tg ? {
        label: "Чат", tone: "chat", icon: ICON_CHAT,
        onTrigger: (r) => {
          SwipeRow.close(r);
          TG.openTelegramLink("https://t.me/" + encodeURIComponent(tg));
        },
      } : null,
      leading: !isAdmin() ? null : inArchive() ? {
        label: "Вернуть", tone: "archive", icon: ICON_ARCHIVE,
        onTrigger: unarchiveRow,
      } : {
        label: "В архив", tone: "archive", icon: ICON_ARCHIVE,
        onTrigger: archiveRow,
      },
    };
  }

  function dropFromCache(orderId) {
    const cached = Cache.items(CACHE);
    if (!cached) return;
    const left = cached.filter((o) => String(o.order_id) !== String(orderId));
    if (left.length !== cached.length) Cache.replace(CACHE, left);
  }

  // Порядок в списке задаёт render (свежие сверху), поэтому возвращаем строку
  // просто в конец кэша.
  function restoreToCache(order) {
    const cached = Cache.items(CACHE);
    if (!cached || cached.some((o) => String(o.order_id) === String(order.order_id))) return;
    Cache.replace(CACHE, cached.concat([order]));
  }

  function redraw() {
    const cached = Cache.items(source());
    if (cached) render(cached);
  }

  // Из архива — обратно в список. Здесь без отложенной отмены: возврат ничего
  // не прячет, и промахнуться им нельзя. Строка уходит сразу, при отказе
  // возвращается. В основном списке заказ появится при его перечитывании.
  function unarchiveRow(row) {
    const order = findOrder(row.dataset.orderId);
    if (!order) { SwipeRow.close(row); return; }
    const cached = Cache.items(ARCH) || [];
    Cache.replace(ARCH, cached.filter((o) => String(o.order_id) !== String(order.order_id)));
    SwipeRow.dismiss(row, "leading").then(redraw);
    TG.hapticTick();
    apiPost("/order/archive", { order_id: Number(order.order_id), back: true })
      .then(() => {
        Cache.stale(CACHE);
        Snackbar.show(`Заказ №${order.order_no} вернулся в список`);
      })
      .catch((err) => {
        Cache.replace(ARCH, (Cache.items(ARCH) || []).concat([order]));
        redraw();
        TG.hapticError();
        Snackbar.show(err.message || "Не получилось вернуть заказ из архива");
      });
  }

  // Архив с отменой. Строка уходит сразу, а запрос — только когда истечёт
  // «Отменить»: тогда отмена не требует второго запроса (и второй записи в
  // таблицу), а нажать её можно, не дожидаясь 6–12 секунд ответа. Ушёл с
  // экрана или свернул приложение — запрос уходит сразу (commitPending).
  //
  // Отказ «вещь на руках» видно ещё до запроса: issued_open приходит в
  // списке. Строка возвращается на место, а отказ говорит, что делать, —
  // тем же текстом, что у бэкенда. Если бэкенд откажет сам (список устарел),
  // строка вернётся после ответа.
  function archiveRow(row) {
    const order = findOrder(row.dataset.orderId);
    if (!order) { SwipeRow.close(row); return; }
    commitPending();   // прежний отложенный архив уходит сразу — отмена у одного
    const open = Number(order.issued_open || 0);
    if (open > 0) {
      SwipeRow.close(row);
      TG.hapticError();
      Snackbar.show("По этому заказу " + open + " ед. на руках — сначала примите их обратно");
      return;
    }
    const snack = Snackbar.show(`Заказ №${order.order_no} в архиве`, {
      action: "Отменить", onAction: undoArchive, ms: UNDO_MS,
    });
    pending = { order, snack, timer: setTimeout(commitPending, UNDO_MS) };
    dropFromCache(order.order_id);
    SwipeRow.dismiss(row, "leading").then(redraw);
  }

  function undoArchive() {
    if (!pending) return;
    clearTimeout(pending.timer);
    const order = pending.order;
    pending = null;
    restoreToCache(order);
    redraw();
    TG.hapticTick();
  }

  function commitPending() {
    if (!pending) return;
    const { order, timer, snack } = pending;
    pending = null;
    clearTimeout(timer);
    Snackbar.hide(snack);
    apiPost("/order/archive", { order_id: Number(order.order_id) })
      .then(() => {
        // Список мог перечитаться, пока запрос шёл, и вернуть заказ обратно.
        dropFromCache(order.order_id);
        Cache.stale(ARCH);
        redraw();
      })
      .catch((err) => {
        restoreToCache(order);
        redraw();
        TG.hapticError();
        Snackbar.show(err.message || "Не получилось убрать заказ в архив");
      });
  }

  // Подсказка один раз на устройство: первая строка на миг приоткрывается.
  // Флаг ставим до показа — не получилось записать (закрытое хранилище),
  // значит, подсказка повторится, и это не беда.
  function maybeHint(list) {
    try {
      if (localStorage.getItem(HINT_KEY)) return;
    } catch (ignored) {
      return;
    }
    setTimeout(() => {
      const screen = document.getElementById("screen-orders");
      const row = list.querySelector("[data-order-id]");
      if (!row || !screen || !screen.classList.contains("screen--active")) return;
      if (SwipeRow.peek(row, "trailing", rowActions) || SwipeRow.peek(row, "leading", rowActions)) {
        try { localStorage.setItem(HINT_KEY, "1"); } catch (ignored) {}
      }
    }, 700);
  }

  function render(orders) {
    const list = document.getElementById("orders-list");
    const hidden = pending ? String(pending.order.order_id) : null;
    if (hidden) orders = orders.filter((o) => String(o.order_id) !== hidden);
    const visible = orders.filter(matches);
    if (!orders.length) {
      list.innerHTML = inArchive()
        ? `<p class="empty">Архив пуст. Заказ попадает сюда смахиванием вправо в списке.</p>`
        : `<p class="empty">Заказов пока нет. Вставьте сообщение бота — оно разберётся само.</p>`;
      return;
    }
    if (!visible.length) {
      list.innerHTML = `<p class="empty">Под фильтры ничего не попало</p>`;
      return;
    }
    // Свежие сверху: склад работает с тем, что оформлено недавно.
    visible.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    list.innerHTML = visible.map(orderCardHtml).join("");
    maybeHint(list);
  }

  async function loadList({ force = false } = {}) {
    const list = document.getElementById("orders-list");
    const name = source();
    const cached = Cache.items(name);

    if (cached) render(cached);
    drawRefreshRow();

    if (!force && cached && Cache.isFresh(name)) return;

    if (!cached || !cached.length) list.innerHTML = skeleton(3);
    busy = true;
    drawRefreshRow();
    try {
      // Через Cache.load: если список уже тянет главная (Cache.warm), ждём
      // тот же ответ, а не заводим второй запрос.
      const orders = name === ARCH
        ? await Cache.load(ARCH, "/orders/list", { status: "all", archived: true }, { fresh: force })
        : await Cache.load(CACHE, "/orders/list", { status: "all" }, { fresh: force });
      // Пока шёл запрос, могли переключить сегмент — рисуем то, что выбрано.
      if (name === source()) render(orders);
    } catch (err) {
      if (!cached || !cached.length) {
        list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      }
    } finally {
      busy = false;
      drawRefreshRow();
    }
  }

  // ---- ввод заказа ----

  function pasteFormHtml() {
    return `
      <h2>Новый заказ</h2>
      <div id="orders-add-error"></div>
      <div class="form-group">
        <div class="field field--stacked">
          <label for="orders-paste">Сообщение бота о заказе</label>
          <textarea id="orders-paste" rows="6" placeholder="Заказ №1525686941&#10;1. GODOX OCTABOX 120: 0 (1 x 0.00)&#10;…"></textarea>
          <p class="hint">Скопируйте сообщение из чата целиком — разберётся само. Сохраним только
            после вашего подтверждения.</p>
        </div>
      </div>
      <button class="btn" id="orders-parse-btn">Разобрать</button>
      <button class="btn btn--secondary" id="orders-manual-btn">Завести вручную</button>`;
  }

  function manualFormHtml() {
    return `
      <h2>Заказ вручную</h2>
      <div id="orders-add-error"></div>
      <p class="hint">Состав здесь не заполнить — выдача пойдёт «вне заказа». Если есть сообщение
        бота, лучше вставить его.</p>
      <div class="form-group">
        <div class="field"><label for="mo-no">Номер заказа</label>
          <input id="mo-no" type="text" inputmode="numeric" /></div>
        <div class="field"><label for="mo-name">ФИО арендатора</label>
          <input id="mo-name" type="text" /></div>
        <div class="field"><label for="mo-phone">Телефон</label>
          <input id="mo-phone" type="tel" placeholder="+7…" /></div>
        <div class="field"><label for="mo-tg">Telegram</label>
          <input id="mo-tg" type="text" placeholder="@ник" /></div>
        <div class="toggle-row">
          <label for="mo-minor">Несовершеннолетний</label>
          <input id="mo-minor" type="checkbox" />
        </div>
      </div>
      <div id="mo-guardian" class="form-group" style="display:none;">
        <div class="field"><label for="mo-gname">ФИО представителя</label>
          <input id="mo-gname" type="text" /></div>
        <div class="field"><label for="mo-gphone">Его телефон</label>
          <input id="mo-gphone" type="tel" /></div>
      </div>
      <div class="form-group">
        <div class="field"><label for="mo-issue">Дата выдачи</label>
          <input id="mo-issue" type="date" required placeholder="не задано" /></div>
        <div class="field"><label for="mo-return">Дата возврата</label>
          <input id="mo-return" type="date" required placeholder="не задано" /></div>
        <div class="field"><label for="mo-project">Проект</label>
          <input id="mo-project" type="text" /></div>
      </div>
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
    const restore = busyButton(document.getElementById("orders-parse-btn"), "Разбираем…");
    showBoxError("orders-add-error", "");
    try {
      const data = await apiPost("/order/parse", { text });
      draft = data;
      showAdd(confirmHtml(data));
    } catch (err) {
      TG.hapticError();
      showBoxError("orders-add-error", err.message);
    } finally {
      restore();
    }
  }

  // После «Создать» ведём сразу в карточку нового заказа, а не перечитываем
  // весь список: /orders/list — самый тяжёлый запрос экрана, и после него
  // человек всё равно искал бы свой заказ глазами. Строку списка собираем из
  // того, что отправили, и номера, который вернул бэкенд (/order/create отдаёт
  // order_id, student_id, student_created, act_url), — в той же форме, что
  // отдаёт /orders/list.
  //
  // Кладём через Cache.replace: он не трогает возраст, поэтому дописанный в
  // старый список заказ не выдаёт весь старый список за только что
  // полученный, — и дописывать можно в любой кэш, а не только в свежий:
  // старый всё равно перечитается молча при возврате, но новый заказ
  // виден в нём сразу.
  function rememberCreated(payload, created) {
    const cached = Cache.items(CACHE);
    if (!cached) return;
    const row = {
      order_id: created.order_id,
      order_no: String(payload.order_no || "").trim(),
      request_code: String(payload.request_code || ""),
      student_id: created.student_id,
      student_name: String(payload.student_name || "").trim(),
      student_phone: String(payload.student_phone || ""),
      student_tg: String(payload.student_tg || ""),
      is_adult: !(payload.is_adult === "FALSE" || payload.is_adult === false),
      guardian_name: payload.guardian_name || "",
      guardian_phone: String(payload.guardian_phone || ""),
      project: payload.project || "",
      issue_date: String(payload.issue_date || ""),
      return_date: String(payload.return_date || ""),
      extra_input: payload.extra_input || "",
      amount: Number(payload.amount || 0),
      currency: payload.currency || "",
      status: "New",
      issued_open: 0,
      issued_total: 0,
      created_at: new Date().toISOString(),
      created_by_name: "",
      items_text: (payload.items || []).map((line) => line.raw_name || "").join(", "),
      archived_at: "",
      act_url: String(created.act_url || ""),
    };
    Cache.replace(CACHE, [row].concat(cached));
  }

  // Открываем карточку так же, как нажатие на строку списка (bindList).
  function openCreated(payload, created) {
    TG.hapticSuccess();
    hideAdd();
    rememberCreated(payload, created);
    Router.navigate("order", { orderId: created.order_id });
  }

  async function submitDraft() {
    if (!draft) return;
    document.querySelectorAll(".order-line-pick").forEach((sel) => {
      if (!sel.value) return;
      const [category, modelCode] = sel.value.split("|");
      const line = draft.items[Number(sel.dataset.line)];
      if (line) { line.category = category; line.model_code = modelCode; }
    });

    const restore = busyButton(document.getElementById("orders-confirm-btn"), "Создаём…");
    try {
      const payload = Object.assign({}, draft.order, { items: draft.items });
      const created = await apiPost("/order/create", payload);
      openCreated(payload, created);
    } catch (err) {
      TG.hapticError();
      showBoxError("orders-add-error", err.message);
      restore();
    }
  }

  async function submitManual() {
    const value = (id) => document.getElementById(id).value.trim();
    if (!value("mo-no")) { showBoxError("orders-add-error", "Укажите номер заказа"); return; }
    if (!value("mo-name")) { showBoxError("orders-add-error", "Укажите ФИО арендатора"); return; }
    const minor = document.getElementById("mo-minor").checked;

    const restore = busyButton(document.getElementById("orders-manual-submit"), "Создаём…");
    try {
      const payload = {
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
      };
      const created = await apiPost("/order/create", payload);
      openCreated(payload, created);
    } catch (err) {
      TG.hapticError();
      showBoxError("orders-add-error", err.message);
      restore();
    }
  }

  // ---- жизненный цикл ----

  function onShow() {
    hideAdd();
    loadList();
  }

  function init() {
    const list = document.getElementById("orders-list");
    bindList(list);
    SwipeRow.attach(list, { row: "[data-order-id]", actions: rowActions });
    // Ушёл с экрана или свернул приложение — отложенный архив уходит сразу:
    // иначе «Отменить» висело бы над чужим экраном, а закрытое приложение
    // унесло бы запрос с собой.
    const screen = document.getElementById("screen-orders");
    new MutationObserver(() => {
      if (!screen.classList.contains("screen--active")) commitPending();
    }).observe(screen, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") commitPending();
    });
    window.addEventListener("pagehide", commitPending);
    document.getElementById("orders-add-toggle").addEventListener("click", () => {
      const box = document.getElementById("orders-add");
      if (box.style.display === "block") hideAdd();
      else showAdd(pasteFormHtml());
    });
    // Подсказывает и номер, и арендатора, и ник, и позицию из состава заказа.
    Suggest.attach("orders-search", (q) => Suggest.orders(Cache.items(source()) || [], q));
    // Поиск — поле, фильтр — сегменты: события у них разные, и общий цикл по
    // именам больше не годится.
    const refilter = () => {
      const cached = Cache.items(source());
      if (cached) render(cached);
    };
    document.getElementById("orders-search").addEventListener("input", refilter);
    // «Архив» — свой список: впервые открытый, он грузится.
    bindSegmented("orders-filter-status", () => {
      if (inArchive()) loadList(); else { refilter(); drawRefreshRow(); }
    });
    Pull.register("orders", () => loadList({ force: true }));
    Router.register("orders", { onShow });
  }

  return { init };
})();
