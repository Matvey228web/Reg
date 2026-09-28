// Общее для всех страниц: снимок каталога, корзина, помощники.
// Ни фреймворков, ни Telegram — сборки у сайта нет, отсюда глобальный объект.

var Site = (function () {
  "use strict";

  var BACKEND = "https://script.google.com/macros/s/AKfycbyEGfWDeV8esYMCk6h-rkuroUNK28PVFNcc0lADlCRNBlRA8wfcCOvzxou6UVgmX4kn/exec";
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
  // В браузере: сервера для черновиков нет. Приватный режим может запретить
  // запись — тогда сайт работает без памяти, а не падает.

  function readCart() {
    try {
      var raw = localStorage.getItem(CART_KEY);
      var data = raw ? JSON.parse(raw) : null;
      if (!data || typeof data !== "object") throw 0;
      if (!Array.isArray(data.lines)) data.lines = [];
      return data;
    } catch (e) {
      return { lines: [], from: "", to: "" };
    }
  }

  function writeCart(cart) {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) { /* без памяти */ }
    paintCount();
    return cart;
  }

  function cartCount() {
    return readCart().lines.reduce(function (sum, l) { return sum + l.qty; }, 0);
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
    loadCatalog: loadCatalog, availability: availability, sendOrder: sendOrder,
    readCart: readCart, cartCount: cartCount, addToCart: addToCart,
    setQty: setQty, removeFromCart: removeFromCart, cartDates: cartDates,
    paintCount: paintCount,
  };
})();

document.addEventListener("DOMContentLoaded", Site.paintCount);
