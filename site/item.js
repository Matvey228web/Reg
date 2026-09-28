// Страница позиции. Данные — из снимка, запросов нет. Наличие спрашиваем,
// только если даты уже выбраны на витрине.

(function () {
  "use strict";

  var $ = Site.$, esc = Site.escapeHtml;
  var model = null;

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
    return '<p class="item-note">В корзине уже ' + n + " " +
      Site.plural(n, "штука", "штуки", "штук") +
      '. <a href="cart.html">Открыть корзину</a></p>';
  }

  function render() {
    $("item").innerHTML =
      '<div class="item-shot">' +
        // Нет файла — нет и запроса: иначе на каждую позицию уходит 404.
        (Site.photo(model)
          ? '<img src="' + esc(Site.photo(model)) + '" alt="" decoding="async"' +
            ' onerror="this.remove()" />'
          : "") + Site.shotIcon() +
      "</div>" +
      '<div class="item-main">' +
        // Код позиции здесь не показываем: это складское обозначение, человеку
        // на витрине оно ничего не говорит. В адресе страницы он остаётся.
        '<p class="cap item-cat">' + esc(model.category_label) + "</p>" +
        "<h1>" + esc(model.model_name) + "</h1>" +
        '<div class="item-add">' +
          '<div class="stepper">' +
            '<button type="button" id="minus" aria-label="Меньше">−</button>' +
            '<input type="number" id="qty" value="1" min="1" inputmode="numeric" />' +
            '<button type="button" id="plus" aria-label="Больше">+</button>' +
          "</div>" +
          '<button class="btn" id="add">В корзину</button>' +
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
      qty.value = Number(qty.value) + 1;
    });

    var add = $("add");
    add.addEventListener("click", function () {
      Site.addToCart(Site.key(model), Math.max(1, Number(qty.value) || 1));
      add.textContent = "Добавлено";
      add.disabled = true;
      setTimeout(function () { add.textContent = "В корзину"; add.disabled = false; }, 1200);

      var note = document.querySelector(".item-note");
      if (note) note.outerHTML = noteHtml();
      else document.querySelector(".item-main").insertAdjacentHTML("beforeend", noteHtml());
    });
  }

  // Вернулись «назад» или правили в соседней вкладке — строка «в корзине уже N»
  // должна стать правдой.
  document.addEventListener("cart-refresh", function () {
    if (!model) return;
    var note = document.querySelector(".item-note");
    if (note) note.outerHTML = noteHtml();
    else {
      var main = document.querySelector(".item-main");
      if (main) main.insertAdjacentHTML("beforeend", noteHtml());
    }
  });

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
    })
    .catch(function () {
      $("item").innerHTML = '<p class="empty">Каталог не загрузился. Обновите страницу.</p>';
    });
})();
