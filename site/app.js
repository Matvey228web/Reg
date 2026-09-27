// Публичный каталог проката.
//
// Два уровня данных. Каталог — снимок catalog.json рядом с сайтом: открывается
// мгновенно и работает, даже когда бэкенд недоступен. Наличие на даты — живой
// запрос, и только когда даты выбраны: оно меняется каждый час, снимком его
// брать нельзя.
//
// Ни Telegram, ни фреймворков: страница должна открываться в любом браузере и
// на слабом телефоне.

(function () {
  "use strict";

  // Адрес бэкенда. Тот же, что у склада; наличие спрашиваем у /public/catalog,
  // он не требует входа и не отдаёт ничего, кроме количеств.
  var BACKEND = "https://script.google.com/macros/s/AKfycbyEGfWDeV8esYMCk6h-rkuroUNK28PVFNcc0lADlCRNBlRA8wfcCOvzxou6UVgmX4kn/exec";

  var catalog = { categories: [], models: [] };
  var free = null;        // ключ модели -> сколько свободно; null — не спрашивали
  var category = "all";
  var query = "";
  var pending = 0;        // номер последнего запроса: ответы могут прийти не по порядку

  var $ = function (id) { return document.getElementById(id); };

  function key(m) { return m.category + "|" + m.model_code; }

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

  // Имя файла фотографии собирается из тех же ключей, что и каталог: положили
  // photos/CAM-01.jpg — и карточка его показала. Ни базы, ни выгрузки.
  function photo(m) {
    return "photos/" + m.category + "-" + m.model_code + ".jpg";
  }

  function matches(m) {
    if (category !== "all" && m.category !== category) return false;
    if (!query) return true;
    return (m.model_name + " " + m.category_label).toLowerCase().indexOf(query) !== -1;
  }

  function freeText(m) {
    var total = Number(m.total) || 0;
    if (!free) {
      return '<span class="card-free">Всего ' + total + " " +
             plural(total, "штука", "штуки", "штук") + "</span>";
    }
    var n = free[key(m)];
    if (n === undefined) n = 0;
    var cls = n > 0 ? "card-free" : "card-free none";
    return '<span class="' + cls + '">Свободно <b>' + n + "</b> из " + total + "</span>";
  }

  function cardHtml(m) {
    return '<article class="card">' +
      '<div class="shot">' +
        '<img src="' + escapeHtml(photo(m)) + '" alt="" loading="lazy" decoding="async"' +
        ' onerror="this.remove()" />' +
        // Пока фотографии нет — нейтральный знак, а не повтор названия:
        // оно и так стоит прямо под плашкой.
        '<svg class="shot-ico" viewBox="0 0 24 24" aria-hidden="true">' +
          '<rect x="3" y="6" width="13" height="12" rx="2"/>' +
          '<path d="M16 10l5-3v10l-5-3z"/>' +
        "</svg>" +
      "</div>" +
      '<div class="card-body">' +
        '<div class="card-name">' + escapeHtml(m.model_name) + "</div>" +
        '<div class="card-cat">' + escapeHtml(m.category_label) + "</div>" +
        freeText(m) +
      "</div>" +
    "</article>";
  }

  function render() {
    var shown = catalog.models.filter(matches);
    $("grid").innerHTML = shown.map(cardHtml).join("");
    $("empty").hidden = shown.length > 0;
  }

  function renderChips() {
    var all = [{ code: "all", label: "Всё" }].concat(catalog.categories);
    $("chips").innerHTML = all.map(function (c) {
      return '<button class="chip' + (c.code === category ? " chip--on" : "") +
        '" type="button" data-cat="' + escapeHtml(c.code) + '">' +
        escapeHtml(c.label) + "</button>";
    }).join("");
  }

  function status(text) { $("status").textContent = text; }

  // Наличие. Один запрос на выбор дат, а не на каждую карточку.
  function loadAvailability() {
    var from = $("from").value;
    var to = $("to").value;
    if (!from && !to) return;
    var mine = ++pending;
    status("Считаем, что свободно…");

    fetch(BACKEND, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ endpoint: "/public/catalog", payload: { from: from || to, to: to || from } }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (mine !== pending) return;      // ответ на устаревший выбор дат
        if (!data || !data.ok) throw new Error((data && data.error) || "отказ");
        free = {};
        (data.data.models || []).forEach(function (m) {
          free[m.category + "|" + m.model_code] = m.free;
        });
        status(dateRangeText(data.data.from, data.data.to));
        render();
      })
      .catch(function () {
        if (mine !== pending) return;
        // Честно говорим, что количества неизвестны, вместо того чтобы
        // показать вчерашние: по ним человек поедет за техникой.
        free = null;
        status("Не удалось узнать, что свободно на эти даты. Каталог показан целиком.");
        render();
      });
  }

  function dateRangeText(from, to) {
    var f = human(from), t = human(to);
    return f === t ? "Свободно на " + f : "Свободно с " + f + " по " + t;
  }

  function human(iso) {
    var p = String(iso || "").split("-");
    return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : String(iso || "");
  }

  function bind() {
    $("chips").addEventListener("click", function (e) {
      var chip = e.target.closest("[data-cat]");
      if (!chip) return;
      category = chip.dataset.cat;
      renderChips();
      render();
    });

    $("search").addEventListener("input", function (e) {
      query = e.target.value.trim().toLowerCase();
      render();
    });

    // Полей дат два, и заполняют их подряд. Без паузы первый запрос уходит на
    // ещё не выбранный период и занимает бэкенд на 5–8 секунд впустую.
    var timer = null;
    ["from", "to"].forEach(function (id) {
      $(id).addEventListener("change", function () {
        // Перепутанные местами даты — обычная опечатка, а не повод отказывать.
        var from = $("from").value, to = $("to").value;
        if (from && to && to < from) { $("from").value = to; $("to").value = from; }
        clearTimeout(timer);
        timer = setTimeout(loadAvailability, 500);
      });
    });
  }

  fetch("catalog.json")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      catalog = data;
      renderChips();
      render();
      status(catalog.models.length + " " +
             plural(catalog.models.length, "позиция", "позиции", "позиций") +
             " в каталоге. Выберите даты, чтобы увидеть свободное.");
      bind();
    })
    .catch(function () {
      status("Каталог не загрузился. Обновите страницу.");
    });
})();
