// Экран входа по PIN + управление сессией сотрудника в localStorage.

const Auth = (() => {
  function getSession() {
    try {
      const raw = localStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw);
      if (Date.now() - session.issued_at > CONFIG.SESSION_TTL_MS) {
        localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  function setSession(data) {
    const session = { ...data, issued_at: Date.now() };
    localStorage.setItem(CONFIG.SESSION_STORAGE_KEY, JSON.stringify(session));
    return session;
  }

  function logout() {
    localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY);
    Router.reset("login");
  }

  function requireAuth() {
    const session = getSession();
    if (!session) {
      Router.reset("login");
      return null;
    }
    return session;
  }

  function showError(message) {
    const box = document.getElementById("login-error");
    box.innerHTML = message ? `<div class="error-box">${escapeHtml(message)}</div>` : "";
  }

  function onShow() {
    showError("");
    const tgUser = TG.getUser();
    const greeting = document.getElementById("login-greeting");
    if (tgUser && tgUser.first_name) {
      greeting.textContent = `Здравствуйте, ${tgUser.first_name}! Введите логин и PIN сотрудника.`;
      const loginInput = document.getElementById("login-input");
      if (tgUser.username && !loginInput.value) loginInput.value = tgUser.username;
    } else {
      greeting.textContent = "Учёт оборудования на складе";
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    showError("");
    const login = document.getElementById("login-input").value.trim();
    const pin = document.getElementById("pin-input").value.trim();
    const submitBtn = document.getElementById("login-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Входим…";
    try {
      const data = await apiPost("/auth/login", {
        login,
        pin,
        telegram_id: TG.getUser() ? TG.getUser().id : null,
        telegram_init_data: TG.getInitData(),
      });
      setSession(data);
      document.getElementById("pin-input").value = "";
      Router.reset("home");
    } catch (err) {
      TG.hapticError();
      showError(err.message || "Не удалось войти");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Войти";
    }
  }

  function init() {
    document.getElementById("login-form").addEventListener("submit", handleSubmit);
    Router.register("login", { onShow });
  }

  return { init, getSession, setSession, logout, requireAuth };
})();
