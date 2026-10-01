// Экран «Этикетки»: печать QR на термопринтер этикеток.
//
// У термопринтера страница И ЕСТЬ этикетка, одна на страницу: размер задаётся
// через @page под каждый формат, этикетки разделяются разрывом страницы.
//
// Размер QR. Номер из шести цифр — это QR версии 1, 21×21 модуль. Принтеры
// обычно 203 dpi (8 точек на мм), и модуль должен попадать в целое число точек,
// иначе края замываются. 4 точки на модуль = 0,5 мм, плюс поле по 4 модуля с
// краёв — около 14 мм. Меньше 12 мм не сканируется уверенно.

const LabelsScreen = (() => {
  const CAPTION_KEY = "mifs_label_caption";
  const SIZE_KEY = "mifs_label_size";
  const DEFAULT_CAPTION = "Киноколледж №40";

  // Вертикальная лента: название сверху, QR посередине, снизу номер плашкой; подпись колледжа бежит строкой по кругу вдоль рамки.
  // Размеры — ходовые у Niimbot и Phomemo. Кегли заданы в миллиметрах:
  // этикетка печатается в физическом размере, и «пункты» здесь ничего не
  // значат. org — опорный кегль подписи по рамке (сама она ещё мельче, чтобы
  // не спорить с названием), а на мелкой ленте ужимается сама, чтобы целиком
  // влезть на короткую сторону.
  const SIZES = {
    v20x30: { label: "20×30", w: 20, h: 30, pad: 1.2, name: 1.9, num: 3.0, org: 1.7, caption: true },
    v30x40: { label: "30×40", w: 30, h: 40, pad: 1.5, name: 2.5, num: 4.0, org: 2.0, caption: true },
    v30x50: { label: "30×50", w: 30, h: 50, pad: 1.5, name: 2.8, num: 4.6, org: 2.2, caption: true },
    v40x60: { label: "40×60", w: 40, h: 60, pad: 2.0, name: 3.4, num: 5.6, org: 2.6, caption: true },
  };
  const DEFAULT_SIZE = "v30x40";

  let items = [];          // что печатаем
  let sizeKey = DEFAULT_SIZE;
  let singleItemId = null; // пришли из карточки предмета
  let catalogError = "";   // каталог не подтянулся — что ответил сервер

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

  // Каталога в кэше нет — тянем его сами (Cache.ensure, как ensureItemsMap в
  // order.js), а не отправляем человека в «Каталог» и обратно.
  function onShow(params) {
    singleItemId = params && params.itemId ? params.itemId : null;
    sizeKey = savedSize();
    catalogError = "";
    render();
    if (!Cache.items("equipment")) {
      Cache.ensure("equipment", "/equipment/list", { category: "all", status: "all" })
        .then(() => {
          if (!Cache.items("equipment")) catalogError = "Каталог загрузился, но не сохранился на телефоне.";
          render();
        })
        .catch((err) => { catalogError = err.message; render(); });
    }
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
      if (catalogError) {
        box.innerHTML = `<div class="error-box">${escapeHtml(catalogError)}</div>`;
      } else if (!Cache.items("equipment")) {
        box.innerHTML = skeleton(3);   // onShow уже тянет каталог
      } else {
        box.innerHTML = `<p class="empty">${singleItemId
          ? `Позиции ${escapeHtml(singleItemId)} нет в каталоге. Обновите «Каталог» и возвращайтесь.`
          : "В каталоге нет ни одной позиции."}</p>`;
      }
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
      <p class="hint">Бежит строкой по кругу вдоль рамки.</p>
      ${singleItemId ? "" : `
      <div class="searchbar">
        <input type="search" id="labels-search" placeholder="Поиск по названию или номеру"
               autocapitalize="off" autocorrect="off" spellcheck="false" />
        <div class="filters">
          <select id="labels-filter-category"></select>
          <select id="labels-filter-status"></select>
        </div>
      </div>`}
      <p id="labels-count" class="hint"></p>
      <button class="btn" id="labels-print">Печать</button>
      <button class="btn btn--secondary" id="labels-save">Сохранить картинками</button>
      <p class="hint">При печати ставьте масштаб 100%, иначе размеры уедут.
      Bluetooth-принтеры (Niimbot, Phomemo) из браузера не печатают — для них
      сохраните картинками.</p>
      <p class="hint">Из Telegram скачать и напечатать нельзя: «Сохранить»
      откроет лист «Поделиться», а если его нет — покажет картинку во весь
      экран. Сохраняйте по одной; пачкой и для печати откройте приложение в Safari.</p>
      <div class="section-title">Размер в настоящую величину</div>
      <div class="size-row" id="labels-sizes"></div>
      <p class="hint">Нажмите на размер, чтобы взять его, на образец ниже —
      чтобы рассмотреть. Ряд прокручивается вбок.</p>
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
        ? "Скачать напрямую из Telegram нельзя — кнопка откроет системный лист «Поделиться», а если его нет — покажет картинку во весь экран (удерживайте, чтобы сохранить)."
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
  // хвост — «SIRIUS 100CM» и «SIRIUS 60CM». Поэтому многоточие — только когда
  // не помогло и ужатие кегля.
  function fitText(ctx, text, maxWidth, startPx, maxLines, weight) {
    let px = startPx;
    while (px > startPx * 0.6) {
      ctx.font = weight + " " + Math.round(px) + "px " + FONT_SANS;
      const rows = wrapText(ctx, text, maxWidth);
      if (rows.length <= maxLines) return { px: Math.round(px), rows };
      px -= Math.max(1, startPx * 0.06);
    }
    ctx.font = weight + " " + Math.round(px) + "px " + FONT_SANS;
    // Не влезло и в самом мелком кегле. Молча отрезать хвост нельзя — на
    // этикетке оставалось «…KIT WITH», и казалось, что так модель и зовётся.
    // Ставим многоточие: видно, что название длиннее.
    const all = wrapText(ctx, text, maxWidth);
    if (all.length <= maxLines) return { px: Math.round(px), rows: all };
    const rows = all.slice(0, maxLines);
    let last = rows[rows.length - 1] + "…";
    while (last.length > 1 && ctx.measureText(last).width > maxWidth) last = last.slice(0, -2).trimEnd() + "…";
    rows[rows.length - 1] = last;
    return { px: Math.round(px), rows, cut: true };
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
    const stroke = Math.max(1, Math.round(mm(0.25, k)));

    // Подпись колледжа — лентой по кругу вдоль рамки. Раньше она стояла
    // строкой под номером (а на снимке владельца — столбиками по бокам кода) и
    // отнимала у кода то высоту, то ширину. По кругу она занимает полосу,
    // которая и так уходила на поля, а потерять её с этикетки нельзя: по ней
    // вещь возвращают, когда она уехала со съёмок в чужой сумке.
    const frameIn = edge + stroke;
    const box = { x: frameIn, y: frameIn, w: canvas.width - frameIn * 2, h: canvas.height - frameIn * 2 };
    const ribbonText = size.caption && captionText ? String(captionText).trim().toUpperCase() : "";
    const ribbon = ribbonText ? fitRibbon(ctx, ribbonText, box, mm(size.org * 0.68, k), k) : null;
    const band = ribbon ? ribbon.band : 0;

    // Скругление рамки — под ленту: средняя линия ленты идёт параллельно рамке,
    // и её дуга в углу должна быть не круче высоты буквы, иначе буквы на
    // повороте налезают друг на друга. Без ленты — прежние 1,4 мм.
    const lift = stroke / 2 + band / 2;   // от линии рамки до середины ленты
    const radius = ribbon ? Math.max(mm(1.4, k), lift + band * 0.8) : mm(1.4, k);
    if (ribbon) ribbon.r = radius - lift;
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

    // Поля внутри ленты небольшие: у кода своё белое поле в четыре модуля,
    // и оно же отделяет его от ленты. Без ленты — прежние поля.
    const pad = ribbon
      ? frameIn + band + mm(Math.max(0.4, size.pad * 0.3), k)
      : frameIn + mm(Math.max(0.7, size.pad * 0.5), k);
    const gap = mm(size.pad * 0.45, k);
    const inner = canvas.width - pad * 2;
    // Код может встать вплотную к ленте: его белое поле и есть отступ.
    const qrRoom = canvas.width - (frameIn + band) * 2;

    // 1. Название сверху. Две строки, если помещается; на самой мелкой ленте
    //    ужимается до одной — см. бюджет ниже.
    const name = String(item.name || "").toUpperCase();
    const fitName = (lines) => name
      ? fitText(ctx, name, inner, mm(size.name, k), lines, "bold")
      : { px: 0, rows: [] };
    // Длинное название, которое в две строки влезает только с многоточием,
    // пробуем в три: с лентой по рамке строка стала уже. Лишнюю строку бюджет
    // ниже снимет первой.
    let fitted = fitName(2);
    if (fitted.cut) fitted = fitName(3);
    let nameLine = Math.round(fitted.px * 1.06);
    let nameHeight = fitted.rows.length * nameLine;

    // 2. Низ: плашка с номером.
    //    Считаем заранее, чтобы знать, сколько высоты остаётся коду.
    // Лента по рамке забирает ширину, и номер в прежнем кегле вылезал за
    // плашку. Кегль номера ужимаем до ширины поля, плашку — вместе с ним.
    let numPx = mm(size.num, k);
    ctx.font = "bold " + numPx + "px " + FONT_MONO;
    const numW = ctx.measureText(groupedId(item.item_id)).width;
    if (numW + numPx * 0.8 > inner) numPx = Math.floor(numPx * inner / (numW + numPx * 0.8));
    const chipPadY = Math.round(numPx * 0.22);
    const chipH = Math.round(numPx * 1.2) + chipPadY * 2;

    // 3. Бюджет высоты. Код не может быть меньше четырёх точек на модуль —
    //    ниже этого края замываются и телефон читает через раз. Если всё сразу
    //    не помещается, жертвуем подписями, а не кодом: подпись читают
    //    глазами, а код — рабочий инструмент.
    const modules = 21 + QUIET * 2;
    const minDot = 4 * k;
    const innerH = canvas.height - pad * 2;
    const ruleH = () => (fitted.rows.length ? Math.round(gap * 0.7) + stroke : 0);
    const fits = () => nameHeight + ruleH() + chipH + gap * 2 + modules * minDot <= innerH;

    // Порядок, в котором жертвуем местом, когда лента мелкая:
    //  0) третья строка длинного названия — с многоточием оно всё равно узнаётся;
    //  1) вторая строка названия — модель узнают и по первой, а на приборе она
    //     обычно написана и без нас.
    //  Подпись колледжа по рамке места у кода не отнимает и не убирается.
    const refit = (lines) => {
      fitted = fitName(lines);
      nameLine = Math.round(fitted.px * 1.06);
      nameHeight = fitted.rows.length * nameLine;
    };
    if (!fits() && fitted.rows.length > 2) refit(2);
    if (!fits() && fitted.rows.length > 1) refit(1);

    const freeNow = () => innerH - nameHeight - ruleH() - chipH - gap * 2;
    const dotNow = () => Math.max(1, Math.floor(Math.min(qrRoom, freeNow()) / modules));
    // Третья строка названия не стоит ни одной точки модуля: код — рабочий
    // инструмент, а название с многоточием всё равно узнаётся.
    if (fitted.rows.length > 2) {
      const with3 = dotNow();
      refit(2);
      if (dotNow() <= with3) refit(3);
    }

    const free = freeNow();
    const dot = dotNow();
    const qrSide = dot * modules;

    const qrCanvas = document.createElement("canvas");
    QR.render(qrCanvas, item.item_id, dot, QUIET);
    ctx.imageSmoothingEnabled = false;

    if (ribbon) drawRibbon(ctx, ribbonText, box, ribbon, k);

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

    // Остаток высоты делим поровну над и под кодом. Сам код уже
    // взял из него всё, что мог (dot выше), так что делить остаётся считанные
    // точки.
    const spare = Math.max(0, free - qrSide);
    y += gap + Math.round(spare / 2);
    ctx.drawImage(qrCanvas, Math.round((canvas.width - qrSide) / 2), y, qrSide, qrSide);
    y += qrSide;

    // Категории на этикетке нет: что это камера, видно и так, а в номере она
    // всё равно закодирована первыми двумя цифрами. Её место отдано коду.

    // Плашку отсчитываем от нижнего края, а не накопленной суммой: округления
    // по дороге сдвигали бы её на пиксель-другой и на мелкой ленте её срезало
    // бы краем.
    y = canvas.height - pad - chipH;

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
    ctx.fillStyle = "#000000";
    ctx.textAlign = "left";
    ctx.restore();
    // Отдаём измеренную геометрию: так о ней можно спросить, а не вычислять её
    // обратно из картинки.
    canvas.dataset.qrMm = (qrSide / (DOTS_PER_MM * k)).toFixed(2);
    canvas.dataset.dot = String(Math.round(dot / k));
    canvas.dataset.ribbonPx = ribbon ? String(Math.round(ribbon.px / k)) : "0";
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

  // --- Подпись по рамке ---
  //
  // Одна непрерывная строка по контуру рамки, по часовой стрелке, верхом
  // наружу — как надпись по краю монеты: сверху читается как обычно, справа —
  // сверху вниз, снизу — вверх ногами, слева — снизу вверх. На скруглениях
  // буквы поворачиваются вместе с рамкой, поэтому строка нигде не рвётся.
  // Между повторами — точка; повторов целое число, и лишняя длина контура
  // раздаётся поровну в разрядку, так что стык нигде не виден.
  //
  // Кегль подбираем так, чтобы подпись целиком влезла хотя бы на короткую
  // сторону. Начертание — курсив средней жирности в разрядку: лента должна
  // читаться фоном и не сливаться с названием и номером (жирная прямая
  // смешивалась с ними в кашу). Тоньше 500 не берём — на мелком кегле
  // термопринтер теряет штрихи тоньше полутора точек. Буквы ставим по одной: свойства
  // letterSpacing у холста в старом Safari нет.
  function ribbonFont(px) {
    return "italic 500 " + px + "px " + FONT_SANS;
  }

  function fitRibbon(ctx, text, box, startPx, k) {
    const floor = mm(1.2, k);
    let px = startPx;
    for (;;) {
      ctx.font = ribbonFont(px);
      const band = Math.round(px * 1.25);
      const run = Math.min(box.w, box.h) - band * 2;
      if (ctx.measureText(text).width <= run || px <= floor) return { px, band };
      px -= Math.max(1, Math.round(k / 2));
    }
  }

  // Средняя линия ленты — скруглённый прямоугольник; точка на нём по длине
  // пути s (от левого конца верхней прямой) и направление касательной.
  function ribbonPath(box, half, r) {
    const x0 = box.x + half, y0 = box.y + half;
    const w = box.w - half * 2, h = box.h - half * 2;
    const sw = w - r * 2, sh = h - r * 2, arc = Math.PI * r / 2;
    // Прямые и дуги по часовой стрелке. У дуги — центр и начальный угол.
    const segs = [
      { len: sw, x: x0 + r, y: y0, a: 0 },
      { len: arc, cx: x0 + w - r, cy: y0 + r, a0: -Math.PI / 2 },
      { len: sh, x: x0 + w, y: y0 + r, a: Math.PI / 2 },
      { len: arc, cx: x0 + w - r, cy: y0 + h - r, a0: 0 },
      { len: sw, x: x0 + w - r, y: y0 + h, a: Math.PI },
      { len: arc, cx: x0 + r, cy: y0 + h - r, a0: Math.PI / 2 },
      { len: sh, x: x0, y: y0 + h - r, a: -Math.PI / 2 },
      { len: arc, cx: x0 + r, cy: y0 + r, a0: Math.PI },
    ];
    const total = segs.reduce((t, g) => t + g.len, 0);
    const at = (s) => {
      s = ((s % total) + total) % total;
      for (const g of segs) {
        if (s <= g.len || g === segs[segs.length - 1]) {
          if (g.cx === undefined) {
            return { x: g.x + Math.cos(g.a) * s, y: g.y + Math.sin(g.a) * s, a: g.a };
          }
          const t = g.a0 + (r ? s / r : 0);
          return { x: g.cx + Math.cos(t) * r, y: g.cy + Math.sin(t) * r, a: t + Math.PI / 2 };
        }
        s -= g.len;
      }
      return { x: x0, y: y0, a: 0 };
    };
    return { total, at, topMid: sw / 2 };
  }

  function drawRibbon(ctx, text, box, ribbon, k) {
    const { px, band } = ribbon;
    const r = Math.max(0, ribbon.r || 0);
    ctx.save();
    ctx.font = ribbonFont(px);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#000000";
    const glyphs = Array.from(text);
    const adv = glyphs.map((g) => ctx.measureText(g).width);
    const unitW = adv.reduce((a, b) => a + b, 0);
    const m = ctx.measureText("КНЖ№");
    const capH = m.actualBoundingBoxAscent || px * 0.72;
    // Точка-разделитель: не тоньше двух точек принтера, иначе пропадает.
    const dotR = Math.max(k, px * 0.11);

    const path = ribbonPath(box, band / 2, r);
    // Повтор = буквы + просвет с точкой. Просвет естественный — в высоту
    // полосы; разрядка не больше четверти кегля, остальное уходит в просвет.
    const gapNat = band;
    // Повторов — сколько влезает без сжатия: тесная подпись на мелком кегле
    // слипается при печати, а лишняя длина уйдёт в разрядку.
    const n = Math.max(1, Math.floor(path.total / (unitW + gapNat)));
    const slot = path.total / n;
    const inner = glyphs.length - 1;
    let track = inner ? (slot - unitW - gapNat) / inner : 0;
    track = Math.max(-px * 0.05, Math.min(px * 0.4, track));
    const runW = unitW + track * inner;
    const gapW = slot - runW;

    // Первый повтор — посередине верхней стороны: её читают первой.
    let s = path.topMid - runW / 2;
    for (let u = 0; u < n; u++) {
      glyphs.forEach((g, i) => {
        const p = path.at(s + adv[i] / 2);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        ctx.fillText(g, -adv[i] / 2, capH / 2);
        ctx.restore();
        s += adv[i] + (i < inner ? track : 0);
      });
      const d = path.at(s + gapW / 2);
      ctx.beginPath();
      ctx.arc(d.x, d.y, dotR, 0, Math.PI * 2);
      ctx.fill();
      s += gapW;
    }
    ctx.restore();
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
  // (сохраняется долгим нажатием), а пачку не сохраняем вовсе — в чат
  // картинки не уходят. Прямого сохранения пачки из мини-приложения не существует:
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
    TG.showAlert("Пачкой внутри Telegram не сохранить. Сохраняйте по одной, " +
      "печатайте кнопкой «Печать» или откройте приложение в браузере.");
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
