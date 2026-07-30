// Локальная имитация бэкенда (Airtable + Latenode) для разработки и демонстрации
// приложения без реального аккаунта. Используется, когда CONFIG.MOCK_MODE === true.
// Структура и содержимое ответов соответствуют контракту вебхуков из SETUP.md.

const MockStore = (() => {
  let nextItemSeq = { CAM: 2, LEN: 1, LGT: 1, AUD: 0, GRP: 0, OTH: 0 };
  let nextClientId = 3;
  let nextTransactionId = 3;
  let nextDefectId = 2;

  const staff = [
    { staff_id: 1, full_name: "Иван Петров", login: "ivan", pin: "1234", role: "Warehouse Staff", active: true },
    { staff_id: 2, full_name: "Мария Сидорова", login: "maria", pin: "0000", role: "Admin", active: true },
  ];

  const equipment = [
    {
      item_id: "MIFS-CAM-001",
      name: "Sony FX6",
      category: "CAM",
      serial_number: "SN-FX6-118",
      status: "Available",
      condition_notes: "Полный комплект, всё в порядке",
      current_transaction_id: null,
    },
    {
      item_id: "MIFS-LEN-001",
      name: "Sigma 24-70mm f/2.8",
      category: "LEN",
      serial_number: "SN-SIG-042",
      status: "Rented",
      condition_notes: "",
      current_transaction_id: 1,
    },
  ];

  const clients = [
    { client_id: 1, client_name: "ООО Реклама Плюс", project_name: "Съёмка ролика", phone: "+7 900 000-00-01", notes: "" },
    { client_id: 2, client_name: "Пётр Иванов", project_name: "Свадебная съёмка", phone: "+7 900 000-00-02", notes: "" },
  ];

  const transactions = [
    {
      transaction_id: 1,
      item_id: "MIFS-LEN-001",
      client_id: 1,
      staff_out: 1,
      staff_in: null,
      checked_out_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      expected_return_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      checked_in_at: null,
      status: "Open",
      notes: "",
    },
  ];

  const defects = [
    {
      defect_id: 1,
      item_id: "MIFS-CAM-001",
      reported_by: 2,
      related_transaction_id: null,
      description: "Небольшая царапина на корпусе, не влияет на работу",
      severity: "Minor",
      status: "Resolved",
      reported_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      resolved_at: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString(),
      resolution_notes: "Косметическая, оставлена как есть",
    },
  ];

  const tokens = new Map(); // token -> staff_id

  function findStaffByLogin(login) {
    return staff.find((s) => s.login === login && s.active);
  }

  function findItem(item_id) {
    return equipment.find((i) => i.item_id === item_id);
  }

  function staffPublic(s) {
    return { staff_id: s.staff_id, full_name: s.full_name, role: s.role };
  }

  function requireToken(token) {
    const staff_id = tokens.get(token);
    if (!staff_id) {
      const err = new Error("Сессия недействительна, войдите заново");
      err.status = 401;
      throw err;
    }
    return staff_id;
  }

  return {
    staff, equipment, clients, transactions, defects, tokens,
    findStaffByLogin, findItem, staffPublic, requireToken,
    nextItemId(category) {
      nextItemSeq[category] = (nextItemSeq[category] || 0) + 1;
      const num = String(nextItemSeq[category]).padStart(3, "0");
      return `MIFS-${category}-${num}`;
    },
    nextClientId: () => nextClientId++,
    nextTransactionId: () => nextTransactionId++,
    nextDefectId: () => nextDefectId++,
  };
})();

const MockAPI = {
  async handle(endpoint, body, token) {
    // имитация сетевой задержки
    await new Promise((r) => setTimeout(r, 250));

    switch (endpoint) {
      case "/auth/login": {
        const s = MockStore.findStaffByLogin(body.login);
        if (!s || s.pin !== body.pin) {
          const err = new Error("Неверный логин или PIN");
          err.status = 401;
          throw err;
        }
        const tok = "mock-token-" + s.staff_id + "-" + Date.now();
        MockStore.tokens.set(tok, s.staff_id);
        return { token: tok, ...MockStore.staffPublic(s) };
      }

      case "/item/lookup": {
        const item = MockStore.findItem(body.item_id);
        if (!item) {
          const err = new Error("Предмет не найден");
          err.status = 404;
          throw err;
        }
        const openDefects = MockStore.defects.filter((d) => d.item_id === item.item_id && d.status !== "Resolved");
        const currentTransaction = item.current_transaction_id
          ? MockStore.transactions.find((t) => t.transaction_id === item.current_transaction_id)
          : null;
        return { ...item, current_transaction: currentTransaction, open_defects: openDefects };
      }

      case "/item/create": {
        MockStore.requireToken(token);
        const item_id = MockStore.nextItemId(body.category);
        MockStore.equipment.push({
          item_id,
          name: body.name,
          category: body.category,
          serial_number: body.serial_number || "",
          status: "Available",
          condition_notes: body.condition_notes || "",
          current_transaction_id: null,
        });
        return { item_id };
      }

      case "/transaction/checkout": {
        const staff_id = MockStore.requireToken(token);
        const item = MockStore.findItem(body.item_id);
        if (!item) { const e = new Error("Предмет не найден"); e.status = 404; throw e; }
        if (item.status !== "Available") {
          const e = new Error("Предмет уже выдан или недоступен");
          e.status = 409;
          throw e;
        }
        const transaction_id = MockStore.nextTransactionId();
        MockStore.transactions.push({
          transaction_id, item_id: item.item_id, client_id: body.client_id,
          staff_out: staff_id, staff_in: null,
          checked_out_at: new Date().toISOString(),
          expected_return_at: body.expected_return_at || null,
          checked_in_at: null, status: "Open", notes: body.notes || "",
        });
        item.status = "Rented";
        item.current_transaction_id = transaction_id;
        return { transaction_id };
      }

      case "/transaction/checkin": {
        const staff_id = MockStore.requireToken(token);
        const item = MockStore.findItem(body.item_id);
        if (!item) { const e = new Error("Предмет не найден"); e.status = 404; throw e; }
        const tx = MockStore.transactions.find((t) => t.item_id === item.item_id && t.status === "Open");
        if (!tx) { const e = new Error("Открытой выдачи для этого предмета не найдено"); e.status = 409; throw e; }
        tx.status = "Closed";
        tx.checked_in_at = new Date().toISOString();
        tx.staff_in = staff_id;

        let defect_id = null;
        if (body.has_defect) {
          defect_id = MockStore.nextDefectId();
          MockStore.defects.push({
            defect_id, item_id: item.item_id, reported_by: staff_id,
            related_transaction_id: tx.transaction_id,
            description: body.defect_description || "",
            severity: body.defect_severity || "Minor",
            status: "Open", reported_at: new Date().toISOString(),
            resolved_at: null, resolution_notes: "",
          });
          item.status = "In Repair";
        } else {
          item.status = "Available";
        }
        item.current_transaction_id = null;
        return { transaction_id: tx.transaction_id, defect_id };
      }

      case "/defect/report": {
        const staff_id = MockStore.requireToken(token);
        const item = MockStore.findItem(body.item_id);
        if (!item) { const e = new Error("Предмет не найден"); e.status = 404; throw e; }
        const defect_id = MockStore.nextDefectId();
        MockStore.defects.push({
          defect_id, item_id: item.item_id, reported_by: staff_id,
          related_transaction_id: null, description: body.description || "",
          severity: body.severity || "Minor", status: "Open",
          reported_at: new Date().toISOString(), resolved_at: null, resolution_notes: "",
        });
        if (body.severity === "Out of Service") item.status = "In Repair";
        return { defect_id };
      }

      case "/defect/resolve": {
        MockStore.requireToken(token);
        const defect = MockStore.defects.find((d) => d.defect_id === body.defect_id);
        if (!defect) { const e = new Error("Дефект не найден"); e.status = 404; throw e; }
        defect.status = body.status || "Resolved";
        defect.resolution_notes = body.resolution_notes || "";
        if (defect.status === "Resolved") {
          defect.resolved_at = new Date().toISOString();
          const item = MockStore.findItem(defect.item_id);
          const stillOpen = MockStore.defects.some((d) => d.item_id === defect.item_id && d.status !== "Resolved" && d.defect_id !== defect.defect_id);
          if (item && !stillOpen && item.status === "In Repair") item.status = "Available";
        }
        return {};
      }

      case "/equipment/list": {
        MockStore.requireToken(token);
        let list = MockStore.equipment;
        if (body && body.status && body.status !== "all") list = list.filter((i) => i.status === body.status);
        if (body && body.category && body.category !== "all") list = list.filter((i) => i.category === body.category);
        return list.map(({ item_id, name, category, status, serial_number }) => ({ item_id, name, category, status, serial_number }));
      }

      case "/clients/list": {
        MockStore.requireToken(token);
        return MockStore.clients.map((c) => ({ ...c }));
      }

      case "/client/create": {
        MockStore.requireToken(token);
        const client_id = MockStore.nextClientId();
        MockStore.clients.push({ client_id, client_name: body.client_name, project_name: body.project_name || "", phone: body.phone || "", notes: body.notes || "" });
        return { client_id };
      }

      case "/client/history": {
        MockStore.requireToken(token);
        const txs = MockStore.transactions.filter((t) => t.client_id === body.client_id);
        return { transactions: txs };
      }

      case "/item/history": {
        MockStore.requireToken(token);
        const txs = MockStore.transactions.filter((t) => t.item_id === body.item_id);
        const defs = MockStore.defects.filter((d) => d.item_id === body.item_id);
        return { transactions: txs, defects: defs };
      }

      case "/defects/list": {
        MockStore.requireToken(token);
        let list = MockStore.defects;
        if (body && body.status && body.status !== "all") list = list.filter((d) => d.status === body.status);
        return list;
      }

      default: {
        const err = new Error("Неизвестный эндпоинт (мок): " + endpoint);
        err.status = 404;
        throw err;
      }
    }
  },
};
