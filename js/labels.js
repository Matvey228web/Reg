// Экран «Этикетки»: печать QR на термопринтер этикеток.
//
// Ключевое отличие от печати на A4: у термопринтера этикеток страница И ЕСТЬ
// этикетка, одна на страницу. Поэтому размер задаётся через @page под каждый
// формат, а этикетки разделяются разрывом страницы — сетки здесь нет.
//
// Про размер QR. Наш номер — шесть цифр, это QR версии 1, 21×21 модуль. Термо-
// принтеры обычно 203 dpi, то есть 8 точек на миллиметр, и модуль должен
// попадать в целое число точек, иначе края замываются и телефон читает плохо.
// При 4 точках на модуль это 0,5 мм; вместе с обязательным пустым полем по
// краям (по 4 модуля) выходит 29 модулей — около 14 мм. Меньше 12 мм делать
// нельзя: перестаёт уверенно сканироваться.

const LabelsScreen = (() => {
  const CAPTION_KEY = "mifs_label_caption";
  const SIZE_KEY = "mifs_label_size";
  const DEFAULT_CAPTION = "Киноколледж #40";

  // Ходовые размеры термоленты. Значения правятся здесь же на экране:
  // окончательные размеры зависят от принтера, который ещё не выбран.
  const SIZES = {
    small: { label: "Маленькая 30×20", w: 30, h: 20, qr: 14, name: false, caption: false },
    medium: { label: "Средняя 40×30", w: 40, h: 30, qr: 18, name: false, caption: true },
    large: { label: "Большая 58×40", w: 58, h: 40, qr: 25, name: true, caption: true },
  };

  let items = [];          // что печатаем
  let sizeKey = "medium";
  let singleItemId = null; // пришли из карточки предмета

  function caption() {
    try {
      return localStorage.getItem(CAPTION_KEY) || DEFAULT_CAPTION;
    } catch {
      return DEFAULT_CAPTION;
    }
  }

  function saveCaption(text) {
    try { localStorage.setItem(CAPTION_KEY, text); } catch { /* не критично */ }
  }

  function savedSize() {
    try { return localStorage.getItem(SIZE_KEY) || "medium"; } catch { return "medium"; }
  }

  function onShow(params) {
    singleItemId = params && params.itemId ? params.itemId : null;
    sizeKey = savedSize();
    render();
  }

  function source() {
    const all = Cache.items("equipment") || [];
    if (singleItemId) return all.filter((i) => String(i.item_id) === String(singleItemId));
    return all;
  }

  function render() {
    const box = document.getElementById("labels-content");
    const all = source();

    if (!all.length) {
      box.innerHTML = `<p class="empty">Каталог ещё не загружен. Откройте «Каталог»,
        чтобы список подтянулся, и возвращайтесь.</p>`;
      return;
    }

    box.innerHTML = `
      ${singleItemId ? `<p class="hint">Этикетка для одной позиции: ${escapeHtml(singleItemId)}.</p>` : ""}
      <div class="field">
        <label for="labels-size">Размер этикетки</label>
        <select id="labels-size">
          ${Object.keys(SIZES).map((k) =>
            `<option value="${k}" ${k === sizeKey ? "selected" : ""}>${escapeHtml(SIZES[k].label)} мм</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="labels-caption">Подпись на этикетке</label>
        <input type="text" id="labels-caption" value="${escapeHtml(caption())}" />
        <p class="hint">Печатается на средней и большой. На маленькой не помещается —
        там только QR и номер.</p>
      </div>
      ${singleItemId ? "" : `
      <div class="filters">
        <select id="labels-filter-category"></select>
        <select id="labels-filter-status"></select>
      </div>
      <div class="field">
        <input type="search" id="labels-search" placeholder="Поиск по названию или номеру"
               autocapitalize="off" autocorrect="off" spellcheck="false" />
      </div>`}
      <div id="labels-count" class="hint"></div>
      <button class="btn" id="labels-print">Печать</button>
      <button class="btn btn--secondary" id="labels-save">Сохранить картинками</button>
      <p class="hint">Печать из браузера подходит принтерам с AirPrint или обычным
      драйвером: выберите принтер и поставьте масштаб 100%, иначе размеры уедут.
      Дешёвые принтеры этикеток с Bluetooth (Niimbot, Phomemo) из браузера печатать
      не умеют вообще — для них сохраните картинками и напечатайте из приложения
      принтера.</p>
      <p class="hint">И печать, и сохранение файлов Telegram внутри себя блокирует.
      На телефоне откройте адрес приложения в Safari, а не в Telegram.</p>
      <div class="section-title">Как будет выглядеть</div>
      <div id="labels-preview"></div>`;

    if (!singleItemId) {
      const cats = categoryList();
      document.getElementById("labels-filter-category").innerHTML =
        `<option value="all">Все категории</option>` +
        cats.map((c) => `<option value="${c.code}">${escapeHtml(c.label)}</option>`).join("");
      document.getElementById("labels-filter-status").innerHTML = `
        <option value="all">Все статусы</option>
        <option value="Available">Доступно</option>
        <option value="Rented">В аренде</option>
        <option value="In Repair">В ремонте</option>
        <option value="Retired">Списано</option>`;
      ["labels-filter-category", "labels-filter-status"].forEach((id) => {
        document.getElementById(id).addEventListener("change", recount);
      });
      document.getElementById("labels-search").addEventListener("input", recount);
    }

    document.getElementById("labels-size").addEventListener("change", (e) => {
      sizeKey = e.target.value;
      try { localStorage.setItem(SIZE_KEY, sizeKey); } catch { /* не критично */ }
      recount();
    });
    document.getElementById("labels-caption").addEventListener("input", (e) => {
      saveCaption(e.target.value);
      recount();
    });
    document.getElementById("labels-print").addEventListener("click", print);
    document.getElementById("labels-save").addEventListener("click", saveImages);

    recount();
  }

  function selected() {
    const all = source();
    if (singleItemId) return all;
    const cat = document.getElementById("labels-filter-category").value;
    const status = document.getElementById("labels-filter-status").value;
    const q = document.getElementById("labels-search").value.trim().toLowerCase();
    return all.filter((i) => {
      if (cat !== "all" && i.category !== cat) return false;
      if (status !== "all" && i.status !== status) return false;
      if (!q) return true;
      return [i.name, i.item_id, i.serial_number, i.inventory_number]
        .filter(Boolean).join(" ").toLowerCase().indexOf(q) !== -1;
    });
  }

  // Предпросмотр показываем в реальных миллиметрах и только несколько штук:
  // рисовать 628 QR на экран незачем, а понять, что влезает, хватает и трёх.
  function recount() {
    items = selected();
    const size = SIZES[sizeKey];
    document.getElementById("labels-count").textContent =
      `К печати: ${items.length} ${plural(items.length, "этикетка", "этикетки", "этикеток")}` +
      ` · ${size.w}×${size.h} мм, QR ${size.qr} мм`;
    drawPreview(items.slice(0, 3));
  }

  function labelHtml(item, size) {
    return `
      <div class="label label--${sizeKey}">
        <canvas class="label-qr" data-code="${escapeHtml(item.item_id)}"></canvas>
        <div class="label-text">
          <div class="label-id">${escapeHtml(item.item_id)}</div>
          ${size.name && item.name ? `<div class="label-name">${escapeHtml(item.name)}</div>` : ""}
          ${size.caption ? `<div class="label-caption">${escapeHtml(caption())}</div>` : ""}
        </div>
      </div>`;
  }

  function paintCanvases(container, size) {
    container.querySelectorAll(".label-qr").forEach((canvas) => {
      // Рисуем с запасом по разрешению и сжимаем стилями до физических
      // миллиметров: так на печати края остаются резкими.
      QR.render(canvas, canvas.dataset.code, 8);
      canvas.style.width = size.qr + "mm";
      canvas.style.height = size.qr + "mm";
    });
  }

  function drawPreview(list) {
    const box = document.getElementById("labels-preview");
    const size = SIZES[sizeKey];
    if (!list.length) {
      box.innerHTML = `<p class="empty">Ничего не найдено</p>`;
      return;
    }
    box.innerHTML = list.map((i) => labelHtml(i, size)).join("");
    paintCanvases(box, size);
  }

  function print() {
    if (!items.length) {
      TG.showAlert("Нечего печатать: под фильтры ничего не попало");
      return;
    }
    const size = SIZES[sizeKey];

    // Размер страницы = размер этикетки: у термопринтера этикеток одна
    // этикетка на страницу, поэтому @page задаём под выбранный формат.
    let style = document.getElementById("labels-print-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "labels-print-style";
      document.head.appendChild(style);
    }
    style.textContent = `@media print { @page { size: ${size.w}mm ${size.h}mm; margin: 0; } }`;

    const sheet = document.getElementById("labels-print-area");
    sheet.innerHTML = items.map((i) => labelHtml(i, size)).join("");
    paintCanvases(sheet, size);

    document.body.classList.add("printing");

    // Убирать этикетки сразу после window.print() нельзя: в части браузеров
    // (в том числе в Safari) вызов возвращает управление до того, как страница
    // отрисована на печать, и уходил бы пустой лист. Чистим по afterprint, а
    // таймер оставляем только как страховку, если событие не придёт.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.body.classList.remove("printing");
      sheet.innerHTML = "";
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(cleanup, 60000);

    // Даём браузеру отрисовать canvas до вызова печати, иначе на страницу
    // может уйти пустой квадрат вместо кода.
    setTimeout(() => window.print(), 250);
  }

  // --- Сохранение этикеток картинками ---
  //
  // Для Bluetooth-принтеров этикеток (Niimbot, Phomemo и прочие дешёвые) это
  // единственный путь: Bluetooth у них закрыт под собственное приложение, и
  // напечатать из браузера нельзя в принципе — только импортировать картинку.
  //
  // Рисуем сразу в разрешении принтера: 203 dpi это ровно 8 точек на миллиметр,
  // поэтому картинка 30×20 мм — это 240×160 точек. Так приложение принтера не
  // пересчитывает размер и края не замываются.
  const DOTS_PER_MM = 8;
  const MAX_AT_ONCE = 30;

  function mm(value) {
    return Math.round(value * DOTS_PER_MM);
  }

  function labelCanvas(item, size) {
    const canvas = document.createElement("canvas");
    canvas.width = mm(size.w);
    canvas.height = mm(size.h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const pad = mm(1.5);
    const gap = mm(1.5);
    const qrSide = mm(size.qr);

    // QR рисуем отдельно и переносим без сглаживания: сглаженный модуль на
    // термопечати расплывается, и код перестаёт читаться.
    const qrCanvas = document.createElement("canvas");
    QR.render(qrCanvas, item.item_id, 8);
    ctx.imageSmoothingEnabled = false;
    const qrTop = Math.round((canvas.height - qrSide) / 2);
    ctx.drawImage(qrCanvas, pad, qrTop, qrSide, qrSide);

    const textLeft = pad + qrSide + gap;
    const textWidth = canvas.width - textLeft - pad;
    ctx.fillStyle = "#000000";
    ctx.textBaseline = "top";

    const lines = [];
    lines.push({ text: item.item_id, size: mm(3.2), font: "bold {px}px monospace" });
    if (size.name && item.name) lines.push({ text: item.name, size: mm(2.4), font: "{px}px sans-serif" });
    if (size.caption) lines.push({ text: caption(), size: mm(2.2), font: "{px}px sans-serif" });

    // Высоту блока считаем заранее, чтобы текст стоял по центру этикетки, а не
    // прижимался к верхнему краю.
    const lineGap = mm(0.8);
    const wrapped = lines.map((line) => {
      ctx.font = line.font.replace("{px}", line.size);
      return { line: line, rows: wrapText(ctx, line.text, textWidth) };
    });
    const totalHeight = wrapped.reduce(
      (sum, w) => sum + w.rows.length * (w.line.size * 1.15) + lineGap, -lineGap);

    let y = Math.max(pad, Math.round((canvas.height - totalHeight) / 2));
    wrapped.forEach((w) => {
      ctx.font = w.line.font.replace("{px}", w.line.size);
      w.rows.forEach((row) => {
        ctx.fillText(row, textLeft, y);
        y += w.line.size * 1.15;
      });
      y += lineGap;
    });
    return canvas;
  }

  function wrapText(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/);
    const rows = [];
    let current = "";
    words.forEach((word) => {
      const candidate = current ? current + " " + word : word;
      if (ctx.measureText(candidate).width <= maxWidth || !current) current = candidate;
      else { rows.push(current); current = word; }
    });
    if (current) rows.push(current);
    return rows.slice(0, 3);   // больше трёх строк на этикетку не влезает
  }

  function saveImages() {
    if (!items.length) {
      TG.showAlert("Нечего сохранять: под фильтры ничего не попало");
      return;
    }
    if (items.length > MAX_AT_ONCE) {
      TG.showAlert("Сразу столько файлов браузер не отдаст. Сузьте фильтры до " +
        MAX_AT_ONCE + " позиций — или печатайте кнопкой «Печать».");
      return;
    }
    const size = SIZES[sizeKey];
    // По одному файлу с паузой: браузеры глушат пачку скачиваний подряд.
    items.forEach((item, index) => {
      setTimeout(() => {
        QR.downloadCanvas(labelCanvas(item, size),
          "mifs-" + item.item_id + "-" + size.w + "x" + size.h + "mm.png");
      }, index * 300);
    });
  }

  function init() {
    Router.register("labels", { onShow });
  }

  return { init };
})();
