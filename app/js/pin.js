// Экран смены своего PIN. Доступен любой роли: PIN — единственный ключ ко
// входу, поэтому сменить его человек должен сам, не дожидаясь администратора.

const PinScreen = (() => {
  function reset() {
    ["pin-current", "pin-new", "pin-repeat"].forEach((id) => {
      document.getElementById(id).value = "";
    });
    showBoxError("pin-change-error", "");
  }

  async function submit() {
    const current_pin = document.getElementById("pin-current").value.trim();
    const pin = document.getElementById("pin-new").value.trim();
    const repeat = document.getElementById("pin-repeat").value.trim();
    showBoxError("pin-change-error", "");

    if (!/^\d{4,6}$/.test(pin)) {
      showBoxError("pin-change-error", "Новый PIN — от 4 до 6 цифр");
      return;
    }
    if (pin !== repeat) {
      showBoxError("pin-change-error", "Новый PIN введён по-разному");
      return;
    }
    if (pin === current_pin) {
      showBoxError("pin-change-error", "Новый PIN совпадает с текущим");
      return;
    }

    const btn = document.getElementById("pin-change-submit");
    btn.disabled = true;
    btn.textContent = "Меняем…";
    try {
      const data = await apiPost("/staff/set-pin", { pin, current_pin });
      // Сервер выдаёт новый токен: старый он аннулирует, чтобы чужая сессия
      // с прежним PIN перестала работать.
      if (data && data.token) {
        const session = Auth.getSession() || {};
        Auth.setSession({ ...session, token: data.token });
      }
      TG.hapticSuccess();
      reset();
      TG.showAlert("PIN изменён");
      Router.reset("home");
    } catch (err) {
      TG.hapticError();
      showBoxError("pin-change-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Сменить PIN";
    }
  }

  function init() {
    document.getElementById("pin-change-submit").addEventListener("click", submit);
    Router.register("pin", { onShow: reset });
  }

  return { init };
})();
