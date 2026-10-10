// Экран «Модели» (администраторам): разбор справочника моделей по категориям.
//
// При импорте категорию угадывают правила по словам в названии, и часть моделей
// оседает не там. Руками в таблице это не чинится: номер вещи XXYYZZ начинается
// с номера категории. Перенос делает бэкенд — с перенумерацией вещей и
// переписыванием ссылок в журналах.

const ModelsScreen = (() => {
  const CACHE = "models";
  let models = [];      // [{ category, model_code, model_name }]
  let counts = {};      // "CAM|01" -> сколько позиций
  let query = "";
  let focus = null;     // { category, model_code } — пришли из карточки вещи
  let warnings = {};    // "CAM|01" -> подсказка после переименования (до ухода с экрана)

  const isAdmin = () => ((Auth.getSession() || {}).role === "Admin");

  // Пусто — «не размечено»: такая модель видна на сайте в обоих разделах.
  // Забытая отметка не должна прятать технику с витрины.
  const SECTION_CHOICES = [
    { value: "", label: "без # — видно везде" },
    { value: "CINE", label: "#кино" },
    { value: "PHOTO", label: "#фото" },
    { value: "CINE,PHOTO", label: "#кино #фото" },
  ];

  // В поиске #кино, #фото и #без отбирают по разделу, остальные слова — по
  // названию: «#без samyang» — неразмеченные Samyang.
  const TAG_FILTER = {
    "#кино": (s) => s.indexOf("CINE") !== -1,
    "#фото": (s) => s.indexOf("PHOTO") !== -1,
    "#без": (s) => !s,
  };

  function key(m) {
    return m.category + "|" + m.model_code;
  }

  // Число позиций считаем по кэшу каталога: отдельный запрос ради счётчиков
  // стоил бы 5–8 секунд, а каталог на этом экране и так уже загружен.
  function recount() {
    counts = {};
    (Cache.items("equipment") || []).forEach((item) => {
      const k = item.category + "|" + String(item.model_code || "");
      counts[k] = (counts[k] || 0) + 1;
    });
  }

  async function load() {
    const box = document.getElementById("models-content");
    // Прошлый список — сразу, свежий — молча вслед. Список моделей меняется
    // редко (переезд модели между категориями, новая цена), а ждать чтения из
    // таблицы приходилось на каждом заходе.
    const known = Cache.items(CACHE);
    if (known && known.length) {
      models = known;
      recount();
      render();
      if (Cache.isFresh(CACHE)) return;
    } else {
      box.innerHTML = skeleton(4);
    }
    try {
      const fresh = await apiPost("/models/list", {});
      Cache.set(CACHE, fresh);
      models = fresh;
      recount();
      if (!isTyping("#models-content")) render();
    } catch (err) {
      if (known && known.length) { showBoxError("models-error", err.message); return; }
      box.innerHTML = "";
      showBoxError("models-error", err.message);
    }
  }

  function matches(m) {
    if (!query) return true;
    const words = query.split(/\s+/);
    const section = String(m.section || "");
    if (!words.filter((w) => TAG_FILTER[w]).every((w) => TAG_FILTER[w](section))) return false;
    const text = words.filter((w) => !TAG_FILTER[w]).join(" ");
    return !text || [m.model_name, m.model_code, categoryLabel(m.category)]
      .filter(Boolean).join(" ").toLowerCase().indexOf(text) !== -1;
  }

  function render() {
    const box = document.getElementById("models-content");
    const cats = categoryList();
    const shown = models.filter(matches);

    if (!models.length) {
      box.innerHTML = `<p class="empty">Моделей пока нет. Они появляются сами,
        когда заводите оборудование или импортируете таблицу.</p>`;
      return;
    }

    let html = `
      <div class="searchbar">
        <input type="search" id="models-search" placeholder="Поиск по модели"
               value="${escapeHtml(query)}" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </div>
      <p class="hint">Модель переезжает со всеми позициями, и номера вещей меняются:
      они начинаются с номера категории. Сколько тронет — скажем заранее.</p>`;

    if (!shown.length) {
      html += `<p class="empty">Под поиск ничего не попало</p>`;
      box.innerHTML = html;
      bind();
      return;
    }

    // Группами по категориям — так видно, что лежит не там.
    cats.forEach((cat) => {
      const inCat = shown.filter((m) => m.category === cat.code);
      if (!inCat.length) return;
      const total = inCat.reduce((sum, m) => sum + (counts[key(m)] || 0), 0);
      html += `
        <div class="section-title">${escapeHtml(cat.label)} · ${escapeHtml(cat.num)} ·
          ${inCat.length} ${plural(inCat.length, "модель", "модели", "моделей")},
          ${total} ${plural(total, "позиция", "позиции", "позиций")}</div>
        ${inCat.map((m) => `<div class="form-group">${rowHtml(m, cats)}</div>`).join("")}`;
    });

    box.innerHTML = html;
    bind();
    if (focus) {
      const m = models.filter((x) => x.category === focus.category &&
        Number(x.model_code) === Number(focus.model_code))[0];
      const el = m && (document.getElementById("model-name-" + key(m)) ||
        document.getElementById("model-cat-" + key(m)));
      if (el) {
        el.scrollIntoView({ block: "center" });
        focus = null;
      }
    }
  }

  function rowHtml(m, cats) {
    const n = counts[key(m)] || 0;
    const k = escapeHtml(key(m));
    const admin = isAdmin();
    // Название и фото правят только администраторы (бэкенд проверяет роль сам;
    // здесь контролы скрыты, чтобы не звать заведомо отказную ручку).
    const nameField = admin
      ? `<div class="field">
          <label for="model-name-${k}">Название</label>
          <input id="model-name-${k}" type="text" maxlength="120" data-name="${k}"
                 value="${escapeHtml(m.model_name)}" autocapitalize="off" autocorrect="off" spellcheck="false" />
          ${warnings[key(m)] ? `<p class="hint">${escapeHtml(warnings[key(m)])}</p>` : ""}
        </div>
        <div class="field">
          <label>Фото</label>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
            ${m.photo
              ? `<img src="${escapeHtml(m.photo)}" alt="" width="56" height="56"
                      style="width:56px;height:56px;object-fit:contain;background:#fff;border-radius:8px;border:1px solid var(--border, #ddd)" />`
              : `<div style="width:56px;height:56px;border-radius:8px;border:1px dashed var(--muted, #999)"></div>`}
            <button type="button" class="btn btn--secondary" style="width:auto;min-height:36px;padding:6px 12px" data-photo-pick="${k}">Фото</button>
            ${m.photo ? `<button type="button" class="btn btn--secondary" style="width:auto;min-height:36px;padding:6px 12px" data-photo-remove="${k}">Убрать</button>` : ""}
            <input type="file" accept="image/*" hidden data-photo-file="${k}" />
          </div>
        </div>`
      : `<p><b>${escapeHtml(m.model_name)}</b></p>`;
    return `
      ${nameField}
      <div class="field">
        <label for="model-cat-${k}">Категория</label>
        <select id="model-cat-${k}" data-move="${k}">
          ${cats.map((c) => `<option value="${escapeHtml(c.code)}"${
            c.code === m.category ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
        </select>
        <p class="hint">${escapeHtml(m.category)}·${escapeHtml(m.model_code)} ·
          ${n} ${plural(n, "позиция", "позиции", "позиций")}</p>
      </div>
      <div class="field">
        <label for="model-sec-${k}">Раздел на сайте</label>
        <select id="model-sec-${k}" data-section="${k}">
          ${SECTION_CHOICES.map((c) => `<option value="${escapeHtml(c.value)}"${
            c.value === (m.section || "") ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="model-price-${k}">Цена, ₽</label>
        <input id="model-price-${k}" type="number" inputmode="numeric"
               data-price="${k}"
               value="${escapeHtml(String(m.price === undefined || m.price === null ? "" : m.price))}" />
      </div>`;
  }

  function bind() {
    const search = document.getElementById("models-search");
    if (search) {
      search.addEventListener("input", (e) => {
        query = e.target.value.trim().toLowerCase();
        render();
        // Перерисовка пересоздаёт поле — возвращаем в него курсор, иначе
        // клавиатура закрывается после первой же буквы.
        const again = document.getElementById("models-search");
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    }
    document.querySelectorAll("[data-move]").forEach((sel) => {
      sel.addEventListener("change", () => move(sel.dataset.move, sel.value, sel));
    });
    document.querySelectorAll("[data-price]").forEach((input) => {
      input.addEventListener("change", (e) => setPrice(e.target.dataset.price, e.target.value, e.target));
    });
    document.querySelectorAll("[data-name]").forEach((input) => {
      input.addEventListener("change", (e) => setName(e.target.dataset.name, e.target.value, e.target));
    });
    document.querySelectorAll("[data-photo-pick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const file = document.querySelector(`[data-photo-file="${btn.dataset.photoPick}"]`);
        if (file) file.click();
      });
    });
    document.querySelectorAll("[data-photo-file]").forEach((input) => {
      input.addEventListener("change", () => {
        const f = input.files && input.files[0];
        if (f) setPhoto(input.dataset.photoFile, f, input);
      });
    });
    document.querySelectorAll("[data-photo-remove]").forEach((btn) => {
      btn.addEventListener("click", () => setPhoto(btn.dataset.photoRemove, null, btn));
    });
    document.querySelectorAll("[data-section]").forEach((sel) => {
      sel.addEventListener("change", () => setSection(sel.dataset.section, sel.value, sel));
    });
  }

  // Раздел меняется без подтверждения: в отличие от переноса между
  // категориями, он ничего не перенумеровывает и откатывается тем же выбором.
  // Цена нужна акту о материальной ответственности: без неё в документе стоит
  // прочерк. Сохраняем по уходу из поля, а не на каждой цифре — иначе на
  // каждое нажатие уходил бы запрос на несколько секунд.
  async function setPrice(modelKey, value, input) {
    const model = models.filter((m) => key(m) === modelKey)[0];
    if (!model) return;
    const was = model.price === undefined || model.price === null ? "" : String(model.price);
    if (String(value).trim() === was) return;
    const parts = modelKey.split("|");
    input.disabled = true;
    showBoxError("models-error", "");
    try {
      const res = await apiPost("/models/price", {
        category: parts[0], model_code: parts[1], price: String(value).trim(),
      });
      model.price = res.price;
      // replace, а не set: поправленная цена не делает свежим весь справочник.
      Cache.replace(CACHE, models);
      TG.hapticSuccess();
    } catch (err) {
      TG.hapticError();
      input.value = was;
      showBoxError("models-error", err.message);
      TG.showAlert(err.message);
    } finally {
      input.disabled = false;
    }
  }

  // Название: сохраняем по Enter или уходу из поля, если текст изменился.
  // Бэкенд хранит набранное как есть и сам переписывает вещи модели.
  async function setName(modelKey, value, input) {
    const model = models.filter((m) => key(m) === modelKey)[0];
    if (!model) return;
    const typed = String(value).replace(/\s+/g, " ").trim();
    if (typed === model.model_name) { input.value = model.model_name; return; }
    const parts = modelKey.split("|");
    input.disabled = true;
    showBoxError("models-error", "");
    try {
      const res = await apiPost("/models/rename", {
        category: parts[0], model_code: parts[1], model_name: typed,
      });
      model.model_name = res.model_name;
      if (res.warning) warnings[modelKey] = res.warning; else delete warnings[modelKey];
      Cache.replace(CACHE, models);
      // Названия вещей в каталоге изменились — старый кэш показал бы прежнее.
      if (res.renamed_units) Cache.clear("equipment");
      TG.hapticSuccess();
      render();
    } catch (err) {
      TG.hapticError();
      input.value = model.model_name;
      showBoxError("models-error", err.message);
      TG.showAlert(err.message);
    } finally {
      input.disabled = false;
    }
  }

  async function setPhoto(modelKey, file, control) {
    const model = models.filter((m) => key(m) === modelKey)[0];
    if (!model) return;
    const parts = modelKey.split("|");
    control.disabled = true;
    showBoxError("models-error", "");
    try {
      const image = file ? await preparePhoto(file) : "";
      const res = await apiPost("/models/photo", {
        category: parts[0], model_code: parts[1], image,
      });
      model.photo = res.photo;
      Cache.replace(CACHE, models);
      TG.hapticSuccess();
      render();
    } catch (err) {
      TG.hapticError();
      showBoxError("models-error", err.message);
      TG.showAlert(err.message);
    } finally {
      control.disabled = false;
      if (control.value) control.value = "";
    }
  }

  async function setSection(modelKey, value, select) {
    const model = models.filter((m) => key(m) === modelKey)[0];
    if (!model) return;
    const was = model.section || "";
    const parts = modelKey.split("|");
    select.disabled = true;
    showBoxError("models-error", "");
    try {
      await apiPost("/models/sections", {
        models: [{ category: parts[0], model_code: parts[1], section: value }],
      });
      model.section = value;
      Cache.replace(CACHE, models);
      TG.hapticSuccess();
    } catch (err) {
      TG.hapticError();
      select.value = was;
      showBoxError("models-error", err.message);
      TG.showAlert(err.message);
    } finally {
      select.disabled = false;
    }
  }

  function move(modelKey, toCategory, select) {
    const parts = modelKey.split("|");
    const model = models.filter((m) => key(m) === modelKey)[0];
    if (!model || toCategory === model.category) return;

    const n = counts[modelKey] || 0;
    const back = () => { select.value = model.category; };

    TG.showConfirm(
      `Перенести «${model.model_name}» в «${categoryLabel(toCategory)}»?\n\n` +
      (n
        ? `Позиций: ${n}. У всех сменятся номера — они начинаются с номера ` +
          `категории. Напечатанные этикетки этих вещей станут неверными.`
        : `Позиций у модели нет, менять нечего кроме самой записи.`),
      (yes) => {
        if (!yes) { back(); return; }
        submit(parts[0], parts[1], toCategory, select, back);
      });
  }

  async function submit(from, code, to, select, back) {
    select.disabled = true;
    showBoxError("models-error", "");
    try {
      const res = await apiPost("/model/move", {
        category: from, model_code: code, to_category: to,
      });
      TG.hapticSuccess();
      // Каталог сбрасываем, а не правим построчно: у перенесённых вещей меняются
      // номер, категория и код модели, и тап по строке со старым номером дал бы
      // «не найдено». Позиций у модели не было — сбрасывать нечего. Справочник
      // моделей — тоже: load() ниже должен нарисовать уже перенесённую модель.
      if (res.moved) Cache.clear("equipment");
      Cache.clear(CACHE);
      TG.showAlert(resultText(res));
      await load();
    } catch (err) {
      TG.hapticError();
      back();
      // Блок с ошибкой стоит над всем списком: если категорию меняли в его
      // середине, текст отрисуется выше экрана, и от отказа останется одна
      // вибрация — «не работает, и непонятно почему». Поэтому причину сначала
      // говорим окном, как и везде в приложении, а в блоке оставляем, чтобы
      // можно было перечитать.
      showBoxError("models-error", err.message);
      TG.showAlert(err.message);
      const box = document.getElementById("models-error");
      if (box && box.scrollIntoView) box.scrollIntoView({ block: "nearest" });
    } finally {
      select.disabled = false;
    }
  }

  // Что сказать после переноса. Уложиться надо в 256 знаков — столько берёт
  // окно Telegram, и на длинном тексте оно не появляется вовсе. Поэтому здесь
  // только то, что человеку решает: что перенесли, сколько позиций тронуло и
  // что этикетки недействительны. Образец из старых→новых номеров пришлось
  // убрать: именно он разрывал лимит, а перечитать его в окне всё равно нельзя
  // — новые номера видны в списке и на карточках.
  function resultText(res) {
    const name = shorten(res.model_name, 60);
    const parts = [];
    parts.push(res.merged
      ? `«${name}» слита с такой же моделью в «${categoryLabel(res.to)}».`
      : `«${name}» перенесена в «${categoryLabel(res.to)}».`);
    parts.push(res.moved
      ? `Позиций: ${res.moved}, у всех новые номера. Этикетки этих позиций ` +
        `нужно напечатать заново.`
      : `Позиций у модели не было.`);
    return parts.join("\n\n");
  }

  function shorten(value, limit) {
    const text = String(value || "");
    return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
  }

  function onShow(params = {}) {
    // Из карточки вещи: сразу к её модели — поиск по названию и прокрутка.
    focus = params.category ? { category: params.category, model_code: params.model_code } : null;
    query = focus ? String(params.name || "").trim().toLowerCase() : "";
    warnings = {};
    showBoxError("models-error", "");
    load();
  }

  function init() {
    Router.register("models", { onShow });
  }

  return { init };
})();
