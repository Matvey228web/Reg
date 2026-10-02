// Генерация QR-кода на canvas (библиотека qrcode-generator, подключена в index.html)
// и обёртка над нативным сканером Telegram для единообразного вызова из экранов.

const QR = (() => {
  // quiet — пустое поле вокруг кода в модулях. По стандарту его нужно четыре с
  // каждой стороны, иначе сканер не находит код на пёстром фоне. На экране и на
  // белой этикетке поле обычно даёт сама подложка, поэтому по умолчанию ноль;
  // там, где код кладут на готовую картинку, поле нужно рисовать самим.
  function render(canvas, text, moduleSize = 8, quiet = 0) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const total = count + quiet * 2;
    const size = total * moduleSize;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect((col + quiet) * moduleSize, (row + quiet) * moduleSize, moduleSize, moduleSize);
        }
      }
    }
    return { count, total, moduleSize, size };
  }

  function downloadCanvas(canvas, filename) {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, "image/png");
  }

  // QR во весь экран. На iPhone внутри Telegram скачивание файла из
  // мини-приложения часто блокируется вебвью, поэтому единственный надёжный
  // способ получить код «в руки» — показать его крупно и снять другим
  // телефоном. Заодно так удобно проверять сканер на своей же технике.
  function showFullscreen(text, caption) {
    const overlay = document.createElement("div");
    overlay.className = "qr-overlay";
    overlay.innerHTML = `
      <div class="qr-overlay-inner">
        <canvas id="qr-overlay-canvas"></canvas>
        <div class="qr-overlay-id">${escapeHtml(text)}</div>
        ${caption ? `<div class="qr-overlay-caption">${escapeHtml(caption)}</div>` : ""}
        <button class="btn" id="qr-overlay-close">Закрыть</button>
      </div>`;
    document.body.appendChild(overlay);

    // Размер под ширину экрана, но кратно модулям — иначе края размываются
    const side = Math.min(window.innerWidth - 48, 420);
    render(document.getElementById("qr-overlay-canvas"), text, Math.max(4, Math.floor(side / 29)));

    const close = () => overlay.remove();
    document.getElementById("qr-overlay-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  }

  // --- Как отдать картинку человеку ---
  //
  // Одного способа не существует, и это не наша недоделка.
  //
  //   1. Обычный браузер — <a download>, файл падает в загрузки. Работает.
  //   2. Внутри Telegram скачивание не работает вовсе: атрибут download вебвью
  //      не поддерживает, и вместо сохранения он уходит по ссылке и показывает
  //      голый файл без кнопки «назад». Удержание картинки тоже не работает —
  //      системное меню «Сохранить в Фото» вебвью Telegram не показывает.
  //      Остаётся системный лист «Поделиться» через navigator.share: оттуда
  //      «Сохранить в Фото» есть.
  //   3. Если и листа нет — картинку показываем во весь экран (showImage),
  //      человек сохраняет её долгим нажатием. В чат картинки не уходят.
  //
  // Файл собираем СИНХРОННО из data-URL, а не через canvas.toBlob: toBlob
  // асинхронный, и к моменту вызова share жест пользователя уже «протух» —
  // iOS такой вызов отклоняет.
  function canvasToFile(canvas, filename) {
    try {
      var bin = atob(canvas.toDataURL("image/png").split(",")[1]);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], filename, { type: "image/png" });
    } catch (e) {
      return null;
    }
  }

  // Возвращает, каким путём ушло: download | share | cancelled | image.
  // Вызывающий решает, что сказать человеку: у листа «Поделиться» и у
  // картинки во весь экран обратная связь своя.
  async function deliverCanvas(canvas, filename, title) {
    if (!TG.isAvailable()) {
      downloadCanvas(canvas, filename);
      return "download";
    }

    var file = canvasToFile(canvas, filename);
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: title || filename });
        return "share";
      } catch (e) {
        // Человек закрыл лист — это не ошибка и не повод показывать картинку.
        if (e && e.name === "AbortError") return "cancelled";
      }
    }

    showImage(canvas, title || filename, "Удерживайте картинку, чтобы сохранить.");
    return "image";
  }

  // Картинка во весь экран. Отдельно от showFullscreen, потому что показываем
  // не QR, а готовую этикетку, и показываем именно <img>, а не <canvas>:
  // по картинке в вебвью работает долгое нажатие с системным «Сохранить в Фото»
  // и «Поделиться», по холсту — нет. Это единственный способ достать файл из
  // мини-приложения на устройство: атрибут download внутри Telegram не работает,
  // вебвью вместо сохранения уходит по ссылке и показывает голый файл без
  // кнопки «назад».
  function showImage(canvas, title, note, onSave) {
    const overlay = document.createElement("div");
    overlay.className = "qr-overlay";
    overlay.innerHTML = `
      <div class="qr-overlay-inner">
        <img class="qr-overlay-img" alt="${escapeHtml(title || "")}" />
        ${title ? `<div class="qr-overlay-title">${escapeHtml(title)}</div>` : ""}
        ${note ? `<div class="qr-overlay-caption">${escapeHtml(note)}</div>` : ""}
        ${onSave ? `<button class="btn" id="qr-overlay-save">Сохранить картинку</button>` : ""}
        <button class="btn btn--secondary" id="qr-overlay-close">Закрыть</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector(".qr-overlay-img").src = canvas.toDataURL("image/png");

    const close = () => overlay.remove();
    document.getElementById("qr-overlay-close").addEventListener("click", close);
    if (onSave) document.getElementById("qr-overlay-save").addEventListener("click", onSave);
    // По самой картинке не закрываем: случайный тап не должен убирать то,
    // что человек рассматривает.
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    return overlay;
  }

  // scan(onResult): onResult(code | null, error | null)
  function scan(onResult) {
    TG.scanQr("Наведите камеру на QR-код оборудования", onResult);
  }

  // Для сверки склада: сканируем подряд, не закрывая окно после каждого кода.
  function scanContinuous(text, onCode) {
    return TG.scanQrContinuous(text, onCode);
  }

  function stopScan() {
    TG.closeScanQr();
  }

  // На этикетке номер напечатан группами — «01 01 01»: так его диктуют и
  // набирают. Пробелы и дефисы поэтому просто выкидываем, иначе человек вводит
  // ровно то, что видит, и получает «предмет не найден».
  function normalize(raw) {
    return String(raw == null ? "" : raw).replace(/[\s\-]/g, "");
  }

  // showScanQrPopup в SDK есть на всех платформах, но камера — только у
  // телефона: на Telegram Desktop и в веб-версии окно сканера не открывается.
  // «unknown» — страница открыта не из Telegram (обычный браузер).
  const DESKTOP = ["tdesktop", "web", "weba", "webk", "macos", "unknown"];

  function isDesktop() {
    return DESKTOP.indexOf(TG.platform()) !== -1;
  }

  function canCamera() {
    return TG.hasScanQr() && !isDesktop();
  }

  // Сканер штрихкодов (USB или Bluetooth) притворяется клавиатурой: печатает
  // номер и жмёт Enter. Отличаем его от человека по скорости: сканер выдаёт
  // знак за 5–30 мс, человек — за 100 мс и дольше.
  const WEDGE_GAP = 50;    // быстрее этого человек не печатает
  const WEDGE_IDLE = 100;  // столько тишины — и очередь сброшена
  // Первые знаки ещё нельзя отличить от человеческих, и они попадают в поле.
  // Перехватываем с третьего: два быстрых нажатия у человека бывают, три — нет.
  const WEDGE_MIN = 3;

  // wedge(onCode, when): onCode(code) — на каждый номер от сканера.
  // when(target) — брать ли очередь, начатую в этом элементе; без него берём
  // любую. Возвращает отписку.
  function wedge(onCode, when) {
    let buf = "", last = 0, held = false, field = null, before = null, timer = null;

    function reset() {
      clearTimeout(timer);
      buf = ""; held = false; field = null; before = null;
    }

    // Вернуть поле к тому, что было до очереди. С text — как если бы его
    // напечатали руками, без text — как будто очереди не было вовсе.
    function restore(text) {
      if (!field || !before) return;
      const typed = text == null ? before.value
        : before.value.slice(0, before.start) + text + before.value.slice(before.end);
      const at = text == null ? before.end : before.start + text.length;
      field.value = typed;
      try { field.setSelectionRange(at, at); } catch (ignored) {}
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Очередь кончилась без Enter: сканер так не делает, но если это был он
    // без суффикса — перехваченные знаки возвращаем в поле, а не теряем.
    function idle() {
      if (held) restore(buf);
      reset();
    }

    function onKey(e) {
      const now = Date.now();
      if (e.key === "Enter") {
        if (buf.length >= WEDGE_MIN && now - last < WEDGE_IDLE) {
          // Иначе Enter дойдёт до поля и кнопок, и номер примут второй раз.
          e.preventDefault();
          e.stopPropagation();
          const code = normalize(buf);
          restore();
          reset();
          if (code) onCode(code);
          return;
        }
        reset();
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing) {
        if (held) restore(buf);
        reset();
        return;
      }
      if (buf && now - last < WEDGE_GAP) {
        buf += e.key;
        if (buf.length >= WEDGE_MIN) {
          e.preventDefault();
          e.stopPropagation();
          held = true;
        }
      } else {
        if (held) restore(buf);
        reset();
        if (when && !when(e.target)) return;
        buf = e.key;
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && typeof t.value === "string") {
          field = t;
          const len = t.value.length;
          let start = len, end = len;
          try {
            if (t.selectionStart != null) { start = t.selectionStart; end = t.selectionEnd; }
          } catch (ignored) {}
          before = { value: t.value, start, end };
        }
      }
      last = now;
      clearTimeout(timer);
      timer = setTimeout(idle, WEDGE_IDLE);
    }

    // Перехват на погружении: обработчики полей (подсказки suggest.js, Enter
    // в поле ввода) не должны увидеть ни очередь, ни её Enter.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      reset();
    };
  }

  return { render, downloadCanvas, deliverCanvas, showFullscreen, showImage,
           scan, scanContinuous, stopScan, normalize, isDesktop, canCamera, wedge };
})();
