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
  var CART_KEY = "mifs_cart";

  var SECTIONS = [
    { code: "cine", label: "Кино", mark: "CINE" },
    { code: "photo", label: "Фото", mark: "PHOTO" },
    { code: "my", label: "My mifs rent", mark: "" },
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

  function photo(m) { return "photos/" + key(m) + ".jpg"; }

  // Пока фотографии нет. Картинка приходит поверх и прячет знак — см. style.css.
  function shotIcon() {
    return '<svg class="shot-ico" viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="3" y="6" width="13" height="12"/>' +
      '<path d="M16 10l5-3v10l-5-3z"/></svg>';
  }

  function humanDate(iso) {
    var p = String(iso || "").split("-");
    return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : String(iso || "");
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
      // не доживает до чтения.
      stored = localStorage.getItem(CART_KEY) === text;
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

  function cartDates(from, to) {
    if (from === undefined) {
      var c = readCart();
      return { from: c.from || "", to: c.to || "" };
    }
    var cart = readCart();
    cart.from = from || "";
    cart.to = to || "";
    writeCart(cart);
    return { from: cart.from, to: cart.to };
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
    el.textContent = n ? String(n) : "";
    el.hidden = !n;
  }

  return {
    $: $, escapeHtml: escapeHtml, plural: plural, key: key, photo: photo,
    humanDate: humanDate, shotIcon: shotIcon,
    SECTIONS: SECTIONS, section: section, setSection: setSection, inSection: inSection,
    loadCatalog: loadCatalog, availability: availability,
    sendOrder: sendOrder, ordersOpen: ordersOpen,
    readCart: readCart, cartCount: cartCount, addToCart: addToCart,
    qtyOf: qtyOf, storageOk: storageOk,
    setQty: setQty, removeFromCart: removeFromCart, cartDates: cartDates,
    paintCount: paintCount, refreshCart: refreshCart,
  };
})();

document.addEventListener("DOMContentLoaded", Site.paintCount);

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
