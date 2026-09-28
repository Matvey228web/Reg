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

  // Браузер запретил запись — корзина не переживёт переход между страницами.
  function storageWarnHtml() {
    return '<p class="hint hint--bad" id="nostore">Браузер не сохраняет корзину —' +
      " похоже, приватный режим. Соберите и отправьте её за один заход.</p>";
  }

  // Строка «когда»: подпись, поле и пример поверх пустого поля.
  function whenField(cap, id, type, value, ph) {
    return '<label class="date"><span class="cap">' + esc(cap) + "</span>" +
      '<span class="picker">' +
        '<input type="' + type + '" id="' + id + '" value="' + esc(value) + '"' +
          (value ? "" : ' class="is-empty"') + " />" +
        '<span class="ph">' + esc(ph) + "</span>" +
      "</span></label>";
  }

  function render() {
    var list = lines();
    var dates = Site.cartDates();
    var keep = snapshot();

    if (!list.length) {
      // Пустая корзина после набранного на витрине — это не «ничего не выбрал»,
      // а запрет хранилища. Молчать об этом хуже всего: человек уверен, что
      // выбирал, и не понимает, куда всё делось.
      $("cart").innerHTML = '<p class="empty">Корзина пуста. ' +
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
        // Набирать дату руками не нужно: нажатие в любое место строки
        // открывает календарь или часы. Пустое поле показывает пример —
        // «дд.мм.гггг» от браузера прячем, он ничего не объясняет.
        '<div class="dates">' +
          whenField("Выдача", "from", "date", dates.from, "05-10-2026") +
          whenField("Время", "from-time", "time", dates.fromTime, "10:00") +
          whenField("Возврат", "to", "date", dates.to, "12-10-2026") +
          whenField("Время", "to-time", "time", dates.toTime, "18:00") +
        "</div>" +
      "</div>" +

      '<div class="block">' +
        "<h2>Кто берёт</h2>" +
        // Раньше вся строка была ярлыком поля, и тумблер переключался от
        // нажатия в пустое место справа от подписи. Теперь нажимается сам
        // тумблер и слова рядом с ним, а не полоса во всю ширину.
        '<div class="row"><span class="row-label">Мне есть 18 лет</span>' +
          '<label class="switch"><input type="checkbox" id="adult"' +
            ' aria-label="Мне есть 18 лет" /></label></div>' +
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
            ' aria-label="Скопировать">' + copyIcon() + "</button>" +
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
    // Совершеннолетие — обычное дело, и писать о нём незачем: раз в заявке нет
    // ни «Нет», ни представителя, значит человеку есть 18. Отмечаем только
    // обратное — то, из-за чего меняется порядок выдачи. Разбор на складе
    // (mapOrderFields в Code.gs) так и считает: нет строки и нет взрослого —
    // заказчик совершеннолетний.
    if (adult) {
      out.push("Full_name: " + val("name"));
      out.push("Phone: " + val("phone"));
      out.push("Telegram: " + val("tg"));
    } else {
      out.push("Are_you_an_adult: Нет");
      out.push("Full_name_minor: " + val("name"));
      out.push("Phone_minors: " + val("phone"));
      out.push("Telegram_Minors: " + val("tg"));
      out.push("Full_name_guardian: " + val("gname"));
      out.push("Phone_guardian: " + val("gphone"));
    }
    out.push("Type_and_name_of_the_project: " + val("project"));
    var extra = extraInput();
    if (extra) out.push("Input: " + extra);
    out.push("Date_of_issue: " + Site.humanDate($("from").value));
    out.push("Time_of_issue: " + val("from-time"));
    out.push("Date_completion: " + Site.humanDate($("to").value));
    out.push("Time_completion: " + val("to-time"));
    return out.join("\n");
  }

  function val(id) { return ($(id) && $(id).value || "").trim(); }

  var WHEN = ["from", "to", "from-time", "to-time"];

  // Пример показываем только у пустого поля: заполненное поле рисует значение
  // само, и два текста наложились бы друг на друга.
  function markEmpty() {
    WHEN.forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle("is-empty", !el.value);
    });
  }

  function clearBad(el) {
    if (el && el.classList) el.classList.remove("is-bad");
  }

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

  // Нажатие в строку даты или времени открывает выбор. Нативную иконку
  // календаря видно, но целиться в неё пальцем — издевательство: строка
  // высотой 44 точки, иконка 16. Без этого поле выглядело мёртвым.
  //
  // Ярлык пересылает нажатие полю, поэтому на один тап приходят два события;
  // второй вызов закрыл бы только что открытое окно — отсекаем по времени.
  var picked = 0;
  function openPicker(input) {
    var now = Date.now();
    if (now - picked < 400) return;
    picked = now;
    try {
      if (input.showPicker) { input.showPicker(); return; }
    } catch (err) { /* без жеста браузер откажет — тогда просто фокус */ }
    input.focus();
  }

  function bind() {
    $("cart").addEventListener("click", function (e) {
      var pick = e.target.closest(".picker");
      if (pick) { openPicker(pick.querySelector("input")); return; }
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
      if (WHEN.indexOf(e.target.id) !== -1) {
        var from = $("from").value, to = $("to").value;
        // Перепутали местами — меняем, а не отказываем: человек имел в виду срок.
        if (from && to && to < from) {
          $("from").value = to; $("to").value = from;
          from = $("from").value; to = $("to").value;
        }
        Site.cartDates(from, to, $("from-time").value, $("to-time").value);
        markEmpty();
        loadFree();
      }
      clearBad(e.target);
      updatePreview();
    });

    $("cart").addEventListener("input", function (e) {
      var tag = e.target.tagName;
      if (e.target.id === "phone" || e.target.id === "gphone") {
        applyMask(e.target, maskPhone);
      }
      if (e.target.id === "tg") applyMask(e.target, maskTg);
      clearBad(e.target);
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
  // Обязательно всё, кроме комментария: заявка без времени возврата или без
  // мастерской всё равно вернётся вопросом в чат, только через час и уже от
  // человека. Комментарий — единственное поле «по желанию».
  var REQUIRED = [
    { id: "name", what: "ФИО" },
    { id: "phone", what: "телефон" },
    { id: "tg", what: "ник в Telegram" },
    { id: "gname", what: "ФИО представителя", minor: true },
    { id: "gphone", what: "телефон представителя", minor: true },
    { id: "project", what: "проект" },
    { id: "workshop", what: "мастерскую и курс" },
    { id: "from", what: "дату выдачи" },
    { id: "from-time", what: "время выдачи" },
    { id: "to", what: "дату возврата" },
    { id: "to-time", what: "время возврата" },
  ];

  function missing() {
    var adult = $("adult").checked;
    return REQUIRED.filter(function (f) {
      if (f.minor && adult) return false;
      return !val(f.id);
    });
  }

  function send() {
    var note = $("sendnote");
    var gaps = missing();
    if (gaps.length) {
      REQUIRED.forEach(function (f) { clearBad($(f.id)); });
      gaps.forEach(function (f) { $(f.id).classList.add("is-bad"); });
      note.hidden = false;
      note.textContent = gaps.length === 1
        ? "Не хватает одного: " + gaps[0].what + "."
        : "Не хватает: " + gaps.map(function (f) { return f.what; }).join(", ") + ".";
      note.classList.add("hint--bad");
      var first = $(gaps[0].id);
      if (WHEN.indexOf(gaps[0].id) !== -1) openPicker(first); else first.focus();
      first.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    // Номер целиком: «+7 999» разбор примет, а позвонить по нему нельзя.
    if (val("phone").replace(/\D/g, "").length < 11) {
      $("phone").classList.add("is-bad");
      note.hidden = false;
      note.classList.add("hint--bad");
      note.textContent = "Телефон не целиком — нужны все десять цифр после +7.";
      $("phone").focus();
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

  // Ответ о свободном перерисовывал корзину целиком — вместе с формой. На
  // телефоне это закрывало только что открытые часы: человек выбирал время,
  // приходил ответ, поле рождалось заново, и окно пропадало. Теперь меняются
  // только строчки предупреждений.
  function loadFree() {
    var dates = Site.cartDates();
    if (!dates.from && !dates.to) return;
    Site.availability(dates.from, dates.to)
      .then(function (res) { free = res.free; paintWarn(); })
      .catch(function () { /* остаёмся на общих количествах */ });
  }

  function paintWarn() {
    lines().forEach(function (l) {
      var row = document.querySelector('.cart-line[data-key="' + l.key + '"]');
      if (!row) return;
      var old = row.querySelector(".cart-warn");
      if (old) old.remove();
      var html = warnHtml(l);
      if (html) row.insertAdjacentHTML("beforeend", html);
    });
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
