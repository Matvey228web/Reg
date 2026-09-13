// Экран «Инвентаризация» — сверка склада по QR.
//
// Зачем понадобилась. Разбор каталога (DUPLICATES.md) показал: по Sony A7 IV в
// системе 64 строки при 29 подтверждённых заводских номерах, и по данным это не
// решается — нужен физический пересчёт. Выписывать номера на бумагу и сверять с
// таблицей на 628 строк невозможно.
//
// Два решения, на которых держится весь экран:
//
// 1. ВО ВРЕМЯ ОБХОДА МЫ НЕ ХОДИМ НА СЕРВЕР. Он отвечает 5–8 секунд; 628
//    предметов по запросу на скан — это больше часа ожидания. Каталог уже
//    целиком лежит в кэше, и «что это за номер, в области ли он, не считали ли
//    мы его» отвечается на месте. Запрос будет ровно один — когда сверку
//    завершат и сохранят.
//
// 2. СКАНИРУЕМ ПОДРЯД. Обычный сканер Telegram закрывается после каждого кода;
//    на шестистах предметах это шестьсот раз «нажать и подождать». Здесь окно
//    остаётся открытым (QR.scanContinuous), а отклик идёт вибрацией — окно
//    закрывает собой экран, и показать счётчик под ним нельзя.
//
// Результат ничего не меняет сам: сверка пишет отчёт, а не правит статусы.
// Ненайденный предмет может лежать в чужой сумке, и решать это должен человек.

const InventoryScreen = (() => {
  const STORE_KEY = "mifs_inventory_session";

  let session = null;   // { scope, started_at, found: {id: qty}, unknown: [] }
  let expected = [];    // снимок области на момент старта
  // Что случилось с последним кодом. Живёт отдельно от DOM: экран
  // перерисовывается после каждого скана, и надпись внутри него затиралась бы
  // ровно тем действием, о котором сообщает.
  let lastMessage = "";

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

  function inScope(item, scope) {
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
    return scope === "all" ? "весь каталог" : categoryLabel(scope);
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

  // ---- экран ----

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
      <p class="hint">Сверка идёт по кэшу каталога и во время обхода не делает ни
      одного запроса — иначе каждый предмет стоил бы 5–8 секунд ожидания.
      Сканируйте подряд, окно сканера закрывать не нужно.</p>
      <div class="field">
        <label for="inventory-scope">Что сверяем</label>
        <select id="inventory-scope">
          <option value="all">Весь каталог — ${items.length} ${plural(items.length, "позиция", "позиции", "позиций")}</option>
          ${categoryList().filter((c) => counts[c.code]).map((c) =>
            `<option value="${escapeHtml(c.code)}">${escapeHtml(c.label)} — ${counts[c.code]}</option>`).join("")}
        </select>
        <p class="hint">Считают полками, а не складом целиком. Предмет из другой
        категории при сверке по категории не пропал — он просто вне области.</p>
      </div>
      <button class="btn" id="inventory-start">Начать сверку</button>`;

    document.getElementById("inventory-start").addEventListener("click", () => {
      const scope = document.getElementById("inventory-scope").value;
      lastMessage = "";
      session = { scope, started_at: new Date().toISOString(), found: {}, unknown: [] };
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
      ${lastMessage ? `<div id="inventory-last" class="hint">${escapeHtml(lastMessage)}</div>` : ""}

      <div class="field">
        <label for="inventory-manual">Ввести номер руками</label>
        <input type="text" id="inventory-manual" inputmode="numeric" placeholder="010101" />
        <button class="btn btn--secondary" id="inventory-add" style="margin-top:8px;">Отметить</button>
      </div>

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
        <p class="hint">Отсканированы, но в каталоге таких номеров нет: чужая
        наклейка, старый номер или позиция, которую не завели.</p>
        ${s.unknown.map((c) => `<div class="card-sub">${escapeHtml(c)}</div>`).join("")}
      </div>` : ""}

      <div class="section">
        <div class="section-title">Не найдено — ${s.missing.length}</div>
        ${s.missing.length
          ? `<div class="list">${s.missing.slice(0, 50).map((i) => `
              <div class="card">
                <div class="card-title">${escapeHtml(i.name)}</div>
                <div class="card-sub">${escapeHtml(i.item_id)} · ${escapeHtml(categoryLabel(i.category))}</div>
              </div>`).join("")}</div>
             ${s.missing.length > 50 ? `<p class="hint">…и ещё ${s.missing.length - 50}. Полный список — в отчёте.</p>` : ""}`
          : `<p class="hint">Всё на месте.</p>`}
      </div>

      <button class="btn btn--secondary" id="inventory-cancel">Отменить сверку</button>`;

    wireSession();
  }

  // Штучные позиции, которые уже отметили: только у них есть что пересчитывать.
  function byQtyFound() {
    return expected.filter((i) => categoryByQty(i.category) &&
      session.found[String(i.item_id)] !== undefined);
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
    document.getElementById("inventory-cancel").addEventListener("click", () => {
      TG.showConfirm("Отменить сверку? Всё, что отсканировано, пропадёт.", (yes) => {
        if (!yes) return;
        session = null;
        lastMessage = "";
        save();
        render();
      });
    });
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
    showBoxError("inventory-error", "");
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
      TG.showAlert(`Сверка записана в журнал. Найдено ${s.found} из ${s.total}, ` +
        `не найдено ${s.missing.length}.`);
      session = null;
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
      btn.disabled = false;
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
