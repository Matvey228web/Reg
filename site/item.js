// Страница позиции. Данные — из снимка, запросов нет. Наличие спрашиваем,
// только если даты уже выбраны на витрине.

(function () {
  "use strict";

  var $ = Site.$, esc = Site.escapeHtml;
  var model = null;
  var limit = 0;

  function modelKey() {
    var m = /[?&]m=([^&]+)/.exec(location.search);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function inCart() {
    return (Site.readCart().lines
      .filter(function (l) { return l.key === Site.key(model); })[0] || {}).qty || 0;
  }

  function noteHtml() {
    var n = inCart();
    if (!n) return "";
    return '<p class="item-note">В заявке уже ' + n + " " +
      Site.plural(n, "штука", "штуки", "штук") +
      '. <a href="cart.html">Открыть заявку</a></p>';
  }

  function render(freeQty) {
    var total = Number(model.total) || 0;
    limit = freeQty === undefined ? total : freeQty;

    var avail = freeQty === undefined
      ? '<div class="spec"><span class="cap">Всего на складе</span><b>' + total + "</b></div>"
      : '<div class="spec' + (freeQty > 0 ? "" : " none") +
        '"><span class="cap">Свободно на выбранные даты</span><b>' +
        freeQty + " из " + total + "</b></div>";

    $("item").innerHTML =
      '<div class="item-shot">' +
        '<img src="' + esc(Site.photo(model)) + '" alt="" decoding="async"' +
        ' onerror="this.remove()" />' + Site.shotIcon() +
      "</div>" +
      '<div class="item-main">' +
        "<h1>" + esc(model.model_name) + "</h1>" +
        '<div class="specs">' +
          '<div class="spec"><span class="cap">Категория</span><b>' +
            esc(model.category_label) + "</b></div>" +
          avail +
          '<div class="spec"><span class="cap">Код позиции</span><b>' +
            esc(Site.key(model)) + "</b></div>" +
        "</div>" +
        '<div class="item-add">' +
          '<div class="stepper">' +
            '<button type="button" id="minus" aria-label="Меньше">−</button>' +
            '<input type="number" id="qty" value="1" min="1" max="' +
              Math.max(1, limit) + '" inputmode="numeric" />' +
            '<button type="button" id="plus" aria-label="Больше">+</button>' +
          "</div>" +
          '<button class="btn" id="add"' + (limit > 0 ? "" : " disabled") + ">" +
            (limit > 0 ? "В заявку" : "Нет свободных") + "</button>" +
        "</div>" + noteHtml() +
      "</div>";

    bind();
  }

  function bind() {
    var qty = $("qty");
    $("minus").addEventListener("click", function () {
      qty.value = Math.max(1, Number(qty.value) - 1);
    });
    $("plus").addEventListener("click", function () {
      qty.value = Math.min(Math.max(1, limit), Number(qty.value) + 1);
    });

    var add = $("add");
    if (!add || add.disabled) return;
    add.addEventListener("click", function () {
      Site.addToCart(Site.key(model),
                     Math.max(1, Math.min(limit, Number(qty.value) || 1)), limit);
      add.textContent = "Добавлено";
      add.disabled = true;
      setTimeout(function () { add.textContent = "В заявку"; add.disabled = false; }, 1200);

      var note = document.querySelector(".item-note");
      if (note) note.outerHTML = noteHtml();
      else document.querySelector(".item-main").insertAdjacentHTML("beforeend", noteHtml());
    });
  }

  Site.loadCatalog()
    .then(function (catalog) {
      model = catalog.byKey[modelKey()];
      if (!model) {
        $("item").innerHTML = '<p class="empty">Такой позиции в каталоге нет. ' +
          '<a href="index.html">Вернуться в каталог</a></p>';
        return;
      }
      document.title = model.model_name + " · MifsRent";
      render();

      var dates = Site.cartDates();
      if (dates.from || dates.to) {
        Site.availability(dates.from, dates.to)
          .then(function (res) {
            var n = res.free[Site.key(model)];
            render(n === undefined ? 0 : n);
          })
          .catch(function () { /* остаёмся на общем количестве */ });
      }
    })
    .catch(function () {
      $("item").innerHTML = '<p class="empty">Каталог не загрузился. Обновите страницу.</p>';
    });
})();
