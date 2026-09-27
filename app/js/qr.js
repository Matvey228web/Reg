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

    // Размер под ширину экрана, но кратно модулям — иначекрая размываются
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
  //   3. Если и листа нет — картинку приносит бот в чат склада.
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

  // Возвращает, каким путём ушло: download | share | cancelled | bot.
  // Вызывающий решает, что сказать человеку: у листа «Поделиться» своя
  // обратная связь, а у бота её нет.
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
        // Человек закрыл лист — это не ошибка и не повод дёргать бота.
        if (e && e.name === "AbortError") return "cancelled";
      }
    }

    await apiPost("/labels/send", {
      files: [{ name: filename, png_base64: canvas.toDataURL("image/png").split(",")[1] }],
    });
    return "bot";
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

  return { render, downloadCanvas, deliverCanvas, showFullscreen, showImage,
           scan, scanContinuous, stopScan };
})();
