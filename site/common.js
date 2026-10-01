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
  // Данные заявки. Отдельно от корзины: корзину человек меняет весь день, а
  // ФИО с телефоном вводит один раз — и терять их при уходе в каталог нельзя.
  // Учёток пока нет, поэтому это единственная память о человеке, и живёт она
  // только в его телефоне: наружу ничего не уходит.
  var FORM_KEY = "mifs_form";

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

  // Пусто, если фотографии нет. Список тех, что есть, лежит в снимке каталога
  // (собирает site/build-catalog.js по папке site/photos): просить у сервера
  // картинку «на всякий случай» — это 404 на каждую позицию.
  function photo(m) {
    var have = (catalog && catalog.photos) || [];
    var k = key(m);
    return have.indexOf(k) === -1 ? "" : "photos/" + k + ".jpg";
  }

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
    el.textContent = n ? String(n) : "";
    el.hidden = !n;
  }

  return {
    $: $, escapeHtml: escapeHtml, plural: plural, key: key, photo: photo,
    humanDate: humanDate, shotIcon: shotIcon,
    SECTIONS: SECTIONS, section: section, setSection: setSection, inSection: inSection,
    loadCatalog: loadCatalog, availability: availability,
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
        '<span class="notice-title">' + Site.escapeHtml(a.title) + "</span></summary>" +
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
