// Локальная имитация бэкенда (Google Sheets + Apps Script) для разработки и демонстрации
// приложения без реального аккаунта. Используется, когда CONFIG.MOCK_MODE === true.
// Структура и содержимое ответов соответствуют контракту вебхуков из SETUP.md.
// Ниже уже есть 2 демо-сотрудника, поэтому bootstrap-ветка /staff/create (регистрация
// первого администратора без токена) в моке недостижима без ручной правки — она нужна
// для симметрии с реальным Apps Script бэкендом, где Staff изначально пуста.

const MockStore = (() => {
  const unitCounters = {};   // "01"+"02" -> сколько экземпляров модели уже заведено
  let nextClientId = 3;
  let nextTransactionId = 3;
  let nextDefectId = 2;
  let nextStaffId = 3;

  const staff = [
    { staff_id: 1, full_name: "Иван Петров", login: "ivan", pin: "1234", role: "Warehouse Staff", active: true },
    { staff_id: 2, full_name: "Мария Сидорова", login: "maria", pin: "0000", role: "Admin", active: true },
  ];

  const equipment = [
    {
      item_id: "010101",
      name: "Sony FX6",
      category: "CAM",
      serial_number: "SN-FX6-118",
      inventory_number: "1013400892",
      status: "Available",
      condition_notes: "Полный комплект, всё в порядке",
      current_transaction_id: null,
    },
    {
      item_id: "020101",
      name: "Sigma 24-70mm f/2.8",
      category: "LEN",
      serial_number: "SN-SIG-042",
      inventory_number: "",
      status: "Rented",
      condition_notes: "",
      current_transaction_id: 1,
    },
  ];

  // Справочник моделей: категория + двузначный код + название.
  const models = [
    { category: "CAM", model_code: "01", model_name: "Sony FX6" },
    { category: "LEN", model_code: "01", model_name: "Sigma 24-70mm f/2.8" },
  ];

  // Счётчики экземпляров восстанавливаем из уже заведённых демо-позиций,
  // иначе следующая такая же модель получила бы номер, который уже занят.
  equipment.forEach((i) => {
    const prefix = String(i.item_id).slice(0, 4);   // XX + YY
    const unit = Number(String(i.item_id).slice(4));
    unitCounters[prefix] = Math.max(unitCounters[prefix] || 0, unit);
  });

  const clients = [
    { client_id: 1, client_name: "ООО Реклама Плюс", project_name: "Съёмка ролика", phone: "+7 900 000-00-01", notes: "" },
    { client_id: 2, client_name: "Пётр Иванов", project_name: "Свадебная съёмка", phone: "+7 900 000-00-02", notes: "" },
  ];

  const transactions = [
    {
      transaction_id: 1,
      item_id: "020101",
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
      item_id: "010101",
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
    const needle = String(login || "").trim().toLowerCase();
    return staff.find((s) => s.login.toLowerCase() === needle && s.active);
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

  function findStaffById(staff_id) {
    return staff.find((s) => s.staff_id === staff_id);
  }

  function requireAdmin(token) {
    const staff_id = requireToken(token);
    const s = findStaffById(staff_id);
    if (!s || s.role !== "Admin") {
      const err = new Error("Только администратор может добавлять сотрудников");
      err.status = 403;
      throw err;
    }
    return s;
  }

  return {
    staff, equipment, clients, transactions, defects, tokens,
    findStaffByLogin, findStaffById, findItem, staffPublic, requireToken, requireAdmin,
    models,
    // Номер вида XXYYZZ: категория, модель, порядковый номер экземпляра.
    nextItemId(category, modelCode) {
      const cat = (CONFIG.CATEGORIES.find((c) => c.code === category) || { num: "06" }).num;
      const yy = String(modelCode).padStart(2, "0");
      unitCounters[cat + yy] = (unitCounters[cat + yy] || 0) + 1;
      return cat + yy + String(unitCounters[cat + yy]).padStart(2, "0");
    },
    normalizeModelName(name) {
      return String(name || "").toLowerCase().replace(/[\s\-_.]+/g, "")
        .replace(/с/g, "c").replace(/о/g, "o").replace(/р/g, "p").replace(/е/g, "e")
        .replace(/а/g, "a").replace(/х/g, "x").replace(/в/g, "b").replace(/к/g, "k")
        .replace(/м/g, "m").replace(/т/g, "t").replace(/у/g, "y");
    },
    findOrCreateModel(category, modelName) {
      const needle = MockStore.normalizeModelName(modelName);
      const found = models.find((m) => m.category === category && MockStore.normalizeModelName(m.model_name) === needle);
      if (found) return found;
      const max = models.filter((m) => m.category === category)
        .reduce((a, m) => Math.max(a, Number(m.model_code)), 0);
      // код модели держим строкой "01" — как в бэкенде и внутри номера предмета
      const created = { category, model_code: String(max + 1).padStart(2, "0"), model_name: String(modelName).trim() };
      models.push(created);
      return created;
    },
    nextClientId: () => nextClientId++,
    nextTransactionId: () => nextTransactionId++,
    nextDefectId: () => nextDefectId++,
    nextStaffId: () => nextStaffId++,
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
        const model = body.model_code
          ? MockStore.models.find((m) => m.category === body.category && Number(m.model_code) === Number(body.model_code))
          : MockStore.findOrCreateModel(body.category, body.model_name || body.name);
        if (!model) { const e = new Error("Модель не найдена в справочнике"); e.status = 404; throw e; }
        const item_id = MockStore.nextItemId(body.category, model.model_code);
        MockStore.equipment.push({
          item_id,
          name: model.model_name,
          category: body.category,
          model_code: String(model.model_code).padStart(2, "0"),
          serial_number: body.serial_number || "",
          inventory_number: body.inventory_number || "",
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
        return list.map(({ item_id, name, category, status, serial_number, inventory_number }) =>
          ({ item_id, name, category, status, serial_number, inventory_number }));
      }

      case "/models/list": {
        MockStore.requireToken(token);
        let list = MockStore.models;
        if (body && body.category && body.category !== "all") list = list.filter((m) => m.category === body.category);
        return list.map((m) => ({ ...m })).sort((a, b) => a.model_name.localeCompare(b.model_name));
      }

      case "/model/create": {
        MockStore.requireToken(token);
        return { ...MockStore.findOrCreateModel(body.category, body.model_name) };
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

      case "/staff/create": {
        const login = String(body.login || "").trim();
        if (!login || !body.pin) {
          const e = new Error("Укажите логин и PIN"); e.status = 400; throw e;
        }
        const isBootstrap = MockStore.staff.length === 0;
        if (isBootstrap) {
          // Первая запись в системе — разрешаем без токена, всегда как Admin.
        } else {
          // Без токена сюда попадают, повторно нажав «создать первого
          // администратора» на экране входа — общее «сессия недействительна»
          // там только запутает, поэтому объясняем причину прямо.
          if (!token) {
            const e = new Error("Сотрудники уже есть, обратитесь к администратору");
            e.status = 403;
            throw e;
          }
          MockStore.requireAdmin(token);
        }
        const loginTaken = MockStore.staff.some((s) => s.login.toLowerCase() === login.toLowerCase());
        if (loginTaken) {
          const e = new Error("Такой логин уже используется"); e.status = 409; throw e;
        }
        const staff_id = MockStore.nextStaffId();
        MockStore.staff.push({
          staff_id, full_name: body.full_name || login, login,
          pin: String(body.pin), // в реальном бэкенде — pin_hash, здесь мок хранит как есть
          role: isBootstrap ? "Admin" : (body.role || "Warehouse Staff"),
          active: true,
        });
        return { staff_id };
      }

      case "/staff/list": {
        MockStore.requireAdmin(token);
        return MockStore.staff.map(({ staff_id, full_name, login, role, active }) => ({ staff_id, full_name, login, role, active }));
      }

      case "/staff/set-active": {
        MockStore.requireAdmin(token);
        const s = MockStore.findStaffById(body.staff_id);
        if (!s) { const e = new Error("Сотрудник не найден"); e.status = 404; throw e; }
        s.active = !!body.active;
        return {};
      }

      default: {
        const err = new Error("Неизвестный эндпоинт (мок): " + endpoint);
        err.status = 404;
        throw err;
      }
    }
  },
};
