// Единая точка обращения к бэкенду (Google Apps Script Web App) или к мокам (js/mock-data.js).
// Все экраны вызывают только apiPost(endpoint, body) — детали транспорта скрыты здесь.

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Бэкенд в таблице живёт своей жизнью: код приложения обновляется выкладкой, а
// Code.gs — руками. Пока его не вставили, новые разделы отвечают «Неизвестный
// эндпоинт». Складмену это слово не говорит ничего, поэтому подменяем текст
// здесь, в единственной точке, где рождается ошибка, — иначе пришлось бы
// помнить про это на каждом экране.
const BACKEND_OUTDATED_TEXT =
  "Раздел заработает после обновления бэкенда в таблице: вставьте Code.gs и " +
  "опубликуйте новую версию (Deploy → Manage deployments → карандаш → New version).";

// Узнаёт и исходный ответ сервера, и уже подменённый текст: экранам удобнее
// спрашивать один раз, не думая, через какую точку ошибка к ним пришла.
function backendOutdated(message) {
  var text = String(message || "");
  return /Неизвестный эндпоинт/i.test(text) || text === BACKEND_OUTDATED_TEXT;
}

function humanError(message) {
  return backendOutdated(message) ? BACKEND_OUTDATED_TEXT : String(message || "Ошибка запроса");
}

function getStoredSession() {
  try {
    const raw = localStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// fresh — «пойди за свежим, минуя кэш». Нужно кнопке «Обновить»: человек жмёт
// её именно потому, что не верит показанному. Кэш в браузере мы и так обходим,
// а этот флаг доезжает до Worker перед таблицей (worker/src/index.js), где
// лежит общий кэш склада.
async function apiPost(endpoint, body = {}, { fresh = false } = {}) {
  const session = getStoredSession();
  const token = session ? session.token : null;

  if (CONFIG.MOCK_MODE) {
    try {
      return await MockAPI.handle(endpoint, body, token);
    } catch (e) {
      if (e.status === 401) {
        localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY);
      }
      throw new ApiError(humanError(e.message), e.status || 500);
    }
  }

  // Apps Script Web App отдаёт один URL без роутинга по путям и не видит
  // произвольные HTTP-заголовки в doPost(e) — поэтому endpoint и токен едут
  // внутри JSON-тела, а не в URL/заголовке. Content-Type должен быть
  // "простым" (text/plain), иначе браузер шлёт CORS-preflight (OPTIONS),
  // который doPost не обрабатывает, и кросс-доменный запрос падает.
  let res;
  try {
    res = await fetch(CONFIG.WEBHOOK_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ endpoint, token, payload: body, fresh }),
    });
  } catch {
    throw new ApiError("Нет связи с сервером. Проверьте интернет-соединение.", 0);
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new ApiError("Некорректный ответ сервера", res.status);
  }

  // Apps Script Web App всегда отвечает настоящим HTTP 200 — логический
  // статус (401/403/404/409...) лежит внутри JSON-тела, не в res.status.
  const logicalStatus = payload.status || (payload.ok ? 200 : 500);

  if (logicalStatus === 401) {
    localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY);
  }

  if (!payload.ok) {
    throw new ApiError(humanError(payload.error), logicalStatus);
  }
  return payload.data;
}
