// Единственная точка обращения к бэкенду (или к мокам): экраны зовут только apiPost.

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

// Сессия истекла или отозвана. Мало стереть её: человек остался бы на экране
// с ошибкой до перезапуска — а без токена там уже ничего не выйдет. Поэтому
// сразу на вход. Сам вход не уводим: 401 на неверный PIN — его обычная
// ошибка, и перерисовка экрана входа стёрла бы её. Не уводим и запрос без
// токена: тогда и сессии не было, уводить некуда — это и защищает от петли.
function sessionExpired(endpoint, token) {
  localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY);
  if (!token || endpoint === "/auth/login") return;
  Cache.clearAll();
  if (typeof Router !== "undefined") Router.reset("login");
}

// fresh — «пойди за свежим, минуя кэш». Нужно кнопке «Обновить»: человек жмёт
// её именно потому, что не верит показанному. Кэш в браузере мы и так обходим,
// а этот флаг доезжает до Worker перед таблицей (worker/src/index.js), где
// лежит общий кэш склада.
//
// Пока хоть один запрос в пути, на body висит класс net-busy — по нему сверху
// бежит тонкая полоска. Ответ таблицы идёт 6–12 секунд, и без неё после
// «Обновить» или фоновой подгрузки не видно, что приложение вообще работает.
// Счётчик, а не флажок: запросы идут и параллельно (каталог + заказы).
let netPending = 0;
function netBusy(delta) {
  netPending = Math.max(0, netPending + delta);
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.toggle("net-busy", netPending > 0);
  }
}

async function apiPost(endpoint, body = {}, options = {}) {
  netBusy(1);
  try {
    return await apiRequest(endpoint, body, options);
  } finally {
    netBusy(-1);
  }
}

// Состояние очереди Worker (GET /health). Не через apiPost: это не ручка
// Apps Script, токен не нужен, а отказ не ошибка — возвращаем null.
// Предел короче, чем у apiPost: плитка не должна висеть минутами.
async function apiHealth() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const res = await fetch(CONFIG.WEBHOOK_BASE_URL.replace(/\/+$/, "") + "/health",
      { signal: abort.signal });
    const json = await res.json();
    return json && typeof json.dead === "number" ? json : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function apiRequest(endpoint, body, { fresh = false } = {}) {
  const session = getStoredSession();
  const token = session ? session.token : null;

  if (CONFIG.MOCK_MODE) {
    try {
      return await MockAPI.handle(endpoint, body, token);
    } catch (e) {
      if (e.status === 401) sessionExpired(endpoint, token);
      throw new ApiError(humanError(e.message), e.status || 500);
    }
  }

  // Apps Script Web App отдаёт один URL без роутинга по путям и не видит
  // произвольные HTTP-заголовки в doPost(e) — поэтому endpoint и токен едут
  // внутри JSON-тела, а не в URL/заголовке. Content-Type должен быть
  // "простым" (text/plain), иначе браузер шлёт CORS-preflight (OPTIONS),
  // который doPost не обрабатывает, и кросс-доменный запрос падает.
  // Предел ожидания. Без него отвалившийся запрос висит вечно: кнопка остаётся
  // нажатой, человек не знает, идёт ли дело, и жмёт ещё раз. Две минуты — с
  // запасом к потолку Apps Script в 5–8 секунд и к самым тяжёлым записям
  // (журнал сверки по всему каталогу — это сотни строк).
  const TIMEOUT_MS = 120000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(CONFIG.WEBHOOK_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ endpoint, token, payload: body, fresh }),
      signal: abort.signal,
    });
  } catch (err) {
    throw new ApiError(err && err.name === "AbortError"
      ? "Таблица не ответила за две минуты. Данные могли и записаться — проверьте, прежде чем повторять."
      : "Нет связи с сервером. Проверьте интернет-соединение.", 0);
  } finally {
    clearTimeout(timer);
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

  if (logicalStatus === 401) sessionExpired(endpoint, token);

  if (!payload.ok) {
    throw new ApiError(humanError(payload.error), logicalStatus);
  }
  return payload.data;
}
