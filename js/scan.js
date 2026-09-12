// Экран "Сканировать": нативный QR-сканер Telegram → поиск предмета →
// оформление выдачи / приёма / дефекта в зависимости от текущего статуса.

const ScanScreen = (() => {
  let currentItem = null;
  let clients = [];
  let mode = null; // "checkout" | "checkin" | "defect"

  function reset() {
    currentItem = null;
    mode = null;
    document.getElementById("scan-result").innerHTML = "";
    showBoxError("scan-error", "");
    TG.mainButton.hide();
  }

  // silent: при автозапуске не показываем ошибку «сканера нет» — в обычном
  // браузере его и не должно быть, там работают ручной ввод и кнопка.
  async function startScan(silent) {
    showBoxError("scan-error", "");
    if (silent && !TG.hasScanQr()) return;
    QR.scan(async (code, error) => {
      if (error) {
        if (!silent) showBoxError("scan-error", error);
        return;
      }
      if (!code) return;
      await lookup(code.trim());
    });
  }

  async function lookup(itemId) {
    const result = document.getElementById("scan-result");
    result.innerHTML = skeleton(2);
    try {
      const item = await apiPost("/item/lookup", { item_id: itemId });
      currentItem = item;
      // Статус мог измениться — поправим его в кэше каталога, чтобы список не
      // показывал устаревшее «Доступно» до следующего обновления.
      if (typeof CatalogScreen !== "undefined" && CatalogScreen.patchCached) {
        CatalogScreen.patchCached(item.item_id, { status: item.status });
      }
      mode = item.status === "Available" ? "checkout" : item.status === "Rented" ? "checkin" : null;
      if (mode === "checkout") await loadClients();
      renderItem();
    } catch (err) {
      currentItem = null;
      result.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadClients() {
    try {
      clients = await apiPost("/clients/list", {});
    } catch {
      clients = [];
    }
  }

  function renderItem() {
    const result = document.getElementById("scan-result");
    const item = currentItem;
    const defectsHtml = item.open_defects && item.open_defects.length
      ? `<p class="hint">Открытые дефекты: ${item.open_defects.length}</p>` : "";

    result.innerHTML = `
      <div class="card">
        <div class="card-title">${escapeHtml(item.name)} ${statusBadge(item.status)}</div>
        <div class="card-sub">${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(item.item_id)}</div>
      </div>
      ${defectsHtml}
      <div class="filters" style="margin-top:12px;">
        <button class="btn ${mode === "checkout" ? "" : "btn--secondary"}" id="mode-checkout" ${item.status !== "Available" ? "disabled" : ""} style="width:auto;">Выдать</button>
        <button class="btn ${mode === "checkin" ? "" : "btn--secondary"}" id="mode-checkin" ${item.status !== "Rented" ? "disabled" : ""} style="width:auto;">Принять</button>
        <button class="btn ${mode === "defect" ? "" : "btn--secondary"}" id="mode-defect" style="width:auto;">Дефект</button>
      </div>
      <div id="mode-form"></div>
    `;
    document.getElementById("mode-checkout").addEventListener("click", async () => {
      mode = "checkout"; await loadClients(); renderItem(); renderForm();
    });
    document.getElementById("mode-checkin").addEventListener("click", () => { mode = "checkin"; renderItem(); renderForm(); });
    document.getElementById("mode-defect").addEventListener("click", () => { mode = "defect"; renderItem(); renderForm(); });
    renderForm();
  }

  function renderForm() {
    const box = document.getElementById("mode-form");
    if (!box) return;
    if (mode === "checkout") {
      box.innerHTML = `
        <div class="section">
          <div class="field">
            <label for="scan-client">Клиент / проект</label>
            <select id="scan-client">
              <option value="">— выберите —</option>
              ${clients.map((c) => `<option value="${c.client_id}">${escapeHtml(c.client_name)}${c.project_name ? " · " + escapeHtml(c.project_name) : ""}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="scan-return-date">Ожидаемая дата возврата</label>
            <input type="date" id="scan-return-date" />
          </div>
          <div class="field">
            <label for="scan-notes">Заметки</label>
            <textarea id="scan-notes"></textarea>
          </div>
        </div>`;
      TG.mainButton.show("Подтвердить выдачу", submitCheckout);
    } else if (mode === "checkin") {
      box.innerHTML = `
        <div class="section">
          <div class="toggle-row">
            <label for="scan-has-defect">Обнаружен дефект?</label>
            <input type="checkbox" id="scan-has-defect" />
          </div>
          <div id="scan-defect-fields" style="display:none;">
            <div class="field">
              <label for="scan-defect-desc">Описание дефекта</label>
              <textarea id="scan-defect-desc"></textarea>
            </div>
            <div class="field">
              <label for="scan-defect-severity">Серьёзность</label>
              <select id="scan-defect-severity">
                <option value="Minor">Незначительный — можно выдавать</option>
                <option value="Major">Серьёзный — снять с выдачи</option>
                <option value="Out of Service">Не работает — снять с выдачи</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label for="scan-checkin-notes">Заметки</label>
            <textarea id="scan-checkin-notes"></textarea>
          </div>
        </div>`;
      document.getElementById("scan-has-defect").addEventListener("change", (e) => {
        document.getElementById("scan-defect-fields").style.display = e.target.checked ? "block" : "none";
      });
      TG.mainButton.show("Подтвердить приём", submitCheckin);
    } else if (mode === "defect") {
      box.innerHTML = `
        <div class="section">
          <div class="field">
            <label for="scan-standalone-desc">Описание дефекта</label>
            <textarea id="scan-standalone-desc"></textarea>
          </div>
          <div class="field">
            <label for="scan-standalone-severity">Серьёзность</label>
            <select id="scan-standalone-severity">
              <option value="Minor">Незначительный — можно выдавать</option>
              <option value="Major">Серьёзный — снять с выдачи</option>
              <option value="Out of Service">Не работает — снять с выдачи</option>
            </select>
          </div>
        </div>`;
      TG.mainButton.show("Сохранить дефект", submitDefect);
    } else {
      box.innerHTML = "";
      TG.mainButton.hide();
    }
  }

  async function submitCheckout() {
    const clientId = document.getElementById("scan-client").value;
    if (!clientId) { TG.showAlert("Выберите клиента"); return; }
    TG.mainButton.setLoading(true);
    try {
      await apiPost("/transaction/checkout", {
        item_id: currentItem.item_id,
        client_id: Number(clientId),
        expected_return_at: document.getElementById("scan-return-date").value || null,
        notes: document.getElementById("scan-notes").value.trim(),
      });
      TG.hapticSuccess();
      TG.showAlert("Оборудование выдано");
      await lookup(currentItem.item_id);
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    } finally {
      TG.mainButton.setLoading(false);
    }
  }

  async function submitCheckin() {
    const hasDefect = document.getElementById("scan-has-defect").checked;
    TG.mainButton.setLoading(true);
    try {
      await apiPost("/transaction/checkin", {
        item_id: currentItem.item_id,
        has_defect: hasDefect,
        defect_description: hasDefect ? document.getElementById("scan-defect-desc").value.trim() : null,
        defect_severity: hasDefect ? document.getElementById("scan-defect-severity").value : null,
        notes: document.getElementById("scan-checkin-notes").value.trim(),
      });
      TG.hapticSuccess();
      TG.showAlert("Оборудование принято");
      await lookup(currentItem.item_id);
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    } finally {
      TG.mainButton.setLoading(false);
    }
  }

  async function submitDefect() {
    const description = document.getElementById("scan-standalone-desc").value.trim();
    if (!description) { TG.showAlert("Опишите дефект"); return; }
    TG.mainButton.setLoading(true);
    try {
      await apiPost("/defect/report", {
        item_id: currentItem.item_id,
        description,
        severity: document.getElementById("scan-standalone-severity").value,
      });
      TG.hapticSuccess();
      TG.showAlert("Дефект сохранён");
      // Перечитываем предмет, а не закрываем экран: человеку надо увидеть,
      // изменился ли статус — незначительный дефект выдачу не блокирует.
      await lookup(currentItem.item_id);
    } catch (err) {
      TG.hapticError();
      TG.showAlert(err.message);
    } finally {
      TG.mainButton.setLoading(false);
    }
  }

  function onShow() {
    reset();
    // Камера открывается сразу: на складе это главное действие, и лишний тап
    // по кнопке здесь только мешал.
    startScan(true);
  }

  function init() {
    document.getElementById("scan-start-btn").addEventListener("click", () => startScan(false));
    document.getElementById("scan-manual-submit").addEventListener("click", async () => {
      const val = document.getElementById("scan-manual-input").value.trim();
      if (!val) return;
      showBoxError("scan-error", "");
      await lookup(val);
    });
    Router.register("scan", { onShow });
  }

  return { init };
})();
