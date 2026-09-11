// Точка входа для настройки окружения Mini App.
// После того как будет задеплоен apps-script/Code.gs по инструкции из SETUP.md,
// впишите сюда URL веб-приложения Apps Script и переключите MOCK_MODE в false.

const CONFIG = {
  // URL веб-приложения Google Apps Script (заканчивается на /exec).
  // Это не секрет: он всё равно уходит в браузер каждого сотрудника вместе
  // с этим файлом. Защита — на стороне Apps Script (логин, PIN, токен).
  WEBHOOK_BASE_URL: "https://script.google.com/macros/s/AKfycbwseLqYuSorX55ICsCCTMB2L8r79HbYYRx4VVdOH0G6jjyzOUCQYmDoVNbY9GSDgGsX/exec",

  // true = все запросы API обслуживаются локальными фейковыми данными (js/mock-data.js),
  // без обращения к Google Sheets/Apps Script. Удобно для разработки и демонстрации
  // приложения до того, как настроен реальный бэкенд.
  MOCK_MODE: false,

  // Через сколько миллисекунд считать сессию сотрудника истёкшей (12 часов)
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,

  SESSION_STORAGE_KEY: "mifs_session",

  // num — первые две цифры номера предмета (XXYYZZ). Менять нельзя:
  // коды попадают на печатные этикетки.
  CATEGORIES: [
    { code: "CAM", num: "01", label: "Камера" },
    { code: "LEN", num: "02", label: "Объектив" },
    { code: "LGT", num: "03", label: "Свет" },
    { code: "AUD", num: "04", label: "Звук" },
    { code: "GRP", num: "05", label: "Грип" },
    { code: "OTH", num: "06", label: "Другое" },
    // Учитываются количеством, а не поштучно. Правила количества — отдельно.
    { code: "CNS", num: "07", label: "Расходники (штучно/навес)" },
  ],
};
