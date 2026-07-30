// Точка входа для настройки окружения Mini App.
// После того как в Latenode будут созданы вебхуки по инструкции из SETUP.md,
// впишите сюда реальный базовый URL и переключите MOCK_MODE в false.

const CONFIG = {
  // Базовый URL сценариев Latenode, например: "https://webhook.latenode.com/12345/abcde"
  WEBHOOK_BASE_URL: "",

  // true = все запросы API обслуживаются локальными фейковыми данными (js/mock-data.js),
  // без обращения к Latenode/Airtable. Удобно для разработки и демонстрации приложения
  // до того, как настроен реальный бэкенд.
  MOCK_MODE: true,

  // Через сколько миллисекунд считать сессию сотрудника истёкшей (12 часов)
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,

  SESSION_STORAGE_KEY: "mifs_session",

  CATEGORIES: [
    { code: "CAM", label: "Камера" },
    { code: "LEN", label: "Объектив" },
    { code: "LGT", label: "Свет" },
    { code: "AUD", label: "Звук" },
    { code: "GRP", label: "Грип" },
    { code: "OTH", label: "Другое" },
  ],
};
