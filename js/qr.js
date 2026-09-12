// Генерация QR-кода на canvas (библиотека qrcode-generator, подключена в index.html)
// и обёртка над нативным сканером Telegram для единообразного вызова из экранов.

const QR = (() => {
  function render(canvas, text, moduleSize = 8) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const size = count * moduleSize;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(col * moduleSize, row * moduleSize, moduleSize, moduleSize);
        }
      }
    }
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

  // scan(onResult): onResult(code | null, error | null)
  function scan(onResult) {
    TG.scanQr("Наведите камеру на QR-код оборудования", onResult);
  }

  return { render, downloadCanvas, showFullscreen, scan };
})();
