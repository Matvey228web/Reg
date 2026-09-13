// Локальная имитация бэкенда (Google Sheets + Apps Script) для разработки и демонстрации
// приложения без реального аккаунта. Используется, когда CONFIG.MOCK_MODE === true.
// Структура и содержимое ответов соответствуют контракту вебхуков из SETUP.md.
// Ниже уже есть 2 демо-сотрудника, поэтому bootstrap-ветка /staff/create (регистрация
// первого администратора без токена) в моке недостижима без ручной правки — она нужна
// для симметрии с реальным Apps Script бэкендом, где Staff изначально пуста.

// Правило серьёзности — такое же, как в бэкенде (defectBlocksRental в Code.gs):
// царапина выдачу не блокирует, «серьёзный» и «не работает» блокируют.
// Настройки и справочник категорий: в настоящем бэкенде живут в таблице
// (лист Categories и ключи setting_* в Meta), здесь — в памяти.
const mockSettings = {
  session_ttl_hours: 12,
  max_login_attempts: 5,
  login_lock_minutes: 15,
  import_source_id: "",
};
const MOCK_SETTINGS_SPEC = {
  session_ttl_hours: { min: 1, max: 720, hint: "от 1 часа до 30 суток" },
  max_login_attempts: { min: 3, max: 20, hint: "от 3 до 20 попыток" },
  login_lock_minutes: { min: 1, max: 1440, hint: "от 1 минуты до суток" },
  import_source_id: { text: true, hint: "идентификатор таблицы Google или пусто" },
};
let mockCats = CONFIG.CATEGORIES.map((c) => ({
  ...c,
  // Мешки, флаги и расходники считаются количеством: личного QR у них нет.
  by_qty: c.code === "GRP" || c.code === "CNS",
}));
function mockByQty(code) {
  const c = mockCats.find((x) => x.code === code);
  return !!(c && c.by_qty);
}
function mockItemQty(item) {
  const n = Number(item.qty);
  return n > 0 ? n : 1;
}
function mockCategories() { return mockCats; }

// --- Заказы в демо-режиме ---
// Настоящие версии этих функций — в apps-script/Code.gs (normalizePhone,
// parseOrderMessage, mapOrderFields, orderStatus) и покрыты node-тестами.
// Здесь ровно столько, чтобы экран заказов можно было прогнать в браузере.

function mockNormalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.charAt(0) === "8") digits = "7" + digits.substring(1);
  if (digits.length === 10) digits = "7" + digits;
  return "+" + digits;
}

function mockRuDate(raw) {
  const m = String(raw || "").trim().match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (!m) return /^\d{4}-\d{2}-\d{2}/.test(String(raw)) ? String(raw).substring(0, 10) : "";
  return m[3] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[1]).padStart(2, "0");
}

function mockFieldKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-zа-яё0-9]/g, "");
}

function mockParseOrder(text) {
  const fields = {}, raw_keys = {}, items = [];
  let order_no = "", source_url = "", amount = 0, currency = "";
  const itemRe = /^\s*(\d+)\s*[.)]\s*(.+?)\s*:\s*([\d\s.,]*)\s*\(\s*(\d+)\s*[x×х]\s*([\d\s.,]+)\s*\)\s*$/;
  const kvRe = /^\s*([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_ ]*?)\s*:\s*(.*)$/;
  const money = (s) => {
    const n = parseFloat(String(s).replace(/\s/g, "").replace(",", "."));
    return isNaN(n) ? 0 : n;
  };

  String(text).split(/\r?\n/).forEach((line) => {
    const trimmed = line.replace(/\t/g, " ").trim();
    if (!trimmed) return;
    const orderM = trimmed.match(/^Заказ\s*№\s*(\S+)/i);
    if (orderM) { order_no = orderM[1]; return; }
    if (/^https?:\/\//i.test(trimmed)) { source_url = trimmed; return; }
    const itemM = trimmed.match(itemRe);
    if (itemM) {
      items.push({ line_no: Number(itemM[1]), raw_name: itemM[2].trim(),
        total: money(itemM[3]), qty: Number(itemM[4]), price: money(itemM[5]) });
      return;
    }
    const kvM = trimmed.match(kvRe);
    if (!kvM) return;
    const key = kvM[1].trim(), value = kvM[2].trim();
    if (!value && key.indexOf(" ") !== -1) return;
    fields[mockFieldKey(key)] = value;
    raw_keys[mockFieldKey(key)] = key;
  });

  const pick = (names) => {
    for (const n of names) {
      const k = mockFieldKey(n);
      if (fields[k]) return fields[k];
    }
    return "";
  };
  const amountLine = pick(["Сумма платежа"]);
  if (amountLine) {
    const am = amountLine.match(/^([\d\s.,]+)\s*(\S*)$/);
    if (am) { amount = money(am[1]); currency = am[2] || ""; }
  }

  const guardianName = pick(["Full_name_guardian"]);
  const adultRaw = pick(["Are_you_an_adult"]);
  const isAdult = adultRaw ? !/^(нет|no|false)$/i.test(adultRaw) : !guardianName;

  const order = {
    order_no, request_code: pick(["Код заявки"]),
    student_name: pick(["Full_name_minor", "Full_name", "Full_name_adult"]),
    student_phone: mockNormalizePhone(pick(["Phone_minors", "Phone_minor", "Phone"])),
    student_tg: pick(["Telegram_Minors", "Telegram_minor", "Telegram"]),
    is_adult: isAdult ? "TRUE" : "FALSE",
    guardian_name: isAdult ? "" : guardianName,
    guardian_phone: isAdult ? "" : mockNormalizePhone(pick(["Phone_guardian"])),
    project: pick(["Type_and_name_of_the_project"]),
    issue_date: mockRuDate(pick(["Date_of_issue"])),
    return_date: mockRuDate(pick(["Date_completion"])),
    extra_input: pick(["Input"]),
    amount, currency, source_url, raw_text: String(text),
  };

  const withMatch = items.map((line) => {
    const needle = MockStore.normalizeModelName(line.raw_name);
    const exact = MockStore.models.find((m) => MockStore.normalizeModelName(m.model_name) === needle);
    const suggestions = exact ? [] : MockStore.models.filter((m) => {
      const c = MockStore.normalizeModelName(m.model_name);
      return c && (c.indexOf(needle) !== -1 || needle.indexOf(c) !== -1);
    }).slice(0, 5).map((m) => ({ category: m.category, model_code: m.model_code, model_name: m.model_name }));
    return { ...line,
      model_code: exact ? exact.model_code : "",
      category: exact ? exact.category : "",
      suggestions };
  });

  const warnings = [];
  if (!order.student_name) warnings.push("Не распознано имя арендатора");
  if (!order.student_phone) warnings.push("Не распознан телефон арендатора — историю по нему будет не собрать");
  if (!order_no) warnings.push("Не распознан номер заказа");
  const unmatched = withMatch.filter((i) => !i.model_code).length;
  if (unmatched) {
    warnings.push("Не сопоставлено с каталогом позиций: " + unmatched +
      " — их можно выдавать количеством, без сканирования");
  }

  return { order, items: withMatch, fields, raw_keys, warnings, already_exists: null };
}

function mockOrderStatus(order, openCount, totalCount) {
  if (order.status === "Cancelled") return "Cancelled";
  if (openCount > 0) return "Issued";
  if (totalCount > 0) return "Returned";
  return "New";
}

function mockDefectBlocksRental(severity) {
  return severity === "Major" || severity === "Out of Service";
}

const MockStore = (() => {
  const unitCounters = {};   // "01"+"02" -> сколько экземпляров модели уже заведено
  let nextClientId = 3;
  let nextTransactionId = 4;
  let nextDefectId = 2;
  let nextStaffId = 4;   // 1–3 заняты демо-сотрудниками
  let nextStudentId = 2;
  let nextOrderId = 3;

  const staff = [
    { staff_id: 1, full_name: "Иван Петров", login: "ivan", pin: "1234", role: "Warehouse Staff", active: true },
    { staff_id: 2, full_name: "Мария Сидорова", login: "maria", pin: "0000", role: "Admin", active: true },
    { staff_id: 3, full_name: "Олег Второв", login: "oleg", pin: "2222", role: "Admin", active: true },
  ];

  // Главный администратор: в настоящем бэкенде это ключ owner_staff_id в Meta.
  // Здесь — та же одна ссылка, чтобы правила «нельзя удалить, можно передать»
  // проверялись тем же путём, что и на складе.
  let ownerStaffId = 2;

  const equipment = [
    {
      item_id: "010101",
      name: "Sony FX6",
      category: "CAM",
      model_code: "01",
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
      model_code: "01",
      serial_number: "SN-SIG-042",
      inventory_number: "",
      status: "Rented",
      condition_notes: "",
      current_transaction_id: 1,
    },
    // Две единицы позиции из настоящего заказа: одна уже выдана по нему,
    // вторая свободна — на ней видно и «выдано 1 из 4», и саму выдачу.
    {
      item_id: "030101",
      name: "OSTERRIG SIRIUS 100CM",
      category: "LGT",
      model_code: "01",
      serial_number: "SN-OST-001",
      inventory_number: "",
      status: "Rented",
      condition_notes: "",
      current_transaction_id: 2,
    },
    {
      item_id: "050101",
      name: "SANDBAG BIG",
      category: "GRP",
      model_code: "01",
      serial_number: "",
      inventory_number: "",
      status: "Available",
      condition_notes: "",
      current_transaction_id: null,
      qty: 25,
      qty_out: 4,
    },
    {
      item_id: "030102",
      name: "OSTERRIG SIRIUS 100CM",
      category: "LGT",
      model_code: "01",
      serial_number: "SN-OST-002",
      inventory_number: "",
      status: "Available",
      condition_notes: "",
      current_transaction_id: null,
    },
  ];

  // Справочник моделей: категория + двузначный код + название.
  const models = [
    { category: "CAM", model_code: "01", model_name: "Sony FX6" },
    { category: "LEN", model_code: "01", model_name: "Sigma 24-70mm f/2.8" },
    { category: "LGT", model_code: "01", model_name: "OSTERRIG SIRIUS 100CM" },
    { category: "GRP", model_code: "01", model_name: "SANDBAG BIG" },
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

  // Заказы и арендаторы. Один заказ нарочно просрочен: бейдж просрочки — то,
  // ради чего вкладку открывают, и в демо он должен быть виден.
  const students = [
    { student_id: 1, full_name: "Ильина-Ноктина Полина Ильинична", phone: "+79257868093",
      tg_username: "@poliviks_notkina", created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), notes: "" },
  ];

  function mockDate(offsetDays) {
    return new Date(Date.now() + offsetDays * 24 * 3600 * 1000).toISOString().substring(0, 10);
  }

  const orders = [
    {
      order_id: 1, order_no: "1525686941", request_code: "3288736:8358371482",
      student_id: 1, student_name: "Ильина-Ноктина Полина Ильинична",
      student_phone: "+79257868093", student_tg: "@poliviks_notkina",
      is_adult: false, guardian_name: "Ильина-Ноткина Елена Борисовна",
      guardian_phone: "+79257868093", project: "км",
      issue_date: mockDate(-5), return_date: mockDate(-2), extra_input: "+ 4 ковра гойда",
      amount: 214050, currency: "RUB", source_url: "https://example.org/mifs_rent/reservation",
      status: "New", raw_text: "Заказ №1525686941\n(демо-режим: исходное сообщение сокращено)",
      created_at: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
      created_by: 1, created_by_name: "Матвей Одинцов", closed_at: "",
    },
    {
      order_id: 2, order_no: "1525686942", request_code: "", student_id: 1,
      student_name: "Ильина-Ноктина Полина Ильинична", student_phone: "+79257868093",
      student_tg: "@poliviks_notkina", is_adult: true, guardian_name: "", guardian_phone: "",
      project: "Курсовая", issue_date: mockDate(1), return_date: mockDate(4), extra_input: "",
      amount: 0, currency: "", source_url: "", status: "New", raw_text: "",
      created_at: new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString(),
      created_by: 1, created_by_name: "Матвей Одинцов", closed_at: "",
    },
  ];

  const orderItems = [
    { order_id: 1, line_no: 1, raw_name: "GODOX OCTABOX 120", model_code: "", category: "", qty: 1, price: 0, total: 0, issued_qty: 0, note: "" },
    { order_id: 1, line_no: 2, raw_name: "OSTERRIG SIRIUS 100CM", model_code: "01", category: "LGT", qty: 4, price: 38500, total: 154000, issued_qty: 1, note: "" },
    { order_id: 1, line_no: 3, raw_name: "SANDBAG BIG", model_code: "", category: "", qty: 20, price: 2500, total: 50000, issued_qty: 0, note: "" },
  ];

  const transactions = [
    {
      transaction_id: 1,
      item_id: "020101",
      client_id: 1,
      order_id: "",
      order_line: "",
      staff_out: 1,
      staff_in: null,
      checked_out_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      expected_return_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      checked_in_at: null,
      status: "Open",
      notes: "",
    },
    {
      transaction_id: 2,
      item_id: "030101",
      client_id: null,
      order_id: 1,
      order_line: "2",
      staff_out: 1,
      staff_in: null,
      checked_out_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
      expected_return_at: mockDate(-2),
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

  // Смена PIN аннулирует прежние сессии сотрудника; себе взамен выдаём новую,
  // иначе человек сменил бы PIN и тут же вылетел на экран входа.
  function rotateToken(staff_id, issueNew) {
    Array.from(tokens.entries()).forEach(([tok, id]) => {
      if (String(id) === String(staff_id)) tokens.delete(tok);
    });
    if (!issueNew) return null;
    const fresh = "mock-token-" + staff_id + "-" + Date.now();
    tokens.set(fresh, staff_id);
    return fresh;
  }

  function findStaffById(staff_id) {
    return staff.find((s) => s.staff_id === staff_id);
  }

  function requireAdmin(token) {
    const staff_id = requireToken(token);
    const s = findStaffById(staff_id);
    if (!s || s.role !== "Admin") {
      const err = new Error("Действие доступно только администратору");
      err.status = 403;
      throw err;
    }
    return s;
  }

  return {
    staff, equipment, clients, transactions, defects, tokens,
    students, orders, orderItems,
    findStaffByLogin, findStaffById, findItem, staffPublic, requireToken, requireAdmin, rotateToken,
    ownerId: () => ownerStaffId,
    setOwnerId: (id) => { ownerStaffId = id; },
    requireOwner(token) {
      const staff_id = requireToken(token);
      if (String(staff_id) !== String(ownerStaffId)) {
        const e = new Error("Действие доступно только главному администратору");
        e.status = 403;
        throw e;
      }
      return findStaffById(staff_id);
    },
    models,
    nextStudentId: () => nextStudentId++,
    nextOrderId: () => nextOrderId++,
    // Номер вида XXYYZZ: категория, модель, порядковый номер экземпляра.
    nextItemId(category, modelCode) {
      const cat = (mockCategories().find((c) => c.code === category) || { num: "06" }).num;
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
        return { token: tok, ...MockStore.staffPublic(s), is_owner: String(s.staff_id) === String(MockStore.ownerId()),
                 settings: { ...mockSettings }, categories: mockCategories() };
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
        const total = mockItemQty(item);
        const out = Number(item.qty_out || 0);
        return { ...item, current_transaction: currentTransaction, open_defects: openDefects,
                 qty: total, qty_out: out, qty_free: total - out, by_qty: mockByQty(item.category) };
      }

      case "/item/create": {
        MockStore.requireToken(token);
        const model = body.model_code
          ? MockStore.models.find((m) => m.category === body.category && Number(m.model_code) === Number(body.model_code))
          : MockStore.findOrCreateModel(body.category, body.model_name || body.name);
        if (!model) { const e = new Error("Модель не найдена в справочнике"); e.status = 404; throw e; }
        const bulk = mockByQty(body.category);
        const qty = bulk ? Math.floor(Number(body.qty || 1)) : 1;
        if (bulk && (!qty || qty < 1)) {
          const e = new Error("Укажите количество — целое число от одного"); e.status = 400; throw e;
        }
        if (bulk) {
          const exists = MockStore.equipment.find((i) =>
            i.category === body.category && String(i.model_code) === String(model.model_code));
          if (exists) {
            exists.qty = mockItemQty(exists) + qty;
            return { item_id: exists.item_id, qty: exists.qty, added: qty };
          }
        }
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
          qty: qty,
          qty_out: 0,
        });
        return { item_id, qty };
      }

      case "/transaction/checkout": {
        const staff_id = MockStore.requireToken(token);
        const item = MockStore.findItem(body.item_id);
        if (!item) { const e = new Error("Предмет не найден"); e.status = 404; throw e; }
        const bulkOut = mockByQty(item.category);
        const totalOut = mockItemQty(item);
        const alreadyOut = Number(item.qty_out || 0);
        const takeQty = bulkOut ? Math.floor(Number(body.qty || 1)) : 1;
        if (bulkOut) {
          if (!takeQty || takeQty < 1) { const e = new Error("Укажите количество — целое число от одного"); e.status = 400; throw e; }
          if (alreadyOut + takeQty > totalOut) {
            const e = new Error("На складе свободно " + (totalOut - alreadyOut) + " из " + totalOut + " — больше выдать нельзя");
            e.status = 409; throw e;
          }
        } else if (item.status !== "Available") {
          const e = new Error("Предмет уже выдан или недоступен");
          e.status = 409;
          throw e;
        }
        let order_id = "", order_line = "", expected = body.expected_return_at || null;
        if (body.order_id) {
          const order = MockStore.orders.find((o) => String(o.order_id) === String(body.order_id));
          if (!order) { const e = new Error("Заказ не найден"); e.status = 404; throw e; }
          if (order.status === "Cancelled") {
            const e = new Error("Заказ отменён, выдавать по нему нельзя");
            e.status = 409;
            throw e;
          }
          order_id = order.order_id;
          if (!expected) expected = order.return_date || null;
          // Списываем экземпляр с подходящей строки состава; не нашлось —
          // «вне заказа», но выдача проходит.
          const line = MockStore.orderItems.find((i) =>
            String(i.order_id) === String(order_id) && i.model_code &&
            i.category === item.category &&
            String(i.model_code) === String(item.model_code) && i.issued_qty < i.qty);
          if (line) { line.issued_qty += 1; order_line = String(line.line_no); }
          else order_line = "off-order";
          order.status = "Issued";
        }
        const transaction_id = MockStore.nextTransactionId();
        MockStore.transactions.push({
          transaction_id, item_id: item.item_id, client_id: body.client_id,
          order_id, order_line,
          staff_out: staff_id, staff_in: null,
          checked_out_at: new Date().toISOString(),
          expected_return_at: expected,
          checked_in_at: null, status: "Open", notes: body.notes || "",
          qty: takeQty, qty_in: 0,
        });
        if (bulkOut) {
          item.qty_out = alreadyOut + takeQty;
          item.status = item.qty_out >= totalOut ? "Rented" : "Available";
        } else {
          item.status = "Rented";
          item.current_transaction_id = transaction_id;
        }
        return { transaction_id, order_line, qty: takeQty };
      }

      case "/transaction/checkin": {
        const staff_id = MockStore.requireToken(token);
        const item = MockStore.findItem(body.item_id);
        if (!item) { const e = new Error("Предмет не найден"); e.status = 404; throw e; }
        const openList = MockStore.transactions.filter((t) => t.item_id === item.item_id && t.status === "Open");
        if (!openList.length) { const e = new Error("Открытой выдачи для этого предмета не найдено"); e.status = 409; throw e; }
        const tx = openList[0];
        const bulkIn = mockByQty(item.category);

        if (bulkIn) {
          // Приём количеством закрывает выдачи по очереди, начиная с ранней.
          const back = Math.floor(Number(body.qty || 1));
          const onHands = openList.reduce((sum, t) => sum + (Number(t.qty || 1) - Number(t.qty_in || 0)), 0);
          if (!back || back < 1) { const e = new Error("Укажите количество — целое число от одного"); e.status = 400; throw e; }
          if (back > onHands) { const e = new Error("На руках " + onHands + " — принять больше нельзя"); e.status = 409; throw e; }
          let left = back;
          openList.forEach((t) => {
            if (left <= 0) return;
            const take = Math.min(Number(t.qty || 1) - Number(t.qty_in || 0), left);
            left -= take;
            t.qty_in = Number(t.qty_in || 0) + take;
            if (t.qty_in >= Number(t.qty || 1)) {
              t.status = "Closed";
              t.checked_in_at = new Date().toISOString();
              t.staff_in = staff_id;
            }
          });
          item.qty_out = Math.max(0, Number(item.qty_out || 0) - back);
          item.status = item.qty_out >= mockItemQty(item) ? "Rented" : "Available";
        } else {
          tx.status = "Closed";
          tx.checked_in_at = new Date().toISOString();
          tx.staff_in = staff_id;
        }

        if (tx.order_id) {
          const line = MockStore.orderItems.find((i) =>
            String(i.order_id) === String(tx.order_id) && String(i.line_no) === String(tx.order_line));
          if (line && line.issued_qty > 0) line.issued_qty -= 1;
          const order = MockStore.orders.find((o) => String(o.order_id) === String(tx.order_id));
          if (order && order.status !== "Cancelled") {
            const stillOut = MockStore.transactions.filter(
              (t) => String(t.order_id) === String(tx.order_id) && t.status === "Open").length;
            order.status = stillOut ? "Issued" : "Returned";
            order.closed_at = stillOut ? "" : new Date().toISOString();
          }
        }

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
          if (mockDefectBlocksRental(body.defect_severity || "Minor")) item.status = "In Repair";
          else if (!bulkIn) item.status = "Available";
        } else if (!bulkIn) {
          // У штучной позиции статус уже посчитан по остатку выше: «доступно»
          // здесь затёрло бы «всё на руках».
          item.status = "Available";
        }
        if (!bulkIn) item.current_transaction_id = null;
        return { transaction_id: tx.transaction_id, defect_id, qty: bulkIn ? Number(body.qty || 1) : 1 };
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
        if (mockDefectBlocksRental(body.severity || "Minor") && item.status === "Available") {
          item.status = "In Repair";
        }
        return { defect_id, status: item.status };
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
          const stillOpen = MockStore.defects.some((d) => d.item_id === defect.item_id &&
            d.status !== "Resolved" && d.defect_id !== defect.defect_id &&
            mockDefectBlocksRental(d.severity));
          if (item && !stillOpen && item.status === "In Repair") item.status = "Available";
        }
        return {};
      }

      case "/equipment/list": {
        MockStore.requireToken(token);
        let list = MockStore.equipment;
        if (body && body.status && body.status !== "all") list = list.filter((i) => i.status === body.status);
        if (body && body.category && body.category !== "all") list = list.filter((i) => i.category === body.category);
        return list.map((i) => {
          const total = mockItemQty(i);
          const out = Number(i.qty_out || 0);
          return {
            item_id: i.item_id, name: i.name, category: i.category, status: i.status,
            serial_number: i.serial_number, inventory_number: i.inventory_number,
            model_code: i.model_code, qty: total, qty_out: out, qty_free: total - out,
          };
        });
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

      // Заказы. Настоящий разбор сообщения живёт в apps-script/Code.gs и покрыт
      // тестами в apps-script/test-local.js; здесь — та же логика в объёме,
      // которого хватает, чтобы прогнать экран в браузере.
      case "/order/parse": {
        MockStore.requireToken(token);
        const parsed = mockParseOrder(body.text || "");
        if (!parsed.order.order_no && !parsed.items.length) {
          const e = new Error("Не похоже на сообщение о заказе: ни номера, ни позиций не нашлось");
          e.status = 400;
          throw e;
        }
        const existing = MockStore.orders.find((o) => o.order_no === parsed.order.order_no);
        parsed.already_exists = existing ? existing.order_id : null;
        return parsed;
      }

      case "/order/create": {
        const staff_id = MockStore.requireToken(token);
        const orderNo = String(body.order_no || "").trim();
        if (!orderNo) { const e = new Error("Укажите номер заказа"); e.status = 400; throw e; }
        if (MockStore.orders.some((o) => o.order_no === orderNo)) {
          const e = new Error("Заказ " + orderNo + " уже заведён");
          e.status = 409;
          throw e;
        }
        const phone = mockNormalizePhone(body.student_phone);
        let student = phone ? MockStore.students.find((s) => s.phone === phone) : null;
        let student_created = false;
        if (phone && !student) {
          student = {
            student_id: MockStore.nextStudentId(), full_name: body.student_name || "",
            phone, tg_username: body.student_tg || "", created_at: new Date().toISOString(), notes: "",
          };
          MockStore.students.push(student);
          student_created = true;
        }
        const order_id = MockStore.nextOrderId();
        const staffRow = MockStore.findStaffById(staff_id);
        MockStore.orders.push({
          order_id, order_no: orderNo, request_code: body.request_code || "",
          student_id: student ? student.student_id : "",
          student_name: body.student_name || "", student_phone: phone,
          student_tg: body.student_tg || "",
          is_adult: !(body.is_adult === "FALSE" || body.is_adult === false),
          guardian_name: body.guardian_name || "", guardian_phone: mockNormalizePhone(body.guardian_phone),
          project: body.project || "", issue_date: body.issue_date || "", return_date: body.return_date || "",
          extra_input: body.extra_input || "", amount: Number(body.amount || 0),
          currency: body.currency || "", source_url: body.source_url || "",
          status: "New", raw_text: body.raw_text || "", created_at: new Date().toISOString(),
          created_by: staff_id, created_by_name: staffRow ? staffRow.full_name : "",
          closed_at: "",
        });
        (body.items || []).forEach((line, idx) => {
          MockStore.orderItems.push({
            order_id, line_no: Number(line.line_no || idx + 1), raw_name: line.raw_name || "",
            model_code: line.model_code || "", category: line.category || "",
            qty: Number(line.qty || 1), price: Number(line.price || 0), total: Number(line.total || 0),
            issued_qty: 0, note: "",
          });
        });
        return { order_id, student_id: student ? student.student_id : "", student_created };
      }

      case "/orders/list": {
        MockStore.requireToken(token);
        return MockStore.orders.map((o) => {
          const txs = MockStore.transactions.filter((t) => String(t.order_id) === String(o.order_id));
          const open = txs.filter((t) => t.status === "Open").length;
          const { raw_text, ...rest } = o;
          const itemsText = MockStore.orderItems
            .filter((i) => String(i.order_id) === String(o.order_id))
            .map((i) => i.raw_name).join(", ");
          return { ...rest, status: mockOrderStatus(o, open, txs.length),
                   issued_open: open, issued_total: txs.length, items_text: itemsText };
        });
      }

      case "/order/card": {
        MockStore.requireToken(token);
        const order = MockStore.orders.find((o) => String(o.order_id) === String(body.order_id));
        if (!order) { const e = new Error("Заказ не найден"); e.status = 404; throw e; }
        const txs = MockStore.transactions.filter((t) => String(t.order_id) === String(order.order_id));
        const open = txs.filter((t) => t.status === "Open").length;
        return {
          order: { ...order, status: mockOrderStatus(order, open, txs.length) },
          items: MockStore.orderItems.filter((i) => String(i.order_id) === String(order.order_id)).map((i) => ({ ...i })),
          transactions: txs.map((t) => ({ ...t })),
        };
      }

      case "/order/update": {
        MockStore.requireToken(token);
        const order = MockStore.orders.find((o) => String(o.order_id) === String(body.order_id));
        if (!order) { const e = new Error("Заказ не найден"); e.status = 404; throw e; }
        if (body.status === "Cancelled") {
          const open = MockStore.transactions.filter(
            (t) => String(t.order_id) === String(order.order_id) && t.status === "Open").length;
          if (open) {
            const e = new Error("По заказу " + open + " позиций на руках — сначала примите их");
            e.status = 409;
            throw e;
          }
        }
        ["project", "issue_date", "return_date", "extra_input", "guardian_name",
         "guardian_phone", "student_tg", "status"].forEach((field) => {
          if (body[field] !== undefined) order[field] = body[field];
        });
        return { order_id: order.order_id };
      }

      case "/order/line-update": {
        MockStore.requireToken(token);
        const line = MockStore.orderItems.find(
          (i) => String(i.order_id) === String(body.order_id) && String(i.line_no) === String(body.line_no));
        if (!line) { const e = new Error("Строка заказа не найдена"); e.status = 404; throw e; }
        if (body.issued_qty !== undefined) {
          if (Number(body.issued_qty) > line.qty) {
            const e = new Error("В заказе этой позиции " + line.qty + ", выдать больше нельзя");
            e.status = 400;
            throw e;
          }
          line.issued_qty = Number(body.issued_qty);
        }
        if (body.model_code !== undefined) {
          line.model_code = body.model_code || "";
          line.category = body.category || "";
        }
        return { order_id: line.order_id, line_no: line.line_no };
      }

      case "/students/list": {
        MockStore.requireToken(token);
        return MockStore.students.map((s) => ({ ...s }));
      }

      case "/student/history": {
        MockStore.requireToken(token);
        return {
          orders: MockStore.orders
            .filter((o) => String(o.student_id) === String(body.student_id))
            .map((o) => ({
              order_id: o.order_id, order_no: o.order_no, project: o.project,
              issue_date: o.issue_date, return_date: o.return_date, status: o.status,
            })),
        };
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
          // Без токена сюда попасть уже нельзя из интерфейса, но причину
          // объясняем прямо: общее «сессия недействительна» запутало бы.
          if (!token) {
            const e = new Error("Сотрудники уже есть, обратитесь к администратору");
            e.status = 403;
            throw e;
          }
          MockStore.requireOwner(token);
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

      case "/settings/get": {
        const meId = MockStore.requireToken(token);
        const me = MockStore.findStaffById(meId);
        const owner = MockStore.findStaffById(MockStore.ownerId());
        const hints = {};
        Object.keys(MOCK_SETTINGS_SPEC).forEach((k) => { hints[k] = MOCK_SETTINGS_SPEC[k].hint; });
        const today = new Date().toISOString().substring(0, 10);
        const openTx = MockStore.transactions.filter((t) => t.status === "Open");
        return {
          settings: { ...mockSettings },
          categories: mockCategories(),
          limits: hints,
          me: { staff_id: me.staff_id, full_name: me.full_name, role: me.role,
                is_owner: String(me.staff_id) === String(MockStore.ownerId()) },
          owner: owner ? { staff_id: owner.staff_id, full_name: owner.full_name } : null,
          summary: {
            items: MockStore.equipment.length,
            available: MockStore.equipment.filter((i) => i.status === "Available").length,
            rented: MockStore.equipment.filter((i) => i.status === "Rented").length,
            in_repair: MockStore.equipment.filter((i) => i.status === "In Repair").length,
            retired: MockStore.equipment.filter((i) => i.status === "Retired").length,
            open_transactions: openTx.length,
            overdue_transactions: openTx.filter((t) =>
              String(t.expected_return_at || "").substring(0, 10) < today &&
              t.expected_return_at).length,
            open_defects: MockStore.defects.filter((d) => d.status === "Open").length,
            orders: MockStore.orders.length,
            orders_new: MockStore.orders.filter((o) => o.status === "New").length,
            orders_issued: MockStore.orders.filter((o) => o.status === "Issued").length,
            orders_overdue: 0,
            staff: MockStore.staff.length,
            staff_active: MockStore.staff.filter((x) => x.active).length,
            admins: MockStore.staff.filter((x) => x.role === "Admin").length,
          },
          maintenance: { journal_archived_at: "", journal_trimmed_at: "" },
        };
      }

      case "/settings/set": {
        MockStore.requireAdmin(token);
        const incoming = body.settings || {};
        const rejected = [];
        Object.keys(incoming).forEach((k) => {
          const spec = MOCK_SETTINGS_SPEC[k];
          if (!spec) { rejected.push(k + ": неизвестная настройка"); return; }
          if (spec.text) { mockSettings[k] = String(incoming[k]).trim(); return; }
          const v = Number(incoming[k]);
          if (!isFinite(v) || v < spec.min || v > spec.max) { rejected.push(k + ": " + spec.hint); return; }
          mockSettings[k] = v;
        });
        if (rejected.length) {
          const e = new Error("Не сохранено — " + rejected.join("; ")); e.status = 400; throw e;
        }
        return { settings: { ...mockSettings } };
      }

      case "/category/create": {
        MockStore.requireAdmin(token);
        const code = String(body.code || "").trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) {
          const e = new Error("Код категории — три латинские буквы, например BAT"); e.status = 400; throw e;
        }
        if (!String(body.label || "").trim()) {
          const e = new Error("Укажите название категории"); e.status = 400; throw e;
        }
        if (mockCats.some((c) => c.code === code)) {
          const e = new Error("Категория с таким кодом уже есть"); e.status = 409; throw e;
        }
        const maxNum = mockCats.reduce((m, c) => Math.max(m, Number(c.num)), 0);
        const num = String(maxNum + 1).padStart(2, "0");
        const created = { code, num, label: String(body.label).trim(), by_qty: !!body.by_qty };
        mockCats.push(created);
        return created;
      }

      case "/category/update": {
        MockStore.requireAdmin(token);
        const code = String(body.code || "").trim().toUpperCase();
        const cat = mockCats.find((c) => c.code === code);
        if (!cat) { const e = new Error("Категория не найдена"); e.status = 404; throw e; }
        if (body.label !== undefined) {
          const label = String(body.label).trim();
          if (!label) { const e = new Error("Название не может быть пустым"); e.status = 400; throw e; }
          cat.label = label;
        }
        if (body.by_qty !== undefined && !!body.by_qty !== !!cat.by_qty) {
          const filled = MockStore.equipment.filter((i) => i.category === code).length;
          if (filled) {
            const e = new Error("В категории уже " + filled + " позиций. Способ учёта меняется " +
              "только у пустой категории: иначе поштучные записи молча стали бы количеством.");
            e.status = 409; throw e;
          }
          cat.by_qty = !!body.by_qty;
        }
        if (body.num !== undefined && String(body.num).padStart(2, "0") !== cat.num) {
          const used = MockStore.equipment.filter((i) => i.category === code).length;
          if (used) {
            const e = new Error("В категории уже " + used + " позиций. Номер вшит в их номера " +
              "и напечатан на этикетках — сменить его нельзя. Название менять можно.");
            e.status = 409; throw e;
          }
          cat.num = String(body.num).padStart(2, "0");
        }
        return { code, changed: true };
      }

      case "/maintenance": {
        MockStore.requireAdmin(token);
        if (body.action === "archive") return { message: "Журнал выгружен (демо-режим)." };
        if (body.action === "trim") {
          return { message: "Подрезка отменена: журнал ни разу не выгружался." };
        }
        const e = new Error("Неизвестное действие обслуживания"); e.status = 400; throw e;
      }

      case "/staff/delete": {
        const me = MockStore.findStaffById(MockStore.requireAdmin(token).staff_id);
        const target = MockStore.staff.find((x) => String(x.staff_id) === String(body.staff_id));
        if (!target) { const e = new Error("Сотрудник не найден"); e.status = 404; throw e; }
        if (String(target.staff_id) === String(me.staff_id)) {
          const e = new Error("Нельзя удалить самого себя"); e.status = 409; throw e;
        }
        if (target.role === "Admin" &&
            MockStore.staff.filter((x) => x.role === "Admin" && x.active).length <= 1) {
          const e = new Error("Это последний администратор, удалить нельзя"); e.status = 409; throw e;
        }
        MockStore.rotateToken(target.staff_id, false);
        MockStore.staff.splice(MockStore.staff.indexOf(target), 1);
        return { staff_id: target.staff_id, full_name: target.full_name };
      }

      case "/staff/set-pin": {
        const staff_id = MockStore.requireToken(token);
        const me = MockStore.staff.find((x) => x.staff_id === staff_id);
        const newPin = String(body.pin || "").trim();
        if (!/^\d{4,6}$/.test(newPin)) {
          const e = new Error("PIN — от 4 до 6 цифр"); e.status = 400; throw e;
        }
        const targetId = body.staff_id === undefined || body.staff_id === null || body.staff_id === ""
          ? staff_id : body.staff_id;
        const isSelf = String(targetId) === String(staff_id);
        const target = isSelf ? me : MockStore.staff.find((x) => String(x.staff_id) === String(targetId));
        if (!target) { const e = new Error("Сотрудник не найден"); e.status = 404; throw e; }
        if (isSelf) {
          if (String(body.current_pin || "") !== String(me.pin)) {
            const e = new Error("Текущий PIN указан неверно"); e.status = 403; throw e;
          }
        } else if (me.role !== "Admin") {
          const e = new Error("Менять PIN другому сотруднику может только администратор");
          e.status = 403; throw e;
        }
        target.pin = newPin;
        const rotated = MockStore.rotateToken(target.staff_id, isSelf);
        return isSelf ? { token: rotated } : {};
      }

      case "/staff/list": {
        MockStore.requireAdmin(token);
        return MockStore.staff.map(({ staff_id, full_name, login, role, active }) => ({
          staff_id, full_name, login, role, active,
          is_owner: String(staff_id) === String(MockStore.ownerId()),
        }));
      }

      case "/staff/set-active": {
        MockStore.requireAdmin(token);
        const s = MockStore.findStaffById(body.staff_id);
        if (!s) { const e = new Error("Сотрудник не найден"); e.status = 404; throw e; }
        if (String(s.staff_id) === String(MockStore.ownerId())) {
          const e = new Error("Главного администратора отключить нельзя — права можно только передать");
          e.status = 409; throw e;
        }
        s.active = !!body.active;
        return { staff_id: s.staff_id, full_name: s.full_name, active: s.active };
      }

      case "/staff/delete": {
        const me = MockStore.requireOwner(token);
        const s = MockStore.findStaffById(body.staff_id);
        if (!s) { const e = new Error("Сотрудник не найден"); e.status = 404; throw e; }
        if (String(s.staff_id) === String(me.staff_id)) {
          const e = new Error("Нельзя удалить самого себя"); e.status = 409; throw e;
        }
        if (String(s.staff_id) === String(MockStore.ownerId())) {
          const e = new Error("Главного администратора удалить нельзя — права можно только передать");
          e.status = 409; throw e;
        }
        MockStore.staff.splice(MockStore.staff.indexOf(s), 1);
        return { staff_id: s.staff_id, full_name: s.full_name };
      }

      case "/staff/set-role": {
        MockStore.requireOwner(token);
        const s = MockStore.findStaffById(body.staff_id);
        if (!s) { const e = new Error("Сотрудник не найден"); e.status = 404; throw e; }
        if (String(s.staff_id) === String(MockStore.ownerId())) {
          const e = new Error("Роль главного администратора не меняется — права можно только передать");
          e.status = 409; throw e;
        }
        s.role = body.role;
        return { staff_id: s.staff_id, full_name: s.full_name, role: s.role };
      }

      case "/staff/transfer-owner": {
        const me = MockStore.requireOwner(token);
        const s = MockStore.findStaffById(body.staff_id);
        if (!s) { const e = new Error("Сотрудник не найден"); e.status = 404; throw e; }
        if (String(s.staff_id) === String(me.staff_id)) {
          const e = new Error("Вы и так главный администратор"); e.status = 409; throw e;
        }
        if (!s.active) {
          const e = new Error("Передать права можно только действующему сотруднику"); e.status = 409; throw e;
        }
        s.role = "Admin";
        MockStore.setOwnerId(s.staff_id);
        return { staff_id: s.staff_id, full_name: s.full_name };
      }

      case "/staff/set-pin": {
        const meId = MockStore.requireToken(token);
        const me = MockStore.findStaffById(meId);
        const targetId = body.staff_id === undefined || body.staff_id === null || body.staff_id === ""
          ? meId : body.staff_id;
        const s = MockStore.findStaffById(targetId);
        if (!s) { const e = new Error("Сотрудник не найден"); e.status = 404; throw e; }
        if (!/^\d{4,6}$/.test(String(body.pin || ""))) {
          const e = new Error("PIN — от 4 до 6 цифр"); e.status = 400; throw e;
        }
        if (String(targetId) === String(meId)) {
          if (String(body.current_pin || "") !== s.pin) {
            const e = new Error("Текущий PIN указан неверно"); e.status = 403; throw e;
          }
        } else if (me.role !== "Admin") {
          const e = new Error("Менять PIN другому сотруднику может только администратор");
          e.status = 403; throw e;
        } else if (String(targetId) === String(MockStore.ownerId())) {
          const e = new Error("PIN главного администратора меняет только он сам");
          e.status = 409; throw e;
        }
        s.pin = String(body.pin);
        return { staff_id: s.staff_id };
      }

      default: {
        const err = new Error("Неизвестный эндпоинт (мок): " + endpoint);
        err.status = 404;
        throw err;
      }
    }
  },
};
