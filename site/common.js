// Общее для всех страниц: снимок каталога, корзина, помощники.
// Ни фреймворков, ни Telegram — сборки у сайта нет, отсюда глобальный объект.

var Site = (function () {
  "use strict";

  // Сайт обращается не к таблице напрямую, а к воркеру перед ней. Таблица
  // отвечает 3–14 секунд вразнобой и раз в несколько запросов отдаёт страницу
  // ошибки Google вместо ответа; воркер отвечает за доли секунды, наличие
  // держит в кэше, а заявку принимает сам и доносит до таблицы в фоне.
  //
  // Если воркер придётся выключить, сюда возвращается прежний адрес:
  // https://script.google.com/macros/s/AKfycbyEGfWDeV8esYMCk6h-rkuroUNK28PVFNcc0lADlCRNBlRA8wfcCOvzxou6UVgmX4kn/exec
  // Витрина от этого не зависит вовсе: каталог лежит снимком рядом со страницей.
  var BACKEND = "https://mifs-rent-api.odintsovmatvey08.workers.dev";
  // Чат склада с заявками (Telegram). Пусто — кнопка «Операторская» не показывается.
  var OPERATOR_URL = "https://t.me/mifs_rent_ecosystem_operator/1";
  var CART_KEY = "mifs_cart";
  // Данные заявки. Отдельно от корзины: корзину человек меняет весь день, а
  // ФИО с телефоном вводит один раз — и терять их при уходе в каталог нельзя.
  // Учёток пока нет, поэтому это единственная память о человеке, и живёт она
  // только в его телефоне: наружу ничего не уходит.
  var FORM_KEY = "mifs_form";

  var SECTIONS = [
    { code: "cine", label: "Кино", mark: "CINE" },
    { code: "photo", label: "Фото", mark: "PHOTO" },
    { code: "my", label: "My rent", mark: "" },
  ];

  // --- Мелочи ---

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function plural(n, one, few, many) {
    var abs = Math.abs(n) % 100, last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
  }

  function key(m) { return m.category + "-" + m.model_code; }

  // Раздел витрины. Держим в адресе: ссылку можно переслать, а возврат из
  // карточки не сбрасывает выбор.
  var current = null;

  function section() {
    if (current === null) {
      var m = /[?&]s=([a-z]+)/.exec(location.search);
      var asked = m ? m[1] : "";
      current = SECTIONS.some(function (s) { return s.code === asked; }) ? asked : "cine";
    }
    return current;
  }

  function setSection(code) {
    current = code;
    try {
      history.replaceState(null, "", code === "cine" ? location.pathname : "?s=" + code);
    } catch (e) { /* адрес не переписался — не беда */ }
  }

  // Неразмеченная модель видна в обоих разделах: забытая отметка не должна
  // прятать технику с витрины.
  function inSection(m) {
    var mark = SECTIONS.filter(function (s) { return s.code === section(); })[0];
    if (!mark || !mark.mark) return false;
    var value = String(m.section || "");
    return !value || value.indexOf(mark.mark) !== -1;
  }

  // Пусто, если фотографии нет. Список тех, что есть, лежит в снимке каталога
  // (собирает site/build-catalog.js по папке site/photos): просить у сервера
  // картинку «на всякий случай» — это 404 на каждую позицию.
  function photo(m) {
    var have = (catalog && catalog.photos) || [];
    var k = key(m);
    return have.indexOf(k) === -1 ? "" : "photos/" + k + ".jpg";
  }

  // --- Значки ---
  // Lucide (лицензия ISC, lucide.dev): контуры вставлены сюда, а не подгружаются,
  // чтобы значок не стоил ни запроса, ни шрифта. Цвет — currentColor, размер и
  // толщина линии задаются в style.css (.ico).
  var ICONS = {
    "shopping-cart": '<path d="m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18"/><path d="M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25"/><circle cx="18" cy="20" r="2"/><circle cx="8" cy="20" r="2"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    "copy": '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    "check": '<path d="M20 6 9 17l-5-5"/>',
    "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    "moon": '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
    "video": '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    "aperture": '<circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/>',
    "lightbulb": '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    "mic": '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
    "wrench": '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
    "package": '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>',
    "search": '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    "plus": '<path d="M5 12h14"/><path d="M12 5v14"/>',
    "minus": '<path d="M5 12h14"/>',
  };

  function icon(name, cls) {
    return '<svg class="ico' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true">' +
      (ICONS[name] || "") + "</svg>";
  }

  // Знак категории: пока своей фотографии у позиции нет, он стоит на фоне
  // картинки категории. Картинка приходит поверх и прячет знак — см. style.css.
  var CAT_ICON = {
    CAM: "video", LEN: "aperture", LGT: "lightbulb",
    AUD: "mic", GRP: "wrench", OTH: "package",
  };

  function shotIcon(m) {
    return icon(CAT_ICON[m && m.category] || "package", "shot-ico");
  }

  // Атрибут для .shot / .item-shot: у позиции без снимка за знаком стоит
  // приглушённая картинка её категории. Со своим снимком фон не нужен.
  function shotAttr(m) {
    return !photo(m) && CAT_ICON[m && m.category]
      ? ' data-cat="' + escapeHtml(m.category) + '"' : "";
  }

  // --- Бегущие цифры ---
  // Число сменилось — старое уезжает вверх и гаснет, новое въезжает снизу.
  // Целиком число, не по цифрам: так хватает одного приёма на всё. `old` —
  // что стояло раньше; страницы, которые перерисовываются целиком (корзина),
  // берут его из старой разметки и передают сюда. Нет старого значения — это
  // первая отрисовка, и анимации нет. Уменьшенное движение — просто подмена.
  // Работает и с <input> (счётчик в карточке и в корзине), и с обычным
  // элементом (число в шапке и на витрине): призрак старого числа лежит поверх
  // и ничего не двигает, стили — в style.css (.num-box, .num-ghost).
  function tick(el, value, old) {
    if (!el) return;
    value = String(value);
    var input = el.tagName === "INPUT";
    var target = el;
    if (!input) {
      target = el.querySelector(".num-v");
      if (!target) {
        // Число обёрнуто один раз; то, что стояло в элементе, сохраняется.
        var prev = el.textContent;
        el.innerHTML = '<span class="num-v"></span>';
        target = el.firstChild;
        target.textContent = prev;
      }
    }
    if (old === undefined) old = input ? el.value : target.textContent;
    if (input) el.value = value; else target.textContent = value;
    if (old === "" || old === null || String(old) === value) return;
    var calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (calm || !target.animate) return;

    var box = input ? el.parentNode : el;
    box.classList.add("num-box");
    // Быстрые нажатия: прежний призрак и незаконченное движение снимаем сразу,
    // иначе призраки копятся по одному на нажатие.
    var olds = box.querySelectorAll(".num-ghost");
    for (var i = 0; i < olds.length; i++) olds[i].remove();
    if (target.getAnimations) target.getAnimations().forEach(function (a) { a.cancel(); });
    var ghost = document.createElement("span");
    ghost.className = "num-ghost";
    ghost.textContent = old;
    box.appendChild(ghost);
    var opts = { duration: 220, easing: "cubic-bezier(.16,.84,.24,1)" };
    var out = ghost.animate([
      { transform: "translateY(0)", opacity: 1 },
      { transform: "translateY(-70%)", opacity: 0 },
    ], opts);
    out.onfinish = out.oncancel = function () { ghost.remove(); };
    target.animate([
      { transform: "translateY(70%)", opacity: 0 },
      { transform: "translateY(0)", opacity: 1 },
    ], opts);
  }

  function humanDate(iso) {
    var p = String(iso || "").split("-");
    return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : String(iso || "");
  }

  // --- Данные заявки ---

  var memForm = null;

  function formRead() {
    try {
      var raw = localStorage.getItem(FORM_KEY);
      var data = raw ? JSON.parse(raw) : null;
      if (!data || typeof data !== "object") throw 0;
      memForm = data;
      return data;
    } catch (e) {
      return memForm || {};
    }
  }

  function formWrite(data) {
    memForm = data || {};
    try { localStorage.setItem(FORM_KEY, JSON.stringify(memForm)); } catch (e) { /* приватный режим */ }
  }

  function formForget() {
    memForm = {};
    try { localStorage.removeItem(FORM_KEY); } catch (e) { /* и забывать нечем */ }
  }

  // --- Каталог ---

  var catalog = null;

  function loadCatalog() {
    if (catalog) return Promise.resolve(catalog);
    return fetch("catalog.json")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        catalog = data;
        catalog.byKey = {};
        (catalog.models || []).forEach(function (m) { catalog.byKey[key(m)] = m; });
        return catalog;
      });
  }

  // Единственный живой запрос сайта, и только когда даты выбраны.
  function availability(from, to) {
    return fetch(BACKEND, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        endpoint: "/public/catalog",
        payload: { from: from || to, to: to || from },
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || "отказ");
        var free = {};
        (data.data.models || []).forEach(function (m) {
          free[m.category + "-" + m.model_code] = m.free;
        });
        return { free: free, from: data.data.from, to: data.data.to };
      });
  }

  // Объявления склада с бэкенда. Таблица при промахе кэша отвечает до 30 секунд,
  // а блок объявлений стоит первой строкой и ждать его долго нельзя: через пять
  // секунд сдаёмся, и вызывающий берёт запасной файл.
  // Тумблер праздничных тем пришёл с объявлениями. Запоминаем его для theme.js
  // (тот решает до отрисовки и ответа ждать не может), а выключенную тему
  // снимаем сразу и с этой страницы: стили темы, атрибут, приветствие на
  // баннере и цвет строки браузера.
  function applySeasons(on) {
    try { localStorage.setItem("mifs_seasons", on ? "on" : "off"); } catch (e) { /* закрыто */ }
    if (on || !window.MifsSeason || /[?&]season=/.test(location.search)) return;
    var root = document.documentElement;
    root.removeAttribute("data-season");
    var links = document.querySelectorAll('link[href^="themes/"]');
    for (var i = 0; i < links.length; i++) links[i].parentNode.removeChild(links[i]);
    var hero = window.MifsHeroDefault;
    if (hero) {
      var h = document.querySelector(".hero h1"), p = document.querySelector(".hero p");
      if (h) h.textContent = hero.title;
      if (p) p.textContent = hero.sub;
    }
    var colors = window.MifsThemeColors;
    if (colors) colors.dark = "#0d0d0f";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && root.getAttribute("data-theme") !== "light") meta.setAttribute("content", "#0d0d0f");
    window.MifsSeason = null;
  }

  function announcements() {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 5000) : null;
    return fetch(BACKEND, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ endpoint: "/public/announcements", payload: {} }),
      signal: ctl ? ctl.signal : undefined,
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        if (!data || !data.ok || !data.data) throw new Error("не ответил");
        if (typeof data.data.seasons === "boolean") applySeasons(data.data.seasons);
        return data.data.items || [];
      }, function (err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
  }

  // Принимает ли склад заявки прямо с сайта. Спрашиваем один раз за страницу:
  // показывать кнопку, которая заведомо откажет, хуже, чем сразу предложить
  // скопировать текст.
  var openKnown = null;

  function ordersOpen() {
    if (openKnown !== null) return Promise.resolve(openKnown);
    return fetch(BACKEND, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ endpoint: "/public/catalog", payload: {} }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error("не ответил");
        openKnown = Number(data.data.orders_open) === 1;
        return openKnown;
      });
  }

  // Отправка заявки складу. Ответа ждём долго — таблица отвечает 5–20 секунд,
  // — поэтому вызывающий обязан показать, что идёт работа.
  //
  // Ручка может быть выключена на стороне склада: тогда приходит отказ, и
  // остаются копирование и письмо. Поэтому кнопка «Отправить» не заменяет их,
  // а стоит рядом.
  function sendOrder(text) {
    return fetch(BACKEND, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        endpoint: "/public/order",
        payload: { raw_text: text, trap: "", source_url: location.href },
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          var err = new Error((data && data.error) || "склад не ответил");
          err.status = data && data.status;
          throw err;
        }
        return data.data;
      });
  }

  // --- Корзина ---
  // Сервера для черновиков нет, поэтому заявка живёт в браузере. Приватный
  // режим и запрет хранилища возможны — тогда сайт работает в пределах одной
  // страницы и честно об этом говорит, а не притворяется, что сохранил.
  //
  // Кук здесь нет намеренно. Safari стирает script-writable хранилище после
  // семи дней без захода на сайт, и кука из JavaScript попадает под то же
  // правило — при этом она вмещает 4 КБ и едет с каждым запросом. Пережить это
  // может только кука от сервера, а сервера у статики нет. Подробности в
  // README.

  var memCart = null;      // копия в памяти: на ней страница работает всегда
  var stored = null;       // прижилась ли запись; null — ещё не проверяли

  function readCart() {
    // Корзина в памяти страницы — главный источник: её сбрасывает refreshCart
    // (соседняя вкладка, возврат «назад»). Разбирать JSON из хранилища на
    // каждом нажатии незачем.
    if (memCart) return memCart;
    try {
      var raw = localStorage.getItem(CART_KEY);
      var data = raw ? JSON.parse(raw) : null;
      if (!data || typeof data !== "object") throw 0;
      if (!Array.isArray(data.lines)) data.lines = [];
      memCart = data;
      return data;
    } catch (e) {
      // Хранилище не отдало ничего — работаем по памяти, если она есть.
      return memCart || { lines: [], from: "", to: "" };
    }
  }

  function writeCart(cart) {
    memCart = cart;
    var text = JSON.stringify(cart);
    try {
      localStorage.setItem(CART_KEY, text);
      // Записалось — не значит сохранилось: в приватном режиме запись молча
      // не доживает до чтения. Проверяем, пока не убедились; дальше хватает записи.
      if (stored !== true) stored = localStorage.getItem(CART_KEY) === text;
    } catch (e) {
      stored = false;
    }
    paintCount();
    return cart;
  }

  // Записывать ради проверки нечего, поэтому пробуем отдельным ключом: на
  // странице заявки к этому моменту может не быть ни одной записи, а сказать
  // правду о памяти нужно до того, как человек всё наберёт.
  function storageOk() {
    if (stored === null) {
      try {
        localStorage.setItem(CART_KEY + "_probe", "1");
        stored = localStorage.getItem(CART_KEY + "_probe") === "1";
        localStorage.removeItem(CART_KEY + "_probe");
      } catch (e) {
        stored = false;
      }
    }
    return stored;
  }

  function cartCount() {
    return readCart().lines.reduce(function (sum, l) { return sum + l.qty; }, 0);
  }

  function qtyOf(modelKey) {
    var line = readCart().lines.filter(function (l) { return l.key === modelKey; })[0];
    return line ? line.qty : 0;
  }

  // Потолка нет: сколько свободно — вопрос дат, а о брони предупреждает
  // заявка, когда даты выбраны.
  function addToCart(modelKey, qty) {
    var cart = readCart();
    var line = cart.lines.filter(function (l) { return l.key === modelKey; })[0];
    if (!line) { line = { key: modelKey, qty: 0 }; cart.lines.push(line); }
    line.qty += qty;
    if (line.qty < 1) return removeFromCart(modelKey);
    writeCart(cart);
    return line.qty;
  }

  function setQty(modelKey, qty) {
    var cart = readCart();
    var line = cart.lines.filter(function (l) { return l.key === modelKey; })[0];
    if (!line) return 0;
    line.qty = Math.max(1, qty);
    writeCart(cart);
    return line.qty;
  }

  function removeFromCart(modelKey) {
    var cart = readCart();
    cart.lines = cart.lines.filter(function (l) { return l.key !== modelKey; });
    writeCart(cart);
    return 0;
  }

  // Даты храним в виде 2026-01-01 — так их сравнивать, — а показываем и пишем
  // в заявку как 01-01-2026. Время просто строкой «10:00».
  function cartDates(from, to, fromTime, toTime) {
    if (from === undefined) {
      var c = readCart();
      return {
        from: c.from || "", to: c.to || "",
        fromTime: c.from_time || "", toTime: c.to_time || "",
      };
    }
    var cart = readCart();
    cart.from = from || "";
    cart.to = to || "";
    cart.from_time = fromTime || "";
    cart.to_time = toTime || "";
    writeCart(cart);
    return {
      from: cart.from, to: cart.to,
      fromTime: cart.from_time, toTime: cart.to_time,
    };
  }

  // Заявка изменилась не на этой странице: вернулись «назад» или правили в
  // соседней вкладке. Память сбрасываем — она устарела, — красим счётчик и
  // даём странице перерисовать своё.
  function refreshCart() {
    memCart = null;
    paintCount();
    document.dispatchEvent(new Event("cart-refresh"));
  }

  // Счётчик в шапке — на каждой странице, поэтому здесь.
  function paintCount() {
    var el = $("cart-count");
    if (!el) return;
    var n = cartCount();
    // Прежнее число берём из шапки: при первой отрисовке его нет — и движения нет.
    var cur = el.querySelector(".num-v");
    var old = el.hidden ? "" : (cur ? cur.textContent : el.textContent);
    el.hidden = !n;
    if (n) tick(el, n, old);
    else el.textContent = "";
  }

  return {
    $: $, escapeHtml: escapeHtml, plural: plural, key: key, photo: photo,
    humanDate: humanDate, icon: icon, shotIcon: shotIcon, shotAttr: shotAttr, tick: tick,
    SECTIONS: SECTIONS, section: section, setSection: setSection, inSection: inSection,
    loadCatalog: loadCatalog, availability: availability,
    OPERATOR_URL: OPERATOR_URL,
    sendOrder: sendOrder, ordersOpen: ordersOpen, announcements: announcements,
    readCart: readCart, cartCount: cartCount, addToCart: addToCart,
    qtyOf: qtyOf, storageOk: storageOk,
    setQty: setQty, removeFromCart: removeFromCart, cartDates: cartDates,
    paintCount: paintCount, refreshCart: refreshCart,
    formRead: formRead, formWrite: formWrite, formForget: formForget,
  };
})();

document.addEventListener("DOMContentLoaded", Site.paintCount);

// Категории в подвале. Снимок каталога уже нужен каждой странице, и повторного
// запроса здесь нет: loadCatalog помнит загруженное.
document.addEventListener("DOMContentLoaded", function () {
  var box = Site.$("foot-cats");
  if (!box) return;
  Site.loadCatalog().then(function (data) {
    box.innerHTML = (data.categories || []).map(function (c) {
      return '<li><a href="index.html?cat=' + Site.escapeHtml(c.code) + '">' +
        Site.escapeHtml(c.label) + "</a></li>";
    }).join("");
  }).catch(function () { /* нет снимка — подвал остаётся без списка */ });
});

// Объявления склада: первой строкой на каждой странице. Завхоз пишет их в чат,
// складмен вставляет в приложении, а сюда они приходят через воркер:
// /public/announcements, кэш пять минут, снятое исчезает сразу (запись сбрасывает
// кэш). Не ответил бэкенд — берём announcements.json рядом со страницей: это
// запасной список, и правится он руками. Ответил пустым списком — значит,
// объявлений нет, и запасной файл не нужен: иначе снятое объявление
// воскресало бы из файла.
// Срок (until, а в файле ещё from) проверяется здесь, в браузере: у посетителя
// свой часовой пояс. ?ann=all показывает всё без оглядки на даты — для проверки.
document.addEventListener("DOMContentLoaded", function () {
  var box = Site.$("notice");
  if (!box) return;
  var all = /[?&]ann=all\b/.test(location.search);
  var d = new Date();
  var today = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" +
    ("0" + d.getDate()).slice(-2);

  function paint(items) {
    var shown = (items || []).filter(function (a) {
      return all || ((!a.from || a.from <= today) && (!a.until || a.until >= today));
    });
    if (!shown.length) return;
    box.innerHTML = shown.map(function (a) {
      return '<details class="notice-item" open><summary><span class="notice-tag">Внимание</span>' +
        '<span class="notice-title">' + Site.escapeHtml(a.title) + "</span>" + Site.icon("chevron-down") + "</summary>" +
        '<div class="notice-body">' + (a.lines || []).map(function (line) {
          return "<p>" + Site.escapeHtml(line) + "</p>";
        }).join("") + "</div></details>";
    }).join("");
    box.hidden = false;
  }

  Site.announcements()
    .then(paint)
    .catch(function () {
      return fetch("announcements.json", { cache: "no-cache" })
        .then(function (res) { return res.json(); })
        .then(function (data) { paint(data.items); });
    })
    .catch(function () { /* нет ни ответа, ни файла — объявлений просто нет */ });
});

// Сезонное приветствие на баннере. Какой сезон идёт, решает theme.js (календарь
// лежит там); здесь только подмена текста. Подмена сразу, а не по
// DOMContentLoaded: скрипт стоит в конце страницы, баннер уже разобран, и
// обычная подпись не успевает мелькнуть.
(function () {
  var s = window.MifsSeason;
  if (!s || !s.hero) return;
  var h = document.querySelector(".hero h1");
  var p = document.querySelector(".hero p");
  // Обычная подпись — на случай, если тему выключат ответом бэкенда (applySeasons).
  window.MifsHeroDefault = { title: h ? h.textContent : "", sub: p ? p.textContent : "" };
  if (h) h.textContent = s.hero.title;
  if (p) p.textContent = s.hero.sub;
})();

// Переключатель светлой/тёмной темы — постоянный. Сама тема выставляется ещё до
// отрисовки скриптом theme.js в <head> (data-theme на <html>, выбор в
// localStorage `mifs_theme`); здесь только кнопка. Без кнопки тема работает.
document.addEventListener("DOMContentLoaded", function () {
  var btn = Site.$("theme-toggle");
  if (!btn) return;
  // Цвета строки браузера считает theme.js: у сезонной темы своя тёмная.
  var COLORS = window.MifsThemeColors || { light: "#f4f3f0", dark: "#0d0d0f" };

  function now() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  // Показываем то, во что нажатие переключит: в тёмной — солнце, в светлой — луна.
  function paint() {
    var light = now() === "light";
    btn.innerHTML = Site.icon(light ? "moon" : "sun");
    btn.setAttribute("aria-label", light ? "Включить тёмную тему" : "Включить светлую тему");
  }

  btn.addEventListener("click", function () {
    var next = now() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", COLORS[next]);
    try { localStorage.setItem("mifs_theme", next); } catch (e) { /* не сохранилось — до перезагрузки */ }
    paint();
  });
  paint();
});

// Возврат кнопкой «назад» страницу заново не выполняет: браузер достаёт её из
// своего кэша ровно такой, какой она была. Набранное в карточке на витрину при
// этом не попадает — счётчик остаётся нулём, а карточки пустыми.
//
// Второй случай — соседняя вкладка: телефон легко держит десяток, и заявка в
// них должна быть одна.
window.addEventListener("pageshow", Site.refreshCart);
window.addEventListener("storage", function (e) {
  if (!e.key || e.key === "mifs_cart") Site.refreshCart();
});
