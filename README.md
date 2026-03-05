
<!DOCTYPE html>
<html>
<head>
    <title>Sklad Scan</title>
    <script src="https://unpkg.com/html5-qrcode"></script>
    <style>
        button { width: 100%; padding: 20px; margin: 10px 0; font-size: 18px; cursor: pointer; }
        #reader { width: 100%; }
        .active-btn { background-color: #4CAF50; color: white; }
    </style>
</head>
<body>
    <div id="menu">
        <button onclick="setMode('Выдача')">📤 Выдача</button>
        <button onclick="setMode('Приемка')">📥 Приемка</button>
        <button onclick="setMode('Дефект')">⚠️ Дефект</button>
    </div>

    <div id="scanner-container" style="display:none;">
        <h2 id="current-mode"></h2>
        <div id="reader"></div>
        <button onclick="stopScanner()">Отмена</button>
    </div>

    <script>
        let currentMode = "";
        const html5QrCode = new Html5Qrcode("reader");

        function setMode(mode) {
            currentMode = mode;
            document.getElementById('menu').style.display = 'none';
            document.getElementById('scanner-container').style.display = 'block';
            document.getElementById('current-mode').innerText = "Режим: " + mode;
            startScanner();
        }

        function startScanner() {
            html5QrCode.start(
                { facingMode: "environment" }, 
                { fps: 10, qrbox: 250 },
                qrCodeMessage => {
                    sendData(qrCodeMessage);
                    html5QrCode.stop();
                }
            ).catch(err => alert("Ошибка камеры: " + err));
        }

        async function sendData(itemId) {
            // URL твоего Webhook в Latenode или Albato
            const webhookUrl = "https://your-webhook-link.com";
            
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: itemId,
                    action: currentMode,
                    timestamp: new Date().toISOString()
                })
            });

            if (response.ok) {
                alert(`Успешно: ${currentMode} для ID ${itemId}`);
                location.reload(); // Возврат в меню
            }
        }

        function stopScanner() {
            html5QrCode.stop().then(() => location.reload());
        }
    </script>
</body>
</html>
