// Витрина: решётка карточек, поиск, фильтр, наличие на даты.

(function () {
  "use strict";

  var $ = Site.$, esc = Site.escapeHtml;
  var catalog = { categories: [], models: [] };
  var category = "all";
  var query = "";

  function freeText(m) {
    return '<span class="card-free cap">Всего ' + (Number(m.total) || 0) + "</span>";
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

  }

  Site.loadCatalog()
    .then(function (data) {
      catalog = data;
      renderChips();
      render();
      status(catalog.models.length + " " +
             Site.plural(catalog.models.length, "позиция", "позиции", "позиций") +
             " в каталоге");
      bind();
    })
    .catch(function () { status("Каталог не загрузился. Обновите страницу."); });
})();
