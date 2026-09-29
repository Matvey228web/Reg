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

  // Пусто — «не размечено»: такая модель видна на сайте в обоих разделах.
  // Забытая отметка не должна прятать технику с витрины.
  const SECTION_CHOICES = [
    { value: "", label: "Не размечено — видно везде" },
    { value: "CINE", label: "Только Кино" },
    { value: "PHOTO", label: "Только Фото" },
    { value: "CINE,PHOTO", label: "Кино и Фото" },
  ];

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
    return [m.model_name, m.model_code, categoryLabel(m.category)]
      .filter(Boolean).join(" ").toLowerCase().indexOf(query) !== -1;
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
        <div class="form-group">
          ${inCat.map((m) => rowHtml(m, cats)).join("")}
        </div>`;
    });

    box.innerHTML = html;
    bind();
  }

  function rowHtml(m, cats) {
    const n = counts[key(m)] || 0;
    return `
      <div class="field">
        <label for="model-cat-${escapeHtml(key(m))}">${escapeHtml(m.model_name)}</label>
        <select id="model-cat-${escapeHtml(key(m))}" data-move="${escapeHtml(key(m))}">
          ${cats.map((c) => `<option value="${escapeHtml(c.code)}"${
            c.code === m.category ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
        </select>
        <p class="hint">${escapeHtml(m.category)}·${escapeHtml(m.model_code)} ·
          ${n} ${plural(n, "позиция", "позиции", "позиций")}</p>
      </div>
      <div class="field">
        <label for="model-sec-${escapeHtml(key(m))}">Раздел на сайте</label>
        <select id="model-sec-${escapeHtml(key(m))}" data-section="${escapeHtml(key(m))}">
          ${SECTION_CHOICES.map((c) => `<option value="${escapeHtml(c.value)}"${
            c.value === (m.section || "") ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="model-price-${escapeHtml(key(m))}">Цена, ₽</label>
        <input id="model-price-${escapeHtml(key(m))}" type="number" inputmode="numeric"
               data-price="${escapeHtml(key(m))}"
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
      Cache.set(CACHE, models);
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
      Cache.set(CACHE, models);
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
      // Номера вещей изменились — кэш каталога устарел целиком, а список
      // моделей поедет за свежим: load() ниже уже не увидит прежний.
      Cache.clear("equipment");
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

  function onShow() {
    query = "";
    showBoxError("models-error", "");
    load();
  }

  function init() {
    Router.register("models", { onShow });
  }

  return { init };
})();
