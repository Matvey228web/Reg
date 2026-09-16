// Обёртка над Telegram WebApp SDK (telegram-web-app.js, подключается в index.html).
// Вне Telegram (например, при открытии в обычном браузере для разработки) деградирует
// мягко: возвращает заглушки, приложение продолжает работать в MOCK_MODE.

const TG = (() => {
  const webApp = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  function init() {
    if (!webApp) {
      // Вне Telegram шапки нет — запас под неё только оставил бы пустую полосу
      // сверху. Это же касается версии для компьютера.
      document.documentElement.style.setProperty("--safe-top", "8px");
      return;
    }
    webApp.ready();
    webApp.expand();
    applyTheme();
    applySafeArea();
    webApp.onEvent("themeChanged", applyTheme);
    // Отступы меняются при развороте на весь экран и повороте устройства
    ["safeAreaChanged", "contentSafeAreaChanged", "viewportChanged"].forEach(function (evt) {
      try { webApp.onEvent(evt, applySafeArea); } catch (ignored) {}
    });
  }

  // Запас сверху. С Bot API 8.0 клиент сообщает безопасные отступы:
  // contentSafeAreaInset — высота своей шапки там, где она лежит ПОВЕРХ
  // страницы (полноэкранный режим), safeAreaInset — вырез и «шторка»
  // устройства. В обычном режиме шапка рисуется над веб-вью, ничего не
  // перекрывает, и оба отступа честно равны нулю.
  //
  // Раньше ноль считался за «клиент промолчал» и подставлялся запас из CSS —
  // 56 px пустоты на каждом экране, которые и было видно на телефоне. Теперь
  // ноль от клиента 8.0 — это ноль. Для клиентов постарше запас остаётся: там
  // спросить не у кого, а полноэкранного режима у них и нет.
  function applySafeArea() {
    if (!webApp) return;
    var root = document.documentElement.style;
    var device = webApp.safeAreaInset || {};
    var content = webApp.contentSafeAreaInset || {};
    var top = Number(device.top || 0) + Number(content.top || 0);
    var bottom = Number(device.bottom || 0) + Number(content.bottom || 0);
    var reports = false;
    try { reports = webApp.isVersionAtLeast("8.0"); } catch (ignored) {}
    if (top > 0) root.setProperty("--safe-top", top + 8 + "px");
    else if (reports) root.setProperty("--safe-top", "0px");
    root.setProperty("--safe-bottom", bottom + "px");
  }

  // Внешняя ссылка. Внутри Telegram открываем его же браузером — страница
  // ложится поверх приложения и закрывается свайпом, склад остаётся под ней.
  // Вне Telegram — обычной вкладкой.
  function openLink(url) {
    if (webApp && typeof webApp.openLink === "function") {
      try { webApp.openLink(url); return true; } catch (ignored) {}
    }
    window.open(url, "_blank", "noopener");
    return true;
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
    markScheme(webApp.themeParams.bg_color);
  }

  // Светлая тема или тёмная — нам нужно знать это самим, а не только через
  // переменные. Полупрозрачный серый, которым заданы все наши поверхности,
  // на белом фоне даёт заметную подложку, а на тёмном (#18222d) почти не
  // виден: карточки сливались с фоном. Telegram признака темы не присылает,
  // поэтому считаем яркость фона и ставим её на корень документа.
  function markScheme(bgColor) {
    const dark = isDarkColor(bgColor);
    if (dark === null) return;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }

  function isDarkColor(value) {
    const hex = String(value || "").trim().replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    // Воспринимаемая яркость: глаз считает зелёный ярче синего, и простое
    // среднее по каналам путало бы синеватый тёмный фон Telegram со светлым.
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
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

  // Версию спрашиваем через свою обёртку: у старых клиентов самого метода
  // isVersionAtLeast может не быть, и прямой вызов упал бы.
  function atLeast(version) {
    if (!webApp || typeof webApp.isVersionAtLeast !== "function") return false;
    try { return !!webApp.isVersionAtLeast(version); } catch (e) { return false; }
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

  // Сканирование подряд: окно сканера НЕ закрывается после каждого кода.
  //
  // Это разница между «сверка склада» и «шестьсот раз нажать кнопку»: при
  // обычном scanQr человек на каждый предмет открывает камеру заново и ждёт.
  // Здесь окно остаётся открытым, а обработчик вызывается на каждый код, пока
  // человек сам не закроет сканер.
  //
  // Окно закрывает собой экран, поэтому единственный доступный отклик —
  // вибрация: показать счётчик под окном Telegram не даёт.
  function scanQrContinuous(text, onCode) {
    if (!hasScanQr()) {
      return { ok: false, error: "QR-сканер Telegram недоступен в этой версии клиента" };
    }
    webApp.showScanQrPopup({ text }, (code) => {
      if (code) onCode(String(code).trim());
      return false;   // false — окно остаётся открытым
    });
    return { ok: true };
  }

  function closeScanQr() {
    if (webApp && typeof webApp.closeScanQrPopup === "function") webApp.closeScanQrPopup();
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
        // Снимаем обработчик вместе с кнопкой. show() предыдущий снимал, а
        // hide() — нет, и обработчик оставался привязанным в SDK: кнопка могла
        // выстрелить в форму, которой на экране уже нет.
        if (mainButton._handler) {
          webApp.MainButton.offClick(mainButton._handler);
          mainButton._handler = null;
        }
        webApp.MainButton.hide();
        return;
      }
      const btn = document.getElementById("fallback-main-button");
      if (btn) { btn.onclick = null; btn.style.display = "none"; }
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
      // (кнопка #back-button в шапке index.html), подменять нечего.
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

  // Подтверждение разрушительного действия. В системе такое окно называет
  // действие словом и красит его красным — «Удалить», а не «ОК»; у showConfirm
  // кнопки нейтральные и без имени.
  //
  // Два ограничения, из-за которых нельзя просто заменить вызовы:
  //   showPopup появился в Bot API 6.2 — на клиентах старее его нет;
  //   сообщение в нём не длиннее 256 знаков, и на длинном он ОТКАЗЫВАЕТ,
  //   а не обрезает. Поэтому в обоих случаях тихо уходим в showConfirm:
  //   нейтральное окно хуже красного, но несравнимо лучше молчания.
  var POPUP_LIMIT = 256;

  function confirmDestructive(title, message, actionText, cb) {
    var fits = String(message || "").length <= POPUP_LIMIT &&
               String(title || "").length <= 64;
    if (!webApp || !webApp.showPopup || !atLeast("6.2") || !fits) {
      showConfirm((title ? title + "\n\n" : "") + message, cb);
      return;
    }
    try {
      webApp.showPopup({
        title: title,
        message: message,
        buttons: [
          { id: "cancel", type: "cancel" },
          { id: "go", type: "destructive", text: actionText },
        ],
      }, function (id) { cb(id === "go"); });
    } catch (e) {
      // Клиент мог отказать и по другой причине — лучше нейтральное окно,
      // чем действие, которое нечем подтвердить.
      showConfirm((title ? title + "\n\n" : "") + message, cb);
    }
  }

  // Вертикальный свайп вниз закрывает мини-приложение. Свой жест «потянуть
  // для обновления» без этого будет закрывать приложение вместо обновления —
  // и выглядеть как падение. Возвращаем, получилось ли: жест ставится только
  // при true.
  function lockVerticalSwipes() {
    if (!webApp || !webApp.disableVerticalSwipes || !atLeast("7.7")) return false;
    try {
      webApp.disableVerticalSwipes();
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    init, getUser, getInitData, isAvailable, hasScanQr, scanQr, scanQrContinuous, closeScanQr,
    mainButton, backButton, hapticSuccess, hapticError, showAlert, showConfirm,
    confirmDestructive, lockVerticalSwipes, openLink,
  };
})();
