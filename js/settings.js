// Экран «Настройки» (администратор): категории, сроки и лимиты, источник
// импорта, обслуживание.
//
// Зачем он есть: раньше всё это было константами в коде, и поменять что-либо
// можно было только правкой файла. Теперь значения живут в таблице, а этот
// экран — место, где их меняет владелец системы.

const SettingsScreen = (() => {
  let data = null;   // { settings, categories, limits, maintenance }

  const FIELDS = [
    { key: "session_ttl_hours", label: "Сколько часов держать сотрудника в системе без повторного входа" },
    { key: "max_login_attempts", label: "Сколько неверных PIN до блокировки входа" },
    { key: "login_lock_minutes", label: "На сколько минут блокировать вход" },
    { key: "import_source_id", label: "Идентификатор исходной таблицы для импорта", text: true },
    { key: "notify_chat_id", label: "Чат склада для уведомлений бота", text: true },
  ];

  async function load() {
    const box = document.getElementById("settings-content");
    box.innerHTML = skeleton(4);
    showBoxError("settings-error", "");
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
          <p class="hint">Настройки живут в таблице, а её бэкенд ещё не обновлён —
          поэтому этот экран пока пустой.</p>
          <div class="section">
            <h2>Что нужно сделать</h2>
            <ol class="hint" style="padding-left:18px;">
              <li>Откройте таблицу склада → Расширения → Apps Script.</li>
              <li>Замените содержимое <b>Code.gs</b> присланным файлом целиком.</li>
              <li>Deploy → Manage deployments → карандаш → New version → Deploy.</li>
            </ol>
            <p class="hint">Важно выбрать именно «новую версию» существующего
            развёртывания, а не создавать новое: у нового будет другой адрес, и
            приложение перестанет находить таблицу.</p>
          </div>`;
      } else {
        showBoxError("settings-error", err.message);
        box.innerHTML = "";
      }
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
        <p class="hint">Номер категории — первые две цифры номера предмета. У категории,
        в которой уже есть техника, он не меняется: номера напечатаны на этикетках.
        Название можно менять всегда.</p>
        <div id="settings-categories"></div>
        <button class="btn btn--secondary" id="settings-cat-add-toggle">+ Новая категория</button>
        <div id="settings-cat-form" style="display:none;" class="section">
          <div id="settings-cat-error"></div>
          <div class="field">
            <label for="settings-cat-code">Код — три латинские буквы</label>
            <input id="settings-cat-code" type="text" maxlength="3" placeholder="BAT"
                   autocapitalize="characters" autocorrect="off" spellcheck="false" />
          </div>
          <div class="field">
            <label for="settings-cat-label">Название</label>
            <input id="settings-cat-label" type="text" placeholder="Аккумуляторы" />
          </div>
          <div class="toggle-row">
            <label for="settings-cat-new-qty">Считать количеством, без личных номеров</label>
            <input type="checkbox" id="settings-cat-new-qty" />
          </div>
          <p class="hint">«Количеством» — для того, на что не наклеить QR: мешки, флаги,
          струбцины, расходники. Такая позиция живёт одной строкой с остатком.
          Способ учёта потом меняется только у пустой категории.</p>
          <p class="hint">Номер система выдаст сама — следующий свободный.</p>
          <button class="btn" id="settings-cat-submit">Добавить</button>
        </div>
      </div>

      <div class="section">
        <h2>Сроки и защита входа</h2>
        <div id="settings-fields-error"></div>
        ${FIELDS.map((f) => `
          <div class="field">
            <label for="set-${f.key}">${escapeHtml(f.label)}</label>
            <input id="set-${f.key}" type="${f.text ? "text" : "number"}"
                   value="${escapeHtml(String(s[f.key] === undefined ? "" : s[f.key]))}"
                   ${f.text ? 'autocapitalize="off" autocorrect="off" spellcheck="false"' : ""} />
            ${hints[f.key] ? `<p class="hint">${escapeHtml(hints[f.key])}</p>` : ""}
          </div>`).join("")}
        <button class="btn" id="settings-save">Сохранить</button>
      </div>

      <div class="section">
        <h2>Бот в Telegram</h2>
        <p class="hint">Бот пишет в чат склада о дефектах и по кнопке — о
        просрочках. Токен бота хранится не здесь, а в Apps Script → Project
        Settings → Script Properties, ключ <b>TELEGRAM_BOT_TOKEN</b>: настройки
        читает любой вошедший сотрудник, а токен — это полный доступ к боту.
        Пошаговая инструкция лежит в файле BOT.md.</p>
        <div id="settings-bot-result"></div>
        <button class="btn btn--secondary" id="settings-bot-test">Проверить связь с чатом</button>
        <button class="btn btn--secondary" id="settings-bot-overdue" style="margin-top:8px;">Отправить сводку по просрочкам</button>
      </div>

      <div class="section">
        <h2>Обслуживание</h2>
        <p class="hint">Выгрузка складывает журнал выдач и дефектов файлом на ваш Google Диск,
        в папку «Mifs Rent — архив». Подрезка удаляет из таблицы уже закрытые записи и работает
        только после выгрузки — иначе данные было бы нечем восстановить. Незакрытые выдачи
        и открытые дефекты не трогаются никогда.</p>
        ${data.maintenance && data.maintenance.journal_archived_at
          ? `<p class="hint">Последняя выгрузка: ${escapeHtml(formatDate(data.maintenance.journal_archived_at))}</p>`
          : `<p class="hint">Журнал ещё не выгружался.</p>`}
        <div id="settings-maintenance-result"></div>
        <button class="btn btn--secondary" id="settings-archive">Выгрузить журнал в файл</button>
        <button class="btn btn--secondary" id="settings-trim" style="margin-top:8px;">Подрезать таблицу</button>
        <p class="hint">Перезаливка каталога осталась в редакторе Apps Script: она тяжёлая,
        и по сети запрос может отвалиться раньше, чем она закончит — тогда непонятно, прошла ли.</p>
      </div>
    `;

    renderCategories();
    bind();
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
        <div class="field" style="margin-top:8px;">
          <input type="text" data-cat-label="${escapeHtml(c.code)}" value="${escapeHtml(c.label)}" />
        </div>
        <div class="toggle-row">
          <label for="cat-qty-${escapeHtml(c.code)}">Считать количеством, без личных номеров</label>
          <input type="checkbox" id="cat-qty-${escapeHtml(c.code)}"
                 data-cat-qty="${escapeHtml(c.code)}" ${c.by_qty ? "checked" : ""} />
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
    if (session) Auth.setSession({ ...session, categories: data.categories });
    render();
  }

  function bind() {
    const staffBtn = document.getElementById("settings-go-staff");
    if (staffBtn) staffBtn.addEventListener("click", () => Router.navigate("staff"));
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
