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
  ];

  async function load() {
    const box = document.getElementById("settings-content");
    box.innerHTML = skeleton(4);
    showBoxError("settings-error", "");
    try {
      data = await apiPost("/settings/get", {});
      render();
    } catch (err) {
      box.innerHTML = "";
      showBoxError("settings-error", err.message);
    }
  }

  function render() {
    const box = document.getElementById("settings-content");
    const s = data.settings || {};
    const hints = data.limits || {};

    box.innerHTML = `
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

  function renderCategories() {
    const box = document.getElementById("settings-categories");
    box.innerHTML = (data.categories || []).map((c) => `
      <div class="card">
        <div class="card-title">${escapeHtml(c.label)}</div>
        <div class="card-sub">${escapeHtml(c.code)} · номер ${escapeHtml(c.num)}</div>
        <div class="field" style="margin-top:8px;">
          <input type="text" data-cat-label="${escapeHtml(c.code)}" value="${escapeHtml(c.label)}" />
        </div>
        <button class="btn btn--secondary" data-cat-save="${escapeHtml(c.code)}" style="width:auto;">
          Переименовать
        </button>
      </div>`).join("");

    box.querySelectorAll("[data-cat-save]").forEach((btn) => {
      btn.addEventListener("click", () => renameCategory(btn.dataset.catSave));
    });
  }

  async function renameCategory(code) {
    const input = document.querySelector(`[data-cat-label="${code}"]`);
    const label = input.value.trim();
    if (!label) { TG.showAlert("Название не может быть пустым"); return; }
    try {
      await apiPost("/category/update", { code, label });
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
      await apiPost("/category/create", { code, label });
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
    document.getElementById("settings-cat-add-toggle").addEventListener("click", () => {
      const form = document.getElementById("settings-cat-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("settings-cat-submit").addEventListener("click", addCategory);
    document.getElementById("settings-save").addEventListener("click", saveFields);
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
