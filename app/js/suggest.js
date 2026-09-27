// Подсказки при вводе в строках поиска.
//
// Названия на складе латиницей и капсом (OSTERRIG SIRIUS 100CM) — их набирают
// по памяти и с ошибками. Подсказки показывают, что существует, до того как имя
// набрано целиком.
//
// Считаются по кэшу, запросов не стоят. Выбор подставляет текст и рассылает
// обычное событие input — фильтрацию экранов трогать не нужно.

const Suggest = (() => {
  const MIN_CHARS = 2;
  const LIMIT = 8;

  let box = null;        // открытый список
  let input = null;      // поле, к которому он относится
  let entries = [];
  let active = -1;
  let justPicked = false;
  let openedAt = 0;      // положение страницы в момент открытия списка

  function close() {
    if (box) box.remove();
    box = null;
    input = null;
    entries = [];
    active = -1;
  }

  function itemHtml(entry, index) {
    return `
      <div class="suggest-item" data-index="${index}">
        <span class="suggest-text">${escapeHtml(entry.text)}</span>
        ${entry.meta ? `<span class="suggest-meta">${escapeHtml(entry.meta)}</span>` : ""}
      </div>`;
  }

  function open(target, list) {
    close();
    input = target;
    entries = list;
    openedAt = window.scrollY || 0;
    box = document.createElement("div");
    box.className = "suggest";
    box.innerHTML = list.map(itemHtml).join("");
    // Пальцем и мышью выбираем по mousedown: blur приходит раньше click, и по
    // клику список успел бы закрыться — нажатие уходило бы в пустоту.
    box.addEventListener("mousedown", (e) => {
      const row = e.target.closest(".suggest-item");
      if (!row) return;
      e.preventDefault();
      pick(Number(row.dataset.index));
    });
    target.parentElement.appendChild(box);
  }

  function highlight() {
    if (!box) return;
    box.querySelectorAll(".suggest-item").forEach((el, i) => {
      el.classList.toggle("suggest-item--active", i === active);
    });
  }

  function pick(index) {
    const entry = entries[index];
    const target = input;
    if (!entry || !target) return;
    target.value = entry.text;
    close();
    // Подставленный текст — это уже готовый запрос; перерисовывать список
    // подсказок по нему незачем.
    justPicked = true;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    justPicked = false;
    target.blur();   // на телефоне убираем клавиатуру: список уже сужен
  }

  function update(target, provider) {
    if (justPicked) return;
    const query = target.value.trim().toLowerCase();
    if (query.length < MIN_CHARS) { close(); return; }
    const list = (provider(query) || []).slice(0, LIMIT);
    // Единственная подсказка, совпадающая с введённым, ничего не добавляет.
    if (!list.length || (list.length === 1 && list[0].text.toLowerCase() === query)) {
      close();
      return;
    }
    open(target, list);
  }

  function onKey(e, target, provider) {
    if (e.key === "Escape") { close(); return; }
    if (!box) {
      if (e.key === "ArrowDown") update(target, provider);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active += e.key === "ArrowDown" ? 1 : -1;
      if (active < 0) active = entries.length - 1;
      if (active >= entries.length) active = 0;
      highlight();
      return;
    }
    if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(active);
    }
  }

  // Экран «Этикетки» пересобирает своё поле при каждой перерисовке, поэтому
  // привязка должна быть безопасной для повторного вызова.
  function attach(inputId, provider) {
    const target = document.getElementById(inputId);
    if (!target || target.dataset.suggest) return;
    target.dataset.suggest = "1";
    target.setAttribute("autocomplete", "off");
    target.parentElement.classList.add("suggest-field");
    target.addEventListener("input", () => update(target, provider));
    target.addEventListener("focus", () => update(target, provider));
    target.addEventListener("keydown", (e) => onKey(e, target, provider));
    // Уход из поля закрывает список, но не раньше, чем отработает выбор.
    target.addEventListener("blur", () => setTimeout(() => {
      if (input === target) close();
    }, 150));
  }

  // ---- подбор и порядок ----

  // Сначала совпадения с начала строки, потом вхождения внутри: «ost» должно
  // сперва предлагать OSTERRIG, а не то, где эти буквы встретились в середине.
  function rank(list, query) {
    const needle = String(query).toLowerCase();
    const scored = [];
    list.forEach((entry) => {
      const at = String(entry.text).toLowerCase().indexOf(needle);
      if (at === -1) return;
      scored.push({ entry, at, len: String(entry.text).length });
    });
    scored.sort((a, b) =>
      (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1) || a.at - b.at || a.len - b.len ||
      String(a.entry.text).localeCompare(String(b.entry.text)));
    return scored.map((s) => s.entry);
  }

  function dedupe() {
    const seen = {};
    const out = [];
    return {
      add(text, meta) {
        const value = String(text == null ? "" : text).trim();
        if (!value) return;
        const key = value.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        out.push({ text: value, meta: meta || "" });
      },
      list: out,
    };
  }

  // ---- каталог: модели, категории, номера ----
  //
  // Четыре одинаковых OSTERRIG в подсказках — это шум: название схлопываем в
  // одну строку и рядом пишем, сколько их. У штучных позиций считаем не строки,
  // а сами штуки: «25 шт» про мешки честнее, чем «1».
  function equipment(items, query) {
    const models = {};
    const catCounts = {};
    (items || []).forEach((item) => {
      const name = String(item.name || "").trim();
      const qty = categoryByQty(item.category) ? Number(item.qty || 1) : 1;
      if (name) {
        if (!models[name]) models[name] = { name, category: item.category, count: 0 };
        models[name].count += qty;
      }
      if (item.category) catCounts[item.category] = (catCounts[item.category] || 0) + qty;
    });

    const modelBox = dedupe();
    Object.keys(models).forEach((name) => {
      const m = models[name];
      modelBox.add(m.name, categoryLabel(m.category) + " · " + m.count + " шт");
    });

    const catBox = dedupe();
    categoryList().forEach((c) => {
      if (catCounts[c.code]) catBox.add(c.label, catCounts[c.code] + " шт");
    });

    const ranked = rank(modelBox.list, query).concat(rank(catBox.list, query));
    const numbers = rank(numberEntries(items, query), query);
    // Если набраны одни цифры — человек ищет номер, и он должен быть сверху.
    return /^[\d\s-]+$/.test(query) ? numbers.concat(ranked) : ranked.concat(numbers);
  }

  // Номера диктуют и записывают по-разному, поэтому сравниваем без пробелов и
  // дефисов — так же, как это уже делает поиск по каталогу.
  function numberEntries(items, query) {
    const digits = String(query).replace(/[\s\-]/g, "");
    if (!/\d/.test(digits)) return [];
    const box = dedupe();
    (items || []).forEach((item) => {
      [item.item_id, item.serial_number, item.inventory_number].forEach((value) => {
        if (!value) return;
        if (String(value).toLowerCase().replace(/[\s\-]/g, "").indexOf(digits) === -1) return;
        box.add(value, item.name || "");
      });
    });
    return box.list;
  }

  // ---- заказы: номер, арендатор, ник, проект, состав ----
  function orders(list, query) {
    const studentOrders = {};
    const itemOrders = {};
    (list || []).forEach((o) => {
      const who = String(o.student_name || "").trim();
      if (who) studentOrders[who] = (studentOrders[who] || 0) + 1;
      String(o.items_text || "").split(",").forEach((name) => {
        const value = name.trim();
        if (value) itemOrders[value] = (itemOrders[value] || 0) + 1;
      });
    });

    const box = dedupe();
    (list || []).forEach((o) => {
      box.add(o.order_no, o.student_name || "");
      box.add(o.student_name, "заказов: " + (studentOrders[String(o.student_name || "").trim()] || 1));
      box.add(o.student_tg, o.student_name || "");
      if (o.project) box.add(o.project, "проект");
    });
    Object.keys(itemOrders).forEach((name) => {
      box.add(name, "в заказах: " + itemOrders[name]);
    });
    return rank(box.list, query);
  }

  function init() {
    // Список не должен загораживать то, до чего человек тянется: прокрутка и
    // нажатие мимо закрывают его.
    window.addEventListener("scroll", (e) => {
      if (!box) return;
      // Прокрутка самого списка его, разумеется, не закрывает.
      const from = e.target;
      if (from && from.closest && from.closest(".suggest")) return;
      // Закрываем только на осознанную прокрутку. На телефоне страница сама
      // дёргается на несколько пикселей, когда вылезает клавиатура, и по
      // такому подскоку список исчезал бы прямо во время набора.
      if (Math.abs((window.scrollY || 0) - openedAt) < 24) return;
      close();
    }, true);
    document.addEventListener("mousedown", (e) => {
      if (!box) return;
      if (e.target.closest(".suggest") || e.target === input) return;
      close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }

  return { init, attach, rank, equipment, orders };
})();
