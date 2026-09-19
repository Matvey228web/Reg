// Экран "Сотрудники" (только для Admin): список + переключатель активности + добавление.

const StaffScreen = (() => {
  // Свои данные нужны, чтобы не предлагать удалить самого себя.
  function mySession() {
    return Auth.getSession() || {};
  }

  let iAmOwner = false;

  async function loadList() {
    const list = document.getElementById("staff-list");
    list.innerHTML = skeleton(3);
    try {
      const staffList = await apiPost("/staff/list", {});
      if (!staffList.length) {
        list.innerHTML = `<p class="empty">Сотрудников пока нет</p>`;
        return;
      }
      const me = mySession();
      // Кто главный, решает сервер. Старый бэкенд этого поля не отдаёт — тогда
      // считаем, что главных нет, и лишних кнопок не рисуем.
      iAmOwner = staffList.some((s) => s.is_owner && String(s.staff_id) === String(me.staff_id));
      document.getElementById("staff-add-toggle").style.display = iAmOwner ? "" : "none";
      document.getElementById("staff-owner-hint").innerHTML = iAmOwner
        ? `<p class="hint">Вы главный администратор: только вы заводите и удаляете
           сотрудников. Эту роль нельзя удалить — её можно только передать другому
           администратору.</p>`
        : `<p class="hint">Заводить и удалять сотрудников может только главный
           администратор.</p>`;

      list.innerHTML = "";
      staffList.forEach((s) => {
        list.insertAdjacentHTML("beforeend", cardHtml(s, me));
      });

      list.querySelectorAll("[data-toggle-active]").forEach((btn) => {
        btn.addEventListener("click", () => toggleActive(btn.dataset.toggleActive, btn.dataset.active !== "true"));
      });
      list.querySelectorAll("[data-reset-pin]").forEach((btn) => {
        btn.addEventListener("click", () => resetPin(btn.dataset.resetPin, btn.dataset.name));
      });
      list.querySelectorAll("[data-delete]").forEach((btn) => {
        btn.addEventListener("click", () => confirmDelete(JSON.parse(btn.dataset.person)));
      });
      list.querySelectorAll("[data-set-role]").forEach((btn) => {
        btn.addEventListener("click", () => setRole(JSON.parse(btn.dataset.person), btn.dataset.setRole));
      });
      list.querySelectorAll("[data-transfer]").forEach((btn) => {
        btn.addEventListener("click", () => confirmTransfer(JSON.parse(btn.dataset.person)));
      });
    } catch (err) {
      list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  // Удаление — обычная кнопка, а не свайп. Свайп на складе не находят: жест
  // ничем не подписан, и снаружи система выглядела как «умеет только
  // отключать».
  function cardHtml(person, me) {
    const isMe = String(person.staff_id) === String(me.staff_id);
    const json = escapeHtml(JSON.stringify({
      staff_id: person.staff_id, full_name: person.full_name, role: person.role,
    }));
    const buttons = [];

    if (!person.is_owner) {
      buttons.push(`<button class="btn btn--secondary" data-toggle-active="${person.staff_id}"
        data-active="${person.active}">${person.active ? "Отключить" : "Включить"}</button>`);
    }
    if (!person.is_owner || isMe) {
      buttons.push(`<button class="btn btn--secondary" data-reset-pin="${person.staff_id}"
        data-name="${escapeHtml(person.full_name)}">Сбросить PIN</button>`);
    }
    if (iAmOwner && !person.is_owner) {
      buttons.push(`<button class="btn btn--secondary" data-set-role="${person.role === "Admin" ? "Warehouse Staff" : "Admin"}"
        data-person="${json}">${person.role === "Admin" ? "Снять администратора" : "Сделать администратором"}</button>`);
      if (person.role === "Admin" && person.active) {
        buttons.push(`<button class="btn btn--secondary" data-transfer data-person="${json}">Передать главные права</button>`);
      }
      buttons.push(`<button class="btn btn--danger" data-delete data-person="${json}">Удалить</button>`);
    }

    return `
      <div class="card">
        <div class="card-title">
          ${escapeHtml(person.full_name)}
          ${person.is_owner ? `<span class="badge badge--owner">Главный</span>` : ""}
          ${person.active ? "" : `<span class="badge badge--retired">Отключён</span>`}
        </div>
        <div class="card-sub">${escapeHtml(person.login)} · ${escapeHtml(roleLabel(person))}${isMe ? " · это вы" : ""}</div>
        ${buttons.length ? `<div class="staff-actions">${buttons.join("")}</div>` : ""}
      </div>`;
  }

  // Удаление необратимо, поэтому спрашиваем. История при этом не пострадает:
  // в журнале рядом с номером сотрудника хранится его имя.
  function confirmDelete(person) {
    TG.confirmDestructive(
      `Удалить ${person.full_name}?`,
      "Войти он больше не сможет. Записи в журнале выдач останутся — там " +
      "сохранено его имя.",
      "Удалить",
      async (yes) => {
        if (!yes) return;
        try {
          const res = await apiPost("/staff/delete", { staff_id: Number(person.staff_id) });
          TG.hapticSuccess();
          // Называем того, кого удалили, по имени: это единственный способ
          // заметить, если удалился не тот.
          TG.showAlert("Удалён: " + ((res && res.full_name) || person.full_name));
          loadList();
        } catch (err) {
          TG.hapticError();
          TG.showAlert(err.message);
        }
      });
  }

  async function setRole(person, role) {
    try {
      await apiPost("/staff/set-role", { staff_id: Number(person.staff_id), role });
      TG.hapticSuccess();
      loadList();
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    }
  }

  // Передача главных прав — единственный способ перестать быть главным, и
  // отменить её сможет только тот, кому передали. Поэтому спрашиваем прямо.
  function confirmTransfer(person) {
    TG.showConfirm(
      `Передать главные права: ${person.full_name}? После этого заводить и ` +
      `удалять сотрудников будет он, а не вы. Вернуть права сможет только он.`,
      async (yes) => {
        if (!yes) return;
        try {
          await apiPost("/staff/transfer-owner", { staff_id: Number(person.staff_id) });
          TG.hapticSuccess();
          TG.showAlert("Главный администратор теперь " + person.full_name);
          const session = Auth.getSession();
          if (session) Auth.setSession({ ...session, is_owner: false });
          loadList();
        } catch (err) {
          TG.hapticError();
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
      <div class="form-group form-group--inset">
        <div class="field">
          <label>Новый PIN</label>
          <input type="password" inputmode="numeric" pattern="[0-9]*" class="pin-reset-input" />
        </div>
      </div>
      <p class="hint">Для ${escapeHtml(name)}, 4–6 цифр.</p>
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
