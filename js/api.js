// Единая точка обращения к бэкенду (Latenode) или к мокам (js/mock-data.js).
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

  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;

  let res;
  try {
    res = await fetch(CONFIG.WEBHOOK_BASE_URL + endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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

  if (res.status === 401) {
    localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY);
  }

  if (!payload.ok) {
    throw new ApiError(payload.error || "Ошибка запроса", res.status);
  }
  return payload.data;
}
