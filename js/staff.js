// Экран "Сотрудники" (только для Admin): список + переключатель активности + добавление.

const StaffScreen = (() => {
  // Свои данные нужны, чтобы не предлагать удалить самого себя.
  function mySession() {
    return Auth.getSession() || {};
  }

  async function loadList() {
    const list = document.getElementById("staff-list");
    list.innerHTML = skeleton(3);
    try {
      const staffList = await apiPost("/staff/list", {});
      if (!staffList.length) {
        list.innerHTML = `<p class="empty">Сотрудников пока нет</p>`;
        return;
      }
      list.innerHTML = "";
      const me = mySession();
      staffList.forEach((s) => {
        const card = `
          <div class="card">
            <div class="card-title">${escapeHtml(s.full_name)} ${s.active ? "" : '<span class="badge badge--retired">Отключён</span>'}</div>
            <div class="card-sub">${escapeHtml(s.login)} · ${s.role === "Admin" ? "Администратор" : "Сотрудник склада"}</div>
            <button class="btn btn--secondary" data-toggle-active="${s.staff_id}" data-active="${s.active}" style="margin-top:8px; width:auto;">
              ${s.active ? "Отключить" : "Включить"}
            </button>
            <button class="btn btn--secondary" data-reset-pin="${s.staff_id}" data-name="${escapeHtml(s.full_name)}" style="margin-top:8px; width:auto;">
              Сбросить PIN
            </button>
          </div>`;

        // Себя удалить нельзя — свайп для своей строки не навешиваем, чтобы не
        // предлагать действие, которое сервер всё равно отклонит.
        if (String(s.staff_id) === String(me.staff_id)) {
          list.insertAdjacentHTML("beforeend", `<div class="swipe"><div class="swipe-body">${card}</div></div>`);
        } else {
          list.appendChild(Swipe.row(card, {
            actionLabel: "Удалить",
            actionIcon: "🗑",
            onAction: ({ close }) => confirmDelete(s, close),
          }));
        }
      });

      list.querySelectorAll("[data-toggle-active]").forEach((btn) => {
        btn.addEventListener("click", () => toggleActive(btn.dataset.toggleActive, btn.dataset.active !== "true"));
      });
      list.querySelectorAll("[data-reset-pin]").forEach((btn) => {
        btn.addEventListener("click", () => resetPin(btn.dataset.resetPin, btn.dataset.name));
      });
    } catch (err) {
      list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // Удаление необратимо, поэтому спрашиваем. История при этом не пострадает:
  // в журнале рядом с номером сотрудника хранится его имя.
  function confirmDelete(staff, closeSwipe) {
    TG.showConfirm(
      `Удалить ${staff.full_name}? Войти он больше не сможет. ` +
      `Записи в журнале выдач останутся — там сохранено его имя.`,
      async (yes) => {
        if (!yes) { closeSwipe(); return; }
        try {
          await apiPost("/staff/delete", { staff_id: Number(staff.staff_id) });
          TG.hapticSuccess();
          loadList();
        } catch (err) {
          TG.hapticError();
          closeSwipe();
          TG.showAlert(err.message);
        }
      });
  }

  async function toggleActive(staffId, nextActive) {
    try {
      await apiPost("/staff/set-active", { staff_id: Number(staffId), active: nextActive });
      TG.hapticSuccess();
      loadList();
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    }
  }

  // Сброс PIN сотруднику. Нативного запроса ввода в Telegram нет (есть только
  // alert и confirm), поэтому поле разворачиваем прямо в карточке.
  // Прежняя сессия сотрудника аннулируется — войдёт заново с новым PIN.
  function resetPin(staffId, name) {
    const card = document.querySelector(`[data-reset-pin="${staffId}"]`).closest(".card");
    if (card.querySelector(".pin-reset-form")) return;
    const box = document.createElement("div");
    box.className = "pin-reset-form section";
    box.innerHTML = `
      <div class="field">
        <label>Новый PIN для ${escapeHtml(name)} (4–6 цифр)</label>
        <input type="password" inputmode="numeric" pattern="[0-9]*" class="pin-reset-input" />
      </div>
      <button class="btn pin-reset-save" style="width:auto;">Сохранить</button>
      <button class="btn btn--secondary pin-reset-cancel" style="width:auto;">Отмена</button>
      <div class="pin-reset-error"></div>`;
    card.appendChild(box);
    const input = box.querySelector(".pin-reset-input");
    const err = box.querySelector(".pin-reset-error");
    input.focus();

    box.querySelector(".pin-reset-cancel").addEventListener("click", () => box.remove());
    box.querySelector(".pin-reset-save").addEventListener("click", async () => {
      const pin = input.value.trim();
      err.innerHTML = "";
      if (!/^\d{4,6}$/.test(pin)) {
        err.innerHTML = `<div class="error-box">PIN — от 4 до 6 цифр</div>`;
        return;
      }
      const save = box.querySelector(".pin-reset-save");
      save.disabled = true;
      try {
        await apiPost("/staff/set-pin", { staff_id: Number(staffId), pin });
        TG.hapticSuccess();
        box.remove();
        TG.showAlert(`PIN изменён. Передайте его ${name} — войти надо будет заново.`);
      } catch (e) {
        TG.hapticError();
        err.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
      } finally {
        save.disabled = false;
      }
    });
  }

  function resetAddForm() {
    document.getElementById("staff-add-form").style.display = "none";
    document.getElementById("new-staff-name").value = "";
    document.getElementById("new-staff-login").value = "";
    document.getElementById("new-staff-pin").value = "";
    document.getElementById("new-staff-role").value = "Warehouse Staff";
    showBoxError("staff-add-error", "");
  }

  async function submitNewStaff() {
    const full_name = document.getElementById("new-staff-name").value.trim();
    const login = document.getElementById("new-staff-login").value.trim();
    const pin = document.getElementById("new-staff-pin").value.trim();
    const role = document.getElementById("new-staff-role").value;
    showBoxError("staff-add-error", "");
    if (!full_name || !login || !pin) {
      showBoxError("staff-add-error", "Заполните имя, логин и PIN");
      return;
    }
    const btn = document.getElementById("new-staff-submit");
    btn.disabled = true;
    try {
      await apiPost("/staff/create", { full_name, login, pin, role });
      TG.hapticSuccess();
      resetAddForm();
      loadList();
    } catch (err) {
      TG.hapticError();
      showBoxError("staff-add-error", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function onShow() {
    resetAddForm();
    loadList();
  }

  function init() {
    document.getElementById("staff-add-toggle").addEventListener("click", () => {
      const form = document.getElementById("staff-add-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("new-staff-submit").addEventListener("click", submitNewStaff);
    Router.register("staff", { onShow });
  }

  return { init };
})();
