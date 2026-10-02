// Зачем он есть: раньше всё это было константами в коде, и поменять что-либо
// можно было только правкой файла. Теперь значения живут в таблице, а этот
// экран — место, где их меняет владелец системы.

const SettingsScreen = (() => {
  let data = null;   // { settings, categories, limits, maintenance }
  const CACHE = "settings";
  // Очередь Worker: GET /health, ответ { ok, queue, dead, oldest_dead_at }.
  // undefined — ещё не спрашивали, null — не ответил (плитка покажет «—»).
  let health;

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
    // Состояние очереди Worker — один раз на заход в экран, не по таймеру:
    // на бесплатном тарифе чтения списка очереди в KV считаются.
    loadHealth();
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
  // «Сотрудники» — строкой рядом со своей учётной записью: раньше это была
  // плитка на главной, но там место под складские дела, а люди и права —
  // настройка. Видна тем же, кому была видна плитка: администраторам.
  // Рисуется вместе с учётной записью, поэтому есть и тогда, когда таблица не
  // ответила, — заблокировать сотрудника бывает нужно именно в такой день.
  function staffEntryHtml(me) {
    if (me.role !== "Admin") return "";
    return `
      <div class="section section--top">
        <div class="menu">
          <button class="menu-row" type="button" id="settings-go-staff">
            <span class="menu-row-main">
              <span class="menu-row-label">Сотрудники</span>
              <span class="menu-row-hint">кто входит, роли, PIN и блокировка</span>
            </span>
            <span class="menu-row-go">›</span>
          </button>
        </div>
      </div>`;
  }

  // withStaff = false, когда «Сотрудники» уже стоят строкой в общем списке
  // настроек (menuHtml): отдельной карточкой они нужны только на запасном
  // экране, когда таблица не ответила.
  function accountHtml(withStaff = true) {
    const me = Auth.getSession() || {};
    return `${withStaff ? staffEntryHtml(me) : ""}
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
    const staffBtn = document.getElementById("settings-go-staff");
    if (staffBtn) staffBtn.addEventListener("click", () => Router.navigate("staff"));
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

  // Значки — как в системных настройках iOS: белый контур на цветной
  // плашке. Цвет различает строки быстрее подписи, поэтому у каждой свой.
  // Контуры — из того же набора, что значки вкладок и плиток главной.
  const ICONS = {
    cats: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    staff: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    public: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    act: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a1 1 0 0 0 1 1h5"/><path d="M8 13h8"/><path d="M8 17h5"/>',
    bot: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    links: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    login: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    // Шестерёнка — как у «Основных» в настройках iOS: гаечный ключ уже у вкладки «Ремонт».
    maint: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  };

  const PANELS = [
    { key: "cats", label: "Категории и модели", hint: "номера, названия, где лежит модель", color: "#ff9500" },
    { key: "staff", label: "Сотрудники", hint: "кто входит, роли, PIN и блокировка", color: "#af52de", go: "staff" },
    { key: "public", label: "Заявки с сайта", hint: "принимать ли заявки и как часто", color: "#007aff" },
    { key: "act", label: "Акт сдачи-приёмки", hint: "шаблон, подписи, папка", color: "#34c759" },
    { key: "bot", label: "Бот в Telegram", hint: "чат, темы и проверка связи", color: "#2aabee" },
    { key: "links", label: "Адреса и связи", hint: "таблица, чат, сайт, приложение", color: "#5856d6" },
    { key: "login", label: "Вход и защита", hint: "срок сессии, попытки, блокировка", color: "#ff3b30" },
    { key: "maint", label: "Обслуживание", hint: "выгрузка и подрезка журналов", color: "#8e8e93" },
  ];

  // Один список, как в настройках iOS. «Сотрудники» — не подраздел, а свой
  // экран: у строки нет data-open, её ведёт bindAccount по id.
  function menuHtml() {
    const me = Auth.getSession() || {};
    const rows = PANELS.filter((x) => !x.go || me.role === "Admin");
    return `
      <div class="section" id="settings-menu">
        <div class="menu">
          ${rows.map((x) => `
            <button class="menu-row" type="button" ${x.go
              ? `id="settings-go-${x.go}"` : `data-open="${x.key}"`}>
              <span class="menu-ico" style="background:${x.color}">
                <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[x.key]}</svg>
              </span>
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
              меняйте формулировки и шапку, впишите, кто подписывает за колледж, —
              не трогайте только слова в двойных скобках.</p>
            <p class="hint">Правьте только как текст: без @-упоминаний, «умных» дат,
              раскрывающихся списков и флажков — с ними Google не откроет шаблон
              и акты перестанут собираться.</p>`
          : `<p class="hint">Шаблона пока нет — акты не собираются. Нажмите «Создать шаблон»:
              получится акт колледжа без данных студента.</p>`}
        <div id="settings-act-error"></div>
        ${data.me && data.me.is_owner
          ? `<button class="btn btn--secondary" id="settings-act-template">${s.act_template_id
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
        ${data.maintenance && data.maintenance.schema_outdated === false ? "" : `
        <button class="btn btn--secondary" id="settings-setup" style="margin-top:8px;">Создать недостающие вкладки</button>
        <p class="hint">Таблица отстаёт от обновления склада: нажмите один раз — появятся новые вкладки
          и колонки. Данные не трогает. После нажатия кнопка пропадёт до следующего такого обновления.</p>`}
        <p class="hint">Перезаливка каталога осталась в редакторе Apps Script: она слишком долгая
          для запроса по сети.</p>
      </div>

      ${accountHtml(false)}
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

    const tile = (value, label, warn, hint) =>
      `<div class="tile${warn ? " tile--warn" : ""}">
         <div class="tile-value">${escapeHtml(String(value))}</div>
         <div class="tile-label">${escapeHtml(label)}</div>
         ${hint ? `<div class="tile-label">${escapeHtml(hint)}</div>` : ""}
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
          ${logsTileHtml(s, tile)}
          ${deadTileHtml()}
        </div>
        <div id="settings-logs" hidden>${logsListHtml(s.logs_recent)}</div>` : ""}
      </div>`;
  }

  // Окно скользящее — последние 24 часа, а не с полуночи: повторяющаяся
  // ошибка держит плитку красной, пока её не устранят. Чтобы понять, что
  // падает, не открывая лист Logs, плитка раскрывает последние записи.
  function logsTileHtml(s, tile) {
    const n = s.logs_24h;
    const html = tile(n === undefined ? "—" : n, "ошибок за сутки", n > 0,
      s.logs_recent && n > 0 ? "нажмите — покажу последние" : "смотрите лист Logs в таблице");
    return s.logs_recent && n > 0
      ? html.replace('<div class="tile', '<div id="settings-logs-toggle" role="button" tabindex="0" class="tile-tap tile')
      : html;
  }

  function logsListHtml(rows) {
    if (!rows || !rows.length) return "";
    return `<div class="menu">${rows.map((r) => `
      <div class="menu-row">
        <span class="menu-row-main">
          <span class="menu-row-label">${escapeHtml(formatDate(r.at))} · ${escapeHtml([r.kind, r.endpoint, r.reason].filter(Boolean).join(" · "))}</span>
          <span class="menu-row-hint">${escapeHtml(r.message || "—")}</span>
        </span>
      </div>`).join("")}</div>
      <p class="hint">Полный журнал — лист Logs в таблице.</p>`;
  }

  // Сколько заявок с сайта застряло в очереди Worker. Молча: не ответил —
  // плитка показывает «—», без окна с ошибкой. В демо в сеть не ходим.
  async function loadHealth() {
    health = undefined;
    if (CONFIG.MOCK_MODE) { health = { ok: true, queue: 0, dead: 0 }; drawHealth(); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const res = await fetch(CONFIG.WEBHOOK_BASE_URL.replace(/\/+$/, "") + "/health",
        { signal: abort.signal });
      const json = await res.json();
      health = json && typeof json.dead === "number" ? json : null;
    } catch (e) {
      health = null;
    } finally {
      clearTimeout(timer);
    }
    drawHealth();
  }

  // Ответ приходит позже экрана — меняем одну плитку, а не перерисовываем всё:
  // перерисовка стёрла бы набранное в полях.
  function drawHealth() {
    const el = document.getElementById("settings-tile-dead");
    if (el) el.outerHTML = deadTileHtml();
  }

  function deadTileHtml() {
    const dead = health ? health.dead : null;
    const warn = dead > 0;
    return `<div class="tile${warn ? " tile--warn" : ""}" id="settings-tile-dead">
         <div class="tile-value">${escapeHtml(dead === null ? "—" : String(dead))}</div>
         <div class="tile-label">застрявших заявок</div>
         ${warn ? `<div class="tile-label">заявки с сайта не дошли до таблицы — см. DEPLOY.md, «Заявки не доходят»</div>` : ""}
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
      btn.addEventListener("click", () => saveCategory(btn.dataset.catSave, btn));
    });
  }

  async function saveCategory(code, btn) {
    const input = document.querySelector(`[data-cat-label="${code}"]`);
    const label = input.value.trim();
    showBoxError("settings-cat-list-error", "");
    if (!label) {
      showCategoryError("Название не может быть пустым");
      return;
    }
    const byQty = document.querySelector(`[data-cat-qty="${code}"]`).checked;
    const restore = busyButton(btn);
    try {
      await apiPost("/category/update", { code, label, by_qty: byQty });
      TG.hapticSuccess();
      // Что записалось, мы и так знаем — без второго чтения всех настроек.
      applyCategories((data.categories || []).map((c) =>
        c.code === code ? { ...c, label, by_qty: byQty } : c));
      showStatusLine("settings-cat-status", "Категория сохранена", { before: "settings-categories" });
    } catch (err) {
      TG.hapticError();
      restore();
      showCategoryError(err.message);
    }
  }

  function showCategoryError(message) {
    const slot = ensureSlot("settings-cat-list-error", "settings-categories");
    if (slot) showBoxError("settings-cat-list-error", message);
  }

  async function addCategory() {
    const code = document.getElementById("settings-cat-code").value.trim().toUpperCase();
    const label = document.getElementById("settings-cat-label").value.trim();
    showBoxError("settings-cat-error", "");
    const restore = busyButton(document.getElementById("settings-cat-submit"), "Добавляем…");
    try {
      // Ответ — сама новая категория с номером (handleCategoryCreate).
      const created = await apiPost("/category/create", {
        code, label,
        by_qty: document.getElementById("settings-cat-new-qty").checked,
      });
      TG.hapticSuccess();
      if (created && created.code) {
        applyCategories((data.categories || []).concat([created]));
      } else {
        await reloadAndRefreshSession();
      }
      showStatusLine("settings-cat-status", "Категория добавлена: " + label,
        { before: "settings-categories" });
    } catch (err) {
      TG.hapticError();
      showBoxError("settings-cat-error", err.message);
      restore();
    }
  }

  // Справочник категорий поправили своими руками: в экран, в кэш (не трогая
  // его возраст) и в сессию — по ней рисуются фильтры каталога.
  function applyCategories(categories) {
    data = { ...data, categories };
    keep();
    const session = Auth.getSession();
    if (session) Auth.setSession({ ...session, categories });
    render();
  }

  // Свою правку — в кэш, не трогая его возраст: остальная часть настроек
  // (сводка, справочники) свежее от неё не стала. Cache.setOne объявил бы
  // свежим всё сразу.
  function keep() {
    if (!Cache.replace(CACHE, [data])) Cache.setOne(CACHE, data);
  }

  // «Сохранено» — строкой над местом ошибки того же подраздела, а не окном.
  function saved(errId, text) {
    showBoxError(errId, "");
    showStatusLine(errId + "-ok", text, { before: errId });
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
    const restore = busyButton(btn, "Создаём…");
    try {
      const res = await apiPost("/act/template", again ? { replace: true } : {});
      data.settings.act_template_id = res.template_id;
      TG.hapticSuccess();
      // Номер шаблона известен — рисуем с ним сразу, в том же подразделе.
      render();
      saved("settings-act-error", "Шаблон создан. Он в вашем Google Диске, правьте как обычный документ.");
      // Шаблон меняет и подписи на экране, и то, что вернёт бэкенд, — за
      // настоящим идём молча, не выбрасывая человека из подраздела.
      Cache.stale(CACHE);
      apiPost("/settings/get", {}, { fresh: true }).then((fresh) => {
        Cache.setOne(CACHE, fresh);
        data = fresh;
        if (!isTyping("#settings-content")) render();
      }).catch(() => {});
    } catch (err) {
      TG.hapticError();
      showActError(err.message);
      restore();
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

  // Приём заявок с сайта сохраняем отдельно от сроков входа: это выключатель
  // единственного адреса, куда пишут без входа, и трогать его заодно с
  // «блокировка, минут» человек не должен.
  async function savePublicOrders() {
    const restore = busyButton(document.getElementById("settings-public-save"));
    showBoxError("settings-public-error", "");
    try {
      const res = await apiPost("/settings/set", {
        settings: {
          public_orders: document.getElementById("set-public_orders").checked ? 1 : 0,
          public_orders_per_hour:
            Number(document.getElementById("set-public_orders_per_hour").value.trim()),
        },
      });
      data.settings = res.settings;
      keep();
      TG.hapticSuccess();
      saved("settings-public-error", Number(res.settings.public_orders) === 1
        ? "Сайт теперь отправляет заявки сам"
        : "Заявки с сайта выключены");
    } catch (err) {
      TG.hapticError();
      showBoxError("settings-public-error", err.message);
    } finally {
      restore();
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
    const restore = busyButton(document.getElementById(btnId));
    try {
      const res = await apiPost("/settings/set", { settings: payload });
      data.settings = res.settings;
      keep();
      // Главная читает адрес сайта из сессии — без этого кнопка появилась бы
      // только после следующего входа.
      const me = Auth.getSession();
      if (me) Auth.setSession({ ...me, settings: res.settings });
      TG.hapticSuccess();
      saved(errId, "Настройки сохранены");
    } catch (err) {
      TG.hapticError();
      showBoxError(errId, err.message);
    } finally {
      restore();
    }
  }

  // Поиск чата. В Telegram на телефоне id чата не показывают вовсе, а прежний
  // способ — открыть в браузере getUpdates с токеном в адресе — заодно уносил
  // токен в историю браузера. Спрашиваем у бэкенда: он ходит в Telegram сам.
  async function findChats() {
    const out = document.getElementById("settings-bot-result");
    const restore = busyButton(document.getElementById("settings-bot-find"), "Ищем…");
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
      restore();
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
    const restore = busyButton(btn);
    try {
      const res = await apiPost("/settings/set", { settings: { notify_chat_id: chatId } });
      data.settings = res.settings;
      keep();
      const me = Auth.getSession();
      if (me) Auth.setSession({ ...me, settings: res.settings });
      // Сразу здороваемся: выбор чата и есть проверка связи. Человек нажал
      // «Это чат склада» — и увидел в чате сообщение от бота, вместо того
      // чтобы искать вторую кнопку и гадать, работает ли вообще.
      //
      // Приветствие не ушло — чат всё равно сохранён, и говорим об этом
      // прямо: терять сохранённую настройку из-за молчащего Telegram нельзя.
      if (btn.isConnected) btn.textContent = "Здороваемся…";
      let hello = "";
      try {
        await apiPost("/notify/hello", { chat_id: chatId });
      } catch (err) {
        hello = "Поздороваться не вышло: " + err.message;
      }
      TG.hapticSuccess();
      // render() сам зовёт bind(); второй bind() удваивал слушатели.
      render();
      showPanel("bot");
      // Итог — карточкой в том же подразделе, а не окном: причину отказа
      // Telegram надо прочитать, а окно закрывают не читая.
      const out = document.getElementById("settings-bot-result");
      if (out) {
        out.innerHTML = hello
          ? `<div class="card"><div class="card-sub">Чат склада сохранён.</div></div>` +
            `<div class="error-box">${escapeHtml(hello)}</div>`
          : `<div class="card"><div class="card-sub">Чат склада сохранён, бот поздоровался — посмотрите в чате.</div></div>`;
      }
    } catch (err) {
      TG.hapticError();
      restore();
      showBoxError("settings-error", err.message);
    }
  }

  // Постоянная связь с Telegram. Сначала показываем, как дела, и только потом
  // предлагаем включить или выключить: кнопка рядом с состоянием честнее
  // тумблера, у которого надо угадывать, что он сейчас означает. Заодно это
  // единственное место, где видно, жива ли связка: Telegram сам говорит,
  // сколько событий ждёт доставки и что не получилось в последний раз.
  async function botLink(mode) {
    const out = document.getElementById("settings-bot-result");
    const restore = busyButton(document.getElementById("settings-bot-link"), "Спрашиваем Telegram…");
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
      restore();
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
    const out = document.getElementById("settings-bot-result");
    const restore = busyButton(document.getElementById(btnId), "Отправляем…");
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
      restore();
    }
  }

  async function maintenance(action, btnId) {
    const out = document.getElementById("settings-maintenance-result");
    const restore = busyButton(document.getElementById(btnId), "Выполняем…");
    out.innerHTML = skeleton(1);
    try {
      const res = await apiPost("/maintenance", { action });
      out.innerHTML = `<div class="card"><div class="card-sub">${escapeHtml(res.message)}</div></div>`;
      TG.hapticSuccess();
      // Таблица догнала схему — кнопка больше не нужна; итог остаётся на экране.
      if (action === "setup" && data && data.maintenance) {
        data.maintenance.schema_outdated = false;
        const btn = document.getElementById(btnId);
        if (btn) { btn.nextElementSibling && btn.nextElementSibling.remove(); btn.remove(); }
      }
    } catch (err) {
      out.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      TG.hapticError();
    } finally {
      restore();
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
    const logsBtn = document.getElementById("settings-logs-toggle");
    if (logsBtn) logsBtn.addEventListener("click", () => {
      const box = document.getElementById("settings-logs");
      box.hidden = !box.hidden;
    });
    // Переходы внутрь и назад: один слушатель на весь экран, потому что
    // содержимое перерисовывается целиком при каждом сохранении.
    document.querySelectorAll("[data-open]").forEach((row) => {
      row.addEventListener("click", () => showPanel(row.dataset.open));
    });
    document.querySelectorAll("[data-close]").forEach((row) => {
      row.addEventListener("click", () => showPanel(null));
    });

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
    // Кнопки нет, когда таблица догнала схему (schema_outdated в /settings/get).
    const setupBtn = document.getElementById("settings-setup");
    if (setupBtn) setupBtn.addEventListener("click", () => maintenance("setup", "settings-setup"));
  }

  function init() {
    Router.register("settings", { onShow: load });
  }

  return { init };
})();
