// Единая точка обращения к бэкенду (Google Apps Script Web App) или к мокам (js/mock-data.js).
// Все экраны вызывают только apiPost(endpoint, body) — детали транспорта скрыты здесь.

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function getStoredSession() {
  try {
    const raw = localStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function apiPost(endpoint, body = {}) {
  const session = getStoredSession();
  const token = session ? session.token : null;

  if (CONFIG.MOCK_MODE) {
    try {
      return await MockAPI.handle(endpoint, body, token);
    } catch (e) {
      if (e.status === 401) {
        localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY);
      }
      throw new ApiError(e.message || "Ошибка запроса", e.status || 500);
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
      body: JSON.stringify({ endpoint, token, payload: body }),
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
    throw new ApiError(payload.error || "Ошибка запроса", logicalStatus);
  }
  return payload.data;
}
