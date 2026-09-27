// Заявка: состав, даты, данные студента и текст для склада.
//
// Сайт не пишет в таблицу, а собирает текст, который бэкенд разбирает с
// первого дня (parseOrderMessage в apps-script/Code.gs). Почему так — в
// site/README.md.

(function () {
  "use strict";

  var $ = Site.$, esc = Site.escapeHtml;
  var catalog = null;
  var free = null;

  function lines() {
    return Site.readCart().lines
      .map(function (l) {
        var m = catalog.byKey[l.key];
        return m ? { key: l.key, qty: l.qty, model: m } : null;
      })
      .filter(Boolean);
  }

  function limitFor(key, model) {
    if (free && free[key] !== undefined) return free[key];
    return Number(model.total) || 0;
  }

  function render() {
    var list = lines();
    var dates = Site.cartDates();

    if (!list.length) {
      $("cart").innerHTML = '<p class="empty">Заявка пуста. ' +
        '<a href="index.html">Выбрать оборудование</a></p>';
      return;
    }

    $("cart").innerHTML =
      '<div class="block">' + list.map(function (l) {
        var limit = limitFor(l.key, l.model);
        return '<div class="cart-line" data-key="' + esc(l.key) + '">' +
          '<a class="cart-name" href="item.html?m=' + esc(l.key) + '">' +
            esc(l.model.model_name) + "</a>" +
          '<span class="cap">' + esc(l.model.category_label) + "</span>" +
          '<div class="stepper">' +
            '<button type="button" data-act="minus" aria-label="Меньше">−</button>' +
            '<input type="number" class="cart-qty" value="' + l.qty +
              '" min="1" max="' + Math.max(1, limit) + '" inputmode="numeric" />' +
            '<button type="button" data-act="plus" aria-label="Больше">+</button>' +
          "</div>" +
          '<button class="link-danger" type="button" data-act="drop">Убрать</button>' +
          (l.qty > limit
            ? '<p class="cart-warn">На складе всего ' + limit + "</p>" : "") +
        "</div>";
      }).join("") + "</div>" +

      '<div class="block">' +
        "<h2>Когда нужно</h2>" +
        '<div class="dates">' +
          '<label class="date"><span class="cap">Выдача</span>' +
            '<input type="date" id="from" value="' + esc(dates.from) + '" /></label>' +
          '<label class="date"><span class="cap">Возврат</span>' +
            '<input type="date" id="to" value="' + esc(dates.to) + '" /></label>' +
        "</div>" +
      "</div>" +

      '<div class="block">' +
        "<h2>Кто берёт</h2>" +
        '<label class="row"><span>Мне есть 18 лет</span>' +
          '<input type="checkbox" id="adult" /></label>' +
        '<label class="field"><span class="cap">ФИО</span>' +
          '<input type="text" id="name" autocomplete="name" /></label>' +
        '<label class="field"><span class="cap">Телефон</span>' +
          '<input type="tel" id="phone" inputmode="tel" placeholder="+7…" /></label>' +
        '<label class="field"><span class="cap">Ник в Telegram</span>' +
          '<input type="text" id="tg" placeholder="@nick" autocapitalize="off" /></label>' +
        '<div id="guardian">' +
          '<h2>Представитель</h2>' +
          '<label class="field"><span class="cap">ФИО представителя</span>' +
            '<input type="text" id="gname" /></label>' +
          '<label class="field"><span class="cap">Телефон представителя</span>' +
            '<input type="tel" id="gphone" inputmode="tel" placeholder="+7…" /></label>' +
        "</div>" +
        '<label class="field"><span class="cap">Проект</span>' +
          '<input type="text" id="project" placeholder="курсовая, короткий метр…" /></label>' +
      "</div>" +

      '<div class="block">' +
        "<h2>Отправить складу</h2>" +
        '<p class="hint">Скопируйте заявку и отправьте её складу любым способом.' +
        " Складмен вставит её в систему — заполнять ничего заново не придётся.</p>" +
        '<div class="btn-row">' +
          '<button class="btn" id="copy">Скопировать заявку</button>' +
          '<a class="btn btn--secondary" id="mail" href="#">Письмом</a>' +
        "</div>" +
        '<p class="hint" id="copied" hidden>Заявка скопирована.</p>' +
        "<pre id=\"preview\" class=\"preview\"></pre>" +
      "</div>";

    bind();
    updateGuardian();
    updatePreview();
  }

  // Нули в ценах не заглушка: в настоящих сообщениях бота они ровно такие.
  function orderText() {
    var list = lines();
    var out = [];
    // Именно «Заказ»: это слово ищет разбор. На сайте мы говорим «заявка»,
    // но строка едет складу и должна быть на его языке.
    out.push("Заказ №" + requestCode());
    list.forEach(function (l, i) {
      out.push((i + 1) + ". " + l.model.model_name + ": 0 (" + l.qty + " x 0)");
    });
    out.push("");
    out.push("Информация о покупателе:");

    var adult = $("adult").checked;
    out.push("Are_you_an_adult: " + (adult ? "Да" : "Нет"));
    out.push("Full_name_minor: " + val("name"));
    out.push("Phone_minors: " + val("phone"));
    out.push("Telegram_Minors: " + val("tg"));
    if (!adult) {
      out.push("Full_name_guardian: " + val("gname"));
      out.push("Phone_guardian: " + val("gphone"));
    }
    out.push("Type_and_name_of_the_project: " + val("project"));
    out.push("Date_of_issue: " + Site.humanDate($("from").value));
    out.push("Date_completion: " + Site.humanDate($("to").value));
    return out.join("\n");
  }

  function val(id) { return ($(id) && $(id).value || "").trim(); }

  // Дата плюс случайный хвост: без сервера уникальность не гарантировать.
  var code = null;
  function requestCode() {
    if (code) return code;
    var d = new Date();
    var stamp = String(d.getFullYear()).slice(2) +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0");
    code = stamp + "-" + String(Math.floor(Math.random() * 9000) + 1000);
    return code;
  }

  function updatePreview() {
    var text = orderText();
    $("preview").textContent = text;
    $("mail").href = "mailto:?subject=" +
      encodeURIComponent("Заявка на оборудование №" + requestCode()) +
      "&body=" + encodeURIComponent(text);
  }

  function updateGuardian() {
    $("guardian").hidden = $("adult").checked;
    updatePreview();
  }

  function bind() {
    $("cart").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-act]");
      if (!btn) return;
      var row = btn.closest(".cart-line");
      var key = row.dataset.key;
      var input = row.querySelector(".cart-qty");
      var limit = Number(input.max) || 0;
      if (btn.dataset.act === "drop") { Site.removeFromCart(key); render(); return; }
      var next = Number(input.value) + (btn.dataset.act === "plus" ? 1 : -1);
      if (next < 1) { Site.removeFromCart(key); render(); return; }
      input.value = Site.setQty(key, next, limit);
      updatePreview();
    });

    $("cart").addEventListener("change", function (e) {
      if (e.target.classList.contains("cart-qty")) {
        var row = e.target.closest(".cart-line");
        e.target.value = Site.setQty(row.dataset.key, Number(e.target.value),
                                     Number(e.target.max) || 0);
      }
      if (e.target.id === "adult") updateGuardian();
      if (e.target.id === "from" || e.target.id === "to") {
        var from = $("from").value, to = $("to").value;
        if (from && to && to < from) { $("from").value = to; $("to").value = from; }
        Site.cartDates($("from").value, $("to").value);
        loadFree();
      }
      updatePreview();
    });

    $("cart").addEventListener("input", function (e) {
      if (e.target.tagName === "INPUT" && e.target.type !== "date") updatePreview();
    });

    $("copy").addEventListener("click", function () {
      var text = orderText();
      var done = function () {
        $("copied").hidden = false;
        setTimeout(function () { $("copied").hidden = true; }, 2500);
      };
      // Буфер доступен не везде: без https и без жеста браузер откажет.
      // Тогда выделяем текст — скопировать его человек сможет сам.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, selectPreview);
      } else {
        selectPreview();
      }
    });
  }

  function selectPreview() {
    var pre = $("preview");
    var range = document.createRange();
    range.selectNodeContents(pre);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    $("copied").textContent = "Текст выделен — скопируйте его вручную.";
    $("copied").hidden = false;
  }

  function loadFree() {
    var dates = Site.cartDates();
    if (!dates.from && !dates.to) return;
    Site.availability(dates.from, dates.to)
      .then(function (res) { free = res.free; render(); })
      .catch(function () { /* остаёмся на общих количествах */ });
  }

  Site.loadCatalog()
    .then(function (data) {
      catalog = data;
      render();
      loadFree();
    })
    .catch(function () {
      $("cart").innerHTML = '<p class="empty">Каталог не загрузился. Обновите страницу.</p>';
    });
})();
