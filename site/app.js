// Витрина: разделы, решётка карточек, поиск, фильтр по категориям.

(function () {
  "use strict";

  var $ = Site.$, esc = Site.escapeHtml;
  var catalog = { categories: [], models: [] };
  var category = "all";
  var query = "";

  function render() {
    if (Site.section() === "my") return renderMy();

    var shown = catalog.models.filter(function (m) {
      if (!Site.inSection(m)) return false;
      if (category !== "all" && m.category !== category) return false;
      if (!query) return true;
      return (m.model_name + " " + m.category_label).toLowerCase().indexOf(query) !== -1;
    });

    var byCat = {};
    shown.forEach(function (m) { (byCat[m.category] = byCat[m.category] || []).push(m); });

    var html = "";
    catalog.categories.forEach(function (c) {
      var list = byCat[c.code];
      if (!list || !list.length) return;
      html += '<h2 class="group-title">' + esc(c.label) + "</h2>" +
        '<div class="grid">' + list.map(function (m) {
          return '<a class="card" href="item.html?m=' + esc(Site.key(m)) + '">' +
            '<div class="shot">' +
              '<img src="' + esc(Site.photo(m)) + '" alt="" loading="lazy"' +
              ' decoding="async" onerror="this.remove()" />' + Site.shotIcon() +
            "</div>" +
            '<div class="card-body"><div class="card-name">' +
              esc(m.model_name) + "</div></div></a>";
        }).join("") + "</div>";
    });

    $("groups").className = "";
    $("groups").innerHTML = html;
    $("empty").hidden = shown.length > 0;
    $("controls").hidden = false;
    $("status").textContent = shown.length + " " +
      Site.plural(shown.length, "позиция", "позиции", "позиций");
  }

  // Свои вещи студентов. Механики нет — и раздел не делает вида, что есть.
  function renderMy() {
    $("controls").hidden = true;
    $("status").textContent = "";
    $("empty").hidden = true;
    $("groups").className = "soonwrap";
    $("groups").innerHTML = '<p class="soon">soon…</p>';
  }

  function renderSections() {
    $("sections").innerHTML = Site.SECTIONS.map(function (s) {
      return '<a class="section' + (s.code === Site.section() ? " section--on" : "") +
        '" href="?s=' + s.code + '" data-section="' + s.code + '">' +
        esc(s.label) + "</a>";
    }).join("");
  }

  // Категории списком под «Каталогом», а не рядом кнопок: их полтора десятка,
  // и ряд пришлось бы прокручивать вбок, теряя половину из виду.
  // Пустые в этом разделе показываем приглушёнными — видно, что они есть.
  function renderCatalog() {
    var counts = {};
    catalog.models.forEach(function (m) {
      if (Site.inSection(m)) counts[m.category] = (counts[m.category] || 0) + 1;
    });
    var all = [{ code: "all", label: "Всё" }].concat(catalog.categories);

    $("catalog-list").innerHTML = all.map(function (c) {
      var n = c.code === "all" ? Object.keys(counts).length : (counts[c.code] || 0);
      var cls = "catalog-item" + (c.code === category ? " catalog-item--on" : "") +
        (n ? "" : " catalog-item--empty");
      return '<button class="' + cls + '" type="button" data-cat="' + esc(c.code) + '"' +
        (n ? "" : " disabled") + ">" + esc(c.label) + "</button>";
    }).join("");

    var chosen = all.filter(function (c) { return c.code === category; })[0];
    $("catalog-label").textContent =
      category === "all" ? "Каталог" : (chosen ? chosen.label : "Каталог");
  }

  function bind() {
    // Раздел живёт в адресе: ссылку можно переслать, а возврат из карточки не
    // сбрасывает выбор. Перезагружать страницу ради этого незачем.
    $("sections").addEventListener("click", function (e) {
      var link = e.target.closest("[data-section]");
      if (!link) return;
      e.preventDefault();
      Site.setSection(link.dataset.section);
      category = "all";
      renderSections();
      renderCatalog();
      render();
    });

    $("catalog-list").addEventListener("click", function (e) {
      var item = e.target.closest("[data-cat]");
      if (!item) return;
      category = item.dataset.cat;
      $("catalog").open = false;
      renderCatalog();
      render();
    });

    $("search").addEventListener("input", function (e) {
      query = e.target.value.trim().toLowerCase();
      render();
    });
  }

  Site.loadCatalog()
    .then(function (data) {
      catalog = data;
      renderSections();
      renderCatalog();
      render();
      bind();
    })
    .catch(function () {
      $("status").textContent = "Каталог не загрузился. Обновите страницу.";
    });
})();
