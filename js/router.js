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

  // «Назад» показываем двумя способами сразу: своей кнопкой в странице и
  // нативной в шапке Telegram, где она поддерживается. Обе ведут в back().
  function renderBackButton(name) {
    var visible = !ROOT_SCREENS.has(name) && stack.length > 1;
    var row = document.getElementById("back-row");
    if (row) row.style.display = visible ? "block" : "none";
    if (visible) TG.backButton.show(() => back());
    else TG.backButton.hide();
  }

  // Экраны без своей вкладки подсвечивают вкладку раздела, из которого открыты,
  // чтобы на карточке предмета было видно, где ты находишься.
  const PARENT_TAB = { item: "catalog", staff: "home" };

  // Панель разделов видна везде, кроме экрана входа; активная вкладка подсвечена.
  function renderTabbar(name) {
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
    renderBackButton(name);
    renderTabbar(name);
    window.scrollTo(0, 0);
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
    document.querySelectorAll("#tabbar [data-tab]").forEach(function (el) {
      // Вкладка — это и есть навигация, поэтому стек сбрасываем: «назад»
      // нужен только внутри раздела (например, из карточки предмета).
      el.addEventListener("click", () => reset(el.dataset.tab));
    });
  }

  return { init, register, navigate, replace, reset, back };
})();
