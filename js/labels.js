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

  // Вертикальная лента: название сверху, QR посередине, снизу номер плашкой и
  // подпись колледжа. Размеры — ходовые у Niimbot и Phomemo. Кегли заданы в
  // миллиметрах: этикетка печатается в физическом размере, и «пункты» здесь
  // ничего не значат.
  const SIZES = {
    v20x30: { label: "20×30", w: 20, h: 30, pad: 1.2, name: 1.9, num: 3.0, org: 1.7, caption: true, category: false },
    v30x40: { label: "30×40", w: 30, h: 40, pad: 1.5, name: 2.5, num: 4.0, org: 2.0, caption: true, category: false },
    v30x50: { label: "30×50", w: 30, h: 50, pad: 1.5, name: 2.8, num: 4.6, org: 2.2, caption: true, category: true },
    v40x60: { label: "40×60", w: 40, h: 60, pad: 2.0, name: 3.4, num: 5.6, org: 2.6, caption: true, category: true },
  };
  const DEFAULT_SIZE = "v30x40";

  let items = [];          // что печатаем
  let sizeKey = DEFAULT_SIZE;
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

  // Раньше размеры звались small/medium/large и были горизонтальными. У тех,
  // кто уже открывал экран, в памяти браузера лежит старое имя — молча
  // подставляем текущее, а не падаем на неизвестном ключе.
  function savedSize() {
    let stored = null;
    try { stored = localStorage.getItem(SIZE_KEY); } catch { stored = null; }
    return SIZES[stored] ? stored : DEFAULT_SIZE;
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
      <div class="form-group">
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
      </div>
      </div>
      <p class="hint">Подпись печатается на всех размерах мелкой строкой под номером.
      На 30×50 и 40×60 рядом с ней помещается ещё и категория.</p>
      ${singleItemId ? "" : `
      <div class="searchbar">
        <input type="search" id="labels-search" placeholder="Поиск по названию или номеру"
               autocapitalize="off" autocorrect="off" spellcheck="false" />
        <div class="filters">
          <select id="labels-filter-category"></select>
          <select id="labels-filter-status"></select>
        </div>
      </div>`}
      <div id="labels-count" class="hint"></div>
      <button class="btn" id="labels-print">Печать</button>
      <button class="btn btn--secondary" id="labels-save">Сохранить картинками</button>
      <p class="hint">Печать из браузера подходит принтерам с AirPrint или обычным
      драйвером: выберите принтер и поставьте масштаб 100%, иначе размеры уедут.
      Дешёвые принтеры этикеток с Bluetooth (Niimbot, Phomemo) из браузера печатать
      не умеют вообще — для них сохраните картинками и напечатайте из приложения
      принтера.</p>
      <p class="hint">Нажмите на образец внизу — этикетка откроется крупно, и там
      же кнопка «Сохранить картинку». Скачивать файлы из Telegram нельзя, это
      ограничение мессенджера: кнопка откроет системный лист «Поделиться», а если
      его нет — картинку пришлёт бот в чат склада. Пачку «Сохранить картинками»
      бот присылает одним архивом. Печать из Telegram тоже заблокирована — для
      неё откройте адрес приложения в Safari.</p>
      <div class="section-title">Размер в настоящую величину</div>
      <div class="size-row" id="labels-sizes"></div>
      <p class="hint">Нажмите на размер, чтобы взять его. Ряд прокручивается вбок:
      четыре этикетки в настоящую величину — это 12 сантиметров, в экран они
      не помещаются.</p>
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
      // Поле пересоздаётся при каждой перерисовке экрана, поэтому привязываем
      // подсказки здесь, а не один раз в init().
      Suggest.attach("labels-search", (q) => Suggest.equipment(source(), q));
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
      ` · ${size.w}×${size.h} мм`;
    drawSizes(items[0]);
    drawPreview(items.slice(0, 3));
  }

  // Предпросмотр показываем той же картинкой, которая уйдёт в печать и в файл:
  // отдельная вёрстка для экрана рано или поздно разъезжается с тем, что
  // печатается, и проверить это на бумаге дорого.
  function labelNode(item, size, scale) {
    const canvas = labelCanvas(item, size, caption(), scale);
    canvas.className = "label";
    canvas.style.width = size.w + "mm";
    canvas.style.height = size.h + "mm";
    return canvas;
  }

  // Образец в списке нажимается: на экране этикетка размером 30×40 мм, и ни
  // номер, ни подпись на ней не разобрать. Открываем её во весь экран в печатном
  // разрешении — там же её и сохраняют долгим нажатием.
  function previewNode(item, size) {
    const node = labelNode(item, size, PREVIEW_SCALE);
    node.classList.add("label--tappable");
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.setAttribute("title", "Показать крупно");
    const open = () => showLabel(item, size);
    node.addEventListener("click", open);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    return node;
  }

  function showLabel(item, size) {
    const canvas = labelCanvas(item, size, caption(), FILE_SCALE);
    // Кнопкой, а не «удерживайте картинку»: системное меню по долгому нажатию
    // вебвью Telegram не показывает — подсказка обещала то, чего не бывает.
    QR.showImage(
      canvas,
      item.name + " · " + item.item_id,
      TG.isAvailable()
        ? "Скачать напрямую из Telegram нельзя — кнопка откроет системный лист «Поделиться», а если его нет, картинку пришлёт бот."
        : "",
      () => saveImageFor(canvas, fileName(item, size), item.name,
                         document.getElementById("qr-overlay-save")));
  }

  // Ряд размеров: одна и та же этикетка во всех форматах, в настоящую величину.
  // Рисуем первую позицию из отобранных — брать разные предметы в ряд сравнения
  // размеров нельзя, иначе непонятно, что именно меняется от карточки к карточке.
  function drawSizes(sample) {
    const box = document.getElementById("labels-sizes");
    if (!box) return;
    box.innerHTML = "";
    if (!sample) return;
    Object.keys(SIZES).forEach((key) => {
      const size = SIZES[key];
      const card = document.createElement("button");
      card.type = "button";
      card.className = "size-card" + (key === sizeKey ? " size-card--on" : "");
      card.dataset.size = key;
      card.setAttribute("aria-pressed", key === sizeKey ? "true" : "false");
      card.appendChild(labelNode(sample, size, PREVIEW_SCALE));
      const name = document.createElement("span");
      name.className = "size-card-name";
      name.textContent = size.label + " мм";
      card.appendChild(name);
      card.addEventListener("click", () => pickSize(key));
      box.appendChild(card);
    });
  }

  function pickSize(key) {
    if (!SIZES[key] || key === sizeKey) return;
    sizeKey = key;
    try { localStorage.setItem(SIZE_KEY, sizeKey); } catch { /* не критично */ }
    // Список в форме — та же настройка, и он должен показывать то же самое.
    const select = document.getElementById("labels-size");
    if (select) select.value = key;
    TG.hapticSuccess();
    recount();
  }

  function drawPreview(list) {
    const box = document.getElementById("labels-preview");
    const size = SIZES[sizeKey];
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = `<p class="empty">Ничего не найдено</p>`;
      return;
    }
    list.forEach((item) => box.appendChild(previewNode(item, size)));
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
    sheet.innerHTML = "";
    // В печать уходит тот же холст, но нарисованный втрое подробнее: лазерный
    // принтер с AirPrint печатает мельче термопринтера, и разрешение ленты на
    // нём выглядело бы крупными ступеньками.
    items.forEach((i) => sheet.appendChild(labelNode(i, size, PRINT_SCALE)));

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

  // --- Отрисовка этикетки ---
  //
  // Одна функция и для экрана, и для печати, и для файла: отдельная вёрстка
  // для предпросмотра рано или поздно разъезжается с тем, что печатается, а
  // заметно это только на бумаге.
  //
  // Рисуем в разрешении принтера: 203 dpi — это ровно 8 точек на миллиметр,
  // поэтому 30×40 мм превращаются в 240×320 точек. Приложение принтера ничего
  // не пересчитывает, и края не замываются. Для печати из браузера тот же
  // рисунок делается втрое подробнее: лазерный принтер печатает мельче ленты.
  const DOTS_PER_MM = 8;
  const PREVIEW_SCALE = 2;   // экран: чтобы не рябило на плотных дисплеях
  const FILE_SCALE = 1;      // файл: ровно печатное разрешение, 8 точек на мм
  const PRINT_SCALE = 3;     // ~609 dpi, кратно 203 — модули остаются целыми
  const QUIET = 4;           // пустое поле вокруг кода, в модулях
  const MAX_AT_ONCE = 30;

  function mm(value, scale) {
    return Math.round(value * DOTS_PER_MM * scale);
  }

  // Номер разбит по смыслу: XX — категория, YY — модель, ZZ — экземпляр.
  // Так его и диктуют по телефону, и набирают руками, и сверяют глазами.
  function groupedId(itemId) {
    const digits = String(itemId).replace(/\D/g, "");
    if (digits.length !== 6) return String(itemId);
    return digits.slice(0, 2) + " " + digits.slice(2, 4) + " " + digits.slice(4, 6);
  }

  // Подбираем кегль так, чтобы название влезло в отведённые строки целиком.
  // Обрезать его многоточием хуже: у моделей одной серии различается как раз
  // хвост — «SIRIUS 100CM» и «SIRIUS 60CM».
  function fitText(ctx, text, maxWidth, startPx, maxLines, weight) {
    let px = startPx;
    while (px > startPx * 0.6) {
      ctx.font = weight + " " + Math.round(px) + "px " + FONT_SANS;
      const rows = wrapText(ctx, text, maxWidth);
      if (rows.length <= maxLines) return { px: Math.round(px), rows };
      px -= Math.max(1, startPx * 0.06);
    }
    ctx.font = weight + " " + Math.round(px) + "px " + FONT_SANS;
    return { px: Math.round(px), rows: wrapText(ctx, text, maxWidth).slice(0, maxLines) };
  }

  const FONT_SANS = '"Helvetica Neue", Arial, sans-serif';
  const FONT_MONO = 'Menlo, Consolas, "Courier New", monospace';

  function labelCanvas(item, size, captionText, scale) {
    const k = scale || 1;
    const canvas = document.createElement("canvas");
    canvas.width = mm(size.w, k);
    canvas.height = mm(size.h, k);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    ctx.textBaseline = "top";

    // Рамка со скруглением. У высечки этикетки углы закруглены, и прямоугольная
    // вёрстка на ней выглядит обрезанной: содержимое упирается в скос. Рамка
    // повторяет высечку и заодно собирает этикетку в законченный блок — видно,
    // где она кончается, даже когда наклеена на чёрный кофр.
    // Отступ рамки от края щедрый: термопринтер тянет ленту с погрешностью в
    // полмиллиметра, и линия впритык к краю уехала бы на одном боку.
    const edge = mm(Math.max(0.8, size.pad * 0.55), k);
    const radius = mm(1.4, k);
    const stroke = Math.max(1, Math.round(mm(0.25, k)));
    roundRect(ctx, edge + stroke / 2, edge + stroke / 2,
              canvas.width - (edge + stroke / 2) * 2, canvas.height - (edge + stroke / 2) * 2,
              radius);
    ctx.lineWidth = stroke;
    ctx.strokeStyle = "#000000";
    ctx.stroke();
    // Всё дальнейшее режется по той же рамке: ни одна подпись не вылезет за неё
    // даже на самой мелкой ленте.
    ctx.save();
    ctx.clip();

    const pad = edge + stroke + mm(Math.max(0.7, size.pad * 0.5), k);
    const gap = mm(size.pad * 0.45, k);
    const inner = canvas.width - pad * 2;

    // 1. Название сверху. Две строки, если помещается; на самой мелкой ленте
    //    ужимается до одной — см. бюджет ниже.
    const name = String(item.name || "").toUpperCase();
    const fitName = (lines) => name
      ? fitText(ctx, name, inner, mm(size.name, k), lines, "bold")
      : { px: 0, rows: [] };
    let fitted = fitName(2);
    let nameLine = Math.round(fitted.px * 1.06);
    let nameHeight = fitted.rows.length * nameLine;

    // 2. Низ: плашка с номером и подписи под ней. Считаем заранее, чтобы знать,
    //    сколько высоты остаётся коду.
    const numPx = mm(size.num, k);
    const chipPadY = Math.round(numPx * 0.22);
    const chipH = Math.round(numPx * 1.2) + chipPadY * 2;
    const orgPx = mm(size.org, k);
    const orgLine = Math.round(orgPx * 1.25);
    const bottomLines = [];
    if (size.category) bottomLines.push(categoryLabel(item.category));
    if (size.caption && captionText) bottomLines.push(String(captionText));

    // 3. Бюджет высоты. Код не может быть меньше четырёх точек на модуль —
    //    ниже этого края замываются и телефон читает через раз. Если всё сразу
    //    не помещается, жертвуем подписями снизу, а не кодом: подпись читают
    //    глазами и она одинакова на всех этикетках, а код — рабочий инструмент.
    const modules = 21 + QUIET * 2;
    const minDot = 4 * k;
    const innerH = canvas.height - pad * 2;
    const ruleH = () => (fitted.rows.length ? Math.round(gap * 0.7) + stroke : 0);
    const bottomH = () => chipH + bottomLines.length * orgLine + (bottomLines.length ? Math.round(gap * 0.5) : 0);
    const fits = () => nameHeight + ruleH() + bottomH() + gap * 2 + modules * minDot <= innerH;

    // Порядок, в котором жертвуем местом, когда лента мелкая:
    //  1) категория — она и так закодирована первыми двумя цифрами номера;
    //  2) вторая строка названия — модель узнают и по первой, а на приборе она
    //     обычно написана и без нас;
    //  3) и только в самом конце подпись колледжа. По ней вещь возвращают,
    //     когда она уехала со съёмок в чужой сумке, — из номера она не
    //     выводится ничем.
    if (!fits() && bottomLines.length > 1) bottomLines.shift();
    if (!fits() && fitted.rows.length > 1) {
      fitted = fitName(1);
      nameLine = Math.round(fitted.px * 1.06);
      nameHeight = fitted.rows.length * nameLine;
    }
    while (!fits() && bottomLines.length) bottomLines.shift();

    const free = innerH - nameHeight - ruleH() - bottomH() - gap * 2;
    const dot = Math.max(1, Math.floor(Math.min(inner, free) / modules));
    const qrSide = dot * modules;

    const qrCanvas = document.createElement("canvas");
    QR.render(qrCanvas, item.item_id, dot, QUIET);
    ctx.imageSmoothingEnabled = false;

    // Раскладываем сверху вниз, а свободный остаток отдаём воздуху вокруг кода.
    let y = pad;
    ctx.fillStyle = "#000000";
    fitted.rows.forEach((row) => {
      ctx.font = "bold " + fitted.px + "px " + FONT_SANS;
      ctx.textAlign = "center";
      ctx.fillText(row, canvas.width / 2, y);
      y += nameLine;
    });

    // Линия под названием: отделяет «что это» от «как это найти». Без неё
    // название и код висели в одном пустом поле и читались как один блок.
    if (ruleH()) {
      const ruleW = Math.round(inner * 0.45);
      y += Math.round(gap * 0.7);
      ctx.fillRect(Math.round((canvas.width - ruleW) / 2), y, ruleW, stroke);
      y += stroke;
    }

    // Остаток высоты делим поровну над и под кодом. Сам код уже взял из него
    // всё, что мог (dot выше), так что делить остаётся считанные точки.
    const spare = Math.max(0, free - qrSide);
    y += gap + Math.round(spare / 2);
    ctx.drawImage(qrCanvas, Math.round((canvas.width - qrSide) / 2), y, qrSide, qrSide);
    // Низ отсчитываем от нижнего края, а не накопленной суммой: округления по
    // дороге сдвигали бы подпись на пиксель-другой и на мелкой ленте её
    // срезало краем.
    y = canvas.height - pad - bottomH();

    // Плашка с номером: выворотка читается на полке быстрее всего.
    const text = groupedId(item.item_id);
    ctx.font = "bold " + numPx + "px " + FONT_MONO;
    const textW = ctx.measureText(text).width;
    const chipW = Math.min(inner, Math.round(textW + numPx * 0.8));
    const chipX = Math.round((canvas.width - chipW) / 2);
    roundRect(ctx, chipX, y, chipW, chipH, Math.round(chipH * 0.28));
    ctx.fillStyle = "#000000";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.fillText(text, canvas.width / 2, y + chipPadY);
    y += chipH;

    ctx.fillStyle = "#000000";
    if (bottomLines.length) {
      y += Math.round(gap * 0.5);
      ctx.font = orgPx + "px " + FONT_SANS;
      bottomLines.forEach((line) => {
        ctx.fillText(line, canvas.width / 2, y);
        y += Math.round(orgPx * 1.25);
      });
    }
    ctx.textAlign = "left";
    ctx.restore();
    // Отдаём измеренную геометрию: так о ней можно спросить, а не вычислять её
    // обратно из картинки.
    canvas.dataset.qrMm = (qrSide / (DOTS_PER_MM * k)).toFixed(2);
    canvas.dataset.dot = String(Math.round(dot / k));
    canvas.dataset.bottomLines = String(bottomLines.length);
    return canvas;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
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
    return rows;
  }

  // Сохранение идёт двумя разными путями, и это не прихоть.
  //
  // В обычном браузере работает <a download>: файлы просто падают в загрузки.
  //
  // Внутри Telegram атрибут download не поддерживается — вебвью вместо
  // сохранения УХОДИТ по ссылке и показывает голый файл без кнопки «назад».
  // Поэтому там его не трогаем вовсе: одну этикетку показываем во весь экран
  // (сохраняется долгим нажатием), пачку отправляет бот в чат склада одним
  // архивом. Прямого сохранения пачки из мини-приложения не существует:
  // WebApp.downloadFile умеет только https-адреса, а наши этикетки рисуются
  // на устройстве и адреса не имеют.
  function fileName(item, size) {
    return "mifs-" + item.item_id + "-" + size.w + "x" + size.h + "mm.png";
  }

  function saveImages() {
    if (!items.length) {
      TG.showAlert("Нечего сохранять: под фильтры ничего не попало");
      return;
    }
    if (items.length > MAX_AT_ONCE) {
      TG.showAlert("Сразу столько файлов не отдать. Сузьте фильтры до " +
        MAX_AT_ONCE + " позиций — или печатайте кнопкой «Печать».");
      return;
    }
    const size = SIZES[sizeKey];

    if (!TG.isAvailable()) {
      // По одному файлу с паузой: браузеры глушат пачку скачиваний подряд.
      items.forEach((item, index) => {
        setTimeout(() => {
          QR.downloadCanvas(labelCanvas(item, size, caption(), FILE_SCALE), fileName(item, size));
        }, index * 300);
      });
      return;
    }

    if (items.length === 1) {
      const btn = document.getElementById("labels-save");
      saveImageFor(labelCanvas(items[0], size, caption(), FILE_SCALE),
                   fileName(items[0], size), items[0].name, btn);
      return;
    }
    sendToChat(size);
  }

  async function sendToChat(size) {
    const btn = document.getElementById("labels-save");
    const before = btn ? btn.textContent : "";
    // Молчащая кнопка на запросе в 5–8 секунд читается как зависшая — это мы
    // уже проходили на «Завершить» в сверке.
    if (btn) { btn.disabled = true; btn.textContent = "Отправляем…"; }
    try {
      const files = items.map((item) => ({
        name: fileName(item, size),
        // Только сами данные, без приставки data:image/png;base64,
        png_base64: labelCanvas(item, size, caption(), FILE_SCALE)
          .toDataURL("image/png").split(",")[1],
      }));
      const res = await apiPost("/labels/send", { files });
      TG.hapticSuccess();
      TG.showAlert(res.message || "Отправлено в чат склада.");
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message || "Не получилось отправить");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = before; }
    }
  }

  function init() {
    Router.register("labels", { onShow });
  }

  // Этикетка для любой вещи, в выбранном на этом экране размере и с текущей
  // подписью. Нужна карточке предмета и каталогу: они отдавали голый QR, а
  // человеку нужна этикетка — та самая, которую он наклеит.
  // Размер берём из хранилища через savedSize(), а не из переменной sizeKey:
  // экран «Этикетки» мог быть ни разу не открыт, и переменная тогда пустая.
  function labelFor(item) {
    return labelCanvas(item, SIZES[savedSize()], caption(), FILE_SCALE);
  }

  function labelFileName(item) {
    const size = SIZES[savedSize()];
    return fileName(item, size);
  }

  // Отрисовщик наружу: демо-лист с образцами печатается тем же кодом, что и
  // склад. Иначе «на демо было так» и «печатается вот так» однажды разойдутся.
  return { init, SIZES, labelCanvas, labelFor, labelFileName };
})();
