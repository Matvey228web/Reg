// «Потянуть для обновления» на экранах со списками.
//
// Главное, из-за чего это нельзя сделать наивно: в мини-приложении Telegram
// вертикальный свайп вниз ЗАКРЫВАЕТ приложение. Свой жест без предосторожности
// закрывал бы склад вместо обновления — и выглядел бы как падение.
//
// Поэтому жест ставится только если клиент умеет отключить свой свайп
// (Bot API 7.7, TG.lockVerticalSwipes). Где не умеет — жеста нет вовсе, и
// остаётся кнопка «Обновить». Закрыть приложение по-прежнему можно кнопкой
// «Закрыть» и шевроном в шапке Telegram, они рядом.
//
// Вне Telegram жест тоже ставим: в браузере тянуть безопасно, а на компьютере
// этого события просто не будет.

const Pull = (() => {
  // Сколько надо протянуть, чтобы сработало. Меньше 64 — срабатывает на
  // случайном движении пальца при обычной прокрутке вверх.
  const THRESHOLD = 64;
  // Дальше этой отметки резинка не растягивается: иначе список уезжает так,
  // что не видно, куда вернётся.
  const MAX = 96;

  let enabled = null;      // решаем один раз при первом подключении
  let indicator = null;
  const handlers = {};     // имя экрана -> что делать при обновлении
  let startY = null;
  let active = null;       // имя экрана, на котором тянут
  let pulled = 0;
  let busy = false;

  function allowed() {
    if (enabled === null) {
      // Вне Telegram блокировать нечего, и жест безопасен.
      enabled = TG.isAvailable() ? TG.lockVerticalSwipes() : true;
    }
    return enabled;
  }

  function getIndicator() {
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "pull-indicator";
      indicator.innerHTML = `<span class="pull-spinner" aria-hidden="true"></span>`;
      document.getElementById("app").appendChild(indicator);
    }
    return indicator;
  }

  function paint(distance, spinning) {
    const el = getIndicator();
    el.style.transform = `translateY(${Math.min(distance, MAX)}px)`;
    el.classList.toggle("pull-indicator--on", distance > 4 || spinning);
    el.classList.toggle("pull-indicator--ready", distance >= THRESHOLD && !spinning);
    el.classList.toggle("pull-indicator--spin", !!spinning);
  }

  function reset() {
    startY = null;
    active = null;
    pulled = 0;
    paint(0, false);
  }

  // Экран регистрирует себя один раз; дальше жест сам смотрит, какой экран
  // открыт, и зовёт его обновление.
  function register(screenName, onRefresh) {
    handlers[screenName] = onRefresh;
    if (!allowed()) return;
    install();
  }

  let installed = false;

  function install() {
    if (installed) return;
    installed = true;

    document.addEventListener("touchstart", (e) => {
      if (busy || e.touches.length !== 1) return;
      // Тянуть можно только от самого верха: иначе жест перебивал бы обычную
      // прокрутку длинного списка.
      if (window.scrollY > 0) return;
      const screen = document.querySelector(".screen--active");
      const name = screen ? screen.id.replace("screen-", "") : "";
      if (!handlers[name]) return;
      startY = e.touches[0].clientY;
      active = name;
      pulled = 0;
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (startY === null || busy) return;
      pulled = e.touches[0].clientY - startY;
      if (pulled <= 0) { paint(0, false); return; }
      // Сопротивление: палец прошёл больше, чем уехал список. Так видно, что
      // жест не бесконечный.
      paint(pulled / 2, false);
    }, { passive: true });

    document.addEventListener("touchend", () => {
      if (startY === null || busy) return;
      const fire = pulled / 2 >= THRESHOLD;
      const name = active;
      if (!fire) { reset(); return; }
      busy = true;
      paint(THRESHOLD, true);
      TG.hapticSuccess();
      Promise.resolve()
        .then(() => handlers[name]())
        .catch(() => { /* экран сам покажет свою ошибку */ })
        .then(() => { busy = false; reset(); });
    }, { passive: true });
  }

  // Наружу — чтобы проверить в тестах, поставлен ли жест вообще.
  function isEnabled() {
    return enabled === true;
  }

  return { register, isEnabled };
})();
