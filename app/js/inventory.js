// Экран «Инвентаризация» — сверка склада по QR.
//
// Три вещи, на которых держится экран:
//
// 1. Во время обхода не ходим на сервер: он отвечает 5–8 секунд, а предметов
//    шестьсот. Всё считается по кэшу каталога, запрос один — при «Завершить».
// 2. Сканируем подряд (QR.scanContinuous): обычный сканер Telegram закрывается
//    после каждого кода. Отклик — вибрацией: окно закрывает собой экран.
// 3. Сверка пишет отчёт, а не правит статусы: ненайденное может лежать в чужой
//    сумке, решать должен человек.
//
// «Нашёл» стоит выше «завести новую» намеренно: вещь без наклейки выглядит
// новой, хотя обычно уже заведена. Заводить второй раз — это ровно то, как в
// каталоге появились 64 строки Sony A7 IV на 29 заводских номеров
// (DUPLICATES.md).

const InventoryScreen = (() => {
  const STORE_KEY = "mifs_inventory_session";

  let session = null;   // { scope, started_at, found: {id: qty}, unknown: [] }
  let expected = [];    // снимок области на момент старта
  // Что случилось с последним кодом. Живёт отдельно от DOM: экран
  // перерисовывается после каждого скана, и надпись внутри него затиралась бы
  // ровно тем действием, о котором сообщает.
  let lastMessage = "";
  // Последний прочитанный код: показываем его серым примером в поле ввода,
  // чтобы было видно, что именно взял сканер.
  let lastCode = "";
  // Поиск по ненайденному: их бывает под сотню, и глазами это не список.
  let missingFilter = "";
  const MISSING_LIMIT = 50;

  // Форма заведения живёт в модуле, а не в DOM. Экран перерисовывается после
  // каждого скана, а отказ сети не должен стирать набранное: повторять ввод
  // стоя у полки с вещью в руках — верный способ бросить эту вещь незаведённой.
  let creating = false;
  let form = null;        // { category, model, name, serial, inventory, qty }
  let createError = "";
  let created = null;     // { item_id, name, qty, added }

  // ---- хранение ----
  //
  // Обход склада — это не минута: телефон уснёт, Telegram свернётся, кто-то
  // позвонит. Сессия живёт в localStorage, чтобы возвращаться в ту же сверку,
  // а не начинать заново.
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      session = raw ? JSON.parse(raw) : null;
    } catch {
      session = null;
    }
    if (session && !session.found) session = null;
  }

  function save() {
    try {
      if (session) localStorage.setItem(STORE_KEY, JSON.stringify(session));
      else localStorage.removeItem(STORE_KEY);
    } catch { /* не критично: сверку можно закончить и без сохранения */ }
  }

  // ---- область сверки ----

  function catalog() {
    return Cache.items("equipment") || [];
  }

  // Выборка задана — область это ровно она, и ничего кроме. Остальное для этой
  // сверки «вне области»: так же, как предмет чужой категории.
  function inScope(item, scope) {
    if (session && session.sample) {
      return session.sample.indexOf(String(item.item_id)) !== -1;
    }
    return scope === "all" || item.category === scope;
  }

  function refreshExpected() {
    expected = session ? catalog().filter((i) => inScope(i, session.scope)) : [];
  }

  function itemById(id) {
    return catalog().find((i) => String(i.item_id) === String(id)) || null;
  }

  // Сколько штук ожидается. У штучных позиций (мешки, расходники) на складе
  // лежит куча с одним QR, и «сколько» — это число, а не количество сканов.
  function expectedQty(item) {
    return categoryByQty(item.category) ? Number(item.qty || 1) : 1;
  }

  function scopeLabel(scope) {
    const base = scope === "all" ? "весь каталог" : categoryLabel(scope);
    if (session && session.sample) {
      const n = session.sample.length;
      return `выборка ${n} ${plural(n, "позиции", "позиций", "позиций")} · ${base}`;
    }
    return base;
  }

  // Случайные n позиций. Перемешиваем копию (Фишер–Йетс), а не сортируем по
  // random: сортировка со случайным компаратором даёт неравномерный результат,
  // и «наугад» оказывается смещённым к началу каталога.
  function pickSample(pool, n) {
    const ids = pool.map((i) => String(i.item_id));
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = ids[i]; ids[i] = ids[j]; ids[j] = swap;
    }
    return ids.slice(0, n);
  }

  // ---- подсчёт ----

  function foundCount() {
    return Object.keys(session.found).length;
  }

  function summary() {
    refreshExpected();
    const missing = [];
    const mismatch = [];
    expected.forEach((item) => {
      const id = String(item.item_id);
      if (session.found[id] === undefined) { missing.push(item); return; }
      const want = expectedQty(item);
      const got = Number(session.found[id]);
      if (got !== want) mismatch.push({ item, want, got });
    });
    return {
      total: expected.length,
      found: foundCount(),
      missing,
      mismatch,
      unknown: session.unknown.slice(),
    };
  }

  // ---- приём кода ----
  //
  // Единственное место, где решается, что делать с отсканированным номером.
  // Возвращает, что случилось, — экран и вибрация идут отсюда.
  function accept(rawCode) {
    const code = String(rawCode || "").replace(/[\s\-]/g, "");
    if (!code) return { kind: "empty" };
    lastCode = code;
    const item = itemById(code);
    if (!item) {
      if (session.unknown.indexOf(code) === -1) session.unknown.push(code);
      save();
      return { kind: "unknown", code };
    }
    if (!inScope(item, session.scope)) {
      return { kind: "out-of-scope", item };
    }
    if (session.found[code] !== undefined) {
      return { kind: "repeat", item };
    }
    // Штучная позиция: код полки отмечает, что полка найдена, а сколько на ней
    // лежит — спросим числом. По умолчанию считаем, что сходится.
    session.found[code] = expectedQty(item);
    save();
    return { kind: "found", item, byQty: categoryByQty(item.category) };
  }

  // «Нашёл» из списка ненайденного: тот же путь, что у скана, но серый пример в
  // поле ввода не трогаем — там показано то, что прочитал сканер, а здесь
  // ничего не сканировали.
  function markFound(id) {
    const keep = lastCode;
    const result = accept(id);
    lastCode = keep;
    return result;
  }

  // ---- справочник моделей ----
  //
  // Собирается из кэша каталога, а не запросом: в каждом предмете уже лежат
  // категория, код модели и название. Модель, у которой на складе нет ни одного
  // экземпляра, сюда не попадёт — для неё есть «новая модель», и дубликата от
  // этого не будет: сервер ищет модель по нормализованному названию и отдаёт
  // существующий код (findOrCreateModel в Code.gs).
  function modelsOf(category) {
    const seen = {};
    const out = [];
    catalog().forEach((item) => {
      if (item.category !== category || !item.model_code) return;
      const code = String(item.model_code);
      if (seen[code]) return;
      seen[code] = true;
      out.push({ model_code: code, model_name: item.name });
    });
    out.sort((a, b) => String(a.model_name).localeCompare(String(b.model_name), "ru"));
    return out;
  }

  function defaultModel(category) {
    const list = modelsOf(category);
    return list.length ? list[0].model_code : "__new";
  }

  function blankForm() {
    const fallback = (categoryList()[0] || {}).code || "OTH";
    const category = session && session.scope !== "all" ? session.scope : fallback;
    return {
      category,
      model: defaultModel(category),
      name: "", serial: "", inventory: "", qty: "1",
    };
  }

  // ---- экран ----

  // Всё, что относится к одной сверке и не должно пережить её конец.
  function resetTransient() {
    lastMessage = "";
    lastCode = "";
    missingFilter = "";
    creating = false;
    form = null;
    createError = "";
    created = null;
  }

  function render() {
    const box = document.getElementById("inventory-content");
    if (!session) { renderStart(box); return; }
    renderSession(box);
  }

  function renderStart(box) {
    const items = catalog();
    if (!items.length) {
      box.innerHTML = `<p class="empty">Каталог ещё не загружен. Откройте «Каталог»,
        чтобы список подтянулся, и возвращайтесь: сверка работает по нему и в сеть
        во время обхода не ходит.</p>`;
      return;
    }
    const counts = {};
    items.forEach((i) => { counts[i.category] = (counts[i.category] || 0) + 1; });

    box.innerHTML = `
      <p class="hint">Сканируйте подряд, окно сканера закрывать не нужно.
      Обход идёт без сети.</p>
      <div class="form-group">
      <div class="field">
        <label for="inventory-scope">Что сверяем</label>
        <select id="inventory-scope">
          <option value="all">Весь каталог — ${items.length} ${plural(items.length, "позиция", "позиции", "позиций")}</option>
          ${categoryList().filter((c) => counts[c.code]).map((c) =>
            `<option value="${escapeHtml(c.code)}">${escapeHtml(c.label)} — ${counts[c.code]}</option>`).join("")}
        </select>
        <p class="hint">Вещи из других категорий в сверку не попадут — они вне
        области, а не пропали.</p>
      </div>
      <div class="field">
        <label for="inventory-sample">Проверить только часть — сколько позиций</label>
        <input type="number" id="inventory-sample" inputmode="numeric" min="1" step="1"
               placeholder="пусто — все" />
        <p class="hint">Система выберет столько позиций наугад. Двадцати хватает,
        чтобы поймать системное расхождение, — полный обход это вечер.</p>
      </div>
      </div>
      <button class="btn" id="inventory-start">Начать сверку</button>`;

    document.getElementById("inventory-start").addEventListener("click", () => {
      const scope = document.getElementById("inventory-scope").value;
      const pool = items.filter((i) => scope === "all" || i.category === scope);
      const want = Math.floor(Number(document.getElementById("inventory-sample").value));
      resetTransient();
      session = { scope, started_at: new Date().toISOString(), found: {}, unknown: [] };
      // Выборку фиксируем на старте и держим в сессии: пересчитывать её на каждом
      // открытии экрана значило бы менять область посреди обхода.
      if (want >= 1 && want < pool.length) session.sample = pickSample(pool, want);
      save();
      render();
    });
  }

  function renderSession(box) {
    const s = summary();
    const percent = s.total ? Math.round(100 * s.found / s.total) : 0;

    box.innerHTML = `
      <div class="card">
        <div class="card-title">Сверка: ${escapeHtml(scopeLabel(session.scope))}</div>
        <div class="card-sub">Начата ${formatDate(session.started_at)}</div>
        <div class="progress-line">Найдено ${s.found} из ${s.total}</div>
        <div class="progress"><span style="width:${percent}%"></span></div>
      </div>

      <div id="inventory-error"></div>
      <div class="btn-row">
        <button class="btn" id="inventory-scan">Сканировать подряд</button>
        <button class="btn btn--secondary" id="inventory-finish">Завершить</button>
      </div>
      <!-- Выход из сверки — здесь, а не под списком. Раньше «Отменить» лежала
           после «Не найдено», и при сверке всего каталога до неё было пятьдесят
           карточек прокрутки: человек просто не мог закрыть сверку и решал, что
           приложение не обновилось. Управление сверкой не должно зависеть от
           того, сколько в ней позиций. -->
      <div class="btn-row btn-row--equal">
        <button class="btn btn--secondary" id="inventory-reset">Сбросить отметки</button>
        <button class="btn btn--danger" id="inventory-cancel">Отменить сверку</button>
      </div>
      ${lastMessage ? `<div id="inventory-last" class="hint">${escapeHtml(lastMessage)}</div>` : ""}

      <div class="form-group">
        <div class="field">
          <label for="inventory-manual">Номер руками</label>
          <input type="text" id="inventory-manual" inputmode="numeric"
                 placeholder="${escapeHtml(lastCode || "010101")}" />
        </div>
      </div>
      <button class="btn btn--secondary" id="inventory-add">Отметить</button>

      ${byQtyFound().length ? `
      <div class="section">
        <div class="section-title">Сколько на полке</div>
        <p class="hint">У мешков и расходников один QR на всю кучу: сканированием
        отмечается сама полка, а количество надо пересчитать и вписать.</p>
        ${byQtyFound().map((item) => `
          <div class="order-line">
            <div class="order-line-name">${escapeHtml(item.name)}</div>
            <div class="order-line-qty">по учёту ${expectedQty(item)}</div>
            <input type="number" inputmode="numeric" min="0" step="1"
                   class="inventory-qty" data-item="${escapeHtml(item.item_id)}"
                   value="${Number(session.found[String(item.item_id)])}" />
          </div>`).join("")}
      </div>` : ""}

      ${s.mismatch.length ? `
      <div class="section">
        <div class="section-title">Разошлось количество</div>
        ${s.mismatch.map((m) => `
          <div class="order-line">
            <div class="order-line-name">${escapeHtml(m.item.name)}</div>
            <div class="order-line-qty">по учёту ${m.want}, насчитали ${m.got}</div>
          </div>`).join("")}
      </div>` : ""}

      ${s.unknown.length ? `
      <div class="section">
        <div class="section-title">Неизвестные коды — ${s.unknown.length}</div>
        <p class="hint">Таких номеров в каталоге нет: чужая наклейка, старый
        номер или позиция, которую не завели.</p>
        ${s.unknown.map((c) => `<div class="card-sub">${escapeHtml(c)}</div>`).join("")}
      </div>` : ""}

      <div class="section">
        <div class="section-title">Не найдено — ${s.missing.length}</div>
        ${s.missing.length ? `
        <p class="hint">«Нашёл» отмечает позицию без сканирования — для вещей,
        с которых отвалилась наклейка.</p>
        <div class="searchbar">
          <input type="search" id="inventory-missing-filter" placeholder="Поиск по названию или номеру"
                 value="${escapeHtml(missingFilter)}" />
        </div>` : ""}
        <div id="inventory-missing-list">${missingListHtml(s.missing)}</div>
      </div>

      ${createdHtml()}

      <div class="section">
        <div class="section-title">Нашли то, чего нет в системе</div>
        <p class="hint">Сначала поищите её выше, в «Не найдено»: заведённая
        второй раз вещь навсегда останется в каталоге двумя строками.</p>
        ${createHtml()}
      </div>

      <div class="inventory-drop">
        <p class="hint">«Сбросить отметки» обнуляет отмеченное, оставляя область
        и выборку. «Отменить сверку» закрывает её целиком, без возврата.</p>
      </div>`;

    wireSession();
  }

  // Штучные позиции, которые уже отметили: только у них есть что пересчитывать.
  function byQtyFound() {
    return expected.filter((i) => categoryByQty(i.category) &&
      session.found[String(i.item_id)] !== undefined);
  }

  // ---- список ненайденного ----

  function missingFiltered(missing) {
    const q = missingFilter.trim().toLowerCase();
    if (!q) return missing;
    return missing.filter((i) =>
      [i.name, i.item_id, i.serial_number, i.inventory_number]
        .filter(Boolean).join(" ").toLowerCase().indexOf(q) !== -1);
  }

  function missingListHtml(missing) {
    if (!missing.length) return `<p class="hint">Всё на месте.</p>`;
    const list = missingFiltered(missing);
    if (!list.length) return `<p class="hint">Под запрос ничего не подходит.</p>`;
    const rows = list.slice(0, MISSING_LIMIT).map((i) => `
      <div class="order-line inventory-miss">
        <div class="inventory-miss-main">
          <div class="order-line-name">${escapeHtml(i.name)}</div>
          <div class="order-line-qty">${escapeHtml(i.item_id)} · ${escapeHtml(categoryLabel(i.category))}</div>
        </div>
        <button class="btn btn--secondary order-line-btn inventory-found"
                data-item="${escapeHtml(i.item_id)}">Нашёл</button>
      </div>`).join("");
    const rest = list.length - MISSING_LIMIT;
    return rows + (rest > 0
      ? `<p class="hint">…и ещё ${rest}. Найдите нужное поиском выше — полный список уйдёт в отчёт.</p>`
      : "");
  }

  // ---- форма заведения ----

  function createHtml() {
    if (!creating) {
      return `<button class="btn btn--secondary" id="inventory-new-open">Завести новый экземпляр</button>`;
    }
    const models = modelsOf(form.category);
    const bulk = categoryByQty(form.category);
    const isNew = form.model === "__new";
    return `
      <div class="form-group">
      <div class="field">
        <label for="inventory-new-category">Категория</label>
        <select id="inventory-new-category">
          ${categoryList().map((c) => `<option value="${escapeHtml(c.code)}"${
            c.code === form.category ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="inventory-new-model">Модель</label>
        <select id="inventory-new-model">
          ${models.map((m) => `<option value="${escapeHtml(m.model_code)}"${
            m.model_code === form.model ? " selected" : ""}>${escapeHtml(m.model_name)}</option>`).join("")}
          <option value="__new"${isNew ? " selected" : ""}>+ Новая модель</option>
        </select>
      </div>
      ${isNew ? `
      <div class="field">
        <label for="inventory-new-name">Название новой модели</label>
        <input type="text" id="inventory-new-name" value="${escapeHtml(form.name)}" />
        <p class="hint">Если такая модель уже есть, номер возьмётся от неё.</p>
      </div>` : ""}
      ${bulk ? `
      <div class="field">
        <label for="inventory-new-qty">Сколько добавить</label>
        <input type="number" id="inventory-new-qty" inputmode="numeric" min="1" step="1"
               value="${escapeHtml(form.qty)}" />
        <p class="hint">Если такая куча уже заведена, количество добавится к ней.</p>
      </div>` : `
      <div class="field">
        <label for="inventory-new-serial">Заводской номер</label>
        <input type="text" id="inventory-new-serial" value="${escapeHtml(form.serial)}" />
      </div>
      <div class="field">
        <label for="inventory-new-inventory">Инвентарный номер</label>
        <input type="text" id="inventory-new-inventory" value="${escapeHtml(form.inventory)}" />
      </div>`}
      </div>
      <div id="inventory-new-error"></div>
      <p class="hint">Номер выдаёт таблица, поэтому здесь нужна сеть и 5–8 секунд
      ожидания. Сканирование остаётся офлайновым.</p>
      <div class="btn-row">
        <button class="btn" id="inventory-new-submit">Завести</button>
        <button class="btn btn--secondary" id="inventory-new-cancel">Отмена</button>
      </div>`;
  }

  function createdHtml() {
    if (!created) return "";
    return `
      <div class="section">
        <div class="section-title">${created.added ? "Пополнено" : "Заведено"}</div>
        <div class="card">
          <div class="card-title">${escapeHtml(created.name)}</div>
          <div class="qr-id">${escapeHtml(created.item_id)}</div>
          <div class="card-sub">${created.added
            ? `добавлено ${created.added}, всего на складе ${created.qty} · позиция отмечена найденной`
            : "номер присвоила таблица · позиция отмечена найденной"}</div>
          <button class="btn btn--secondary" id="inventory-created-label" style="margin-top:12px;">Этикетка</button>
        </div>
      </div>`;
  }

  function wireSession() {
    document.getElementById("inventory-scan").addEventListener("click", startScanning);
    // change, а не input: перерисовка на каждую цифру выбивала бы фокус из поля.
    document.querySelectorAll(".inventory-qty").forEach((input) => {
      input.addEventListener("change", () => {
        const value = Math.max(0, Math.floor(Number(input.value)));
        session.found[String(input.dataset.item)] = isFinite(value) ? value : 0;
        save();
        render();
      });
    });
    document.getElementById("inventory-add").addEventListener("click", () => {
      const input = document.getElementById("inventory-manual");
      const result = accept(input.value);
      input.value = "";
      showResult(result);
      render();
    });
    document.getElementById("inventory-finish").addEventListener("click", finish);
    wireMissing();
    wireCreate();
    document.getElementById("inventory-reset").addEventListener("click", () => {
      TG.confirmDestructive("Обнулить отмеченное?",
        "Область и выборка останутся — пропадут только отметки.", "Обнулить", (yes) => {
        if (!yes) return;
        session.found = {};
        session.unknown = [];
        lastMessage = "";
        lastCode = "";
        missingFilter = "";
        save();
        render();
      });
    });
    document.getElementById("inventory-cancel").addEventListener("click", () => {
      TG.confirmDestructive("Отменить сверку?",
        "Всё, что отсканировано, пропадёт. В журнал ничего не запишется.",
        "Отменить сверку", (yes) => {
        if (!yes) return;
        session = null;
        resetTransient();
        save();
        render();
      });
    });
  }

  function bindFound(container) {
    container.querySelectorAll(".inventory-found").forEach((btn) => {
      btn.addEventListener("click", () => {
        showResult(markFound(btn.dataset.item));
        render();
      });
    });
  }

  function wireMissing() {
    const box = document.getElementById("inventory-missing-list");
    bindFound(box);
    const filter = document.getElementById("inventory-missing-filter");
    if (!filter) return;
    // Перерисовываем только список: полный render() выбивал бы фокус из поля на
    // каждой набранной букве.
    filter.addEventListener("input", () => {
      missingFilter = filter.value;
      box.innerHTML = missingListHtml(summary().missing);
      bindFound(box);
    });
  }

  // Значения формы забираем в модуль перед любой перерисовкой.
  function readForm() {
    if (!creating || !form) return;
    const value = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : undefined;
    };
    const next = {
      category: value("inventory-new-category"),
      model: value("inventory-new-model"),
      name: value("inventory-new-name"),
      serial: value("inventory-new-serial"),
      inventory: value("inventory-new-inventory"),
      qty: value("inventory-new-qty"),
    };
    Object.keys(next).forEach((k) => { if (next[k] !== undefined) form[k] = next[k]; });
  }

  function wireCreate() {
    const label = document.getElementById("inventory-created-label");
    if (label) {
      label.addEventListener("click", () =>
        Router.navigate("labels", { itemId: created.item_id }));
    }

    const open = document.getElementById("inventory-new-open");
    if (open) {
      open.addEventListener("click", () => {
        creating = true;
        createError = "";
        created = null;
        form = blankForm();
        render();
      });
      return;
    }

    const cat = document.getElementById("inventory-new-category");
    cat.addEventListener("change", () => {
      readForm();
      // Модель из прошлой категории в новой не существует.
      form.model = defaultModel(form.category);
      render();
    });
    document.getElementById("inventory-new-model").addEventListener("change", () => {
      readForm();
      render();
    });
    ["inventory-new-name", "inventory-new-serial", "inventory-new-inventory", "inventory-new-qty"]
      .forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", readForm);
      });

    document.getElementById("inventory-new-submit").addEventListener("click", submitNew);
    document.getElementById("inventory-new-cancel").addEventListener("click", () => {
      readForm();
      creating = false;
      createError = "";
      render();
    });
    showBoxError("inventory-new-error", createError);
  }

  async function submitNew() {
    readForm();
    createError = "";
    const bulk = categoryByQty(form.category);
    if (form.model === "__new" && !form.name.trim()) {
      createError = "Укажите название новой модели";
      render();
      return;
    }
    const qty = bulk ? Math.floor(Number(form.qty)) : 1;
    if (bulk && (!qty || qty < 1)) {
      createError = "Количество — целое число от одного";
      render();
      return;
    }

    const payload = { category: form.category };
    if (form.model === "__new") payload.model_name = form.name.trim();
    else payload.model_code = Number(form.model);
    if (bulk) payload.qty = qty;
    else {
      payload.serial_number = form.serial.trim();
      payload.inventory_number = form.inventory.trim();
    }
    const name = form.model === "__new"
      ? form.name.trim()
      : (modelsOf(form.category).find((m) => m.model_code === form.model) || {}).model_name || "";

    const btn = document.getElementById("inventory-new-submit");
    btn.disabled = true;
    btn.textContent = "Заводим…";
    showBoxError("inventory-new-error", "");
    try {
      const res = await apiPost("/item/create", payload);
      const id = String(res.item_id);
      const items = catalog();
      const known = items.some((i) => String(i.item_id) === id);
      if (known) {
        // Штучную позицию сервер пополнил, а не завёл заново.
        Cache.patch("equipment", "item_id", id, { qty: Number(res.qty || qty) });
      } else {
        // Номер собран как XXYYZZ, средняя пара — код модели; сервер его не
        // возвращает, а этикеткам и группировке он нужен.
        Cache.set("equipment", items.concat([{
          item_id: id,
          name: name || id,
          category: form.category,
          model_code: id.slice(2, 4),
          serial_number: payload.serial_number || "",
          inventory_number: payload.inventory_number || "",
          status: "Available",
          qty: Number(res.qty || 1),
          qty_out: 0,
          qty_free: Number(res.qty || 1),
        }]));
      }
      refreshExpected();
      // Вещь в руках — значит найдена. Иначе она попадёт в «не найдено» тем же
      // вечером, когда её и завели.
      const fresh = itemById(id);
      session.found[id] = fresh ? expectedQty(fresh) : 1;
      save();
      TG.hapticSuccess();
      created = { item_id: id, name: (fresh && fresh.name) || name || id,
                  qty: Number(res.qty || 1), added: res.added };
      creating = false;
      form = null;
      lastMessage = "";
      render();
    } catch (err) {
      TG.hapticError();
      // Форма остаётся заполненной: набирать заново, стоя у полки, никто не станет.
      createError = err.message;
      render();
    }
  }

  // Отклик на скан. Пока открыт сканер, экрана не видно — поэтому вибрация
  // важнее текста, а текст читается уже после закрытия окна.
  function showResult(result) {
    const texts = {
      found: () => "Отмечено: " + result.item.name,
      repeat: () => "Уже отмечен: " + result.item.name,
      unknown: () => "Нет в каталоге: " + result.code,
      "out-of-scope": () => result.item.name + " — вне области сверки",
      empty: () => "",
    };
    lastMessage = (texts[result.kind] || texts.empty)();
    if (result.kind === "found") TG.hapticSuccess();
    else if (result.kind !== "empty") TG.hapticError();
  }

  function startScanning() {
    showBoxError("inventory-error", "");
    const res = QR.scanContinuous(
      "Сканируйте предметы подряд — окно закроется, когда вы его закроете",
      (code) => {
        const result = accept(code);
        showResult(result);
        // Экран под окном сканера перерисовываем сразу: закрыв сканер, человек
        // должен увидеть готовый счётчик, а не стартовое состояние.
        renderSession(document.getElementById("inventory-content"));
      });
    if (!res.ok) {
      showBoxError("inventory-error", res.error +
        ". Отмечайте номера полем ниже — они напечатаны под QR.");
    }
  }

  // ---- завершение ----

  async function finish() {
    QR.stopScan();
    const s = summary();
    const btn = document.getElementById("inventory-finish");
    btn.disabled = true;
    // Кнопка обязана говорить, что происходит. В журнал уходит строка на каждую
    // ненайденную позицию: при сверке всего каталога это сотни строк и
    // десятки секунд, и молчащая кнопка читается как зависшая.
    const rows = 1 + s.missing.length + s.mismatch.length + s.unknown.length;
    btn.textContent = "Сохраняем…";
    showBoxError("inventory-error", "");
    lastMessage = `Записываем ${rows} ${plural(rows, "строку", "строки", "строк")} в журнал — ` +
      "таблица отвечает 5–8 секунд, на полной сверке дольше. Не закрывайте экран.";
    renderSession(document.getElementById("inventory-content"));
    document.getElementById("inventory-finish").disabled = true;
    document.getElementById("inventory-finish").textContent = "Сохраняем…";
    try {
      await apiPost("/inventory/save", {
        scope: session.scope,
        started_at: session.started_at,
        finished_at: new Date().toISOString(),
        found: session.found,
        missing: s.missing.map((i) => i.item_id),
        unknown: s.unknown,
      });
      TG.hapticSuccess();
      lastMessage = "";
      TG.showAlert(`Сверка записана в журнал. Найдено ${s.found} из ${s.total}, ` +
        `не найдено ${s.missing.length}.`);
      session = null;
      resetTransient();
      save();
      render();
    } catch (err) {
      TG.hapticError();
      // Отчёт уже собран и никуда не денется — сессия остаётся на месте, чтобы
      // его можно было сохранить позже или переписать глазами.
      if (backendOutdated(err.message)) {
        showBoxError("inventory-error", "Сверка посчитана, но записать её в журнал " +
          "пока некуда: таблица работает на старой версии бэкенда. Обновите Code.gs " +
          "и нажмите «Завершить» снова — результат сохранён на телефоне и не пропал.");
      } else {
        showBoxError("inventory-error", err.message);
      }
    } finally {
      const again = document.getElementById("inventory-finish");
      if (again) { again.disabled = false; again.textContent = "Завершить"; }
    }
  }

  function onShow() {
    load();
    refreshExpected();
    render();
  }

  function init() {
    Router.register("inventory", { onShow });
  }

  return { init };
})();
