// Экран "Клиенты": список клиентов/проектов, добавление нового, история аренды по клику.

const ClientsScreen = (() => {
  let itemsById = {};
  let expandedClientId = null;

  async function loadItemsMap() {
    try {
      const items = await apiPost("/equipment/list", {});
      itemsById = Object.fromEntries(items.map((i) => [i.item_id, i]));
    } catch {
      itemsById = {};
    }
  }

  async function loadList() {
    const list = document.getElementById("clients-list");
    list.innerHTML = `<p class="empty">Загрузка…</p>`;
    try {
      const clients = await apiPost("/clients/list", {});
      if (!clients.length) {
        list.innerHTML = `<p class="empty">Клиентов пока нет</p>`;
        return;
      }
      list.innerHTML = clients.map((c) => `
        <div class="card" data-client-id="${c.client_id}">
          <div class="card-title">${escapeHtml(c.client_name)}</div>
          <div class="card-sub">${escapeHtml(c.project_name || "")}${c.phone ? " · " + escapeHtml(c.phone) : ""}</div>
          <div id="client-history-${c.client_id}"></div>
        </div>
      `).join("");
      list.querySelectorAll("[data-client-id]").forEach((el) => {
        el.addEventListener("click", () => toggleHistory(el.dataset.clientId));
      });
    } catch (err) {
      list.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  async function toggleHistory(clientId) {
    const box = document.getElementById(`client-history-${clientId}`);
    if (!box) return;
    if (expandedClientId === clientId) {
      box.innerHTML = "";
      expandedClientId = null;
      return;
    }
    expandedClientId = clientId;
    box.innerHTML = `<p class="hint">Загрузка истории…</p>`;
    try {
      await loadItemsMap();
      const { transactions } = await apiPost("/client/history", { client_id: Number(clientId) });
      if (!transactions.length) {
        box.innerHTML = `<p class="hint">Аренд пока не было</p>`;
        return;
      }
      box.innerHTML = transactions
        .slice()
        .sort((a, b) => new Date(b.checked_out_at) - new Date(a.checked_out_at))
        .map((t) => {
          const item = itemsById[t.item_id];
          return `<div class="section" style="margin-top:8px;">
            <div class="card-sub">${escapeHtml(item ? item.name : t.item_id)} ${statusBadge(t.status)}</div>
            <div class="card-sub">Выдано: ${formatDate(t.checked_out_at)}${t.checked_in_at ? " · Принято: " + formatDate(t.checked_in_at) : ""}</div>
          </div>`;
        }).join("");
    } catch (err) {
      box.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  function resetAddForm() {
    document.getElementById("clients-add-form").style.display = "none";
    document.getElementById("new-client-name").value = "";
    document.getElementById("new-client-project").value = "";
    document.getElementById("new-client-phone").value = "";
    showBoxError("clients-add-error", "");
  }

  async function submitNewClient() {
    const client_name = document.getElementById("new-client-name").value.trim();
    if (!client_name) {
      showBoxError("clients-add-error", "Укажите имя или компанию");
      return;
    }
    const btn = document.getElementById("new-client-submit");
    btn.disabled = true;
    try {
      await apiPost("/client/create", {
        client_name,
        project_name: document.getElementById("new-client-project").value.trim(),
        phone: document.getElementById("new-client-phone").value.trim(),
      });
      TG.hapticSuccess();
      resetAddForm();
      loadList();
    } catch (err) {
      TG.hapticError();
      showBoxError("clients-add-error", err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function onShow() {
    expandedClientId = null;
    resetAddForm();
    loadList();
  }

  function init() {
    document.getElementById("clients-add-toggle").addEventListener("click", () => {
      const form = document.getElementById("clients-add-form");
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
    document.getElementById("new-client-submit").addEventListener("click", submitNewClient);
    Router.register("clients", { onShow });
  }

  return { init };
})();
