// Витрина: решётка карточек, поиск, фильтр, наличие на даты.

(function () {
  "use strict";

  var $ = Site.$, esc = Site.escapeHtml;
  var catalog = { categories: [], models: [] };
  var free = null;
  var category = "all";
  var query = "";
  var pending = 0;   // ответы могут прийти не в том порядке, что запросы

  function freeText(m) {
    var total = Number(m.total) || 0;
    if (!free) {
      return '<span class="card-free cap">Всего ' + total + "</span>";
    }
    var n = free[Site.key(m)];
    if (n === undefined) n = 0;
    return '<span class="card-free cap' + (n > 0 ? "" : " none") +
           '">Свободно <b>' + n + "</b> из " + total + "</span>";
  }

  function cardHtml(m) {
    return '<a class="card" href="item.html?m=' + esc(Site.key(m)) + '">' +
      '<div class="shot">' +
        '<img src="' + esc(Site.photo(m)) + '" alt="" loading="lazy" decoding="async"' +
        ' onerror="this.remove()" />' + Site.shotIcon() +
      "</div>" +
      '<div class="card-body">' +
        '<div class="card-name">' + esc(m.model_name) + "</div>" +
        '<div class="cap">' + esc(m.category_label) + "</div>" +
        freeText(m) +
      "</div></a>";
  }

  function matches(m) {
    if (category !== "all" && m.category !== category) return false;
    if (!query) return true;
    return (m.model_name + " " + m.category_label).toLowerCase().indexOf(query) !== -1;
  }

  function render() {
    var shown = catalog.models.filter(matches);
    var byCat = {};
    shown.forEach(function (m) { (byCat[m.category] = byCat[m.category] || []).push(m); });

    var html = "";
    catalog.categories.forEach(function (c) {
      var list = byCat[c.code];
      if (!list || !list.length) return;
      html += '<h2 class="group-title">' + esc(c.label) +
        " <span>" + list.length + "</span></h2>" +
        '<div class="grid">' + list.map(cardHtml).join("") + "</div>";
    });

    $("groups").innerHTML = html;
    $("empty").hidden = shown.length > 0;
  }

  function renderChips() {
    var all = [{ code: "all", label: "Всё" }].concat(catalog.categories);
    $("chips").innerHTML = all.map(function (c) {
      return '<button class="chip' + (c.code === category ? " chip--on" : "") +
        '" type="button" data-cat="' + esc(c.code) + '">' + esc(c.label) + "</button>";
    }).join("");
  }

  function status(text) { $("status").textContent = text; }

  function loadAvailability() {
    var from = $("from").value, to = $("to").value;
    if (!from && !to) return;
    Site.cartDates(from, to);
    var mine = ++pending;
    status("Считаем, что свободно…");

    Site.availability(from, to)
      .then(function (res) {
        if (mine !== pending) return;
        free = res.free;
        status(res.from === res.to
          ? "Свободно на " + Site.humanDate(res.from)
          : "Свободно с " + Site.humanDate(res.from) + " по " + Site.humanDate(res.to));
        render();
      })
      .catch(function () {
        if (mine !== pending) return;
        // Вчерашние количества хуже никаких: по ним человек поедет за техникой.
        free = null;
        status("Не удалось узнать, что свободно на эти даты. Каталог показан целиком.");
        render();
      });
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

    // Полей дат два, заполняют их подряд: без паузы первый запрос уходит на
    // ещё не выбранный период и занимает бэкенд на 5–8 секунд впустую.
    var timer = null;
    ["from", "to"].forEach(function (id) {
      $(id).addEventListener("change", function () {
        var from = $("from").value, to = $("to").value;
        if (from && to && to < from) { $("from").value = to; $("to").value = from; }
        clearTimeout(timer);
        timer = setTimeout(loadAvailability, 500);
      });
    });
  }

  Site.loadCatalog()
    .then(function (data) {
      catalog = data;
      renderChips();
      render();
      status(catalog.models.length + " " +
             Site.plural(catalog.models.length, "позиция", "позиции", "позиций") +
             " в каталоге. Выберите даты, чтобы увидеть свободное.");
      bind();

      var saved = Site.cartDates();
      if (saved.from || saved.to) {
        $("from").value = saved.from;
        $("to").value = saved.to;
        loadAvailability();
      }
    })
    .catch(function () { status("Каталог не загрузился. Обновите страницу."); });
})();
