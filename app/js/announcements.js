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

  const CACHE = "announcements";
  let edits = 0;   // свои правки, сделанные пока список шёл с сервера

  // Список живёт в кэше, как на «Сотрудниках» (staff.js loadList): показываем
  // прошлый сразу, свежий подтягиваем молча.
  async function loadList({ force = false } = {}) {
    const list = document.getElementById("ann-list");
    const cached = Cache.items(CACHE);
    if (cached) render(cached);
    if (!force && cached && Cache.isFresh(CACHE)) return;
    if (!cached) list.innerHTML = skeleton(2);
    const seq = edits;
    try {
      // Ответ — объект со списком и пределами, поэтому не Cache.load:
      // в кэш кладём только список.
      const res = await apiPost("/announcements/list", {}, { fresh: force });
      limits = { ...limits, ...(res.limits || {}) };
      // Пока список шёл, здесь же что-то сняли или сохранили — ответ этого
      // не видел. Оставляем то, что на экране.
      if (seq !== edits) return;
      Cache.set(CACHE, res.items || []);
      render(res.items || []);
    } catch (err) {
      if (!cached) list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
      else showBoxError("ann-list-error", "Не удалось обновить список: " + err.message);
    }
  }

  function render(list) {
    items = list;
    ensureSlot("ann-list-error", "ann-list");
    const box = document.getElementById("ann-list");
    if (!items.length) {
      box.innerHTML = `<p class="empty">Объявлений нет. Сайт покажет их первой строкой, как только вы добавите.</p>`;
      return;
    }
    box.innerHTML = items.map(cardHtml).join("");
    box.querySelectorAll("[data-ann-edit]").forEach((btn) => {
      btn.addEventListener("click", () => startEdit(btn.dataset.annEdit));
    });
    box.querySelectorAll("[data-ann-remove]").forEach((btn) => {
      btn.addEventListener("click", () => confirmRemove(btn.dataset.annRemove, btn));
    });
  }

  // Правка своими руками — экран и кэш без нового запроса.
  function commit(next) {
    edits++;
    if (!Cache.replace(CACHE, next)) Cache.set(CACHE, next);
    render(next);
  }

  function showDone(text) {
    showBoxError("ann-list-error", "");
    showStatusLine("ann-status", text, { before: "ann-list" });
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
  // Снимаем оптимистично, как setSection в models.js: карточка уходит сразу,
  // откажет таблица — возвращается на место с причиной над списком.
  function confirmRemove(id, btn) {
    const a = items.find((x) => x.announcement_id === id);
    if (!a) return;
    TG.confirmDestructive(
      `Снять «${a.title}»?`,
      "Объявление пропадёт с сайта. Строка в таблице останется.",
      "Снять",
      async (yes) => {
        if (!yes) return;
        const before = items;
        busyButton(btn, "Снимаем…");
        commit(items.filter((x) => x.announcement_id !== id));
        if (editingId === id) resetForm();
        TG.hapticSuccess();
        showDone("Снято с сайта: " + a.title);
        try {
          await apiPost("/announcement/remove", { announcement_id: id });
        } catch (err) {
          TG.hapticError();
          commit(before);
          showStatusLine("ann-status", "");
          showBoxError("ann-list-error", "Не сняли «" + a.title + "»: " + err.message);
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
    const restore = busyButton(document.getElementById("ann-submit"),
      editingId ? "Сохраняем…" : "Публикуем…");
    const id = editingId;
    try {
      const res = await apiPost("/announcement/save", { announcement_id: id, title, text, until });
      TG.hapticSuccess();
      restore();
      resetForm();
      // Что записалось, известно и так (handleAnnouncementSave): абзацы —
      // непустые строки без отступов. Новое — первым, как в /announcements/list.
      const row = {
        title, until,
        text: text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join("\n"),
        expired: !!until && until < new Date().toISOString().substring(0, 10),
      };
      if (id) {
        commit(items.map((a) => a.announcement_id === id ? { ...a, ...row } : a));
        showDone("Сохранено");
      } else {
        const me = Auth.getSession() || {};
        commit([{
          ...row, announcement_id: String(res && res.announcement_id),
          created_at: new Date().toISOString(), created_by_name: me.full_name || "",
        }].concat(items));
        showDone("Опубликовано — сайт покажет его первой строкой");
      }
    } catch (err) {
      TG.hapticError();
      restore();
      showBoxError("ann-error", err.message);
    }
  }

  // Праздничные темы сайта — тумблер главного администратора (site_seasons в
  // SETTINGS_SPEC): лицо витрины рядом с её первой строкой. Значение берём из
  // кэша настроек, как его кладёт settings.js; нет кэша — спрашиваем молча.
  // Переключение сразу, при отказе тумблер возвращается (как setSection в
  // models.js). Сайт узнаёт о нём из /public/announcements.
  function seasonsHtml(on) {
    return `
      <div class="form-group">
        <div class="toggle-row">
          <label for="ann-seasons">Темы на сайте</label>
          <input type="checkbox" id="ann-seasons" ${on ? "checked" : ""} />
        </div>
      </div>
      <p class="hint">Новый год, Хэллоуин и День кино по календарю. Выключено — сайт всегда обычный.</p>`;
  }

  function drawSeasons() {
    const box = ensureSlot("ann-seasons-box", "ann-list");
    const me = Auth.getSession() || {};
    if (!me.is_owner) { box.innerHTML = ""; return; }
    const known = Cache.one("settings");
    const value = known && known.settings ? known.settings.site_seasons : undefined;
    box.innerHTML = seasonsHtml(value === undefined ? true : Number(value) !== 0);
    document.getElementById("ann-seasons").addEventListener("change", toggleSeasons);
    if (value === undefined) {
      apiPost("/settings/get", {}).then((fresh) => {
        Cache.setOne("settings", fresh);
        const input = document.getElementById("ann-seasons");
        if (input && fresh.settings) input.checked = Number(fresh.settings.site_seasons) !== 0;
      }).catch(() => {});
    }
  }

  async function toggleSeasons(e) {
    const input = e.target;
    const on = input.checked;
    input.disabled = true;
    TG.hapticTick();
    try {
      const res = await apiPost("/settings/set", { settings: { site_seasons: on ? 1 : 0 } });
      const known = Cache.one("settings");
      if (known) Cache.setOne("settings", { ...known, settings: res.settings });
      showStatusLine("ann-status", on ? "Темы на сайте включены" : "Темы на сайте выключены",
        { before: "ann-list" });
    } catch (err) {
      input.checked = !on;
      TG.hapticError();
      showBoxError("ann-list-error", err.message);
    } finally {
      input.disabled = false;
    }
  }

  function onShow() {
    resetForm();
    drawSeasons();
    loadList();
  }

  function init() {
    document.getElementById("ann-add-toggle").addEventListener("click", () => {
      resetForm();
      showForm(true);
    });
    document.getElementById("ann-cancel").addEventListener("click", resetForm);
    document.getElementById("ann-submit").addEventListener("click", submit);
    Pull.register("announcements", () => loadList({ force: true }));
    Router.register("announcements", { onShow });
  }

  return { init };
})();
