// Экран "Сотрудники" (только для Admin): список + переключатель активности + добавление.

const StaffScreen = (() => {
  async function loadList() {
    const list = document.getElementById("staff-list");
    list.innerHTML = `<p class="empty">Загрузка…</p>`;
    try {
      const staffList = await apiPost("/staff/list", {});
      if (!staffList.length) {
        list.innerHTML = `<p class="empty">Сотрудников пока нет</p>`;
        return;
      }
      list.innerHTML = staffList.map((s) => `
        <div class="card">
          <div class="card-title">${escapeHtml(s.full_name)} ${s.active ? "" : '<span class="badge badge--retired">Отключён</span>'}</div>
          <div class="card-sub">${escapeHtml(s.login)} · ${s.role === "Admin" ? "Администратор" : "Сотрудник склада"}</div>
          <button class="btn btn--secondary" data-toggle-active="${s.staff_id}" data-active="${s.active}" style="margin-top:8px; width:auto;">
            ${s.active ? "Отключить" : "Включить"}
          </button>
        </div>
      `).join("");
      list.querySelectorAll("[data-toggle-active]").forEach((btn) => {
        btn.addEventListener("click", () => toggleActive(btn.dataset.toggleActive, btn.dataset.active !== "true"));
      });
    } catch (err) {
      list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
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
