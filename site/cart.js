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

  // Два листа — общепринятый знак «скопировать», его узнают без подписи.
  function copyIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="9" y="9" width="11" height="11" rx="1"/>' +
      '<path d="M15 5H5a1 1 0 0 0-1 1v10"/></svg>';
  }

  function doneIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 12l5 5L20 6"/></svg>';
  }

  // Телефон. «+7» подставляется само, как только набрали цифру: набирать код
  // руками незачем, а без него разбор на складе не поймёт номер.
  //
  // Чужой код с «+» не ломаем: если начали не с семёрки, оставляем как есть —
  // приезжают и не из России.
  function maskPhone(raw) {
    var value = String(raw || "");
    var foreign = /^\+(?!7)/.test(value.trim());
    var digits = value.replace(/\D/g, "");
    if (foreign) return "+" + digits;
    if (!digits) return "";
    if (digits[0] === "8" || digits[0] === "7") digits = digits.slice(1);
    digits = digits.slice(0, 10);
    var out = "+7";
    if (digits.length) out += " " + digits.slice(0, 3);
    if (digits.length > 3) out += " " + digits.slice(3, 6);
    if (digits.length > 6) out += " " + digits.slice(6, 8);
    if (digits.length > 8) out += " " + digits.slice(8, 10);
    return out;
  }

  // Ник: «@» подставляется само и не удваивается.
  function maskTg(raw) {
    var value = String(raw || "").replace(/@/g, "").trim();
    return value ? "@" + value : "";
  }

  // Курсор держим в конце: маска переписывает строку целиком, и без этого он
  // прыгал бы в начало на каждом знаке.
  function applyMask(input, fn) {
    var atEnd = input.selectionStart === input.value.length;
    var next = fn(input.value);
    if (next === input.value) return;
    input.value = next;
    if (atEnd) { try { input.setSelectionRange(next.length, next.length); } catch (e) { /* не всем полям можно */ } }
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
          '<input type="tel" id="phone" inputmode="tel" /></label>' +
        '<label class="field"><span class="cap">Ник в Telegram</span>' +
          '<input type="text" id="tg" autocapitalize="off" autocorrect="off"' +
            ' spellcheck="false" /></label>' +
        '<div id="guardian">' +
          '<h2>Представитель</h2>' +
          '<label class="field"><span class="cap">ФИО представителя</span>' +
            '<input type="text" id="gname" /></label>' +
          '<label class="field"><span class="cap">Телефон представителя</span>' +
            '<input type="tel" id="gphone" inputmode="tel" /></label>' +
        "</div>" +
        '<label class="field"><span class="cap">Проект</span>' +
          '<input type="text" id="project" placeholder="курсовая, короткий метр…" /></label>' +
        '<label class="field"><span class="cap">Мастерская и курс</span>' +
          '<input type="text" id="workshop" /></label>' +
        '<label class="field"><span class="cap">Комментарий</span>' +
          '<textarea id="note" rows="3"></textarea></label>' +
      "</div>" +

      '<div class="block">' +
        // Поле-ловушка: человек его не видит и не заполнит.
        '<input type="text" id="trap" tabindex="-1" autocomplete="off"' +
          ' aria-hidden="true" class="trap" />' +
        '<button class="btn btn--wide" id="send">Забронировать</button>' +
        '<p class="hint" id="sendnote" hidden></p>' +
        (Site.storageOk() ? "" : storageWarnHtml()) +
        '<div class="preview-box">' +
          '<pre id="preview" class="preview"></pre>' +
          '<button type="button" class="copy-btn" id="copy"' +
            ' aria-label="Скопировать заявку">' + copyIcon() + "</button>" +
        "</div>" +
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
    $("preview").textContent = orderText();
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
      if (e.target.id === "phone" || e.target.id === "gphone") {
        applyMask(e.target, maskPhone);
      }
      if (e.target.id === "tg") applyMask(e.target, maskTg);
      if ((tag === "INPUT" && e.target.type !== "date") || tag === "TEXTAREA") {
        updatePreview();
      }
    });

    $("send").addEventListener("click", send);

    $("copy").addEventListener("click", function () {
      var btn = $("copy");
      var done = function () {
        btn.innerHTML = doneIcon();
        btn.classList.add("copy-btn--done");
        setTimeout(function () {
          btn.innerHTML = copyIcon();
          btn.classList.remove("copy-btn--done");
        }, 2000);
      };
      // Буфер доступен не везде: без https и без жеста браузер откажет.
      // Тогда выделяем текст — скопировать его человек сможет сам.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(orderText()).then(done, selectPreview);
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
    btn.textContent = "Бронируем…";
    note.classList.remove("hint--bad");
    note.hidden = true;

    Site.sendOrder(orderText())
      .then(function (res) {
        btn.textContent = "Забронировано";
        note.hidden = false;
        note.textContent = res.repeat
          ? "Эта заявка уже принята, номер " + res.order_no + "."
          : "Заявка №" + res.order_no + " у склада. Ответ придёт вам в Telegram.";
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Забронировать";
        note.hidden = false;
        note.classList.add("hint--bad");
        note.textContent = err.status === 403
          ? "Склад пока не принимает заявки с сайта. Скопируйте текст и отправьте его складу."
          : "Забронировать не вышло: " + (err.message || "склад не ответил") +
            ". Скопируйте текст и отправьте его складу.";
      });
  }

  function selectPreview() {
    var pre = $("preview");
    var range = document.createRange();
    range.selectNodeContents(pre);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    var note = $("sendnote");
    note.hidden = false;
    note.textContent = "Текст выделен — скопируйте его вручную.";
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

  // Приём заявок на складе выключают и включают. Спрашиваем на входе и, если
  // выключен, убираем кнопку — вместо неё остаётся текст с копированием.
  function checkOpen() {
    Site.ordersOpen()
      .then(function (open) {
        var btn = $("send");
        if (!btn || open) return;
        btn.hidden = true;
        var note = $("sendnote");
        note.hidden = false;
        note.textContent = "Склад пока принимает заявки только текстом: " +
          "скопируйте её и отправьте любым способом.";
      })
      .catch(function () { /* не ответил — оставляем кнопку, она объяснит сама */ });
  }

  Site.loadCatalog()
    .then(function (data) {
      catalog = data;
      render();
      loadFree();
      checkOpen();
    })
    .catch(function () {
      $("cart").innerHTML = '<p class="empty">Каталог не загрузился. Обновите страницу.</p>';
    });
})();
