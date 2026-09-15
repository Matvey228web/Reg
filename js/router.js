// Простой роутер по экранам внутри одной страницы (index.html).
// Каждый экран — <div class="screen" id="screen-&lt;name&gt;">, показывается/скрывается через CSS-класс.
// Экраны регистрируются через Router.register(name, { onShow(params) }).

const Router = (() => {
  const screens = {};
  const stack = []; // [{ name, params }]
  const ROOT_SCREENS = new Set(["login", "home"]);

  function register(name, handlers) {
    screens[name] = handlers || {};
  }

  // Названия экранов: ими подписана кнопка «назад» (куда она ведёт) и заголовок,
  // который шапка подхватывает при прокрутке.
  const SCREEN_TITLES = {
    login: "Вход", home: "Главная", catalog: "Каталог", scan: "Скан",
    repair: "Ремонт", orders: "Заказы", order: "Заказ", item: "Оборудование",
    inventory: "Инвентаризация", staff: "Сотрудники", labels: "Этикетки",
    settings: "Настройки", pin: "Смена PIN",
  };

  // «Назад» показываем двумя способами сразу: своей кнопкой в шапке и нативной
  // в шапке Telegram, где она поддерживается. Обе ведут в back().
  // Своя кнопка подписана названием предыдущего экрана — как в iOS: видно не
  // только что уйти можно, но и куда уйдёшь.
  function renderBackButton(name) {
    var visible = !ROOT_SCREENS.has(name) && stack.length > 1;
    var bar = document.getElementById("appbar");
    if (bar) bar.classList.toggle("appbar--pushed", visible);
    if (visible) {
      var prev = stack[stack.length - 2];
      var label = document.getElementById("back-label");
      if (label) label.textContent = SCREEN_TITLES[prev.name] || "Назад";
      TG.backButton.show(() => back());
    } else {
      TG.backButton.hide();
    }
    return visible;
  }

  // Крупный заголовок экрана при прокрутке уезжает вверх, и ровно в этот момент
  // его подхватывает шапка — системное поведение больших заголовков в iOS.
  // Заголовок читаем каждый раз заново: на карточке предмета и в заказе его
  // ставят уже после загрузки данных, снимок при показе экрана был бы пустым.
  function syncTitle() {
    var bar = document.getElementById("appbar");
    var slot = document.getElementById("appbar-title");
    if (!bar || !slot) return;
    var screen = document.querySelector(".screen--active");
    var big = screen ? screen.querySelector("h1") : null;
    var text = big ? big.textContent.trim() : "";
    if (slot.textContent !== text) slot.textContent = text;
    // Без крупного заголовка подхватывать нечего — от прокрутки остаётся только
    // волосяная линия под шапкой, чтобы список не подтекал под неё незаметно.
    var collapsed = big
      ? big.getBoundingClientRect().bottom < bar.getBoundingClientRect().bottom
      : window.scrollY > 4;
    bar.classList.toggle("appbar--collapsed", collapsed);
  }

  // Экраны без своей вкладки подсвечивают вкладку раздела, из которого открыты,
  // чтобы на карточке предмета было видно, где ты находишься.
  const PARENT_TAB = { item: "catalog", labels: "catalog", order: "orders",
                       staff: "home", settings: "home", pin: "home",
                       inventory: "home" };

  // Панель разделов видна везде, кроме экрана входа; активная вкладка подсвечена.
  // Вывеска в шапке остаётся и на входе — она и есть название системы, — а
  // кнопка настроек до входа не ведёт никуда.
  function renderTabbar(name, pushed) {
    // Шестерёнка — действие корня раздела. На вложенном экране её место занято
    // кнопкой «назад» и заголовком, и в системе там стоят действия этого экрана,
    // а не вход в настройки.
    var gear = document.getElementById("appbar-settings");
    if (gear) gear.style.display = name === "login" || pushed ? "none" : "";
    var bar = document.getElementById("tabbar");
    if (!bar) return;
    bar.style.display = name === "login" ? "none" : "flex";
    var active = PARENT_TAB[name] || name;
    bar.querySelectorAll("[data-tab]").forEach(function (btn) {
      btn.classList.toggle("tab--active", btn.dataset.tab === active);
    });
  }

  function show(name, params = {}) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("screen--active"));
    const el = document.getElementById("screen-" + name);
    if (!el) {
      console.error("Неизвестный экран:", name);
      return;
    }
    el.classList.add("screen--active");
    TG.mainButton.hide();
    if (screens[name] && typeof screens[name].onShow === "function") {
      screens[name].onShow(params);
    }
    var pushed = renderBackButton(name);
    renderTabbar(name, pushed);
    window.scrollTo(0, 0);
    syncTitle();
  }

  function navigate(name, params = {}) {
    stack.push({ name, params });
    show(name, params);
  }

  function replace(name, params = {}) {
    stack[stack.length - 1] = { name, params };
    show(name, params);
  }

  function reset(name, params = {}) {
    stack.length = 0;
    stack.push({ name, params });
    show(name, params);
  }

  function back() {
    if (stack.length <= 1) return;
    stack.pop();
    const top = stack[stack.length - 1];
    show(top.name, top.params);
  }

  function init() {
    var btn = document.getElementById("back-button");
    if (btn) btn.addEventListener("click", () => back());
    // Прокрутку слушаем через requestAnimationFrame: событие приходит чаще, чем
    // браузер успевает рисовать, и считать прямоугольники на каждое — лишнее.
    var pending = false;
    window.addEventListener("scroll", function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; syncTitle(); });
    }, { passive: true });
    document.querySelectorAll("#tabbar [data-tab]").forEach(function (el) {
      // Вкладка — это и есть навигация, поэтому стек сбрасываем: «назад»
      // нужен только внутри раздела (например, из карточки предмета).
      el.addEventListener("click", () => reset(el.dataset.tab));
    });
  }

  return { init, register, navigate, replace, reset, back };
})();
