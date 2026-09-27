// Страница позиции. Данные — из того же снимка, что и витрина: запросов нет.
// Наличие спрашиваем, только если даты уже выбраны на витрине.

(function () {
  "use strict";

  var $ = Site.$, esc = Site.escapeHtml;
  var model = null;
  var limit = 0;   // сколько максимум можно положить: свободно или всего

  function modelKey() {
    var m = /[?&]m=([^&]+)/.exec(location.search);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function render(freeQty) {
    var total = Number(model.total) || 0;
    limit = freeQty === undefined ? total : freeQty;
    var inCart = (Site.readCart().lines
      .filter(function (l) { return l.key === Site.key(model); })[0] || {}).qty || 0;

    var avail = freeQty === undefined
      ? "Всего на складе: " + total + " " + Site.plural(total, "штука", "штуки", "штук")
      : "Свободно <b>" + freeQty + "</b> из " + total + " на выбранные даты";

    $("item").innerHTML =
      '<div class="item-shot">' +
        '<img src="' + esc(Site.photo(model)) + '" alt="" decoding="async"' +
        ' onerror="this.remove()" />' +
        '<svg class="shot-ico" viewBox="0 0 24 24" aria-hidden="true">' +
          '<rect x="3" y="6" width="13" height="12" rx="2"/>' +
          '<path d="M16 10l5-3v10l-5-3z"/>' +
        "</svg>" +
      "</div>" +
      '<div class="item-main">' +
        "<h1>" + esc(model.model_name) + "</h1>" +
        '<p class="item-cat">' + esc(model.category_label) + "</p>" +
        '<p class="item-avail' + (limit > 0 ? "" : " none") + '">' + avail + "</p>" +
        '<div class="item-add">' +
          '<div class="stepper">' +
            '<button type="button" id="minus" aria-label="Меньше">−</button>' +
            '<input type="number" id="qty" value="1" min="1" max="' + Math.max(1, limit) +
              '" inputmode="numeric" />' +
            '<button type="button" id="plus" aria-label="Больше">+</button>' +
          "</div>" +
          '<button class="btn" id="add"' + (limit > 0 ? "" : " disabled") + ">" +
            (limit > 0 ? "В заявку" : "Нет свободных") + "</button>" +
        "</div>" +
        (inCart ? '<p class="item-note">В заявке уже ' + inCart + " " +
          Site.plural(inCart, "штука", "штуки", "штук") +
          '. <a href="cart.html">Открыть заявку</a></p>' : "") +
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
      var n = Math.max(1, Math.min(limit, Number(qty.value) || 1));
      Site.addToCart(Site.key(model), n, limit);
      add.textContent = "Добавлено";
      add.disabled = true;
      // Кнопка возвращается в строй: человек может передумать и добавить ещё.
      setTimeout(function () {
        add.textContent = "В заявку";
        add.disabled = false;
      }, 1200);
      var note = document.querySelector(".item-note");
      var inCart = (Site.readCart().lines
        .filter(function (l) { return l.key === Site.key(model); })[0] || {}).qty || 0;
      var text = "В заявке уже " + inCart + " " +
        Site.plural(inCart, "штука", "штуки", "штук") + ". ";
      if (note) {
        note.innerHTML = esc(text) + '<a href="cart.html">Открыть заявку</a>';
      } else {
        $("item").querySelector(".item-main").insertAdjacentHTML("beforeend",
          '<p class="item-note">' + esc(text) + '<a href="cart.html">Открыть заявку</a></p>');
      }
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
