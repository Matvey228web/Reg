// Точка входа для настройки окружения Mini App.
// После того как будет задеплоен apps-script/Code.gs по инструкции из SETUP.md,
// впишите сюда URL веб-приложения Apps Script и переключите MOCK_MODE в false.

const CONFIG = {
  // URL веб-приложения Google Apps Script (заканчивается на /exec).
  // Это не секрет: он всё равно уходит в браузер каждого сотрудника вместе
  // с этим файлом. Защита — на стороне Apps Script (логин, PIN, токен).
  WEBHOOK_BASE_URL: "https://script.google.com/macros/s/AKfycbyEGfWDeV8esYMCk6h-rkuroUNK28PVFNcc0lADlCRNBlRA8wfcCOvzxou6UVgmX4kn/exec",

  // true = все запросы API обслуживаются локальными фейковыми данными (js/mock-data.js),
  // без обращения к Google Sheets/Apps Script. Удобно для разработки и демонстрации
  // приложения до того, как настроен реальный бэкенд.
  MOCK_MODE: false,

  // Через сколько миллисекунд считать сессию сотрудника истёкшей (12 часов)
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,

  SESSION_STORAGE_KEY: "mifs_session",

  // ЗАПАСНОЙ список. Действующий справочник живёт в таблице (лист Categories),
  // приходит с бэкенда при входе и правится в «Настройках». Этот нужен, только
  // если бэкенд недоступен, — иначе каталог было бы нечем нарисовать.
  //
  // num — первые две цифры номера предмета (XXYYZZ). У категории, в которой уже
  // есть техника, номер менять нельзя: он напечатан на этикетках.
  CATEGORIES: [
    { code: "CAM", num: "01", label: "Камеры" },
    { code: "LEN", num: "02", label: "Объективы" },
    { code: "LGT", num: "03", label: "Осветители" },
    { code: "AUD", num: "04", label: "Звук" },
    { code: "GRP", num: "05", label: "Грип" },
    { code: "OTH", num: "06", label: "Другое" },
    // Учитываются количеством, а не поштучно. Правила количества — отдельно.
    { code: "CNS", num: "07", label: "Расходники" },
    { code: "SUP", num: "08", label: "Штативы и поддержка" },
    { code: "MOD", num: "09", label: "Модификаторы света" },
    { code: "MON", num: "10", label: "Мониторы и видеотракт" },
    { code: "RIG", num: "11", label: "Обвес камеры" },
    { code: "FLT", num: "12", label: "Фильтры" },
    { code: "PWR", num: "13", label: "Питание" },
    { code: "MED", num: "14", label: "Носители" },
  ],
};
