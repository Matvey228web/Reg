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

  // Предупреждение о брони — только когда выбраны даты: без них «свободно»
  // не определено, а пугать человека числом со склада незачем.
  function warnHtml(l) {
    if (!free) return "";
    var n = free[l.key];
    if (n === undefined) n = 0;
    if (l.qty <= n) return "";
    return '<p class="cart-warn">' + (n
      ? "На эти даты свободно только " + n + " из " + l.qty + " — остальное забронировано."
      : "На эти даты всё забронировано. Выберите другие или уберите позицию.") + "</p>";
  }

  // Браузер запретил запись — заявка не переживёт переход между страницами.
  function storageWarnHtml() {
    return '<p class="hint hint--bad" id="nostore">Браузер не сохраняет заявку —' +
      " похоже, приватный режим. Соберите и отправьте её за один заход.</p>";
  }

  function render() {
    var list = lines();
    var dates = Site.cartDates();
    var keep = snapshot();

    if (!list.length) {
      // Пустая заявка после набранного на витрине — это не «ничего не выбрал»,
      // а запрет хранилища. Молчать об этом хуже всего: человек уверен, что
      // выбирал, и не понимает, куда всё делось.
      $("cart").innerHTML = '<p class="empty">Заявка пуста. ' +
        '<a href="index.html">Выбрать оборудование</a></p>' +
        (Site.storageOk() ? "" : storageWarnHtml());
      return;
    }

    $("cart").innerHTML =
      '<div class="block">' + list.map(function (l) {
        return '<div class="cart-line" data-key="' + esc(l.key) + '">' +
          '<a class="cart-name" href="item.html?m=' + esc(l.key) + '">' +
            esc(l.model.model_name) + "</a>" +
          '<span class="cap">' + esc(l.model.category_label) + "</span>" +
          '<div class="stepper">' +
            '<button type="button" data-act="minus" aria-label="Меньше">−</button>' +
            '<input type="number" class="cart-qty" value="' + l.qty +
              '" min="1" inputmode="numeric" />' +
            '<button type="button" data-act="plus" aria-label="Больше">+</button>' +
          "</div>" +
          '<button class="link-danger" type="button" data-act="drop">Убрать</button>' +
          warnHtml(l) +
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
        '<label class="field"><span class="cap">Мастерская или курс</span>' +
          '<input type="text" id="workshop" placeholder="оператор, режиссура, звук…" /></label>' +
        '<label class="field"><span class="cap">Комментарий</span>' +
          '<textarea id="note" rows="3" ' +
            'placeholder="пожелания, во сколько удобно забрать"></textarea></label>' +
      "</div>" +

      '<div class="block">' +
        "<h2>Отправить складу</h2>" +
        // Поле-ловушка: человек его не видит и не заполнит.
        '<input type="text" id="trap" tabindex="-1" autocomplete="off"' +
          ' aria-hidden="true" class="trap" />' +
        '<div class="btn-row">' +
          '<button class="btn" id="send">Отправить складу</button>' +
          '<button class="btn btn--secondary" id="copy">Скопировать</button>' +
          '<a class="btn btn--secondary" id="mail" href="#">Письмом</a>' +
        "</div>" +
        '<p class="hint" id="sendnote">Ответ идёт до 20 секунд — столько думает' +
        " склад. Не получилось — скопируйте заявку и отправьте любым способом.</p>" +
        (Site.storageOk() ? "" : storageWarnHtml()) +
        '<p class="hint" id="copied" hidden>Заявка скопирована.</p>' +
        "<pre id=\"preview\" class=\"preview\"></pre>" +
      "</div>";

    bind();
    restore(keep);
    updateGuardian();
    updatePreview();
  }

  // Список перерисовывается целиком при каждом изменении количества, а форма
  // живёт в том же блоке: без этого набранный текст пропадал от нажатия «+».
  var TEXT_FIELDS = ["name", "phone", "tg", "gname", "gphone", "project",
                     "workshop", "note"];

  function snapshot() {
    if (!$("adult")) return null;
    var kept = { adult: $("adult").checked };
    TEXT_FIELDS.forEach(function (id) {
      kept[id] = $(id) ? $(id).value : "";
    });
    return kept;
  }

  function restore(kept) {
    if (!kept) return;
    $("adult").checked = kept.adult;
    TEXT_FIELDS.forEach(function (id) {
      if ($(id)) $(id).value = kept[id];
    });
  }

  // Нули в ценах не заглушка: в настоящих сообщениях бота они ровно такие.
  function orderText() {
    var list = lines();
    var out = [];
    // Именно «Заказ»: это слово ищет разбор. На сайте мы говорим «заявка»,
    // но строка едет складу и должна быть на его языке.
    out.push("Заказ №" + requestCode());
    list.forEach(function (l, i) {
      // Перенос внутри названия разорвал бы строку, и разбор потерял бы позицию.
      var name = String(l.model.model_name).replace(/\s+/g, " ").trim();
      out.push((i + 1) + ". " + name + ": 0 (" + l.qty + " x 0)");
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
    var extra = extraInput();
    if (extra) out.push("Input: " + extra);
    out.push("Date_of_issue: " + Site.humanDate($("from").value));
    out.push("Date_completion: " + Site.humanDate($("to").value));
    return out.join("\n");
  }

  function val(id) { return ($(id) && $(id).value || "").trim(); }

  // Мастерская и комментарий едут одной строкой «Input»: в таблице под них
  // одна колонка (extra_input), и так же называлось поле в форме на Tilda —
  // старые сообщения бота и новые заявки лягут в одно место.
  //
  // Пробелы схлопываем: перенос строки внутри комментария разорвал бы строку,
  // и разбор потерял бы поле. На названиях моделей мы на это уже наступали.
  function extraInput() {
    var parts = [];
    var workshop = flat(val("workshop"));
    var note = flat(val("note"));
    if (workshop) parts.push("Мастерская: " + workshop);
    if (note) parts.push("Комментарий: " + note);
    return parts.join(". ");
  }

  function flat(s) { return String(s).replace(/\s+/g, " ").trim(); }

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
      if (btn.dataset.act === "drop") { Site.removeFromCart(key); render(); return; }
      var next = Number(input.value) + (btn.dataset.act === "plus" ? 1 : -1);
      if (next < 1) { Site.removeFromCart(key); render(); return; }
      Site.setQty(key, next);
      render();
    });

    $("cart").addEventListener("change", function (e) {
      if (e.target.classList.contains("cart-qty")) {
        var row = e.target.closest(".cart-line");
        e.target.value = Site.setQty(row.dataset.key, Number(e.target.value));
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
      var tag = e.target.tagName;
      if ((tag === "INPUT" && e.target.type !== "date") || tag === "TEXTAREA") {
        updatePreview();
      }
    });

    $("send").addEventListener("click", send);

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

  // Отправка. Обязательное проверяем здесь же: отказ после двадцати секунд
  // ожидания — худший способ узнать, что не введён телефон.
  function send() {
    var note = $("sendnote");
    if (!val("name") || !val("phone")) {
      note.textContent = "Заполните ФИО и телефон — без них склад не поймёт, кому выдавать.";
      note.classList.add("hint--bad");
      ($("name").value ? $("phone") : $("name")).focus();
      return;
    }
    if (($("trap") && $("trap").value).trim()) return;

    var btn = $("send");
    btn.disabled = true;
    btn.textContent = "Отправляем…";
    note.classList.remove("hint--bad");
    note.textContent = "Идёт отправка. Это до 20 секунд, не закрывайте страницу.";

    Site.sendOrder(orderText())
      .then(function (res) {
        btn.textContent = "Заявка отправлена";
        note.textContent = res.repeat
          ? "Эта заявка уже была принята, номер " + res.order_no + ". Второй раз не завели."
          : "Склад принял заявку, номер " + res.order_no + ". Ждите ответа.";
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Отправить складу";
        note.classList.add("hint--bad");
        note.textContent = "Отправить не вышло: " + (err.message || "склад не ответил") +
          ". Скопируйте заявку и отправьте её складу любым способом.";
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

  // Вернулись «назад» или правили в соседней вкладке.
  document.addEventListener("cart-refresh", function () {
    if (catalog) render();
  });

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
