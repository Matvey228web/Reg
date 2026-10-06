(function () {
  "use strict";

  var $ = Site.$, esc = Site.escapeHtml;
  var catalog = { categories: [], models: [] };
  // Категория живёт в адресе: ссылку из подвала можно открыть с любой
  // страницы, выбор переживает возврат «назад» и его можно переслать.
  var category = (new URLSearchParams(location.search)).get("cat") || "all";
  var query = "";

  // Меняем адрес, не перезагружая страницу: раздел уже так работает.
  function keepInUrl() {
    var q = new URLSearchParams(location.search);
    if (category === "all") q.delete("cat"); else q.set("cat", category);
    var tail = q.toString();
    history.replaceState(null, "", location.pathname + (tail ? "?" + tail : ""));
  }

  // Что стоит в ячейке под названием: кнопка, пока позиции в корзине нет, и
  // счётчик, когда есть. Число видно прямо на витрине — раньше узнать его
  // можно было только на странице позиции.
  // fresh — только что нажали «В корзину» на этой карточке: счётчик появляется
  // с наплывом заливки. При перерисовке всей решётки анимации быть не должно,
  // иначе восемьдесят карточек мигнут разом.
  function addHtml(k, fresh) {
    var n = Site.qtyOf(k);
    if (!n) return '<button type="button" class="add" data-act="add">В корзину</button>';
    return '<div class="stepper stepper--wide' + (fresh ? " is-new" : "") + '">' +
      '<button type="button" data-act="minus" aria-label="Меньше">' + Site.icon("minus") + "</button>" +
      '<span class="stepper-num">' + n + "</span>" +
      '<button type="button" data-act="plus" aria-label="Больше">' + Site.icon("plus") + "</button>" +
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

  // Картинку ставим только тогда, когда файл есть: пустой src браузер грузит
  // как саму страницу, а выдуманный — как 404 на каждую позицию. Нет файла —
  // остаётся знак «фотографии пока нет», он и так под картинкой.
  function photoTag(m, extra) {
    var src = Site.photo(m);
    if (!src) return "";
    return '<img src="' + esc(src) + '" alt=""' + (extra || "") +
      ' decoding="async" onerror="this.remove()" />';
  }

  // Карточка группы вариантов. Положить в корзину отсюда нечего — неизвестно,
  // какую длину, поэтому вместо «В корзину» переход к выбору. Без data-add:
  // перерисовка по cart-refresh поставила бы сюда счётчик одного варианта.
  function groupCell(m) {
    var list = Site.variants(m).filter(Site.inSection);
    var first = list[0] || m;
    var face = list.filter(function (v) { return Site.photo(v); })[0] || first;
    var href = "item.html?m=" + esc(Site.key(first));
    return '<div class="cell">' +
      '<a class="card" href="' + href + '">' +
        '<div class="shot"' + Site.shotAttr(face) + ">" +
          photoTag(face, ' loading="lazy"') + Site.shotIcon(face) +
        "</div>" +
        '<div class="card-body"><div class="card-name">' + esc(m.group) + "</div>" +
          '<div class="card-variants">' + list.length + " " +
            Site.plural(list.length, "вариант", "варианта", "вариантов") + "</div>" +
        "</div>" +
      "</a>" +
      '<div class="card-add"><a class="add" href="' + href + '">Выбрать</a></div>' +
    "</div>";
  }

  function render() {
    if (Site.section() === "my") return renderMy();

    var shown = catalog.models.filter(function (m) {
      if (!Site.inSection(m)) return false;
      if (category !== "all" && m.category !== category) return false;
      if (!query) return true;
      return (m.model_name + " " + m.category_label).toLowerCase().indexOf(query) !== -1;
    });

    // Варианты одной позиции («Кабель BNC · 3 м», «… · 10 м») — одна карточка:
    // длину выбирают на странице позиции. Поиск по-прежнему идёт по каждому
    // названию, поэтому карточку находит и группа, и любой её вариант.
    var byCat = {}, seen = {};
    shown.forEach(function (m) {
      if (m.group) {
        var g = m.category + "|" + m.group;
        if (seen[g]) return;
        seen[g] = true;
      }
      (byCat[m.category] = byCat[m.category] || []).push(m);
    });

    var html = "";
    catalog.categories.forEach(function (c) {
      var list = byCat[c.code];
      if (!list || !list.length) return;
      html += '<h2 class="group-title">' + esc(c.label) + "</h2>" +
        '<div class="grid">' + list.map(function (m) {
          if (m.group) return groupCell(m);
          var k = esc(Site.key(m));
          // Кнопки — рядом со ссылкой, а не внутри: кнопка внутри ссылки это
          // сломанная разметка и случайные переходы вместо нажатия.
          return '<div class="cell">' +
            '<a class="card" href="item.html?m=' + k + '">' +
              '<div class="shot"' + Site.shotAttr(m) + ">" +
                photoTag(m, ' loading="lazy"') + Site.shotIcon(m) +
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

  // Свои вещи студентов: каталог отдельный (my.json, перенесён с Tilda), склад
  // их не выдаёт — о цене и аренде договариваются с владельцем напрямую, поэтому
  // вместо корзины ссылка на его Telegram. Это единственное место сайта, где
  // Telegram разрешён: так решил владелец, иначе связаться не с кем.
  var my = null;

  function myOffer(o) {
    var bits = [];
    if (o.qty) bits.push(o.qty + " шт.");
    bits.push(o.price ? o.price + " ₽" : "цена по договорённости");
    return '<li><a href="https://t.me/' + encodeURIComponent(o.tg) +
      '" target="_blank" rel="noopener">@' + esc(o.tg) + "</a> · " + esc(bits.join(" · ")) +
      (o.note ? '<span class="my-note">' + esc(o.note) + "</span>" : "") + "</li>";
  }

  function renderMy() {
    $("controls").hidden = true;
    $("status").textContent = "";
    $("empty").hidden = true;
    if (!my) {
      fetch("my.json")
        .then(function (res) { return res.json(); })
        .then(function (data) { my = data; if (Site.section() === "my") renderMy(); })
        .catch(function () { $("status").textContent = "Раздел не загрузился. Обновите страницу."; });
      return;
    }
    // Открытие назначил владелец (15 октября, 12:00 по Москве). Файл к этому
    // времени уже выложен — прячем только витрину, это не защита данных.
    if (Date.now() < Date.parse(my.opens_at)) {
      $("groups").className = "soonwrap";
      $("groups").innerHTML = '<p class="soon">soon…</p>';
      return;
    }
    var html = "";
    my.categories.forEach(function (c) {
      var list = my.items.filter(function (m) { return m.category === c.code; });
      if (!list.length) return;
      html += '<h2 class="group-title">' + esc(c.label) + "</h2>" +
        '<div class="grid">' + list.map(function (m) {
          return '<div class="cell my-cell">' +
            '<div class="shot">' + (m.photo
              ? '<img src="photos/' + esc(m.key) + '.jpg" alt="" loading="lazy" decoding="async" onerror="this.remove()" />'
              : "") + Site.shotIcon(m) + "</div>" +
            '<div class="card-body"><div class="card-name">' + esc(m.name) + "</div>" +
              (m.mark ? '<div class="my-mark">' + esc(m.mark) + "</div>" : "") +
              (m.note ? '<p class="my-note">' + esc(m.note) + "</p>" : "") +
              '<ul class="my-offers">' + m.offers.map(myOffer).join("") + "</ul>" +
            "</div>" +
          "</div>";
        }).join("") + "</div>";
    });
    $("groups").className = "";
    $("groups").innerHTML = html;
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
    var counts = {}, seen = {};
    catalog.models.forEach(function (m) {
      if (!Site.inSection(m)) return;
      if (m.group) {
        if (seen[m.category + "|" + m.group]) return;
        seen[m.category + "|" + m.group] = true;
      }
      counts[m.category] = (counts[m.category] || 0) + 1;
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
      keepInUrl();
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
      keepInUrl();
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
      // Число меняется на месте и «прокатывается»: перерисовка ячейки заново
      // съела бы старое значение, а с ним и движение. Появление счётчика
      // (было ноль) — по-прежнему перерисовка с наплывом заливки.
      var num = box.querySelector(".stepper-num");
      if (num && was > 0) Site.tick(num, Site.qtyOf(k), was);
      else paintAdd(k, act === "add");
    });
  }

  // Живой каталог заменил снимок (переименование, раздел, фото). Поиск и
  // категория остаются, пропавшая категория сбрасывается на «Всё»; место
  // прокрутки возвращаем, анимации входа нет — мигать нечему.
  document.addEventListener("catalog-live", function () {
    if (category !== "all" && !catalog.categories.some(function (c) { return c.code === category; })) {
      category = "all";
      keepInUrl();
    }
    var y = window.scrollY;
    renderCatalog();
    render();
    window.scrollTo(0, y);
  });

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
