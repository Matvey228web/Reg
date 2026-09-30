// Экран «Настройки» (администратор): категории, сроки и лимиты, источник
// импорта, обслуживание.
//
// Зачем он есть: раньше всё это было константами в коде, и поменять что-либо
// можно было только правкой файла. Теперь значения живут в таблице, а этот
// экран — место, где их меняет владелец системы.

const SettingsScreen = (() => {
  let data = null;   // { settings, categories, limits, maintenance }
  const CACHE = "settings";

  // Подписи короткие: это названия строк, а не предложения. Объяснение к каждой
  // приходит с бэкенда в limits и печатается пояснением под строкой — раньше
  // предложение стояло подписью, занимало две строки и выдавливало значение
  // за край. Подсказка в пустом поле нужна затем же: внутри группы у поля нет
  // ни рамки, ни заливки, и пустое оно ничем не отличается от пустого места.
  // grp — в каком подразделе поле показывается. Сохраняются они всё равно все
  // сразу: бэкенд принимает настройки одним словарём, а поля остаются в DOM,
  // даже когда подраздел закрыт.
  const FIELDS = [
    { key: "session_ttl_hours", label: "Срок входа, часов", grp: "login" },
    { key: "max_login_attempts", label: "Попыток до блокировки", grp: "login" },
    { key: "login_lock_minutes", label: "Блокировка, минут", grp: "login" },
    { key: "import_source_id", label: "Исходная таблица", text: true, ph: "идентификатор", grp: "links" },
    { key: "notify_chat_id", label: "Чат склада", text: true, ph: "-1001234567890", grp: "links" },
    { key: "notify_thread_orders", label: "Тема для заявок", text: true, ph: "123", grp: "links" },
    { key: "notify_thread_acts", label: "Тема для актов", text: true, ph: "123", grp: "links" },
    { key: "site_url", label: "Сайт проката", text: true, ph: "https://", grp: "links" },
    { key: "app_link", label: "Ссылка на приложение", text: true, ph: "https://t.me/бот/app", grp: "links" },
    { key: "api_url", label: "Адрес Worker", text: true, ph: "https://", grp: "links" },
  ];

  // Одна строка поля — чтобы два подраздела рисовались одним кодом.
  function fieldHtml(f, s, hints) {
    return `
      <div class="field${f.text ? " field--stacked" : ""}">
        <label for="set-${f.key}">${escapeHtml(f.label)}</label>
        <input id="set-${f.key}" type="${f.text ? "text" : "number"}"
               value="${escapeHtml(String(s[f.key] === undefined ? "" : s[f.key]))}"
               ${f.ph ? `placeholder="${escapeHtml(f.ph)}"` : ""}
               ${f.text ? 'autocapitalize="off" autocorrect="off" spellcheck="false"' : ""} />
        ${hints[f.key] ? `<p class="hint">${escapeHtml(hints[f.key])}</p>` : ""}
      </div>`;
  }

  async function load() {
    const box = document.getElementById("settings-content");
    const me = Auth.getSession() || {};
    showBoxError("settings-error", "");
    // Заходя в настройки заново, человек ждёт список, а не тот подраздел, где
    // был в прошлый раз. Внутри экрана подраздел держится (сохранение
    // перерисовывает всё), а вход на экран его сбрасывает.
    panel = null;
    // Складскому сотруднику здесь нужна только своя учётная запись: категории,
    // сроки, бот и обслуживание — администраторские, их правку бэкенд всё равно
    // не пропустит, и показывать кнопки, которые ответят «нельзя», незачем.
    // Заодно ни одного запроса: сменить PIN и выйти можно и без сети.
    if (me.role !== "Admin") {
      box.innerHTML = accountHtml();
      bindAccount();
      return;
    }
    // Показываем прошлые настройки сразу, а за свежими идём молча. Экран
    // настроек — самый медленный в приложении: одно чтение, но оно упирается
    // в потолок таблицы, и всё это время человек смотрел на заглушки. Сроки
    // входа и ФИО мастера меняются раз в месяц, поэтому показать вчерашние и
    // тут же обновить — честнее, чем держать пустой экран.
    const known = Cache.one(CACHE);
    if (known) {
      data = known;
      render();
      if (Cache.isFresh(CACHE)) return;
    } else {
      box.innerHTML = skeleton(4);
    }
    try {
      const fresh = await apiPost("/settings/get", {});
      Cache.setOne(CACHE, fresh);
      data = fresh;
      // Если человек уже что-то печатает в поле, перерисовка стёрла бы
      // набранное. Данные сохранены, покажем их при следующем заходе.
      if (!isTyping("#settings-content")) render();
    } catch (err) {
      // Кэш уже нарисован — незачем менять экран на сообщение об ошибке.
      if (known) { showBoxError("settings-error", err.message); return; }
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
      <div class="section section--account section--top">
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

  // Куда открыт вход: null — список, иначе имя подраздела. Всё содержимое
  // рисуется сразу, а видно одно: обработчики остаются прежними, и правка
  // блоков не зависит от того, как их показывают.
  let panel = null;

  const PANELS = [
    { key: "cats", label: "Категории и модели", hint: "номера, названия, где лежит модель" },
    { key: "public", label: "Заявки с сайта", hint: "принимать ли заявки и как часто" },
    { key: "act", label: "Акт сдачи-приёмки", hint: "шаблон, подписи, папка" },
    { key: "bot", label: "Бот в Telegram", hint: "чат, темы и проверка связи" },
    { key: "links", label: "Адреса и связи", hint: "таблица, чат, сайт, приложение" },
    { key: "login", label: "Вход и защита", hint: "срок сессии, попытки, блокировка" },
    { key: "maint", label: "Обслуживание", hint: "выгрузка и подрезка журналов" },
  ];

  function menuHtml() {
    return `
      <div class="section" id="settings-menu">
        <div class="menu">
          ${PANELS.map((x) => `
            <button class="menu-row" type="button" data-open="${x.key}">
              <span class="menu-row-main">
                <span class="menu-row-label">${escapeHtml(x.label)}</span>
                <span class="menu-row-hint">${escapeHtml(x.hint)}</span>
              </span>
              <span class="menu-row-go">›</span>
            </button>`).join("")}
        </div>
      </div>`;
  }

  // Показываем один подраздел или список. Прокрутку возвращаем наверх: иначе
  // после длинного списка категорий следующий экран открывается с середины.
  function showPanel(key) {
    panel = key || null;
    const menu = document.getElementById("settings-menu");
    if (menu) menu.hidden = !!panel;
    document.querySelectorAll("#settings-content [data-panel]").forEach((el) => {
      el.hidden = el.dataset.panel !== panel;
    });
    // Панель со сводкой и своя учётка — только на верхнем уровне.
    document.querySelectorAll("#settings-content .section--top").forEach((el) => {
      el.hidden = !!panel;
    });
    const screen = document.getElementById("screen-settings");
    if (screen) screen.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function render() {
    const box = document.getElementById("settings-content");
    const s = data.settings || {};
    const hints = data.limits || {};

    box.innerHTML = `
      ${panelHtml()}
      ${menuHtml()}

      <div class="section" data-panel="cats" hidden>
        <button class="sub-back" type="button" data-close="1">← Настройки</button>
        <h2>Категории и модели</h2>
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

      <div class="section" data-panel="links" hidden>
        <button class="sub-back" type="button" data-close="1">← Настройки</button>
        <h2>Адреса и связи</h2>
        <p class="hint">Куда система смотрит наружу: таблица, из которой берут каталог,
          чат склада, витрина для студентов и ссылка на это приложение.</p>
        <div id="settings-links-error"></div>
        <div class="form-group">
          ${FIELDS.filter((f) => f.grp === "links").map((f) => fieldHtml(f, s, hints)).join("")}
        </div>
        <button class="btn" id="settings-links-save">Сохранить</button>
      </div>

      <div class="section" data-panel="login" hidden>
        <button class="sub-back" type="button" data-close="1">← Настройки</button>
        <h2>Вход и защита</h2>
        <p class="hint">Сколько держится вход и что происходит после неверных PIN.</p>
        <div id="settings-fields-error"></div>
        <div class="form-group">
          ${FIELDS.filter((f) => f.grp === "login").map((f) => fieldHtml(f, s, hints)).join("")}
        </div>
        <button class="btn" id="settings-save">Сохранить</button>
      </div>

      <div class="section" data-panel="act" hidden>
        <button class="sub-back" type="button" data-close="1">← Настройки</button>
        <h2>Акт сдачи-приёмки</h2>
        <p class="hint">Акт собирается сам, как только появился заказ: ссылка уходит
          в чат склада и остаётся в карточке заказа.</p>
        ${s.act_template_id
          ? `<p class="hint">Шаблон готов —
              <a href="https://docs.google.com/document/d/${escapeHtml(s.act_template_id)}/edit"
                 target="_blank" rel="noopener">открыть и править</a>. Это обычный документ:
              меняйте формулировки и шапку, не трогайте только слова в двойных скобках.</p>`
          : `<p class="hint">Шаблона пока нет — акты не собираются. Нажмите «Создать шаблон»:
              получится акт колледжа без данных студента.</p>`}
        <div id="settings-act-error"></div>
        <div class="form-group">
          <div class="field field--stacked">
            <label for="set-act_master">Мастер, ФИО целиком</label>
            <input id="set-act_master" type="text" placeholder="Гриднев Егор Олегович"
                   value="${escapeHtml(String(s.act_master || ""))}" />
          </div>
          <div class="field field--stacked">
            <label for="set-act_director">Директор в договоре</label>
            <input id="set-act_director" type="text" placeholder="Директора Керзиной О.А."
                   value="${escapeHtml(String(s.act_director || ""))}" />
          </div>
        </div>
        <button class="btn" id="settings-act-save">Сохранить</button>
        ${data.me && data.me.is_owner
          ? `<button class="btn btn--secondary" id="settings-act-template"
                     style="margin-top:8px;">${s.act_template_id
                       ? "Пересоздать шаблон" : "Создать шаблон"}</button>`
          : `<p class="hint">Шаблон создаёт главный администратор.</p>`}
      </div>

      <div class="section" data-panel="public" hidden>
        <button class="sub-back" type="button" data-close="1">← Настройки</button>
        <h2>Заявки с сайта</h2>
        <p class="hint">Включено — сайт отправляет заявку сам: строка появляется в «Заказах»
          со статусом «Новый», и бот пишет об этом в чат. Выключено — студент копирует
          текст и присылает его любым способом, как сейчас.</p>
        <p class="hint">Это единственный адрес, куда пишут без входа в систему. Со складом он
          ничего не делает: технику по-прежнему списывает человек. Предел в час не даст
          завалить таблицу, если адрес найдут роботы.</p>
        <div id="settings-public-error"></div>
        <div class="form-group">
          <div class="toggle-row">
            <label for="set-public_orders">Принимать заявки с сайта</label>
            <input type="checkbox" id="set-public_orders"
                   ${Number(s.public_orders) === 1 ? "checked" : ""} />
          </div>
          <div class="field">
            <label for="set-public_orders_per_hour">Не больше в час</label>
            <input id="set-public_orders_per_hour" type="number"
                   value="${escapeHtml(String(s.public_orders_per_hour === undefined ? 20 : s.public_orders_per_hour))}" />
          </div>
        </div>
        <button class="btn" id="settings-public-save">Сохранить</button>
      </div>

      <div class="section" data-panel="bot" hidden>
        <button class="sub-back" type="button" data-close="1">← Настройки</button>
        <h2>Бот в Telegram</h2>
        <p class="hint">Бот пишет в чат склада только заявки и акты. Чат находит кнопка
          «Найти чат склада». Если в группе включены темы, заявки и акты можно
          развести по своим: номер темы — из /id внутри темы, впишите его в поля
          «Тема для заявок» и «Тема для актов» (раздел «Адреса и связи»); пусто —
          сообщение уходит в General.
          «Поздороваться в чате» проверяет связь.</p>
        <p class="hint">Токен бота — не здесь,
          а в Script Properties, ключ TELEGRAM_BOT_TOKEN (эти настройки видит любой
          сотрудник). Как завести — в BOT.md.</p>
        <p class="hint">Чат склада сейчас:
          ${s.notify_chat_id
            ? `<b>${escapeHtml(String(s.notify_chat_id))}</b>`
            : "не выбран — бот не знает, куда писать"}.</p>
        <p class="hint" id="settings-bot-who" hidden></p>
        <div id="settings-bot-result"></div>
        <button class="btn btn--secondary" id="settings-bot-find">Найти чат склада</button>
        <button class="btn btn--secondary" id="settings-bot-link" style="margin-top:8px;">Постоянная связь</button>
        <button class="btn btn--secondary" id="settings-bot-hello" style="margin-top:8px;">Поздороваться в чате</button>
      </div>

      <div class="section" data-panel="maint" hidden>
        <button class="sub-back" type="button" data-close="1">← Настройки</button>
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
    // Сохранение перерисовывает экран целиком — возвращаемся туда, где были,
    // а не выбрасываем человека в список.
    showPanel(panel);
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
      <div class="section section--top">
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

  // Приём заявок с сайта сохраняем отдельно от сроков входа: это выключатель
  // единственного адреса, куда пишут без входа, и трогать его заодно с
  // «блокировка, минут» человек не должен.
  // Акт: подписи и папка. Шаблон — отдельной кнопкой, потому что это создание
  // документа в Диске, а не правка настройки.
  async function saveAct() {
    const btn = document.getElementById("settings-act-save");
    showBoxError("settings-act-error", "");
    btn.disabled = true;
    btn.textContent = "Сохраняем…";
    try {
      const res = await apiPost("/settings/set", {
        settings: {
          act_master: document.getElementById("set-act_master").value.trim(),
          act_director: document.getElementById("set-act_director").value.trim(),
        },
      });
      data.settings = res.settings;
      Cache.setOne(CACHE, data);
      TG.hapticSuccess();
      TG.showAlert("Сохранено");
      // Ссылка «открыть и править» и подпись про шаблон зависят от того, что
      // сохранили: перерисовываем, чтобы не врать до следующего входа.
      render();
      bind();
    } catch (err) {
      TG.hapticError();
      showBoxError("settings-act-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Сохранить";
    }
  }

  async function createActTemplate() {
    const btn = document.getElementById("settings-act-template");
    const again = !!data.settings.act_template_id;
    if (again) {
      const go = await new Promise((resolve) => TG.showConfirm(
        "Создать новый шаблон? Прежний останется в Диске, но акты будут " +
        "собираться по новому.", resolve));
      if (!go) return;
    }
    showBoxError("settings-act-error", "");
    btn.disabled = true;
    btn.textContent = "Создаём…";
    try {
      const res = await apiPost("/act/template", again ? { replace: true } : {});
      data.settings.act_template_id = res.template_id;
      // Кэш здесь надо сбросить, а не подправить: шаблон меняет и подписи на
      // экране, и то, что вернёт бэкенд, — пусть load() сходит за настоящим.
      Cache.clear(CACHE);
      TG.hapticSuccess();
      TG.showAlert("Шаблон создан. Он в вашем Google Диске, правьте как обычный документ.");
      load();
    } catch (err) {
      TG.hapticError();
      showActError(err.message);
      btn.disabled = false;
      btn.textContent = again ? "Пересоздать шаблон" : "Создать шаблон";
    }
  }

  // Отказ с ссылкой внутри — это разовая настройка на стороне Google. Ссылку
  // делаем кнопкой: читать адрес с телефона и набирать его руками незачем.
  function showActError(message) {
    const box = document.getElementById("settings-act-error");
    const url = (String(message).match(/https?:\/\/\S+/) || [])[0];
    if (!url) { showBoxError("settings-act-error", message); return; }
    const words = String(message).replace(url, "").replace(/\s+/g, " ").trim();
    box.innerHTML = `
      <div class="error-box">
        <p style="margin:0 0 8px;">${escapeHtml(words)}</p>
        <button class="btn btn--secondary" id="settings-act-fix">Открыть страницу Google</button>
      </div>`;
    document.getElementById("settings-act-fix")
      .addEventListener("click", () => TG.openLink(url));
  }

  async function savePublicOrders() {
    const btn = document.getElementById("settings-public-save");
    showBoxError("settings-public-error", "");
    btn.disabled = true;
    btn.textContent = "Сохраняем…";
    try {
      const res = await apiPost("/settings/set", {
        settings: {
          public_orders: document.getElementById("set-public_orders").checked ? 1 : 0,
          public_orders_per_hour:
            Number(document.getElementById("set-public_orders_per_hour").value.trim()),
        },
      });
      data.settings = res.settings;
      Cache.setOne(CACHE, data);
      TG.hapticSuccess();
      TG.showAlert(Number(res.settings.public_orders) === 1
        ? "Сайт теперь отправляет заявки сам"
        : "Заявки с сайта выключены");
    } catch (err) {
      TG.hapticError();
      showBoxError("settings-public-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Сохранить";
    }
  }

  // Кнопки две — в «Адресах» и во «Входе», — а сохранение одно: бэкенд
  // принимает настройки словарём, и делить его по подразделам смысла нет.
  // Отличается только то, где показать отказ и какую кнопку погасить.
  async function saveFields(btnId, errId) {
    const payload = {};
    FIELDS.forEach((f) => {
      const raw = document.getElementById("set-" + f.key).value.trim();
      payload[f.key] = f.text ? raw : Number(raw);
    });
    showBoxError(errId, "");
    const btn = document.getElementById(btnId);
    btn.disabled = true;
    btn.textContent = "Сохраняем…";
    try {
      const res = await apiPost("/settings/set", { settings: payload });
      data.settings = res.settings;
      Cache.setOne(CACHE, data);
      // Главная читает адрес сайта из сессии — без этого кнопка появилась бы
      // только после следующего входа.
      const me = Auth.getSession();
      if (me) Auth.setSession({ ...me, settings: res.settings });
      TG.hapticSuccess();
      TG.showAlert("Настройки сохранены");
    } catch (err) {
      TG.hapticError();
      showBoxError(errId, err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Сохранить";
    }
  }

  // Поиск чата. В Telegram на телефоне id чата не показывают вовсе, а прежний
  // способ — открыть в браузере getUpdates с токеном в адресе — заодно уносил
  // токен в историю браузера. Спрашиваем у бэкенда: он ходит в Telegram сам.
  async function findChats() {
    const btn = document.getElementById("settings-bot-find");
    const out = document.getElementById("settings-bot-result");
    btn.disabled = true;
    out.innerHTML = skeleton(2);
    try {
      const res = await apiPost("/notify/chats", {});
      // Как зовут бота, знает Telegram — показываем сразу с готовой командой.
      // Без этого человеку приходилось идти в BotFather за именем, чтобы
      // подставить его в подсказку вида «/id@имя_бота».
      showBotName(res);
      if (!res.chats.length) {
        out.innerHTML = `<div class="card"><div class="card-sub">${escapeHtml(res.hint)}</div></div>`;
        return;
      }
      out.innerHTML = res.chats.map((c) => `
        <div class="card">
          <div class="card-title">${escapeHtml(c.title)}</div>
          <div class="card-sub">${escapeHtml(c.chat_id)} · ${escapeHtml(chatKind(c.type))}${
            String(c.chat_id) === String(res.current) ? " · сейчас выбран" : ""}</div>
          <button class="btn btn--secondary" data-pick="${escapeHtml(c.chat_id)}"
                  style="margin-top:8px;">Это чат склада</button>
        </div>`).join("");
      out.querySelectorAll("[data-pick]").forEach((b) => {
        b.addEventListener("click", () => pickChat(b.dataset.pick, b));
      });
    } catch (err) {
      TG.hapticError();
      out.innerHTML = `<div class="card"><div class="card-sub">${escapeHtml(err.message)}</div></div>`;
    } finally {
      btn.disabled = false;
    }
  }

  function chatKind(type) {
    if (type === "private") return "личная переписка";
    if (type === "channel") return "канал";
    return "группа";
  }

  // Имя бота и команда. Команду ставим тем же начертанием, каким в Telegram
  // выглядят команды, — чтобы её переписали в чат как есть.
  function showBotName(res) {
    const box = document.getElementById("settings-bot-who");
    const bot = res.bot || {};
    if (!box || !bot.username) return;
    box.hidden = false;
    box.innerHTML = `Бот: <b>@${escapeHtml(bot.username)}</b>. Чтобы он услышал чат, ` +
      `напишите в группе <code>${escapeHtml(res.command || "/id@" + bot.username)}</code> — ` +
      `команда может быть любая, важно только, чтобы она дошла до бота.`;
  }

  // Выбранный чат сохраняем сразу: заставлять человека переписывать число
  // руками в другой подраздел — ровно та работа, от которой мы его избавляем.
  async function pickChat(chatId, btn) {
    btn.disabled = true;
    btn.textContent = "Сохраняем…";
    try {
      const res = await apiPost("/settings/set", { settings: { notify_chat_id: chatId } });
      data.settings = res.settings;
      Cache.setOne(CACHE, data);
      const me = Auth.getSession();
      if (me) Auth.setSession({ ...me, settings: res.settings });
      // Сразу здороваемся: выбор чата и есть проверка связи. Человек нажал
      // «Это чат склада» — и увидел в чате сообщение от бота, вместо того
      // чтобы искать вторую кнопку и гадать, работает ли вообще.
      //
      // Приветствие не ушло — чат всё равно сохранён, и говорим об этом
      // прямо: терять сохранённую настройку из-за молчащего Telegram нельзя.
      let hello = "";
      try {
        await apiPost("/notify/hello", { chat_id: chatId });
      } catch (err) {
        hello = "\n\nПоздороваться не вышло: " + err.message;
      }
      TG.hapticSuccess();
      TG.showAlert(hello
        ? "Чат склада сохранён." + hello
        : "Чат склада сохранён, бот поздоровался — посмотрите в чате.");
      render();
      bind();
      showPanel("bot");
    } catch (err) {
      TG.hapticError();
      btn.disabled = false;
      btn.textContent = "Это чат склада";
      showBoxError("settings-error", err.message);
    }
  }

  // Постоянная связь с Telegram. Сначала показываем, как дела, и только потом
  // предлагаем включить или выключить: кнопка рядом с состоянием честнее
  // тумблера, у которого надо угадывать, что он сейчас означает. Заодно это
  // единственное место, где видно, жива ли связка: Telegram сам говорит,
  // сколько событий ждёт доставки и что не получилось в последний раз.
  async function botLink(mode) {
    const btn = document.getElementById("settings-bot-link");
    const out = document.getElementById("settings-bot-result");
    btn.disabled = true;
    out.innerHTML = skeleton(1);
    try {
      const res = await apiPost("/notify/webhook", { mode: mode || "status" });
      out.innerHTML = linkCard(res);
      const act = out.querySelector("[data-link]");
      if (act) act.addEventListener("click", () => botLink(act.dataset.link));
      TG.hapticSuccess();
    } catch (err) {
      out.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      TG.hapticError();
    } finally {
      btn.disabled = false;
    }
  }

  function linkCard(res) {
    const lines = [];
    if (res.message) lines.push(escapeHtml(res.message));
    lines.push(res.on
      ? "Связь постоянная: Telegram присылает события сам."
      : "Связи нет: чаты ищутся опросом по кнопке, и события живут не дольше суток.");
    if (res.on && res.pending) lines.push("Ждёт доставки событий: " + res.pending + ".");
    if (res.last_error) lines.push("Последняя ошибка: " + escapeHtml(res.last_error) + ".");
    return `<div class="card">
        <div class="card-sub">${lines.join("<br>")}</div>
        <button class="btn btn--secondary" data-link="${res.on ? "off" : "on"}"
                style="margin-top:8px;">${res.on ? "Выключить" : "Включить"}</button>
      </div>`;
  }

  // Проверка связи и приветствие — одно и то же по форме: нажали, ждём,
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
  // После правки категорий идём за свежим минуя кэш — и кладём ответ в кэш
  // сами. Иначе следующий заход показал бы список без только что добавленной
  // категории и выглядел бы так, будто правка не сохранилась.
  async function reloadAndRefreshSession() {
    data = await apiPost("/settings/get", {}, { fresh: true });
    Cache.setOne(CACHE, data);
    const session = Auth.getSession();
    if (session) Auth.setSession({ ...session, categories: data.categories, settings: data.settings });
    render();
  }

  function bind() {
    // Переходы внутрь и назад: один слушатель на весь экран, потому что
    // содержимое перерисовывается целиком при каждом сохранении.
    document.querySelectorAll("[data-open]").forEach((row) => {
      row.addEventListener("click", () => showPanel(row.dataset.open));
    });
    document.querySelectorAll("[data-close]").forEach((row) => {
      row.addEventListener("click", () => showPanel(null));
    });

    const staffBtn = document.getElementById("settings-go-staff");
    if (staffBtn) staffBtn.addEventListener("click", () => Router.navigate("staff"));
    document.getElementById("settings-models").addEventListener("click", () => Router.navigate("models"));
    document.getElementById("settings-cat-add-toggle").addEventListener("click", () => {
      const form = document.getElementById("settings-cat-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("settings-cat-submit").addEventListener("click", addCategory);
    document.getElementById("settings-save")
      .addEventListener("click", () => saveFields("settings-save", "settings-fields-error"));
    document.getElementById("settings-links-save")
      .addEventListener("click", () => saveFields("settings-links-save", "settings-links-error"));
    document.getElementById("settings-public-save")
      .addEventListener("click", savePublicOrders);
    document.getElementById("settings-act-save").addEventListener("click", saveAct);
    const tplBtn = document.getElementById("settings-act-template");
    if (tplBtn) tplBtn.addEventListener("click", createActTemplate);
    document.getElementById("settings-bot-find")
      .addEventListener("click", findChats);
    document.getElementById("settings-bot-link")
      .addEventListener("click", () => botLink("status"));
    document.getElementById("settings-bot-hello")
      .addEventListener("click", () => bot("/notify/hello", "settings-bot-hello"));
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
