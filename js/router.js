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

  function renderBackButton(name) {
    if (ROOT_SCREENS.has(name) || stack.length <= 1) {
      TG.backButton.hide();
    } else {
      TG.backButton.show(() => back());
    }
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

  return { register, navigate, replace, reset, back };
})();
