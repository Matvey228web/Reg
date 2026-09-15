// Круглая кнопка главного действия в правом нижнем углу.
//
// Раньше полоса с «+ Добавить» липла к верху экрана, чтобы не потеряться на
// 629 позициях. Получалось два этажа панелей посреди списка: шапка, под ней
// полоса, и всё это обрубало содержимое. Теперь полоса уезжает вместе со
// списком, а действие подхватывает кнопка у большого пальца.
//
// Экранам про неё знать не нужно: модуль сам находит на активном экране полосу
// .sticky-bar, берёт из неё первую кнопку и перенаправляет ей нажатие. Так это
// работает и в каталоге, и в заказах, и на любом будущем экране с такой полосой.

const Fab = (() => {
  let el = null;
  let source = null;   // настоящая кнопка, которой мы двойник
  let io = null;

  function init() {
    el = document.getElementById("fab");
    if (!el) return;
    el.addEventListener("click", () => {
      if (!source) return;
      source.click();
      // После открытия формы список уезжает вниз, и двойник больше не нужен:
      // настоящая кнопка снова на экране. Наблюдатель это увидит сам, но с
      // задержкой в кадр — гасим сразу, чтобы кнопка не моргала поверх формы.
      hide();
    });
  }

  function hide() {
    if (el) el.classList.remove("fab--on");
  }

  // Вызывается роутером на каждом показе экрана.
  function watch() {
    if (io) { io.disconnect(); io = null; }
    hide();
    source = null;
    if (!el) return;
    const screen = document.querySelector(".screen--active");
    const bar = screen ? screen.querySelector(".sticky-bar") : null;
    source = bar ? bar.querySelector(".btn") : null;
    if (!source) return;
    el.setAttribute("aria-label", source.textContent.trim());
    el.setAttribute("title", source.textContent.trim());
    // Наблюдатель, а не обработчик прокрутки: браузер сам считает пересечение,
    // и на списке в 629 строк это не стоит ничего.
    io = new IntersectionObserver((entries) => {
      const e = entries[0];
      // Показываем только когда полоса ушла ВВЕРХ за край. Если она ниже экрана
      // (форма открыта и всё уехало вниз), двойник не нужен — до кнопки можно
      // просто долистать.
      const gone = !e.isIntersecting && e.boundingClientRect.top < 0;
      el.classList.toggle("fab--on", gone);
    }, { threshold: 0 });
    io.observe(bar);
  }

  return { init, watch, hide };
})();
