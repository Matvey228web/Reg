// Экран «Настройки» (администратор): категории, сроки и лимиты, источник
// импорта, обслуживание.
//
// Зачем он есть: раньше всё это было константами в коде, и поменять что-либо
// можно было только правкой файла. Теперь значения живут в таблице, а этот
// экран — место, где их меняет владелец системы.

const SettingsScreen = (() => {
  let data = null;   // { settings, categories, limits, maintenance }

  // Подписи короткие: это названия строк, а не предложения. Объяснение к каждой
  // приходит с бэкенда в limits и печатается пояснением под строкой — раньше
  // предложение стояло подписью, занимало две строки и выдавливало значение
  // за край. Подсказка в пустом поле нужна затем же: внутри группы у поля нет
  // ни рамки, ни заливки, и пустое оно ничем не отличается от пустого места.
  const FIELDS = [
    { key: "session_ttl_hours", label: "Срок входа, часов" },
    { key: "max_login_attempts", label: "Попыток до блокировки" },
    { key: "login_lock_minutes", label: "Блокировка, минут" },
    { key: "import_source_id", label: "Исходная таблица", text: true, ph: "идентификатор" },
    { key: "notify_chat_id", label: "Чат склада", text: true, ph: "-1001234567890" },
    { key: "site_url", label: "Сайт проката", text: true, ph: "https://" },
  ];

  async function load() {
    const box = document.getElementById("settings-content");
    const me = Auth.getSession() || {};
    showBoxError("settings-error", "");
    // Складскому сотруднику здесь нужна только своя учётная запись: категории,
    // сроки, бот и обслуживание — администраторские, их правку бэкенд всё равно
    // не пропустит, и показывать кнопки, которые ответят «нельзя», незачем.
    // Заодно ни одного запроса: сменить PIN и выйти можно и без сети.
    if (me.role !== "Admin") {
      box.innerHTML = accountHtml();
      bindAccount();
      return;
    }
    box.innerHTML = skeleton(4);
    try {
      data = await apiPost("/settings/get", {});
      render();
    } catch (err) {
      // Пустой экран с одной красной строкой ничего не объясняет. Если бэкенд
      // просто старее приложения — показываем, что именно сделать, и красную
      // строку не дублируем: инструкция и есть сообщение об ошибке.
      if (backendOutdated(err.message)) {
        showBoxError("settings-error", "");
        box.innerHTML = `
          <p class="hint">Настройки живут в таблице, а её бэкенд ещё не обновлён.</p>
          <div class="section">
            <h2>Что нужно сделать</h2>
            <p class="hint">Выложить бэкенд заново: <b>node apps-script/deploy.js
            push</b>. Порядок и права — в DEPLOY.md.</p>
          </div>
          ${accountHtml()}`;
        bindAccount();
      } else {
        showBoxError("settings-error", err.message);
        // Своя учётная запись от состояния таблицы не зависит: выйти из системы
        // и сменить PIN нужно уметь как раз тогда, когда всё остальное отвалилось.
        box.innerHTML = accountHtml();
        bindAccount();
      }
    }
  }

  // Своя учётная запись — в самом низу и отдельной зоной: это единственное на
  // экране, что меняет не склад, а вас. «Выйти» красной: на складе один телефон
  // ходит по рукам, и промах здесь выкидывает человека в форму входа.
  function accountHtml() {
    const me = Auth.getSession() || {};
    return `
      <div class="section section--account">
        <h2>Учётная запись</h2>
        <p class="hint">Вошли как ${escapeHtml(me.full_name || "—")}${
          me.full_name ? ` · ${escapeHtml(roleLabel(me))}` : ""}.</p>
        <button class="btn btn--secondary" id="settings-pin">Сменить свой PIN</button>
        <button class="btn btn--danger" id="settings-logout">Выйти</button>
      </div>`;
  }

  function bindAccount() {
    const pin = document.getElementById("settings-pin");
    if (pin) pin.addEventListener("click", () => Router.navigate("pin"));
    const out = document.getElementById("settings-logout");
    // Раньше выход происходил молча с одного тапа, а кнопка стоит рядом со
    // «Сменить свой PIN» — промахнуться легко, а обратно только через логин
    // и PIN, которые сотрудник может и не помнить.
    if (out) {
      out.addEventListener("click", () => {
        TG.confirmDestructive("Выйти из системы?",
          "Чтобы вернуться, понадобятся логин и PIN.", "Выйти", (yes) => {
            if (yes) Auth.logout();
          });
      });
    }
  }

  function render() {
    const box = document.getElementById("settings-content");
    const s = data.settings || {};
    const hints = data.limits || {};

    box.innerHTML = `
      ${panelHtml()}

      <div class="section">
        <h2>Категории</h2>
        <p class="hint">Номер категории — первые две цифры номера вещи. Там, где техника уже
          есть, он не меняется: номера напечатаны на этикетках. Название — всегда.</p>
        <div id="settings-categories"></div>
        <button class="btn btn--secondary" id="settings-cat-add-toggle">+ Новая категория</button>
        <!-- Модели — тот же справочник, только на уровень ниже: у каждой модели
             своя категория, и после импорта часть лежит не там. -->
        <button class="btn btn--secondary" id="settings-models">Модели по категориям</button>
        <div id="settings-cat-form" style="display:none;" class="section">
          <div id="settings-cat-error"></div>
          <div class="form-group">
            <div class="field">
              <label for="settings-cat-code">Код</label>
              <input id="settings-cat-code" type="text" maxlength="3" placeholder="BAT"
                     autocapitalize="characters" autocorrect="off" spellcheck="false" />
              <p class="hint">Три латинские буквы.</p>
            </div>
            <div class="field">
              <label for="settings-cat-label">Название</label>
              <input id="settings-cat-label" type="text" placeholder="Аккумуляторы" />
            </div>
            <div class="toggle-row">
              <label for="settings-cat-new-qty">Считать количеством</label>
              <input type="checkbox" id="settings-cat-new-qty" />
            </div>
          </div>
          <p class="hint">«Количеством» — для того, на что не наклеить QR: мешки, флаги, расходники.
            Одна строка с остатком. Потом меняется только у пустой категории.</p>
          <p class="hint">Номер система выдаст сама — следующий свободный.</p>
          <button class="btn" id="settings-cat-submit">Добавить</button>
        </div>
      </div>

      <div class="section">
        <h2>Сроки и защита входа</h2>
        <div id="settings-fields-error"></div>
        <div class="form-group">
          ${FIELDS.map((f) => `
            <div class="field${f.text ? " field--stacked" : ""}">
              <label for="set-${f.key}">${escapeHtml(f.label)}</label>
              <input id="set-${f.key}" type="${f.text ? "text" : "number"}"
                     value="${escapeHtml(String(s[f.key] === undefined ? "" : s[f.key]))}"
                     ${f.ph ? `placeholder="${escapeHtml(f.ph)}"` : ""}
                     ${f.text ? 'autocapitalize="off" autocorrect="off" spellcheck="false"' : ""} />
              ${hints[f.key] ? `<p class="hint">${escapeHtml(hints[f.key])}</p>` : ""}
            </div>`).join("")}
        </div>
        <button class="btn" id="settings-save">Сохранить</button>
      </div>

      <div class="section">
        <h2>Бот в Telegram</h2>
        <p class="hint">Бот пишет в чат склада о дефектах и о просрочках. Токен бота — не здесь,
          а в Script Properties, ключ TELEGRAM_BOT_TOKEN (эти настройки видит любой
          сотрудник). Как завести — в BOT.md.</p>
        <div id="settings-bot-result"></div>
        <button class="btn btn--secondary" id="settings-bot-test">Проверить связь с чатом</button>
        <button class="btn btn--secondary" id="settings-bot-overdue" style="margin-top:8px;">Отправить сводку по просрочкам</button>
      </div>

      <div class="section">
        <h2>Обслуживание</h2>
        <p class="hint">Выгрузка кладёт журналы на ваш Google Диск, в папку «Mifs Rent — архив».
          Подрезка удаляет закрытые записи и работает только после выгрузки.</p>
        ${data.maintenance && data.maintenance.journal_archived_at
          ? `<p class="hint">Последняя выгрузка: ${escapeHtml(formatDate(data.maintenance.journal_archived_at))}</p>`
          : `<p class="hint">Журнал ещё не выгружался.</p>`}
        <div id="settings-maintenance-result"></div>
        <button class="btn btn--secondary" id="settings-archive">Выгрузить журнал в файл</button>
        <button class="btn btn--secondary" id="settings-trim" style="margin-top:8px;">Подрезать таблицу</button>
        <p class="hint">Перезаливка каталога осталась в редакторе Apps Script: она слишком долгая
          для запроса по сети.</p>
      </div>

      ${accountHtml()}
    `;

    renderCategories();
    bind();
    bindAccount();
  }

  // Панель главного администратора. Смысл не в красоте, а в том, чтобы одним
  // взглядом видеть состояние склада: что на руках, что просрочено, что
  // сломано. Раньше за каждым числом надо было идти на свой экран и ждать
  // ответа таблицы.
  function panelHtml() {
    const me = data.me || {};
    const owner = data.owner;
    const s = data.summary;
    if (!s && !owner) return "";   // старый бэкенд — панели просто нет

    const tile = (value, label, warn) =>
      `<div class="tile${warn ? " tile--warn" : ""}">
         <div class="tile-value">${escapeHtml(String(value))}</div>
         <div class="tile-label">${escapeHtml(label)}</div>
       </div>`;

    return `
      <div class="section">
        <h2>${me.is_owner ? "Панель главного администратора" : "Панель администратора"}</h2>
        ${owner
          ? `<p class="hint">Главный администратор — ${escapeHtml(owner.full_name)}${me.is_owner ? " (это вы)" : ""}.
             ${me.is_owner
               ? "Только вы заводите и удаляете сотрудников. Эту роль нельзя удалить — её можно только передать на экране «Сотрудники»."
               : "Заводить и удалять сотрудников может только он."}</p>`
          : ""}
        ${s ? `
        <div class="tiles">
          ${tile(s.items, "позиций в каталоге")}
          ${tile(s.open_transactions, "на руках")}
          ${tile(s.overdue_transactions, "просрочено", s.overdue_transactions > 0)}
          ${tile(s.open_defects, "открытых дефектов", s.open_defects > 0)}
          ${tile(s.orders_issued, "заказов выдано")}
          ${tile(s.orders_new, "заказов ждут выдачи")}
          ${tile(s.in_repair, "в ремонте", s.in_repair > 0)}
          ${tile(s.staff_active, "сотрудников в строю")}
        </div>` : ""}
        <button class="btn btn--secondary" id="settings-go-staff">Сотрудники и права</button>
      </div>`;
  }

  function renderCategories() {
    const box = document.getElementById("settings-categories");
    box.innerHTML = (data.categories || []).map((c) => `
      <div class="card">
        <div class="card-title">${escapeHtml(c.label)}${c.by_qty ? `<span class="badge">количеством</span>` : ""}</div>
        <div class="card-sub">${escapeHtml(c.code)} · номер ${escapeHtml(c.num)}</div>
        <div class="form-group form-group--inset">
          <div class="field">
            <label for="cat-label-${escapeHtml(c.code)}">Название</label>
            <input type="text" id="cat-label-${escapeHtml(c.code)}"
                   data-cat-label="${escapeHtml(c.code)}" value="${escapeHtml(c.label)}" />
          </div>
          <div class="toggle-row">
            <label for="cat-qty-${escapeHtml(c.code)}">Считать количеством</label>
            <input type="checkbox" id="cat-qty-${escapeHtml(c.code)}"
                   data-cat-qty="${escapeHtml(c.code)}" ${c.by_qty ? "checked" : ""} />
          </div>
        </div>
        <button class="btn btn--secondary" data-cat-save="${escapeHtml(c.code)}" style="width:auto;">
          Сохранить
        </button>
      </div>`).join("");

    box.querySelectorAll("[data-cat-save]").forEach((btn) => {
      btn.addEventListener("click", () => saveCategory(btn.dataset.catSave));
    });
  }

  async function saveCategory(code) {
    const input = document.querySelector(`[data-cat-label="${code}"]`);
    const label = input.value.trim();
    if (!label) { TG.showAlert("Название не может быть пустым"); return; }
    const byQty = document.querySelector(`[data-cat-qty="${code}"]`).checked;
    try {
      await apiPost("/category/update", { code, label, by_qty: byQty });
      TG.hapticSuccess();
      await reloadAndRefreshSession();
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    }
  }

  async function addCategory() {
    const code = document.getElementById("settings-cat-code").value.trim().toUpperCase();
    const label = document.getElementById("settings-cat-label").value.trim();
    showBoxError("settings-cat-error", "");
    const btn = document.getElementById("settings-cat-submit");
    btn.disabled = true;
    try {
      await apiPost("/category/create", {
        code, label,
        by_qty: document.getElementById("settings-cat-new-qty").checked,
      });
      TG.hapticSuccess();
      await reloadAndRefreshSession();
    } catch (err) {
      TG.hapticError();
      showBoxError("settings-cat-error", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function saveFields() {
    const payload = {};
    FIELDS.forEach((f) => {
      const raw = document.getElementById("set-" + f.key).value.trim();
      payload[f.key] = f.text ? raw : Number(raw);
    });
    showBoxError("settings-fields-error", "");
    const btn = document.getElementById("settings-save");
    btn.disabled = true;
    btn.textContent = "Сохраняем…";
    try {
      const res = await apiPost("/settings/set", { settings: payload });
      data.settings = res.settings;
      // Главная читает адрес сайта из сессии — без этого кнопка появилась бы
      // только после следующего входа.
      const me = Auth.getSession();
      if (me) Auth.setSession({ ...me, settings: res.settings });
      TG.hapticSuccess();
      TG.showAlert("Настройки сохранены");
    } catch (err) {
      TG.hapticError();
      showBoxError("settings-fields-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Сохранить";
    }
  }

  // Проверка связи и сводка просрочек — одно и то же по форме: нажали, ждём,
  // показали, что ответил Telegram. Отказ здесь ожидаем (нет токена, бота не
  // добавили в чат), поэтому объясняем причину, а не прячем её.
  async function bot(endpoint, btnId) {
    const btn = document.getElementById(btnId);
    const out = document.getElementById("settings-bot-result");
    btn.disabled = true;
    out.innerHTML = skeleton(1);
    try {
      const res = await apiPost(endpoint, {
        chat_id: document.getElementById("set-notify_chat_id").value.trim(),
      });
      out.innerHTML = `<div class="card"><div class="card-sub">${escapeHtml(res.message || "Готово")}</div></div>`;
      TG.hapticSuccess();
    } catch (err) {
      out.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      TG.hapticError();
    } finally {
      btn.disabled = false;
    }
  }

  async function maintenance(action, btnId) {
    const btn = document.getElementById(btnId);
    const out = document.getElementById("settings-maintenance-result");
    btn.disabled = true;
    out.innerHTML = skeleton(1);
    try {
      const res = await apiPost("/maintenance", { action });
      out.innerHTML = `<div class="card"><div class="card-sub">${escapeHtml(res.message)}</div></div>`;
      TG.hapticSuccess();
    } catch (err) {
      out.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      TG.hapticError();
    } finally {
      btn.disabled = false;
    }
  }

  // Справочник категорий лежит в сессии, и по нему рисуются фильтры каталога.
  // После правки его надо освежить, иначе каталог продолжит показывать старое
  // название до следующего входа.
  async function reloadAndRefreshSession() {
    data = await apiPost("/settings/get", {});
    const session = Auth.getSession();
    if (session) Auth.setSession({ ...session, categories: data.categories, settings: data.settings });
    render();
  }

  function bind() {
    const staffBtn = document.getElementById("settings-go-staff");
    if (staffBtn) staffBtn.addEventListener("click", () => Router.navigate("staff"));
    document.getElementById("settings-models").addEventListener("click", () => Router.navigate("models"));
    document.getElementById("settings-cat-add-toggle").addEventListener("click", () => {
      const form = document.getElementById("settings-cat-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("settings-cat-submit").addEventListener("click", addCategory);
    document.getElementById("settings-save").addEventListener("click", saveFields);
    document.getElementById("settings-bot-test")
      .addEventListener("click", () => bot("/notify/test", "settings-bot-test"));
    document.getElementById("settings-bot-overdue")
      .addEventListener("click", () => bot("/notify/overdue", "settings-bot-overdue"));
    document.getElementById("settings-archive")
      .addEventListener("click", () => maintenance("archive", "settings-archive"));
    document.getElementById("settings-trim")
      .addEventListener("click", () => maintenance("trim", "settings-trim"));
  }

  function init() {
    Router.register("settings", { onShow: load });
  }

  return { init };
})();
