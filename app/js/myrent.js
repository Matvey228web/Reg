// Экран «My rent» (администраторам): объявления студентов, которые они
// публикуют через бота. Модерации нет (решение владельца, 7 октября 2026) —
// студент публикует сразу, а админ может поправить текст, заменить фото,
// снять и вернуть любое объявление.
//
// Скопирован с models.js: список с кэшем «сразу старое, молча свежее», правка
// по месту, фото через общий preparePhoto (util.js). Отдельный файл — потому что
// это свой экран со своей разметкой, а не подраздел «Моделей».

const MyRentScreen = (() => {
  const CACHE = "myrent";
  let items = [];        // строки /myrent/admin/list
  let categories = [];   // [{ code, label }]
  let filter = "approved";
  let editingId = "";

  const LIMITS = { title: 80, description: 600, price: 1000000 };

  const FILTERS = [
    { key: "approved", label: "На сайте" },
    { key: "removed", label: "Снято" },
    // Строки, оставшиеся от модерации (части 1–2 контракта): новых таких нет,
    // но старые не должны пропасть с экрана.
    { key: "old", label: "Прочие" },
  ];

  const inFilter = (it, key) => key === "old"
    ? it.status !== "approved" && it.status !== "removed"
    : it.status === key;

  function categoryName(it) {
    const c = categories.find((x) => x.code === it.category);
    return it.category_label || (c && c.label) || it.category;
  }

  function priceText(it) {
    if (it.price === null || it.price === undefined || it.price === "") {
      return it.price_text || "Договорная";
    }
    return Number(it.price).toLocaleString("ru-RU") + " ₽";
  }

  function dateText(value) {
    const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    const d = new Date(value);
    return isNaN(d) ? "" : d.toLocaleDateString("ru-RU");
  }

  const username = (it) => String(it.tg_username || "").replace(/^@/, "");

  async function load({ force = false } = {}) {
    const box = document.getElementById("myrent-content");
    const known = Cache.one(CACHE);
    if (known) {
      items = known.items || [];
      categories = known.categories || [];
      render();
      if (!force && Cache.isFresh(CACHE)) return;
    } else {
      box.innerHTML = skeleton(4);
    }
    try {
      const res = await apiPost("/myrent/admin/list", {}, { fresh: force });
      Cache.setOne(CACHE, { items: res.items || [], categories: res.categories || [] });
      items = res.items || [];
      categories = res.categories || [];
      if (!isTyping("#myrent-content")) render();
    } catch (err) {
      if (!known) box.innerHTML = "";
      showBoxError("myrent-error", err.message);
    }
  }

  // Правим одну строку и кладём список на место, не делая его «свежим»:
  // остальные строки от этого свежее не стали (Cache.replace).
  function remember() {
    if (!Cache.replace(CACHE, { items, categories })) {
      Cache.setOne(CACHE, { items, categories });
    }
  }

  function render() {
    if (editingId) { renderEdit(); return; }
    const box = document.getElementById("myrent-content");
    if (!items.length) {
      box.innerHTML = `<p class="empty">Объявлений пока нет. Они появятся, когда студенты
        опубликуют их через бота.</p>`;
      return;
    }
    const tabs = FILTERS.filter((f) => f.key !== "old" || items.some((i) => inFilter(i, "old")));
    if (!tabs.some((t) => t.key === filter)) filter = "approved";
    const shown = items.filter((i) => inFilter(i, filter));
    box.innerHTML = `
      <div class="myrent-tabs">
        ${tabs.map((t) => `<button type="button" class="myrent-tab${t.key === filter ? " myrent-tab--on" : ""}"
          data-myrent-tab="${t.key}">${escapeHtml(t.label)} · ${items.filter((i) => inFilter(i, t.key)).length}</button>`).join("")}
      </div>
      <p class="hint">Студенты публикуют сами, без проверки. Здесь можно поправить, снять и вернуть любое
        объявление. Правка и фото студенту не приходят; снятие — приходит.</p>
      ${shown.length ? shown.map(rowHtml).join("") : `<p class="empty">В этом разделе пусто</p>`}`;
    box.querySelectorAll("[data-myrent-tab]").forEach((b) => {
      b.addEventListener("click", () => { filter = b.dataset.myrentTab; render(); });
    });
    box.querySelectorAll("[data-myrent-open]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;   // @username ведёт в Telegram, не в правку
        editingId = row.dataset.myrentOpen;
        showBoxError("myrent-error", "");
        render();
        window.scrollTo(0, 0);
      });
    });
  }

  function thumbHtml(it, size) {
    return it.photo
      ? `<img src="${escapeHtml(it.photo)}" alt="" width="${size}" height="${size}" class="myrent-thumb"
              style="width:${size}px;height:${size}px" loading="lazy" />`
      : `<div class="myrent-thumb myrent-thumb--empty" style="width:${size}px;height:${size}px"></div>`;
  }

  function rowHtml(it) {
    const u = username(it);
    return `
      <div class="card card--link myrent-row" data-myrent-open="${escapeHtml(it.id)}">
        ${thumbHtml(it, 56)}
        <div class="myrent-main">
          <div class="card-title">${escapeHtml(it.title)}</div>
          <div class="card-sub">${escapeHtml(categoryName(it))} · ${escapeHtml(priceText(it))}</div>
          <div class="card-sub">${u
            ? `<a href="https://t.me/${encodeURIComponent(u)}" target="_blank" rel="noopener">@${escapeHtml(u)}</a>`
            : escapeHtml(it.tg_name || "")} · ${escapeHtml(dateText(it.created_at))}</div>
        </div>
      </div>`;
  }

  function renderEdit() {
    const it = items.find((x) => x.id === editingId);
    const box = document.getElementById("myrent-content");
    if (!it) { editingId = ""; render(); return; }
    const removed = it.status === "removed";
    const u = username(it);
    const price = it.price === null || it.price === undefined ? "" : String(it.price);
    box.innerHTML = `
      <button class="sub-back" type="button" id="myrent-back">← К списку</button>
      <p class="hint">${escapeHtml(it.id)} · ${removed
        ? "снято" + (it.removed_by === "admin" ? " администратором" : " автором") : "на сайте"}
        ${u ? ` · <a href="https://t.me/${encodeURIComponent(u)}" target="_blank" rel="noopener">@${escapeHtml(u)}</a>` : ""}</p>
      <div class="form-group">
        <div class="field">
          <label for="myrent-category">Категория</label>
          <select id="myrent-category">
            ${categories.map((c) => `<option value="${escapeHtml(c.code)}"${
              c.code === it.category ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="myrent-title">Название</label>
          <input id="myrent-title" type="text" maxlength="${LIMITS.title}" value="${escapeHtml(it.title)}" />
        </div>
        <div class="field">
          <label for="myrent-description">Описание</label>
          <textarea id="myrent-description" rows="4" maxlength="${LIMITS.description}">${escapeHtml(it.description || "")}</textarea>
        </div>
        <div class="field">
          <label for="myrent-price">Цена, ₽/сутки</label>
          <input id="myrent-price" type="number" inputmode="numeric" min="0" max="${LIMITS.price}"
                 placeholder="Договорная" value="${escapeHtml(price)}" />
          <p class="hint">Пусто — на сайте будет «Договорная».</p>
        </div>
        <div class="field">
          <label>Фото</label>
          <div class="myrent-photo">
            ${thumbHtml(it, 72)}
            <button type="button" class="btn btn--secondary myrent-small" id="myrent-photo-pick">Заменить</button>
            <input type="file" accept="image/*" hidden id="myrent-photo-file" />
          </div>
          <p class="hint">В карточках бота у студента останется прежнее фото.</p>
        </div>
      </div>
      <button class="btn" type="button" id="myrent-save">Сохранить</button>
      ${removed
        ? `<button class="btn btn--secondary" type="button" id="myrent-restore">Вернуть на сайт</button>`
        : `<button class="btn btn--danger" type="button" id="myrent-remove">Снять</button>`}`;
    document.getElementById("myrent-back").addEventListener("click", () => {
      editingId = "";
      showBoxError("myrent-error", "");
      render();
    });
    document.getElementById("myrent-save").addEventListener("click", (e) => save(it, e.currentTarget));
    const rm = document.getElementById("myrent-remove");
    if (rm) rm.addEventListener("click", () => remove(it, rm));
    const rs = document.getElementById("myrent-restore");
    if (rs) rs.addEventListener("click", () => restore(it, rs));
    const file = document.getElementById("myrent-photo-file");
    document.getElementById("myrent-photo-pick").addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (f) setPhoto(it, f, file);
    });
  }

  // Ошибки пишем и в блок, и окном: на длинной форме блок вверху не виден
  // (так же сделано в models.js submit).
  function fail(err) {
    TG.hapticError();
    showBoxError("myrent-error", err.message);
    TG.showAlert(err.message);
  }

  async function save(it, btn) {
    const val = (id) => document.getElementById(id).value;
    const changes = {};
    const category = val("myrent-category");
    const title = val("myrent-title").replace(/\s+/g, " ").trim();
    const description = val("myrent-description").trim();
    const priceRaw = val("myrent-price").trim();
    if (!title) return fail(new Error("Название не может быть пустым"));
    if (title.length > LIMITS.title) return fail(new Error(`Название длиннее ${LIMITS.title} знаков`));
    if (description.length > LIMITS.description) return fail(new Error(`Описание длиннее ${LIMITS.description} знаков`));
    let price = null;
    if (priceRaw !== "") {
      price = Number(priceRaw);
      if (!Number.isInteger(price) || price < 0 || price > LIMITS.price) {
        return fail(new Error(`Цена — целое число от 0 до ${LIMITS.price}`));
      }
    }
    // Шлём только изменённое: бэкенд не должен переписывать то, что не трогали.
    if (category !== it.category) changes.category = category;
    if (title !== it.title) changes.title = title;
    if (description !== (it.description || "")) changes.description = description;
    const was = it.price === undefined || it.price === "" ? null : it.price;
    if (price !== (was === null ? null : Number(was))) changes.price = price;
    if (!Object.keys(changes).length) { TG.showAlert("Ничего не изменилось"); return; }

    btn.disabled = true;
    showBoxError("myrent-error", "");
    try {
      await apiPost("/myrent/admin/save", { id: it.id, changes });
      Object.assign(it, changes);
      if (changes.category) it.category_label = (categories.find((c) => c.code === category) || {}).label || it.category_label;
      if ("price" in changes) it.price_text = price === null ? "Договорная" : "";
      remember();
      TG.hapticSuccess();
      editingId = "";
      render();
    } catch (err) {
      fail(err);
      btn.disabled = false;
    }
  }

  async function setPhoto(it, file, input) {
    input.disabled = true;
    showBoxError("myrent-error", "");
    try {
      const image = await preparePhoto(file);
      const res = await apiPost("/myrent/admin/photo", { id: it.id, image });
      it.photo = res.photo;
      remember();
      TG.hapticSuccess();
      renderEdit();
    } catch (err) {
      fail(err);
    } finally {
      input.disabled = false;
      if (input.value) input.value = "";
    }
  }

  function remove(it, btn) {
    TG.showConfirm(`Снять «${it.title}» с сайта? Студенту придёт сообщение, что объявление снято администратором.`, async (yes) => {
      if (!yes) return;
      btn.disabled = true;
      showBoxError("myrent-error", "");
      try {
        const res = await apiPost("/myrent/admin/remove", { id: it.id });
        it.status = res.status || "removed";
        it.removed_by = "admin";
        remember();
        TG.hapticSuccess();
        editingId = "";
        filter = "removed";
        render();
      } catch (err) {
        fail(err);
        btn.disabled = false;
      }
    });
  }

  async function restore(it, btn) {
    btn.disabled = true;
    showBoxError("myrent-error", "");
    try {
      const res = await apiPost("/myrent/admin/restore", { id: it.id });
      it.status = res.status || "approved";
      it.removed_by = "";
      remember();
      TG.hapticSuccess();
      editingId = "";
      filter = "approved";
      render();
    } catch (err) {
      fail(err);
      btn.disabled = false;
    }
  }

  function onShow() {
    editingId = "";
    showBoxError("myrent-error", "");
    load();
  }

  function init() {
    Router.register("myrent", { onShow });
  }

  return { init };
})();
