// Экран "Карточка предмета": статус, история выдач и дефектов, быстрый репорт дефекта.

const ItemScreen = (() => {
  let currentItemId = null;
  let clientsById = {};

  async function loadClientsMap() {
    try {
      const clients = await apiPost("/clients/list", {});
      clientsById = Object.fromEntries(clients.map((c) => [String(c.client_id), c]));
    } catch {
      clientsById = {};
    }
  }

  function clientLabel(clientId) {
    if (!clientId) return "—";
    const c = clientsById[String(clientId)];
    return c ? c.client_name + (c.project_name ? " · " + c.project_name : "") : `Клиент #${clientId}`;
  }

  async function load() {
    const content = document.getElementById("item-content");
    document.getElementById("item-title").textContent = currentItemId;
    content.innerHTML = `<p class="empty">Загрузка…</p>`;
    try {
      const [item, history] = await Promise.all([
        apiPost("/item/lookup", { item_id: currentItemId }),
        apiPost("/item/history", { item_id: currentItemId }),
      ]);
      await loadClientsMap();
      render(item, history);
    } catch (err) {
      content.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  function render(item, history) {
    document.getElementById("item-title").textContent = item.name;
    const content = document.getElementById("item-content");

    const txRows = (history.transactions || [])
      .slice()
      .sort((a, b) => new Date(b.checked_out_at) - new Date(a.checked_out_at))
      .map((t) => `
        <div class="card">
          <div class="card-title">${escapeHtml(clientLabel(t.client_id))} ${statusBadge(t.status)}</div>
          <div class="card-sub">Выдано: ${formatDate(t.checked_out_at)}${t.checked_in_at ? " · Принято: " + formatDate(t.checked_in_at) : ""}</div>
        </div>`).join("") || `<p class="empty">Пока не было выдач</p>`;

    const defectRows = (history.defects || [])
      .slice()
      .sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at))
      .map((d) => `
        <div class="card">
          <div class="card-title">${escapeHtml(STATUS_LABELS[d.severity] || d.severity)} ${statusBadge(d.status)}</div>
          <div class="card-sub">${escapeHtml(d.description || "")}</div>
          <div class="card-sub">Заявлен: ${formatDate(d.reported_at)}</div>
        </div>`).join("") || `<p class="empty">Дефектов не было</p>`;

    content.innerHTML = `
      <div class="card">
        <div class="card-title">${statusBadge(item.status)}</div>
        <div class="card-sub">${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(item.item_id)}</div>
        ${item.serial_number ? `<div class="card-sub">S/N: ${escapeHtml(item.serial_number)}</div>` : ""}
        ${item.condition_notes ? `<div class="card-sub">${escapeHtml(item.condition_notes)}</div>` : ""}
      </div>

      <div class="section">
        <div class="section-title">История выдач</div>
        ${txRows}
      </div>

      <div class="section">
        <div class="section-title">История дефектов</div>
        ${defectRows}
      </div>

      <div class="section">
        <button class="btn btn--secondary" id="item-report-defect-toggle">Сообщить о дефекте</button>
        <div id="item-defect-form" style="display:none;">
          <div class="field">
            <label for="item-defect-desc">Описание</label>
            <textarea id="item-defect-desc"></textarea>
          </div>
          <div class="field">
            <label for="item-defect-severity">Серьёзность</label>
            <select id="item-defect-severity">
              <option value="Minor">Незначительный</option>
              <option value="Major">Серьёзный</option>
              <option value="Out of Service">Не работает</option>
            </select>
          </div>
          <button class="btn" id="item-defect-submit">Сохранить дефект</button>
        </div>
      </div>
    `;

    document.getElementById("item-report-defect-toggle").addEventListener("click", () => {
      const form = document.getElementById("item-defect-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("item-defect-submit").addEventListener("click", async () => {
      const description = document.getElementById("item-defect-desc").value.trim();
      if (!description) { TG.showAlert("Опишите дефект"); return; }
      const btn = document.getElementById("item-defect-submit");
      btn.disabled = true;
      try {
        await apiPost("/defect/report", {
          item_id: item.item_id,
          description,
          severity: document.getElementById("item-defect-severity").value,
        });
        TG.hapticSuccess();
        TG.showAlert("Дефект сохранён");
        load();
      } catch (err) {
        TG.hapticError();
        TG.showAlert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function onShow(params) {
    currentItemId = params.itemId;
    load();
  }

  function init() {
    Router.register("item", { onShow });
  }

  return { init };
})();
