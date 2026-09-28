// Витрина: разделы, решётка карточек, поиск, фильтр по категориям.

(function () {
  "use strict";

  var $ = Site.$, esc = Site.escapeHtml;
  var catalog = { categories: [], models: [] };
  var category = "all";
  var query = "";

  // Что стоит в ячейке под названием: кнопка, пока позиции в корзине нет, и
  // счётчик, когда есть. Число видно прямо на витрине — раньше узнать его
  // можно было только на странице позиции.
  // fresh — только что нажали «Добавить» на этой карточке: счётчик появляется
  // с наплывом заливки. При перерисовке всей решётки анимации быть не должно,
  // иначе восемьдесят карточек мигнут разом.
  function addHtml(k, fresh) {
    var n = Site.qtyOf(k);
    if (!n) return '<button type="button" class="add" data-act="add">Добавить</button>';
    return '<div class="stepper stepper--wide' + (fresh ? " is-new" : "") + '">' +
      '<button type="button" data-act="minus" aria-label="Меньше">−</button>' +
      '<span class="stepper-num">' + n + "</span>" +
      '<button type="button" data-act="plus" aria-label="Больше">+</button>' +
    "</div>";
  }

  // Перерисовываем одну ячейку, а не решётку: иначе на каждом нажатии теряется
  // место прокрутки.
  function paintAdd(k, fresh) {
    var box = document.querySelector('[data-add="' + k + '"]');
    if (box) box.innerHTML = addHtml(k, fresh);
  }

  // Заявку меняли не здесь: вернулись «назад» или правили в соседней вкладке.
  document.addEventListener("cart-refresh", function () {
    var boxes = document.querySelectorAll("[data-add]");
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].innerHTML = addHtml(boxes[i].dataset.add);
    }
  });

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
          var k = esc(Site.key(m));
          // Кнопки — рядом со ссылкой, а не внутри: кнопка внутри ссылки это
          // сломанная разметка и случайные переходы вместо нажатия.
          return '<div class="cell">' +
            '<a class="card" href="item.html?m=' + k + '">' +
              '<div class="shot">' +
                '<img src="' + esc(Site.photo(m)) + '" alt="" loading="lazy"' +
                ' decoding="async" onerror="this.remove()" />' + Site.shotIcon() +
              "</div>" +
              '<div class="card-body"><div class="card-name">' +
                esc(m.model_name) + "</div></div>" +
            "</a>" +
            '<div class="card-add" data-add="' + k + '">' + addHtml(k) + "</div>" +
          "</div>";
        }).join("") + "</div>";
    });

    $("groups").className = "";
    $("groups").innerHTML = html;
    $("empty").hidden = shown.length > 0;
    $("controls").hidden = false;
    $("status").textContent = "";
  }

  // Свои вещи студентов. Механики нет — и раздел не делает вида, что есть.
  function renderMy() {
    $("controls").hidden = true;
    $("status").textContent = "";
    $("empty").hidden = true;
    $("groups").className = "soonwrap";
    $("groups").innerHTML = '<p class="soon">soon…</p>';
  }

  // Короткий заход содержимого. Перезапуск честный: класс снимаем и ставим
  // заново, иначе при быстрых нажатиях анимация проигрывается только раз.
  function flashGroups() {
    var box = $("groups");
    box.classList.remove("swap");
    void box.offsetWidth;
    box.classList.add("swap");
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
      flashGroups();
    });

    $("catalog-list").addEventListener("click", function (e) {
      var item = e.target.closest("[data-cat]");
      if (!item) return;
      category = item.dataset.cat;
      $("catalog").open = false;
      renderCatalog();
      render();
      // Отклик на выбор: решётка не подменяется молча, а выезжает. Без этого
      // после нажатия непонятно, случилось ли что-нибудь вообще.
      flashGroups();
    });

    $("search").addEventListener("input", function (e) {
      query = e.target.value.trim().toLowerCase();
      render();
    });

    // Один слушатель на всю решётку: карточек под сотню, и вешать по три
    // обработчика на каждую незачем.
    $("groups").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-act]");
      if (!btn) return;
      var box = btn.closest("[data-add]");
      if (!box) return;
      var k = box.dataset.add;
      var act = btn.dataset.act;
      var was = Site.qtyOf(k);
      if (act === "minus") Site.addToCart(k, -1);
      else Site.addToCart(k, 1);

      // Уход заливки надо показать, а не проглотить: даём анимации отыграть и
      // только потом ставим на место кнопку.
      if (act === "minus" && was === 1) {
        var stepper = box.querySelector(".stepper--wide");
        if (stepper) {
          stepper.classList.remove("is-new");
          stepper.classList.add("is-off");
          setTimeout(function () { paintAdd(k, false); }, 260);
          return;
        }
      }
      paintAdd(k, act === "add");
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
