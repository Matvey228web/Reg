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
  site_url: "",
  app_link: "",
  api_url: "https://mifs-rent-api.example.workers.dev",
  site_seasons: 1,
  public_orders: 1,
  public_orders_per_hour: 20,
  archive_keep_days: 2,
  act_template_id: "",
  act_folder_id: "",
  notify_thread_orders: "",
  notify_thread_acts: "",
};
// Состояние постоянной связи с Telegram. В демо её никто не устанавливает —
// важно лишь, что экран умеет показать оба состояния и переключить их.
const mockWebhook = { on: false, url: "", last_error: "" };

// Из ссылки — идентификатор, как на живом бэкенде (driveIdFrom в Code.gs).
function mockDriveId(value) {
  const v = String(value || "").trim();
  const m = v.match(/\/(?:d|folders)\/([A-Za-z0-9_-]{20,})/) ||
            v.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : v;
}

const MOCK_SETTINGS_SPEC = {
  site_url: { def: "", text: true, check: (v) => v === "" || /^https:\/\/[^\s]+$/.test(String(v)),
              hint: "адрес сайта проката целиком, начиная с https:// — или пусто" },
  app_link: { def: "", text: true, check: (v) => v === "" || /^https:\/\/t\.me\/[^\s]+$/.test(String(v)),
              hint: "https://t.me/ваш_бот/имя_приложения или пусто" },
  api_url: { def: "", text: true, check: (v) => v === "" || /^https:\/\/[^\s]+$/.test(String(v)),
             hint: "адрес Worker целиком, начиная с https:// — на него Telegram присылает события бота" },
  notify_chat_id: { def: "", text: true, check: (v) => v === "" || /^-?\d{5,20}$/.test(String(v)),
                    hint: "числовой id чата склада (у групп он отрицательный) или пусто — тогда бот молчит" },
  notify_thread_orders: { def: "", text: true, check: (v) => v === "" || /^\d{1,10}$/.test(String(v)),
                          hint: "номер темы «ЗАЯВКИ» (из /id внутри темы) или пусто — тогда в General" },
  notify_thread_acts: { def: "", text: true, check: (v) => v === "" || /^\d{1,10}$/.test(String(v)),
                        hint: "номер темы «АКТЫ» (из /id внутри темы) или пусто — тогда в General" },
  session_ttl_hours: { min: 1, max: 720, hint: "от 1 часа до 30 суток" },
  max_login_attempts: { min: 3, max: 20, hint: "от 3 до 20 попыток" },
  login_lock_minutes: { min: 1, max: 1440, hint: "от 1 минуты до суток" },
  import_source_id: { text: true, hint: "идентификатор таблицы Google или пусто" },
  site_seasons: { min: 0, max: 1, hint: "1 — праздничные темы по календарю, 0 — выключены" },
  public_orders: { min: 0, max: 1, hint: "1 — сайт отправляет заявку сам, 0 — только копипастом" },
  public_orders_per_hour: { min: 1, max: 200, hint: "от 1 до 200" },
  archive_keep_days: { min: 0, max: 3650, hint: "сколько дней заказ лежит в архиве до удаления; 0 — хранить всегда" },
  act_template_id: { text: true, clean: mockDriveId,
                     check: (v) => v === "" || /^[A-Za-z0-9_-]{20,}$/.test(v),
                     hint: "ссылка на документ-шаблон или пусто" },
  act_folder_id: { text: true, clean: mockDriveId,
                   check: (v) => v === "" || /^[A-Za-z0-9_-]{20,}$/.test(v),
                   hint: "ссылка на папку для готовых актов или пусто" },
};
let mockCats = CONFIG.CATEGORIES.map((c) => ({
  ...c,
  // Мешки, флаги и расходники считаются количеством: личного QR у них нет.
  by_qty: c.code === "GRP",
}));
function mockByQty(code) {
  const c = mockCats.find((x) => x.code === code);
  return !!(c && c.by_qty);
}
function mockItemQty(item) {
  const n = Number(item.qty);
  return n > 0 ? n : 1;
}
// Строка каталога — как equipmentListRow в Code.gs: её отдают и
// /equipment/list, и /item/update.
function mockListRow(i) {
  const total = mockItemQty(i);
  const out = Number(i.qty_out || 0);
  return {
    item_id: i.item_id, name: i.name, category: i.category, status: i.status,
    serial_number: i.serial_number, inventory_number: i.inventory_number,
    model_code: i.model_code, qty: total, qty_out: out, qty_free: total - out,
    condition_notes: i.condition_notes || "",
  };
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
  let nextStudentId = 3;
  let nextOrderId = 4;

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
    // Без ника: на нём видно, что «Чат» в списке заказов не смахивается.
    { student_id: 2, full_name: "Гусев Артём Олегович", phone: "+79161234567",
      tg_username: "", created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(), notes: "" },
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
      act_url: "https://docs.google.com/document/d/demo-act-1/edit",
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
    // Заказ без ника и без вещей на руках: в демо его можно смахнуть в архив
    // и вернуть, а «Чата» у него нет.
    {
      order_id: 3, order_no: "1525686943", request_code: "", student_id: 2,
      student_name: "Гусев Артём Олегович", student_phone: "+79161234567",
      student_tg: "", is_adult: true, guardian_name: "", guardian_phone: "",
      project: "Диплом", issue_date: mockDate(3), return_date: mockDate(6), extra_input: "",
      amount: 0, currency: "", source_url: "", status: "New", raw_text: "",
      created_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
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
    inventories: [],
    announcements: [],
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

// Приём одной позиции — общий для /transaction/checkin и пакетного приёма,
// как checkinUnderLock в Code.gs. Статус заказа здесь не считается: затронутые
// заказы копятся в touched и закрываются в mockSettleOrders.
function mockCheckinOne(body, staff_id, touched) {
  const item = MockStore.findItem(body.item_id);
  if (!item) { const e = new Error("Предмет не найден"); e.status = 404; throw e; }
  const openList = MockStore.transactions.filter((t) => t.item_id === item.item_id && t.status === "Open");
  if (!openList.length) { const e = new Error("Открытой выдачи для этого предмета не найдено"); e.status = 409; throw e; }
  const tx = openList[0];
  const bulkIn = mockByQty(item.category);
  // Строка состава освобождается на принятое каждой записью — как
  // releaseOrderLine в Code.gs.
  const release = (t, n) => {
    if (!t.order_id) return;
    touched.add(String(t.order_id));
    const line = MockStore.orderItems.find((i) =>
      String(i.order_id) === String(t.order_id) && String(i.line_no) === String(t.order_line));
    if (line) line.issued_qty = Math.max(0, Number(line.issued_qty || 0) - n);
  };

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
      release(t, take);
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
    release(tx, 1);
  }

  let defect_id = null;
  if (body.has_defect) {
    defect_id = MockStore.nextDefectId();
    MockStore.defects.push({
      defect_id, item_id: item.item_id, reported_by: staff_id,
      reported_by_name: (MockStore.findStaffById(staff_id) || {}).full_name || "",
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
  return { transaction_id: tx.transaction_id, defect_id, qty: bulkIn ? Number(body.qty || 1) : 1,
    qty_out: bulkIn ? item.qty_out : undefined };
}

// Заказ закрыт, когда по нему на руках ничего нет, — как settleOrderStatus.
function mockSettleOrders(touched) {
  touched.forEach((orderId) => {
    const order = MockStore.orders.find((o) => String(o.order_id) === orderId);
    if (order && order.status !== "Cancelled") {
      const stillOut = MockStore.transactions.filter(
        (t) => String(t.order_id) === orderId && t.status === "Open").length;
      order.status = stillOut ? "Issued" : "Returned";
      order.closed_at = stillOut ? "" : new Date().toISOString();
    }
  });
}

function mockFail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

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

      // Токен обязателен — как и в Apps Script: адрес веб-приложения не секрет,
      // а номера напечатаны на этикетках, и без проверки склад читался перебором.
      case "/item/lookup": {
        MockStore.requireToken(token);
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

      // Исправление номеров у конкретной вещи. Настоящая версия —
      // handleItemNumbers в Code.gs, там же и объяснение, почему дубль номера
      // отклоняется, а не просто подсвечивается.
      case "/item/numbers": {
        MockStore.requireAdmin(token);
        const id = String(body.item_id || "").trim();
        if (!id) { const e = new Error("Не сказано, какой вещи править номера"); e.status = 400; throw e; }
        const item = MockStore.findItem(id);
        if (!item) { const e = new Error("Предмет не найден"); e.status = 404; throw e; }
        if (mockByQty(item.category)) {
          const e = new Error("Это позиция с учётом количеством — одна строка на всю " +
            "полку. Личных номеров у неё нет, вписывать их некуда.");
          e.status = 409; throw e;
        }
        const next = {};
        ["serial_number", "inventory_number"].forEach((f) => {
          if (!Object.prototype.hasOwnProperty.call(body, f)) return;
          next[f] = String(body[f] == null ? "" : body[f]).trim();
        });
        if (!Object.keys(next).length) {
          const e = new Error("Нечего править: ни заводского, ни инвентарного номера не прислано");
          e.status = 400; throw e;
        }
        const labels = { serial_number: "заводской", inventory_number: "инвентарный" };
        Object.keys(next).forEach((f) => {
          if (!next[f]) return;
          const taken = MockStore.equipment.find((r) => String(r.item_id) !== id &&
            String(r[f] || "").trim().toLowerCase() === next[f].toLowerCase());
          if (taken) {
            const e = new Error("Такой " + labels[f] + " номер уже стоит у вещи " +
              taken.item_id + " («" + (taken.name || "") + "»). Два одинаковых номера — " +
              "это потерянная вещь: по ним ищут технику, и повторный импорт считает их " +
              "одной и той же.");
            e.status = 409; throw e;
          }
        });
        const changed = {};
        Object.keys(next).forEach((f) => {
          const was = String(item[f] || "");
          if (was !== next[f]) { changed[f] = { was, now: next[f] }; item[f] = next[f]; }
        });
        return {
          item_id: id, name: item.name || "",
          serial_number: String(item.serial_number || ""),
          inventory_number: String(item.inventory_number || ""),
          changed,
        };
      }

      // Правка карточки вещи. Настоящая версия — handleItemUpdate в Code.gs,
      // там же объяснение правил; здесь те же отказы и тот же ответ, чтобы
      // карточка в демо вела себя как на живой таблице. Перенос всей модели —
      // через ветку /model/move ниже, как и в бэкенде (moveModel).
      case "/item/update": {
        MockStore.requireAdmin(token);
        const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
        const id = String(body.item_id || "").trim();
        if (!id) fail(400, "Не сказано, какую вещь править");
        const item = MockStore.findItem(id);
        if (!item) fail(404, "Предмет не найден");
        const allModel = body.all_model === true;
        const bulk = mockByQty(item.category);
        const from = item.category;
        const code = String(item.model_code || "");
        const has = (f) => Object.prototype.hasOwnProperty.call(next, f);
        const next = {};
        ["name", "serial_number", "inventory_number", "condition_notes", "qty", "category"].forEach((f) => {
          if (!Object.prototype.hasOwnProperty.call(body, f)) return;
          next[f] = String(body[f] == null ? "" : body[f]).trim();
        });
        if (!Object.keys(next).length) fail(400, "Нечего править: ни одного поля не прислано");
        if (allModel && ["serial_number", "inventory_number", "condition_notes", "qty"].some(has)) {
          fail(400, "Номера, состояние и количество у каждой вещи свои — для всей модели их не задать. " +
            "Снимите галочку «ко всем вещам модели» и правьте эту вещь.");
        }
        if (has("name") && !next.name) fail(400, "Название не может быть пустым");
        const labels = { serial_number: "заводской", inventory_number: "инвентарный" };
        Object.keys(labels).forEach((f) => {
          if (!has(f)) return;
          if (bulk) {
            if (!next[f]) { delete next[f]; return; }
            fail(409, "Это позиция с учётом количеством — одна строка на всю полку. " +
              "Личных номеров у неё нет, вписывать их некуда.");
          }
          if (!next[f]) return;
          const taken = MockStore.equipment.find((r) => String(r.item_id) !== id &&
            String(r[f] || "").trim().toLowerCase() === next[f].toLowerCase());
          if (taken) {
            fail(409, "Такой " + labels[f] + " номер уже стоит у вещи " + taken.item_id +
              " («" + (taken.name || "") + "»). Два одинаковых номера — это потерянная вещь.");
          }
        });
        if (has("qty")) {
          if (!bulk) fail(400, "Это поштучная вещь — количество у неё всегда одно");
          const qty = Number(next.qty);
          if (!next.qty || !Number.isInteger(qty) || qty < 1) fail(400, "Количество — целое число от одного");
          const out = Number(item.qty_out || 0);
          if (qty < out) {
            fail(409, "На руках сейчас " + out + " шт. — меньше этого количество не поставить. " +
              "Сначала примите выданное.");
          }
          next.qty = qty;
        }
        let to = null;
        if (has("category")) {
          const wanted = next.category.toUpperCase();
          delete next.category;
          if (wanted && wanted !== from) {
            MockStore.requireOwner(token);
            const toCat = mockCategories().find((c) => c.code === wanted);
            if (!toCat) fail(404, "Категория, в которую переносим, не найдена");
            if (!!toCat.by_qty !== bulk) {
              fail(409, "У категорий разный способ учёта: одна считается количеством, " +
                "другая — поштучно. Перенос превратил бы поштучные записи в количество или наоборот.");
            }
            if (!allModel && bulk) {
              fail(409, "У позиции с учётом количеством одна строка на модель — переносится " +
                "вся модель. Включите «Применить ко всем вещам этой модели».");
            }
            if (!allModel && (item.status === "Rented" || item.current_transaction_id)) {
              fail(409, "Вещь сейчас выдана — номер ей менять нельзя: принимать её будут по " +
                "старой наклейке. Сначала примите, потом переносите.");
            }
            to = wanted;
          }
        }
        // Вся модель с выданным: /model/move ниже откажет сам, но название к
        // тому времени уже было бы переписано — проверяем до записи.
        if (to && allModel && MockStore.equipment.some((r) => r.category === from &&
            String(r.model_code) === code &&
            (Number(r.qty_out || 0) > 0 || r.status === "Rented" || r.current_transaction_id))) {
          fail(409, "Что-то из этой модели на руках — переносить её нельзя: номера сменятся, а " +
            "принимать выданное будут по старым наклейкам. Сначала примите, потом переносите.");
        }
        const sameModel = (r) => r.category === from && String(r.model_code) === code;
        const modelRow = MockStore.models.find(sameModel);
        if (allModel && (has("name") || to)) {
          if (!modelRow) fail(409, "У вещи нет строки в справочнике моделей — править всю модель нечем.");
          if (has("name")) {
            const needle = MockStore.normalizeModelName(next.name);
            const clash = MockStore.models.find((m) => m !== modelRow && m.category === from &&
              MockStore.normalizeModelName(m.model_name) === needle);
            if (clash) fail(409, "В этой категории уже есть модель «" + clash.model_name + "».");
          }
        }

        const changed = {};
        let renamed = 0;
        if (allModel && has("name")) {
          const modelRenamed = modelRow.model_name !== next.name;
          modelRow.model_name = next.name;
          MockStore.equipment.filter(sameModel).forEach((r) => {
            if (r.name === next.name) return;
            r.name = next.name;
            renamed++;
          });
          if (modelRenamed || renamed) changed.name = { was: item.name, now: next.name };
          delete next.name;
        }
        Object.keys(next).forEach((f) => {
          const was = String(item[f] == null ? "" : item[f]);
          if (was !== String(next[f])) { changed[f] = { was, now: String(next[f]) }; item[f] = next[f]; }
        });

        let moved = null;
        if (to && allModel) {
          moved = await MockAPI.handle("/model/move", { category: from, model_code: code, to_category: to }, token);
          changed.category = { was: from, now: to };
        } else if (to) {
          const target = MockStore.findOrCreateModel(to, item.name);
          const fresh = MockStore.nextItemId(to, target.model_code);
          let journalRows = 0;
          [MockStore.transactions, MockStore.defects, MockStore.inventories].forEach((rows) => {
            (rows || []).forEach((row) => {
              if (String(row.item_id) === id) { row.item_id = fresh; journalRows++; }
            });
          });
          item.item_id = fresh;
          item.category = to;
          item.model_code = target.model_code;
          let removed = false;
          if (modelRow && !MockStore.equipment.some(sameModel)) {
            MockStore.models.splice(MockStore.models.indexOf(modelRow), 1);
            removed = true;
          }
          moved = { old: id, fresh, journal_rows: journalRows, model_removed: removed,
                    model_code: target.model_code };
          changed.category = { was: from, now: to };
        }
        return { item: mockListRow(item), old_item_id: id, item_id: item.item_id,
                 all_model: allModel, renamed, moved, changed };
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
        let order_id = "", expected = body.expected_return_at || null;
        let parts = [{ line: "", qty: takeQty }];
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
          // Как claimOrderLine в Code.gs: выданное количество ложится на строки
          // той же модели, пока в них есть место; остаток — «вне заказа», но
          // выдача проходит. Каждая часть — своя запись журнала.
          parts = [];
          let want = takeQty;
          MockStore.orderItems.forEach((i) => {
            if (want <= 0) return;
            if (String(i.order_id) !== String(order_id) || !i.model_code) return;
            if (i.category !== item.category || String(i.model_code) !== String(item.model_code)) return;
            const take = Math.min(want, Number(i.qty || 0) - Number(i.issued_qty || 0));
            if (take <= 0) return;
            i.issued_qty = Number(i.issued_qty || 0) + take;
            parts.push({ line: String(i.line_no), qty: take });
            want -= take;
          });
          if (want > 0) parts.push({ line: "off-order", qty: want });
          order.status = "Issued";
        }
        let transaction_id = null, order_line = "";
        parts.forEach((part) => {
          const id = MockStore.nextTransactionId();
          if (transaction_id === null) transaction_id = id;
          if (!order_line || part.line === "off-order") order_line = part.line;
          MockStore.transactions.push({
            transaction_id: id, item_id: item.item_id, client_id: body.client_id,
            order_id, order_line: part.line,
            staff_out: staff_id, staff_in: null,
            checked_out_at: new Date().toISOString(),
            expected_return_at: expected,
            checked_in_at: null, status: "Open", notes: body.notes || "",
            qty: part.qty, qty_in: 0,
          });
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
        const touched = new Set();
        const res = mockCheckinOne(body, staff_id, touched);
        mockSettleOrders(touched);
        return res;
      }

      case "/transaction/checkin-batch": {
        const staff_id = MockStore.requireToken(token);
        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length) { const e = new Error("Нечего принимать — список пуст"); e.status = 400; throw e; }
        if (items.length > 40) { const e = new Error("За раз можно принять не больше 40 позиций"); e.status = 400; throw e; }
        const touched = new Set();
        const results = items.map((it) => {
          const item_id = String((it && it.item_id) || "").trim();
          try {
            const r = mockCheckinOne(it || {}, staff_id, touched);
            return { item_id, ok: true, transaction_id: r.transaction_id, defect_id: r.defect_id, qty: r.qty, qty_out: r.qty_out };
          } catch (err) {
            return { item_id, ok: false, status: err.status || 500, error: err.message };
          }
        });
        mockSettleOrders(touched);
        const failed = results.filter((r) => !r.ok).length;
        return { results, done: results.length - failed, failed };
      }

      case "/defect/report": {
        const staff_id = MockStore.requireToken(token);
        const item = MockStore.findItem(body.item_id);
        if (!item) { const e = new Error("Предмет не найден"); e.status = 404; throw e; }
        const defect_id = MockStore.nextDefectId();
        MockStore.defects.push({
          defect_id, item_id: item.item_id, reported_by: staff_id,
          reported_by_name: (MockStore.findStaffById(staff_id) || {}).full_name || "",
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
        return list.map(mockListRow);
      }

      case "/models/list": {
        MockStore.requireToken(token);
        let list = MockStore.models;
        if (body && body.category && body.category !== "all") list = list.filter((m) => m.category === body.category);
        return list.map((m) => ({ section: "", photo: "", ...m })).sort((a, b) => a.model_name.localeCompare(b.model_name));
      }

      // Разметка моделей по разделам витрины. Настоящая версия —
      // handleModelsSections в Code.gs.
      case "/models/sections": {
        MockStore.requireAdmin(token);
        const list = body && body.models;
        if (!list || !list.length) { const e = new Error("Нечего размечать: список пуст"); e.status = 400; throw e; }
        const allowed = ["CINE", "PHOTO"];
        const tags = { "#КИНО": "CINE", "КИНО": "CINE", "#CINE": "CINE",
                       "#ФОТО": "PHOTO", "ФОТО": "PHOTO", "#PHOTO": "PHOTO" };
        const wanted = list.map((row) => {
          const raw = String(row.section || "").trim();
          const parts = raw.toUpperCase().split(/[,;\s]+/).filter(Boolean).map((p) => tags[p] || p);
          const clean = allowed.filter((c) => parts.indexOf(c) !== -1).join(",");
          if (raw && !clean) {
            const e = new Error("Неизвестный раздел: " + raw + ". Допустимо #кино, #фото или оба.");
            e.status = 400; throw e;
          }
          return { category: String(row.category || "").toUpperCase(),
                   model_code: String(row.model_code || ""), section: clean };
        });
        let changed = 0;
        const missing = [];
        wanted.forEach((w) => {
          const m = MockStore.models.find((x) => x.category === w.category &&
            String(x.model_code).padStart(2, "0") === w.model_code.padStart(2, "0"));
          if (!m) { missing.push(w.category + "·" + w.model_code); return; }
          if ((m.section || "") === w.section) return;
          m.section = w.section;
          changed += 1;
        });
        return { changed, asked: wanted.length, missing };
      }

      // Цена модели — для акта. В демо просто запоминаем.
      case "/models/price": {
        MockStore.requireAdmin(token);
        const cat = String(body.category || "").toUpperCase();
        const code = String(body.model_code || "").padStart(2, "0");
        const raw = String(body.price === undefined || body.price === null ? "" : body.price).trim();
        const price = raw === "" ? "" : Number(raw.replace(/\s/g, "").replace(",", "."));
        if (price !== "" && (!isFinite(price) || price < 0)) {
          const e = new Error("Цена — неотрицательное число или пусто"); e.status = 400; throw e;
        }
        const m = MockStore.models.find((x) => x.category === cat &&
          String(x.model_code).padStart(2, "0") === code);
        if (!m) { const e = new Error("Такой модели нет: " + cat + "·" + code); e.status = 404; throw e; }
        m.price = price;
        return { category: cat, model_code: code, price };
      }

      // Название и фото модели — как handleModelsRename / handleModelsPhoto.
      // Фото в демо хранится самим data URL: Диска здесь нет.
      case "/models/rename": {
        MockStore.requireAdmin(token);
        const cat = String(body.category || "").toUpperCase();
        const code = String(body.model_code || "").padStart(2, "0");
        const raw = String(body.model_name || "");
        const err = (msg, status) => { const e = new Error(msg); e.status = status; return e; };
        if (/[:\r\n]/.test(raw)) throw err("В названии нельзя двоеточие и перенос строки: по двоеточию разбирается строка заказа.", 400);
        const name = raw.replace(/\s+/g, " ").trim();
        if (!name) throw err("Название не может быть пустым", 400);
        if (name.length > 120) throw err("Название длиннее 120 знаков", 400);
        const m = MockStore.models.find((x) => x.category === cat &&
          String(x.model_code).padStart(2, "0") === code);
        if (!m) throw err("Такой модели нет: " + cat + "·" + code, 404);
        const needle = MockStore.normalizeModelName(name);
        const clash = MockStore.models.find((x) => x !== m && x.category === cat &&
          MockStore.normalizeModelName(x.model_name) === needle);
        if (clash) throw err("В этой категории уже есть модель «" + clash.model_name + "» — это то же название.", 409);
        m.model_name = name;
        let units = 0;
        MockStore.equipment.forEach((i) => {
          if (i.category === cat && String(i.model_code).padStart(2, "0") === code && i.name !== name) {
            i.name = name; units += 1;
          }
        });
        return { category: cat, model_code: code, model_name: name, renamed_units: units };
      }

      case "/models/photo": {
        MockStore.requireAdmin(token);
        const cat = String(body.category || "").toUpperCase();
        const code = String(body.model_code || "").padStart(2, "0");
        const image = String(body.image || "");
        if (image && !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
          const e = new Error("Нужна картинка JPEG, PNG или WebP"); e.status = 400; throw e;
        }
        if (image.length > 700 * 1024 * 4 / 3) { const e = new Error("Фото больше 700 КБ"); e.status = 413; throw e; }
        const m = MockStore.models.find((x) => x.category === cat &&
          String(x.model_code).padStart(2, "0") === code);
        if (!m) { const e = new Error("Такой модели нет: " + cat + "·" + code); e.status = 404; throw e; }
        m.photo = image;
        return { category: cat, model_code: code, photo: image };
      }

      // Выдача по заявке без сканирования — как handleOrderIssue в Code.gs:
      // выбор свободных предметов здесь, а сама выдача — тем же
      // /transaction/checkout, что и со «Скана». Раньше мок писал журнал сам и
      // ставил предмету статус «Issued», которого в каталоге нет: в демо
      // выданное оставалось «как бы свободным», а у штучных позиций выдача не
      // считалась вовсе.
      case "/order/issue": {
        MockStore.requireToken(token);
        const order = MockStore.orders.find((o) => String(o.order_id) === String(body.order_id));
        if (!order) { const e = new Error("Заказ не найден"); e.status = 404; throw e; }
        if (order.status === "Cancelled") {
          const e = new Error("Заказ отменён, выдавать по нему нельзя"); e.status = 409; throw e;
        }
        const line = MockStore.orderItems.find((i) =>
          String(i.order_id) === String(order.order_id) &&
          Number(i.line_no) === Number(body.line_no));
        if (!line) { const e = new Error("Такой строки в заказе нет"); e.status = 404; throw e; }
        if (!line.model_code || !line.category) {
          const e = new Error("Позиция не сопоставлена с моделью"); e.status = 409; throw e;
        }
        const left = Number(line.qty || 1) - Number(line.issued_qty || 0);
        if (left < 1) { const e = new Error("По этой строке уже всё выдано"); e.status = 409; throw e; }
        const asked = body.qty === undefined || body.qty === null || body.qty === "";
        let want = asked ? left : Math.floor(Number(body.qty));
        if (!want || want < 1) { const e = new Error("Количество — целое число от одного"); e.status = 400; throw e; }
        if (want > left) { const e = new Error("По этой строке осталось выдать " + left); e.status = 409; throw e; }
        const byQty = mockByQty(line.category);
        const model = String(line.model_code).padStart(2, "0");
        const free = MockStore.equipment.filter((e2) =>
          e2.category === line.category &&
          String(e2.model_code).padStart(2, "0") === model &&
          (byQty ? mockItemQty(e2) - Number(e2.qty_out || 0) > 0 : e2.status === "Available"))
          .sort((x, y) => (String(x.item_id) < String(y.item_id) ? -1 : 1));
        if (!free.length) {
          const e = new Error("Свободных «" + (line.raw_name || model) + "» на складе нет — ни одной");
          e.status = 409; throw e;
        }
        const issued = [];
        const checkout = (itemId, qty) => MockAPI.handle("/transaction/checkout", {
          item_id: itemId, order_id: order.order_id, qty,
          notes: "Выдано по заявке без сканирования",
        }, token);
        if (byQty) {
          const spare = mockItemQty(free[0]) - Number(free[0].qty_out || 0);
          if (asked) want = Math.min(want, spare);
          if (spare < want) { const e = new Error("Свободно только " + spare + " из " + want); e.status = 409; throw e; }
          await checkout(free[0].item_id, want);
          issued.push({ item_id: free[0].item_id, qty: want });
        } else {
          if (asked) want = Math.min(want, free.length);
          if (free.length < want) {
            const e = new Error("Свободно только " + free.length + " из " + want); e.status = 409; throw e;
          }
          for (let i = 0; i < want; i++) {
            await checkout(free[i].item_id, 1);
            issued.push({ item_id: free[i].item_id, qty: 1 });
          }
        }
        return { order_id: Number(order.order_id), line_no: Number(line.line_no), issued, left: left - want };
      }

      // Архив заказа. Не удаление: запись о договорённости остаётся целой.
      case "/order/archive": {
        MockStore.requireAdmin(token);
        const order = MockStore.orders.find((o) => String(o.order_id) === String(body.order_id));
        if (!order) { const e = new Error("Заказ не найден"); e.status = 404; throw e; }
        if (body.back) {
          order.archived_at = "";
          return { order_id: order.order_id, archived_at: "" };
        }
        const open = MockStore.transactions.filter(
          (t) => String(t.order_id) === String(order.order_id) && t.status === "Open");
        if (open.length) {
          const e = new Error("По этому заказу " + open.length +
            " ед. на руках — сначала примите их обратно");
          e.status = 409; throw e;
        }
        order.archived_at = new Date().toISOString();
        return { order_id: order.order_id, archived_at: order.archived_at };
      }

      // Шаблон акта. В демо документа нет — запоминаем выдуманный
      // идентификатор, чтобы экран настроек можно было проверить.
      case "/act/template": {
        // Проверяем так же, как весь остальной мок: главный администратор —
        // это ownerStaffId, а не «сотрудник №1». Раньше здесь стояла единица,
        // и в демо шаблон не мог создать даже владелец.
        MockStore.requireOwner(token);
        if (mockSettings.act_template_id && !body.replace) {
          const e = new Error("Шаблон уже есть"); e.status = 409; throw e;
        }
        mockSettings.act_template_id = "demo-template-" + Date.now();
        return { template_id: mockSettings.act_template_id,
                 url: "https://docs.google.com/document/d/" + mockSettings.act_template_id + "/edit" };
      }

      // Акт. Документ делает настоящий бэкенд через Google Docs; в демо
      // отдаём ссылку-заглушку, чтобы экран можно было проверить.
      case "/act/build": {
        MockStore.requireToken(token);
        const order = MockStore.orders.find((o) => String(o.order_id) === String(body.order_id));
        if (!order) { const e = new Error("Заказ не найден"); e.status = 404; throw e; }
        const lines = MockStore.orderItems.filter((i) => String(i.order_id) === String(order.order_id));
        if (!lines.length) { const e = new Error("В заказе нет ни одной позиции"); e.status = 409; throw e; }
        const unpriced = lines.filter((l) => !Number(l.total || 0)).length;
        order.act_url = "https://docs.google.com/document/d/demo-act/edit";
        return {
          url: order.act_url,
          document_id: "demo-act", lines: lines.length,
          total: lines.reduce((s2, l) => s2 + Number(l.total || 0), 0), unpriced,
        };
      }

      // Перенос модели. В моке важно воспроизвести именно перенумерацию и
      // переписывание ссылок: если мок этого не делает, экран «Модели» в тестах
      // выглядит работающим, а на живой таблице у вещей отвяжется история.
      case "/model/move": {
        MockStore.requireAdmin(token);
        const from = String(body.category || "").toUpperCase();
        const to = String(body.to_category || "").toUpperCase();
        const code = String(body.model_code || "");
        if (!from || !to) { const e = new Error("Укажите, какую модель и куда переносим"); e.status = 400; throw e; }
        if (from === to) { const e = new Error("Модель уже в этой категории"); e.status = 400; throw e; }
        const cats = mockCategories();
        const fromCat = cats.find((c) => c.code === from);
        const toCat = cats.find((c) => c.code === to);
        if (!fromCat) { const e = new Error("Категория, из которой переносим, не найдена"); e.status = 404; throw e; }
        if (!toCat) { const e = new Error("Категория, в которую переносим, не найдена"); e.status = 404; throw e; }
        if (!!fromCat.by_qty !== !!toCat.by_qty) {
          const e = new Error("У категорий разный способ учёта: одна считается количеством, " +
            "другая — поштучно. Перенос превратил бы поштучные записи в количество или наоборот.");
          e.status = 409; throw e;
        }
        const source = MockStore.models.find((m) => m.category === from && String(m.model_code) === code);
        if (!source) { const e = new Error("Модель не найдена в этой категории"); e.status = 404; throw e; }
        // Пока что-то из модели на руках, не переносим — как assertModelNotOut
        // в Code.gs: номера сменятся, а принимать будут по старым наклейкам.
        const outN = MockStore.equipment
          .filter((i) => i.category === from && String(i.model_code) === code)
          .reduce((n, i) => n + (Number(i.qty_out || 0) ||
            (i.status === "Rented" || i.current_transaction_id ? 1 : 0)), 0);
        if (outN) {
          const word = fromCat.by_qty ? "шт." : (outN % 10 === 1 && outN % 100 !== 11 ? "вещь" :
            [2, 3, 4].includes(outN % 10) && ![12, 13, 14].includes(outN % 100) ? "вещи" : "вещей");
          const e = new Error("На руках " + outN + " " + word + " этой модели — переносить её нельзя: " +
            "номера сменятся, а принимать выданное будут по старым наклейкам. Сначала примите, потом переносите.");
          e.status = 409; throw e;
        }

        const merged = MockStore.models.some((m) => m.category === to && m.model_name === source.model_name);
        const target = MockStore.findOrCreateModel(to, source.model_name);
        const items = MockStore.equipment.filter((i) => i.category === from && String(i.model_code) === code);
        const renames = items.map((item) => {
          const fresh = MockStore.nextItemId(to, target.model_code);
          const old = String(item.item_id);
          item.item_id = fresh;
          item.category = to;
          item.model_code = target.model_code;
          return { old, fresh };
        });
        let journalRows = 0;
        renames.forEach(({ old, fresh }) => {
          [MockStore.transactions, MockStore.defects, MockStore.inventories].forEach((rows) => {
            (rows || []).forEach((row) => {
              if (String(row.item_id) === old) { row.item_id = fresh; journalRows++; }
            });
          });
        });
        // Именно splice, а не переприсваивание: models — та же ссылка, что внутри
        // MockStore, и подмена массива снаружи его не изменила бы.
        MockStore.models.splice(MockStore.models.indexOf(source), 1);
        return { ok: true, model_name: source.model_name, from, to,
                 model_code: target.model_code, merged, moved: renames.length,
                 journal_rows: journalRows, renames };
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
          closed_at: "", act_url: "",
        });
        (body.items || []).forEach((line, idx) => {
          MockStore.orderItems.push({
            order_id, line_no: Number(line.line_no || idx + 1), raw_name: line.raw_name || "",
            model_code: line.model_code || "", category: line.category || "",
            qty: Number(line.qty || 1), price: Number(line.price || 0), total: Number(line.total || 0),
            issued_qty: 0, note: "",
          });
        });
        // Акт собирается сам, как на живом бэкенде: есть шаблон — есть ссылка.
        const act_url = mockSettings.act_template_id
          ? "https://docs.google.com/document/d/demo-act-" + order_id + "/edit" : "";
        if (act_url) {
          MockStore.orders[MockStore.orders.length - 1].act_url = act_url;
        }
        return { order_id, student_id: student ? student.student_id : "",
                 student_created, act_url };
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
                   issued_open: open, issued_total: txs.length, items_text: itemsText,
                   archived_at: o.archived_at || "",
                   // Ссылка на акт нужна и в списке: по ней номер заказа открывает акт.
                   act_url: o.act_url || "" };
        })
        // Архив по умолчанию не показываем — как и настоящий бэкенд.
        .filter((o) => (body.archived ? !!o.archived_at : !o.archived_at));
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
        // Длина — только у нового PIN, как в Code.gs: демо-сотрудники с
        // 4-значными PIN (ivan/1234) входят по-прежнему.
        if (!/^\d{6}$/.test(String(body.pin))) {
          const e = new Error("PIN — ровно 6 цифр"); e.status = 400; throw e;
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

      // Поиск чата. В демо Telegram нет, поэтому отдаём то, что отдал бы он:
      // группу, личную переписку и признак того, какой чат выбран сейчас.
      case "/notify/chats": {
        MockStore.requireAdmin(token);
        return {
          chats: [
            { chat_id: "-1001234567890", title: "Склад Киноколледж №40",
              type: "supergroup", at: new Date().toISOString() },
            { chat_id: "482913756", title: "Мария Сидорова",
              type: "private", at: new Date().toISOString() },
          ],
          current: String(mockSettings.notify_chat_id || ""),
          // Имя бота живой бэкенд спрашивает у Telegram (getMe) — в демо
          // подставляем такое же по форме, иначе экран здесь и на живой
          // таблице ведёт себя по-разному.
          bot: { username: "mifs_rent_demo_bot", name: "Mifs Rent" },
          command: "/id@mifs_rent_demo_bot",
          webhook: mockWebhook.on,
          hint: "",
        };
      }

      // Постоянная связь. В демо это переключатель без Telegram, но по форме
      // ответ тот же: включено или нет, сколько событий ждёт, последняя ошибка.
      case "/notify/webhook": {
        MockStore.requireAdmin(token);
        const mode = String(body.mode || "status");
        if (mode === "on") {
          if (!String(mockSettings.api_url || "").trim()) {
            const e = new Error("Не задан адрес Worker: Настройки → «Адреса и связи» → " +
              "«Адрес Worker» — туда Telegram и будет присылать события.");
            e.status = 400; throw e;
          }
          mockWebhook.on = true;
          mockWebhook.url = String(mockSettings.api_url).replace(/\/+$/, "") + "/tg/демо";
          mockWebhook.last_error = "";
        } else if (mode === "off") {
          mockWebhook.on = false;
          mockWebhook.url = "";
        }
        return {
          message: mode === "on"
            ? "Постоянная связь включена. Напишите в чате «/id» — бот ответит сам."
            : (mode === "off" ? "Постоянная связь выключена: вернулись к опросу по кнопке." : ""),
          on: mockWebhook.on,
          url: mockWebhook.url,
          pending: 0,
          last_error: mockWebhook.last_error,
          last_error_at: "",
        };
      }

      // Приветствие в чате. Живой бэкенд шлёт его через Telegram; в демо
      // важно повторить условия отказа — без чата ручка отвечает так же.
      case "/notify/hello": {
        MockStore.requireAdmin(token);
        const chat = String(body.chat_id || "").trim() || String(mockSettings.notify_chat_id || "");
        if (!chat) {
          const e = new Error("Не выбран чат склада: нажмите «Найти чат склада» и " +
            "укажите, в какой группе работает бот.");
          e.status = 400; throw e;
        }
        return { ok: true, message: "Бот поздоровался — посмотрите в чате." };
      }

      case "/notify/test": {
        MockStore.requireAdmin(token);
        if (!String(body.chat_id || "").trim()) {
          const e = new Error("Не указан чат: впишите числовой id чата склада в настройках и сохраните.");
          e.status = 400; throw e;
        }
        return { ok: true, message: "Сообщение отправлено — проверьте чат." };
      }

      // Этикетки в чат больше не отправляются: картинки в Telegram не уходят
      // вовсе. Ручка отвечает отказом, как живой бэкенд.
      case "/labels/send": {
        MockStore.requireToken(token);
        const e = new Error("Отправка этикеток в чат отключена. В Telegram сохраняйте по одной " +
          "(кнопка «Сохранить»), пачкой — кнопкой «Печать» или откройте приложение в браузере.");
        e.status = 410; throw e;
      }

      case "/inventory/save": {
        const staff_id = MockStore.requireToken(token);
        const found = Object.keys(body.found || {});
        const rec = {
          inventory_id: MockStore.inventories.length + 1,
          scope: body.scope, started_at: body.started_at, finished_at: body.finished_at,
          found: found.length, missing: (body.missing || []).length,
          unknown: (body.unknown || []).length, staff_id,
        };
        MockStore.inventories.push(rec);
        return rec;
      }

      case "/inventory/list": {
        MockStore.requireToken(token);
        return MockStore.inventories.slice().reverse();
      }

      // Объявления склада: писать и снимать может любой вошедший, не только
      // администратор. Публичной ручки для сайта в демо нет — сайт мок не
      // использует.
      case "/announcements/list": {
        MockStore.requireToken(token);
        const today = new Date().toISOString().substring(0, 10);
        return {
          items: MockStore.announcements.filter((a) => !a.removed_at).map((a) => ({
            ...a, expired: !!a.until && a.until < today,
          })).reverse(),
          limits: { title: 120, text: 2000, lines: 10, active: 10 },
        };
      }

      case "/announcement/save": {
        const staff_id = MockStore.requireToken(token);
        const title = String(body.title || "").trim();
        const text = String(body.text || "").trim();
        if (!title) throw mockFail(400, "Укажите заголовок объявления");
        if (!text) throw mockFail(400, "Напишите текст объявления");
        const until = String(body.until || "").trim();
        const id = String(body.announcement_id || "");
        if (id) {
          const rec = MockStore.announcements.find((a) => a.announcement_id === id && !a.removed_at);
          if (!rec) throw mockFail(404, "Объявление не найдено");
          Object.assign(rec, { title, text, until });
          return { announcement_id: id, changed: true };
        }
        const rec = {
          announcement_id: String(MockStore.announcements.length + 1),
          title, text, until,
          created_at: new Date().toISOString(),
          created_by_name: MockStore.findStaffById(staff_id).full_name,
          removed_at: "",
        };
        MockStore.announcements.push(rec);
        return { announcement_id: rec.announcement_id, changed: true };
      }

      case "/announcement/remove": {
        MockStore.requireToken(token);
        const rec = MockStore.announcements.find((a) => a.announcement_id === String(body.announcement_id));
        if (!rec) throw mockFail(404, "Объявление не найдено");
        rec.removed_at = rec.removed_at || new Date().toISOString();
        return { announcement_id: rec.announcement_id, changed: true };
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
            // В демо журнала Logs нет — ошибок за сутки ноль, как на чистой таблице.
            logs_24h: 2,
            logs_recent: [
              { at: new Date(Date.now() - 3600e3).toISOString(), kind: "act", endpoint: "autoAct", reason: "build-failed",
                message: "Скрипту не хватает разрешения Google (DocumentApp)." },
              { at: new Date(Date.now() - 7200e3).toISOString(), kind: "telegram", endpoint: "sendMessage", reason: "fallback",
                message: "Тема форума не приняла сообщение, ушло в General." },
            ],
          },
          maintenance: { journal_archived_at: "", journal_trimmed_at: "", schema_outdated: false },
        };
      }

      case "/settings/set": {
        MockStore.requireAdmin(token);
        const incoming = body.settings || {};
        const rejected = [];
        Object.keys(incoming).forEach((k) => {
          const spec = MOCK_SETTINGS_SPEC[k];
          if (!spec) { rejected.push(k + ": неизвестная настройка"); return; }
          if (spec.text) {
            // Текстовые настройки бэкенд тоже проверяет — мок обязан вести себя
            // так же, иначе кривой адрес ловился бы только на живой таблице.
            const raw = spec.clean ? spec.clean(String(incoming[k]).trim())
                                   : String(incoming[k]).trim();
            if (spec.check && !spec.check(raw)) { rejected.push(k + ": " + spec.hint); return; }
            mockSettings[k] = raw;
            return;
          }
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
        if (body.action === "setup") return { message: "Готово. Создано вкладок: 0 (демо-режим)." };
        if (body.action === "trim") {
          return { message: "Подрезка отменена: журнал ни разу не выгружался." };
        }
        if (body.action === "ids") return { problems: [], counts: {}, total: 0 };
        const e = new Error("Неизвестное действие обслуживания"); e.status = 400; throw e;
      }

      case "/staff/delete": {
        const me = MockStore.requireOwner(token);
        const target = MockStore.findStaffById(body.staff_id);
        if (!target) { const e = new Error("Сотрудник не найден"); e.status = 404; throw e; }
        if (String(target.staff_id) === String(me.staff_id)) {
          const e = new Error("Нельзя удалить самого себя"); e.status = 409; throw e;
        }
        if (String(target.staff_id) === String(MockStore.ownerId())) {
          const e = new Error("Главного администратора удалить нельзя — права можно только передать");
          e.status = 409; throw e;
        }
        MockStore.rotateToken(target.staff_id, false);
        MockStore.staff.splice(MockStore.staff.indexOf(target), 1);
        return { staff_id: target.staff_id, full_name: target.full_name };
      }

      case "/staff/set-pin": {
        const staff_id = MockStore.requireToken(token);
        const me = MockStore.staff.find((x) => x.staff_id === staff_id);
        const newPin = String(body.pin || "").trim();
        if (!/^\d{6}$/.test(newPin)) {
          const e = new Error("PIN — ровно 6 цифр"); e.status = 400; throw e;
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
        } else if (String(targetId) === String(MockStore.ownerId())) {
          const e = new Error("PIN главного администратора меняет только он сам");
          e.status = 409; throw e;
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

      default: {
        const err = new Error("Неизвестный эндпоинт (мок): " + endpoint);
        err.status = 404;
        throw err;
      }
    }
  },
};
