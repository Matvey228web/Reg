// Экран "Объявления" (любой вошедший): список действующих + добавление, правка и снятие.
// Скопирован с staff.js: список карточек, форма внизу, ошибки в error-box.
// Объявления показываются на сайте проката первой строкой.

const AnnouncementsScreen = (() => {
  let limits = { title: 120, text: 2000, lines: 10, active: 10 };
  let items = [];
  let editingId = "";

  function untilLabel(a) {
    if (!a.until) return "Пока не снимете";
    const [y, m, d] = a.until.split("-");
    return (a.expired ? "Срок вышел " : "Показывается до ") + `${d}.${m}.${y}`;
  }

  async function loadList() {
    const list = document.getElementById("ann-list");
    list.innerHTML = skeleton(2);
    try {
      const res = await apiPost("/announcements/list", {});
      limits = { ...limits, ...(res.limits || {}) };
      items = res.items || [];
      if (!items.length) {
        list.innerHTML = `<p class="empty">Объявлений нет. Сайт покажет их первой строкой, как только вы добавите.</p>`;
        return;
      }
      list.innerHTML = items.map(cardHtml).join("");
      list.querySelectorAll("[data-ann-edit]").forEach((btn) => {
        btn.addEventListener("click", () => startEdit(btn.dataset.annEdit));
      });
      list.querySelectorAll("[data-ann-remove]").forEach((btn) => {
        btn.addEventListener("click", () => confirmRemove(btn.dataset.annRemove));
      });
    } catch (err) {
      list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  function cardHtml(a) {
    return `
      <div class="card">
        <div class="card-title">
          ${escapeHtml(a.title)}
          ${a.expired ? `<span class="badge badge--retired">Срок вышел</span>` : ""}
        </div>
        <div class="card-sub">${escapeHtml(untilLabel(a))}${a.created_by_name ? " · " + escapeHtml(a.created_by_name) : ""}</div>
        <p class="hint" style="white-space:pre-line;">${escapeHtml(a.text)}</p>
        <div class="staff-actions">
          <button class="btn btn--secondary" data-ann-edit="${escapeHtml(a.announcement_id)}">Править</button>
          <button class="btn btn--danger" data-ann-remove="${escapeHtml(a.announcement_id)}">Снять</button>
        </div>
      </div>`;
  }

  // Снятое с сайта пропадает сразу, но строка в таблице остаётся: записи не
  // удаляем. Поэтому спрашиваем коротко, без страшных слов.
  function confirmRemove(id) {
    const a = items.find((x) => x.announcement_id === id);
    if (!a) return;
    TG.confirmDestructive(
      `Снять «${a.title}»?`,
      "Объявление пропадёт с сайта. Строка в таблице останется.",
      "Снять",
      async (yes) => {
        if (!yes) return;
        try {
          await apiPost("/announcement/remove", { announcement_id: id });
          TG.hapticSuccess();
          if (editingId === id) resetForm();
          loadList();
        } catch (err) {
          TG.hapticError();
          TG.showAlert(err.message);
        }
      });
  }

  function showForm(show) {
    document.getElementById("ann-form").style.display = show ? "block" : "none";
  }

  function resetForm() {
    editingId = "";
    showForm(false);
    document.getElementById("ann-title").value = "";
    document.getElementById("ann-text").value = "";
    document.getElementById("ann-until").value = "";
    document.getElementById("ann-form-title").textContent = "Новое объявление";
    document.getElementById("ann-submit").textContent = "Опубликовать";
    showBoxError("ann-error", "");
  }

  function startEdit(id) {
    const a = items.find((x) => x.announcement_id === id);
    if (!a) return;
    editingId = id;
    document.getElementById("ann-title").value = a.title;
    document.getElementById("ann-text").value = a.text;
    document.getElementById("ann-until").value = a.until || "";
    document.getElementById("ann-form-title").textContent = "Правка объявления";
    document.getElementById("ann-submit").textContent = "Сохранить";
    showBoxError("ann-error", "");
    showForm(true);
    document.getElementById("ann-title").focus();
  }

  async function submit() {
    const title = document.getElementById("ann-title").value.trim();
    const text = document.getElementById("ann-text").value.trim();
    const until = document.getElementById("ann-until").value;
    showBoxError("ann-error", "");
    if (!title || !text) {
      showBoxError("ann-error", "Заполните заголовок и текст");
      return;
    }
    const btn = document.getElementById("ann-submit");
    btn.disabled = true;
    try {
      await apiPost("/announcement/save", { announcement_id: editingId, title, text, until });
      TG.hapticSuccess();
      resetForm();
      loadList();
    } catch (err) {
      TG.hapticError();
      showBoxError("ann-error", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function onShow() {
    resetForm();
    loadList();
  }

  function init() {
    document.getElementById("ann-add-toggle").addEventListener("click", () => {
      resetForm();
      showForm(true);
    });
    document.getElementById("ann-cancel").addEventListener("click", resetForm);
    document.getElementById("ann-submit").addEventListener("click", submit);
    Router.register("announcements", { onShow });
  }

  return { init };
})();
