// Свайп влево по строке открывает действие под ней — как в списках на iPhone.
//
// Главная сложность здесь не сам жест, а сосуществование с Telegram:
//   * вертикальным свайпом Telegram закрывает мини-приложение, поэтому вертикаль
//     мы не перехватываем вообще. За это отвечает `touch-action: pan-y` в CSS:
//     браузеру сказано «вертикальные жесты твои, горизонтальные мои», и список
//     продолжает прокручиваться, а приложение — закрываться свайпом вниз;
//   * у левого края экрана в iOS живёт системный жест «назад», поэтому жесты,
//     начатые в этой зоне, игнорируем;
//   * решение «это горизонтальный свайп» принимается один раз за касание и
//     только когда по горизонтали ушли заметно дальше, чем по вертикали.
//
// Работает на pointer-событиях, а не на touch: тогда то же самое доступно мышью
// на компьютере. Иначе действие было бы недостижимо с ПК — там касаний нет.

const Swipe = (() => {
  const EDGE_ZONE = 28;     // от левого края — не наш жест, там системный «назад»
  const DECIDE_AT = 8;      // пока не ушли на столько пикселей, решение не принимаем
  const RATIO = 1.3;        // горизонтальное движение должно быть заметно больше вертикального
  const OPEN_AT = 0.4;      // какую долю кнопки надо оттянуть, чтобы она осталась открытой
  const WIDTH = 88;         // синхронно с .swipe-action в css/style.css

  function row(innerHtml, { actionLabel, actionIcon, onAction }) {
    const wrap = document.createElement("div");
    wrap.className = "swipe";
    wrap.innerHTML = `
      <button class="swipe-action" type="button" aria-label="${escapeHtml(actionLabel)}">
        <span class="swipe-action-ico">${actionIcon}</span>${escapeHtml(actionLabel)}
      </button>
      <div class="swipe-body">${innerHtml}</div>`;

    const body = wrap.querySelector(".swipe-body");
    const action = wrap.querySelector(".swipe-action");

    let startX = 0, startY = 0, dx = 0;
    let decided = null;   // null — ещё не решили, "swipe" или "scroll"
    let opened = false;
    let pointerId = null;

    const setOffset = (px) => { body.style.transform = px ? `translateX(${px}px)` : ""; };
    function close() {
      opened = false;
      wrap.classList.remove("swipe--open", "swipe--dragging");
      setOffset(0);
    }
    function open() {
      opened = true;
      wrap.classList.remove("swipe--dragging");
      wrap.classList.add("swipe--open");
      setOffset(-WIDTH);
    }

    body.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch" && e.clientX < EDGE_ZONE) { decided = "scroll"; return; }
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      decided = null;
    });

    body.addEventListener("pointermove", (e) => {
      if (pointerId !== e.pointerId || decided === "scroll") return;
      const moveX = e.clientX - startX;
      const moveY = e.clientY - startY;

      if (decided === null) {
        if (Math.abs(moveX) < DECIDE_AT && Math.abs(moveY) < DECIDE_AT) return;
        // Вертикаль отдаём странице: это прокрутка списка либо закрытие
        // приложения свайпом вниз — оба жеста ломать нельзя.
        decided = Math.abs(moveX) > Math.abs(moveY) * RATIO ? "swipe" : "scroll";
        if (decided === "scroll") return;
        wrap.classList.add("swipe--dragging");
        body.setPointerCapture(e.pointerId);
      }

      // Тянем только влево и не дальше ширины кнопки
      dx = Math.max(-WIDTH, Math.min(0, moveX + (opened ? -WIDTH : 0)));
      setOffset(dx);
    });

    // После перетаскивания браузер присылает click — и он закрывал бы строку
    // сразу же, как только она открылась. Один такой клик гасим.
    let swallowClick = false;

    function finish(e) {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      if (decided !== "swipe") { decided = null; return; }
      decided = null;
      swallowClick = true;
      if (dx < -WIDTH * OPEN_AT) open();
      else close();
    }
    body.addEventListener("pointerup", finish);
    body.addEventListener("pointercancel", finish);

    // Клик по строке закрывает открытое действие — как в системных списках
    body.addEventListener("click", (e) => {
      if (swallowClick) {
        swallowClick = false;
        // жест не должен ещё и открывать карточку предмета под строкой
        e.stopPropagation();
        return;
      }
      if (opened) close();
    }, true);

    action.addEventListener("click", (e) => {
      e.stopPropagation();
      onAction({ close });
    });

    return wrap;
  }

  return { row, WIDTH };
})();
