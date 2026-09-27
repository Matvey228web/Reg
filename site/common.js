// Общее для всех страниц сайта: снимок каталога, корзина, мелкие помощники.
//
// Ни фреймворков, ни Telegram. Глобальный объект вместо модулей — страницы
// подключают файл тегом script, и сборки у сайта нет.

var Site = (function () {
  "use strict";

  var BACKEND = "https://script.google.com/macros/s/AKfycbyEGfWDeV8esYMCk6h-rkuroUNK28PVFNcc0lADlCRNBlRA8wfcCOvzxou6UVgmX4kn/exec";
  var CART_KEY = "mifs_cart";

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

  function photo(m) { return "photos/" + key(m) + ".jpg"; }

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

  // Наличие на даты. Единственный живой запрос сайта, и только когда даты есть.
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

  // --- Корзина ---
  //
  // Хранится в браузере: сервера для черновиков у нас нет, а терять набранное
  // при переходе на карточку нельзя. Приватный режим может запретить запись —
  // тогда сайт просто работает без памяти, а не падает.

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

  // Больше, чем есть на складе, в заявку не кладём: иначе человек соберёт
  // невыполнимую заявку и узнает об этом только от складмена.
  function addToCart(modelKey, qty, limit) {
    var cart = readCart();
    var line = cart.lines.filter(function (l) { return l.key === modelKey; })[0];
    if (!line) { line = { key: modelKey, qty: 0 }; cart.lines.push(line); }
    var max = Number(limit) || 0;
    line.qty = max ? Math.min(max, line.qty + qty) : line.qty + qty;
    if (line.qty < 1) return removeFromCart(modelKey);
    writeCart(cart);
    return line.qty;
  }

  function setQty(modelKey, qty, limit) {
    var cart = readCart();
    var line = cart.lines.filter(function (l) { return l.key === modelKey; })[0];
    if (!line) return 0;
    var max = Number(limit) || 0;
    line.qty = Math.max(1, max ? Math.min(max, qty) : qty);
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

  // Счётчик в шапке. Рисуется на каждой странице, поэтому живёт здесь.
  function paintCount() {
    var el = $("cart-count");
    if (!el) return;
    var n = cartCount();
    el.textContent = n ? String(n) : "";
    el.hidden = !n;
  }

  return {
    $: $, escapeHtml: escapeHtml, plural: plural, key: key, photo: photo,
    humanDate: humanDate,
    loadCatalog: loadCatalog, availability: availability,
    readCart: readCart, cartCount: cartCount, addToCart: addToCart,
    setQty: setQty, removeFromCart: removeFromCart, cartDates: cartDates,
    paintCount: paintCount,
  };
})();

document.addEventListener("DOMContentLoaded", Site.paintCount);
