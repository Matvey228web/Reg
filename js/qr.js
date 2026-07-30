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

  // scan(onResult): onResult(code | null, error | null)
  function scan(onResult) {
    TG.scanQr("Наведите камеру на QR-код оборудования", onResult);
  }

  return { render, downloadCanvas, scan };
})();
