// Экран «Модели» (только для администраторов): разбор справочника моделей по
// категориям.
//
// Зачем он есть. Каталог собран импортом чужой таблицы, а категорию при импорте
// угадывают правила по словам в названии — часть моделей оседает не там.
// Поправить это в самой таблице нельзя: номер вещи XXYYZZ начинается с номера
// категории, и правка одной ячейки рассогласует номер с содержимым. Перенос
// делает бэкенд, с перенумерацией вещей и переписыванием ссылок в журналах.
//
// Список группируем по категориям и показываем, сколько в модели позиций: так
// сразу видно, что лежит не на своей полке.

const ModelsScreen = (() => {
  let models = [];      // [{ category, model_code, model_name }]
  let counts = {};      // "CAM|01" -> сколько позиций
  let query = "";

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
    box.innerHTML = skeleton(4);
    try {
      models = await apiPost("/models/list", {});
      recount();
      render();
    } catch (err) {
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
      <p class="hint">Смена категории переносит модель вместе со всеми её позициями.
      Номера вещей при этом меняются — они начинаются с номера категории, — поэтому
      система заранее скажет, сколько позиций тронет.</p>`;

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
      // Номера вещей изменились — кэш каталога устарел целиком.
      Cache.clear("equipment");
      TG.showAlert(resultText(res));
      await load();
    } catch (err) {
      TG.hapticError();
      back();
      showBoxError("models-error", err.message);
    } finally {
      select.disabled = false;
    }
  }

  function resultText(res) {
    const parts = [];
    parts.push(res.merged
      ? `«${res.model_name}» слита с такой же моделью в «${categoryLabel(res.to)}».`
      : `«${res.model_name}» перенесена в «${categoryLabel(res.to)}».`);
    if (res.moved) {
      parts.push(`Позиций: ${res.moved}, у всех новые номера.`);
      const sample = (res.renames || []).slice(0, 3)
        .map((r) => r.old + " → " + r.fresh).join("\n");
      if (sample) parts.push(sample + ((res.renames || []).length > 3 ? "\n…" : ""));
      parts.push("Этикетки этих позиций нужно напечатать заново.");
    } else {
      parts.push("Позиций у модели не было.");
    }
    return parts.join("\n\n");
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
