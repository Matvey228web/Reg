// Экран «Сотрудники» — только для Admin.

const StaffScreen = (() => {
  // Свои данные нужны, чтобы не предлагать удалить самого себя.
  function mySession() {
    return Auth.getSession() || {};
  }

  let iAmOwner = false;
  let people = [];   // список, как он показан сейчас
  const CACHE = "staff";
  let edits = 0;     // сколько своих правок было — см. loadList

  // Список живёт в кэше, как каталог и заказы (catalog.js loadList): экран
  // рисуется сразу из прошлого раза, свежий список приходит молча.
  async function loadList({ force = false } = {}) {
    const list = document.getElementById("staff-list");
    const cached = Cache.items(CACHE);
    if (cached) render(cached);
    if (!force && cached && Cache.isFresh(CACHE)) return;
    if (!cached) list.innerHTML = skeleton(3);
    const seq = edits;
    try {
      const fresh = await Cache.load(CACHE, "/staff/list", {}, { fresh: force });
      // Пока список шёл, здесь же что-то поменяли: ответ это изменение не
      // видел и вернул бы старое. Оставляем то, что на экране.
      if (seq !== edits) { Cache.replace(CACHE, people); return; }
      // Открыта форма сброса PIN или набирается новый сотрудник — не мешаем.
      if (!isTyping("#screen-staff")) render(fresh);
    } catch (err) {
      if (!cached) list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      else showError("Не удалось обновить список: " + err.message);
    }
  }

  // Правка своими руками: и экран, и кэш — без нового запроса на 6–9 секунд.
  // Возраст кэша не трогаем: остальные строки свежее не стали.
  function commit(next) {
    edits++;
    if (!Cache.replace(CACHE, next)) Cache.set(CACHE, next);
    render(next);
  }

  function patchPerson(staffId, changes) {
    return people.map((p) => String(p.staff_id) === String(staffId) ? { ...p, ...changes } : p);
  }

  function showError(message) {
    const slot = ensureSlot("staff-error", "staff-list");
    if (slot) slot.innerHTML = message ? `<div class="error-box">${escapeHtml(message)}</div>` : "";
  }

  function showDone(text) {
    showError("");
    showStatusLine("staff-status", text, { before: "staff-list" });
  }

  function render(staffList) {
    const list = document.getElementById("staff-list");
    people = staffList;
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
      ? `<p class="hint">Только вы заводите и удаляете сотрудников. Эту роль нельзя удалить —
  только передать.</p>`
      : `<p class="hint">Заводить и удалять сотрудников может только главный
         администратор.</p>`;

    list.innerHTML = staffList.map((s) => cardHtml(s, me)).join("");

    list.querySelectorAll("[data-toggle-active]").forEach((btn) => {
      btn.addEventListener("click", () => toggleActive(btn.dataset.toggleActive, btn.dataset.active !== "true", btn));
    });
    list.querySelectorAll("[data-reset-pin]").forEach((btn) => {
      btn.addEventListener("click", () => resetPin(btn.dataset.resetPin, btn.dataset.name));
    });
    list.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", () => confirmDelete(JSON.parse(btn.dataset.person), btn));
    });
    list.querySelectorAll("[data-set-role]").forEach((btn) => {
      btn.addEventListener("click", () => setRole(JSON.parse(btn.dataset.person), btn.dataset.setRole, btn));
    });
    list.querySelectorAll("[data-transfer]").forEach((btn) => {
      btn.addEventListener("click", () => confirmTransfer(JSON.parse(btn.dataset.person), btn));
    });
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
  // Не оптимистично: удалённого не вернуть, и показывать «удалён» раньше,
  // чем таблица согласилась, значит обещать то, чего ещё нет.
  function confirmDelete(person, btn) {
    TG.confirmDestructive(
      `Удалить ${person.full_name}?`,
      "Войти он больше не сможет. Записи в журнале выдач останутся — там " +
      "сохранено его имя.",
      "Удалить",
      async (yes) => {
        if (!yes) return;
        const restore = busyButton(btn, "Удаляем…");
        try {
          const res = await apiPost("/staff/delete", { staff_id: Number(person.staff_id) });
          TG.hapticSuccess();
          commit(people.filter((p) => String(p.staff_id) !== String(person.staff_id)));
          // Называем того, кого удалили, по имени: это единственный способ
          // заметить, если удалился не тот.
          showDone("Удалён: " + ((res && res.full_name) || person.full_name));
        } catch (err) {
          TG.hapticError();
          restore();
          showError(err.message);
        }
      });
  }

  // Роль и активность — оптимистично, как setSection в models.js: карточка
  // меняется сразу, а откажет таблица — возвращаем, как было, и пишем почему.
  async function optimistic(staffId, changes, btn, busyText, endpoint, body, doneText) {
    const before = people;
    const restore = busyButton(btn, busyText);
    commit(patchPerson(staffId, changes));
    TG.hapticSuccess();
    try {
      await apiPost(endpoint, body);
      showDone(doneText);
    } catch (err) {
      TG.hapticError();
      restore();
      commit(before);
      showError(err.message);
    }
  }

  function setRole(person, role, btn) {
    optimistic(person.staff_id, { role }, btn, "Меняем…", "/staff/set-role",
      { staff_id: Number(person.staff_id), role },
      `${person.full_name}: ${role === "Admin" ? "теперь администратор" : "теперь сотрудник склада"}`);
  }

  // Передача главных прав — единственный способ перестать быть главным, и
  // отменить её сможет только тот, кому передали. Поэтому спрашиваем прямо.
  function confirmTransfer(person, btn) {
    TG.showConfirm(
      `Передать главные права: ${person.full_name}? После этого заводить и ` +
      `удалять сотрудников будет он, а не вы. Вернуть права сможет только он.`,
      async (yes) => {
        if (!yes) return;
        const restore = busyButton(btn, "Передаём…");
        try {
          await apiPost("/staff/transfer-owner", { staff_id: Number(person.staff_id) });
          TG.hapticSuccess();
          const session = Auth.getSession();
          if (session) Auth.setSession({ ...session, is_owner: false });
          // Как в handleStaffTransferOwner: новый главный — администратор,
          // прежний главным быть перестал.
          commit(people.map((p) => String(p.staff_id) === String(person.staff_id)
            ? { ...p, is_owner: true, role: "Admin" }
            : { ...p, is_owner: false }));
          resetAddForm();
          showDone("Главный администратор теперь " + person.full_name);
        } catch (err) {
          TG.hapticError();
          restore();
          showError(err.message);
        }
      });
  }

  function toggleActive(staffId, nextActive, btn) {
    const person = people.find((p) => String(p.staff_id) === String(staffId)) || {};
    optimistic(staffId, { active: nextActive }, btn, nextActive ? "Включаем…" : "Отключаем…",
      "/staff/set-active", { staff_id: Number(staffId), active: nextActive },
      `${person.full_name || "Сотрудник"}: ${nextActive ? "включён" : "отключён"}`);
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
          <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" class="pin-reset-input" />
        </div>
      </div>
      <p class="hint">Для ${escapeHtml(name)}, 6 цифр.</p>
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
      if (!/^\d{6}$/.test(pin)) {
        err.innerHTML = `<div class="error-box">PIN — ровно 6 цифр</div>`;
        return;
      }
      const restore = busyButton(box.querySelector(".pin-reset-save"));
      try {
        await apiPost("/staff/set-pin", { staff_id: Number(staffId), pin });
        TG.hapticSuccess();
        box.remove();
        showDone(`PIN изменён. Передайте его ${name} — войти надо будет заново.`);
      } catch (e) {
        TG.hapticError();
        restore();
        err.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
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
    if (!/^\d{6}$/.test(pin)) {
      showBoxError("staff-add-error", "PIN — ровно 6 цифр");
      return;
    }
    const restore = busyButton(document.getElementById("new-staff-submit"), "Заводим…");
    try {
      const res = await apiPost("/staff/create", { full_name, login, pin, role });
      TG.hapticSuccess();
      resetAddForm();
      // Сервер вернул номер, остальное мы и так знаем (handleStaffCreate).
      commit(people.concat([{
        staff_id: res && res.staff_id, full_name, login, role, active: true, is_owner: false,
      }]));
      showDone("Заведён: " + full_name);
    } catch (err) {
      TG.hapticError();
      showBoxError("staff-add-error", err.message);
    } finally {
      restore();
    }
  }

  function onShow() {
    resetAddForm();
    showError("");
    showStatusLine("staff-status", "");
    loadList();
  }

  function init() {
    document.getElementById("staff-add-toggle").addEventListener("click", () => {
      const form = document.getElementById("staff-add-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("new-staff-submit").addEventListener("click", submitNewStaff);
    Pull.register("staff", () => loadList({ force: true }));
    Router.register("staff", { onShow });
  }

  return { init };
})();
