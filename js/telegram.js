// Обёртка над Telegram WebApp SDK (telegram-web-app.js, подключается в index.html).
// Вне Telegram (например, при открытии в обычном браузере для разработки) деградирует
// мягко: возвращает заглушки, приложение продолжает работать в MOCK_MODE.

const TG = (() => {
  const webApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  function init() {
    if (!webApp) return;
    webApp.ready();
    webApp.expand();
    applyTheme();
    webApp.onEvent("themeChanged", applyTheme);
  }

  function applyTheme() {
    if (!webApp || !webApp.themeParams) return;
    const root = document.documentElement.style;
    const map = {
      "--tg-bg-color": webApp.themeParams.bg_color,
      "--tg-text-color": webApp.themeParams.text_color,
      "--tg-hint-color": webApp.themeParams.hint_color,
      "--tg-link-color": webApp.themeParams.link_color,
      "--tg-button-color": webApp.themeParams.button_color,
      "--tg-button-text-color": webApp.themeParams.button_text_color,
      "--tg-secondary-bg-color": webApp.themeParams.secondary_bg_color,
    };
    for (const [key, value] of Object.entries(map)) {
      if (value) root.setProperty(key, value);
    }
  }

  function getUser() {
    return webApp && webApp.initDataUnsafe && webApp.initDataUnsafe.user
      ? webApp.initDataUnsafe.user
      : null;
  }

  function getInitData() {
    return webApp ? webApp.initData : "";
  }

  function isAvailable() {
    return !!webApp;
  }

  function hasScanQr() {
    return !!(webApp && typeof webApp.showScanQrPopup === "function");
  }

  function scanQr(text, onResult) {
    if (!hasScanQr()) {
      onResult(null, "QR-сканер Telegram недоступен в этой версии клиента");
      return;
    }
    webApp.showScanQrPopup({ text }, (code) => {
      webApp.closeScanQrPopup();
      onResult(code || null, null);
      return true;
    });
  }

  // Вне Telegram (обычный браузер, локальная разработка) нативной MainButton не существует —
  // подменяем её обычной кнопкой, зафиксированной снизу экрана, с тем же API.
  function getFallbackButton() {
    let btn = document.getElementById("fallback-main-button");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "fallback-main-button";
      btn.className = "btn fallback-main-button";
      document.body.appendChild(btn);
    }
    return btn;
  }

  const mainButton = {
    show(text, onClick) {
      if (webApp) {
        webApp.MainButton.setText(text);
        webApp.MainButton.offClick(mainButton._handler);
        mainButton._handler = onClick;
        webApp.MainButton.onClick(onClick);
        webApp.MainButton.show();
        return;
      }
      const btn = getFallbackButton();
      btn.textContent = text;
      btn.onclick = onClick;
      btn.style.display = "block";
    },
    hide() {
      if (webApp) {
        webApp.MainButton.hide();
        return;
      }
      const btn = document.getElementById("fallback-main-button");
      if (btn) btn.style.display = "none";
    },
    setLoading(loading) {
      if (webApp) {
        if (loading) webApp.MainButton.showProgress();
        else webApp.MainButton.hideProgress();
        return;
      }
      const btn = document.getElementById("fallback-main-button");
      if (btn) btn.disabled = loading;
    },
  };

  // Нативная BackButton появилась в Bot API 6.1. На клиентах старее вызовы
  // молча ничего не делают, поэтому проверяем версию, а не наличие webApp.
  function hasNativeBackButton() {
    return !!(webApp && webApp.BackButton &&
      (typeof webApp.isVersionAtLeast !== "function" || webApp.isVersionAtLeast("6.1")));
  }

  const backButton = {
    show(onClick) {
      if (hasNativeBackButton()) {
        webApp.BackButton.offClick(backButton._handler);
        backButton._handler = onClick;
        webApp.BackButton.onClick(onClick);
        webApp.BackButton.show();
        return;
      }
      // Вне Telegram и на старых клиентах «назад» рисует сама страница
      // (#back-row в index.html), подменять нечего.
    },
    hide() {
      if (hasNativeBackButton()) {
        webApp.BackButton.hide();
        return;
      }
    },
  };

  function hapticSuccess() {
    if (webApp && webApp.HapticFeedback) webApp.HapticFeedback.notificationOccurred("success");
  }

  function hapticError() {
    if (webApp && webApp.HapticFeedback) webApp.HapticFeedback.notificationOccurred("error");
  }

  function showAlert(message) {
    if (webApp && webApp.showAlert) webApp.showAlert(message);
    else alert(message);
  }

  function showConfirm(message, cb) {
    if (webApp && webApp.showConfirm) webApp.showConfirm(message, cb);
    else cb(confirm(message));
  }

  return {
    init, getUser, getInitData, isAvailable, hasScanQr, scanQr,
    mainButton, backButton, hapticSuccess, hapticError, showAlert, showConfirm,
  };
})();
