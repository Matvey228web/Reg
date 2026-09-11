/**
 * Mifs Rent — бэкенд на Google Apps Script.
 *
 * Как использовать: этот файл целиком вставляется в редактор Apps Script,
 * привязанный к таблице Google Sheets (Extensions → Apps Script из самой
 * таблицы). Дальше один раз запускается функция setupSheets() (кнопка «Run»
 * вверху редактора) — она сама создаст все нужные вкладки с заголовками,
 * вручную ничего заполнять не нужно. После этого скрипт деплоится как
 * Web App. Подробности — в SETUP.md в корне репозитория.
 */

var SHEETS = {
  EQUIPMENT: "Equipment",
  STAFF: "Staff",
  CLIENTS: "Clients",
  TRANSACTIONS: "Transactions",
  DEFECTS: "Defects",
  META: "Meta",
};

// Единственное описание структуры таблицы: используется и при создании
// вкладок в setupSheets(), и как источник порядка колонок при записи строк.
var SCHEMA = {
  Equipment: ["item_id", "name", "category", "serial_number", "inventory_number", "status", "condition_notes", "created_at", "current_transaction_id"],
  Staff: ["staff_id", "full_name", "login", "pin_hash", "telegram_id", "role", "active", "session_token", "token_issued_at"],
  Clients: ["client_id", "client_name", "project_name", "phone", "notes", "created_at"],
  Transactions: ["transaction_id", "item_id", "client_id", "staff_out", "staff_in", "checked_out_at", "expected_return_at", "checked_in_at", "status", "notes"],
  Defects: ["defect_id", "item_id", "reported_by", "related_transaction_id", "description", "severity", "status", "reported_at", "resolved_at", "resolution_notes"],
  Meta: ["key", "value"],
};

var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов, как в js/config.js
var LOCK_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------
// Первоначальная настройка таблицы — запустить один раз кнопкой «Run»
// ---------------------------------------------------------------------

/**
 * Полная первоначальная настройка в один запуск: создаёт вкладки и сразу
 * переносит существующую инвентаризацию. Именно эту функцию удобно запускать
 * первой — остальные нужны только по отдельности.
 */
function setupEverything() {
  var a = setupSheets();
  var b = importInventory();
  var message = a + " " + b;
  Logger.log(message);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(message, "Mifs Rent", 15); } catch (ignored) {}
  return message;
}

/**
 * Создаёт недостающие вкладки и проставляет заголовки колонок.
 * Запускать можно сколько угодно раз: существующие данные не трогаются,
 * заголовки переписываются только если первая строка листа пустая.
 */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var created = [];
  var filled = [];

  for (var name in SCHEMA) {
    var headers = SCHEMA[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      created.push(name);
    }
    // Заголовки пишем только в пустой лист, чтобы не затереть данные,
    // если функцию запустили повторно на уже работающей таблице.
    var firstCell = sheet.getRange(1, 1).getValue();
    if (firstCell === "" || firstCell === null) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      filled.push(name);
    }
  }

  // Убираем пустой лист по умолчанию ("Sheet1" / "Лист1"), который Google
  // создаёт в новой таблице — иначе он останется висеть рядом со схемой.
  // Листы с любыми данными не трогаем, даже если они не из схемы.
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    var s = all[i];
    var isSchemaSheet = Object.prototype.hasOwnProperty.call(SCHEMA, s.getName());
    if (!isSchemaSheet && s.getLastRow() === 0 && ss.getSheets().length > 1) {
      ss.deleteSheet(s);
    }
  }

  var message = "Готово. Создано вкладок: " + created.length +
    (created.length ? " (" + created.join(", ") + ")" : "") +
    "; заголовки проставлены: " + filled.length + ".";
  Logger.log(message);
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(message, "Mifs Rent", 10);
  } catch (ignored) {
    // toast доступен не во всех контекстах запуска — не критично
  }
  return message;
}

// ---------------------------------------------------------------------
// Разовый импорт существующей инвентаризации — запустить один раз после setupSheets()
// ---------------------------------------------------------------------

// ID исходной таблицы с инвентаризацией (можно очистить после импорта).
// Берётся из её адреса: docs.google.com/spreadsheets/d/<ЭТОТ_КУСОК>/edit
var IMPORT_SOURCE_ID = "1Y9UR7whPZt8ONRId30TevI-Rid7VhiisWEogE30XbY4";

// Ключевые слова, по которым состояние считается неисправным / утерянным.
var IMPORT_BROKEN = ["не работает", "неработает", "ремонт", "разбит", "сломан",
                     "нельзя", "горелый", "заела", "треснут", "не включ"];
var IMPORT_LOST = ["потерян"];

/**
 * Переносит оборудование из старой таблицы-инвентаризации во вкладку Equipment.
 * Запускать после setupSheets(). Повторный запуск безопасен: позиции, которые
 * уже есть (по заводскому номеру, либо по названию+инвентарному номеру),
 * пропускаются, дубликатов не возникает.
 */
function importInventory() {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var source = SpreadsheetApp.openById(IMPORT_SOURCE_ID);
    var eqSheet = getSheet(SHEETS.EQUIPMENT);

    // Что уже импортировано. Метка источника («вкладка#строка») — единственный
    // надёжный признак: по названию дедуплицировать нельзя, у склада десятки
    // физически разных единиц с одинаковым названием и без серийника
    // (60 чайнаболлов, 30 октобоксов, 8 радиосистем).
    var seenSerial = {}, seenImport = {};
    readRows(eqSheet).forEach(function (r) {
      var s = importCleanSerial(r.serial_number);
      if (s) seenSerial[s] = true;
      var m = String(r.condition_notes || "").match(/Импорт:\s*([^/]+#\d+)/);
      if (m) seenImport[m[1].trim()] = true;
    });

    // Счётчики item_id читаем один раз и держим в памяти: 600+ обращений
    // к вкладке Meta по одному не уложились бы в лимит времени Apps Script.
    var metaSheet = getSheet(SHEETS.META);
    var metaRows = readRows(metaSheet);
    var counters = {}, metaRowIndex = {};
    metaRows.forEach(function (r) {
      counters[r.key] = Number(r.value) || 0;
      metaRowIndex[r.key] = r.__row;
    });

    var headers = SCHEMA.Equipment;
    var out = [];
    var stats = { merged: 0, alreadyImported: 0, byTab: {} };
    var now = new Date().toISOString();

    source.getSheets().forEach(function (sheet) {
      var tab = sheet.getName();
      var values = sheet.getDataRange().getValues();
      if (values.length < 2) return;

      var keys = importHeaderKeys(values[0]);
      var sectionRows = importMergedHeaderRows(sheet);

      for (var i = 1; i < values.length; i++) {
        // Строки-разделители групп («Камеры», «Объективы», «Godox SL300 R»).
        // Ловим двумя независимыми способами: как объединённые ячейки и как
        // строку, где одно и то же значение продублировано по всем колонкам —
        // в выгрузках такие строки выглядят по-разному.
        if (sectionRows[i + 1]) continue;
        if (importIsUniformRow(values[i])) continue;
        var row = {};
        for (var c = 0; c < keys.length; c++) row[keys[c]] = importTrim(values[i][c]);

        var name = row["Наименование"] || row["col0"] || row["Тип"] || "";
        var serial = importCleanSerial(row["Заводской номер"]);
        var inventory = row["Инвентарный номер"] || "";
        if (!name && !serial && !inventory) continue;
        if (!name) name = "[без названия] " + (serial || inventory);

        var importKey = tab + "#" + (i + 1);
        if (seenImport[importKey]) { stats.alreadyImported++; continue; }
        if (serial && seenSerial[serial]) { stats.merged++; continue; }
        if (serial) seenSerial[serial] = true;
        seenImport[importKey] = true;

        var statusCell = row["Состояние"] || (tab === "ЗВУК" ? row["col2"] : "");
        var st = importStatus(statusCell);
        var category = importCategory(row["Тип"] || "", tab, name);

        // Счётчик держим в памяти: 600+ обращений к вкладке Meta по одному
        // не уложились бы в лимит времени Apps Script.
        if (!counters["item_seq"] || counters["item_seq"] < ITEM_ID_START) counters["item_seq"] = ITEM_ID_START;
        counters["item_seq"] += 1;
        var itemId = String(counters["item_seq"]);

        var notes = [
          row["Комплектация"] || row["Комплектация 13.04 наличие"] || "",
          row["Примечания"] || "",
          st.note,
          row["Хранение"] ? "Хранение: " + row["Хранение"] : "",
          "Импорт: " + importKey,
        ].filter(function (x) { return x; }).join(" / ");

        var record = {
          item_id: itemId, name: name, category: category, serial_number: serial,
          inventory_number: inventory, status: st.status, condition_notes: notes,
          created_at: now, current_transaction_id: "",
        };
        out.push(headers.map(function (h) { return record[h] !== undefined ? record[h] : ""; }));
        stats.byTab[tab] = (stats.byTab[tab] || 0) + 1;
      }
    });

    // Запись одним махом — построчный appendRow на 600+ позиций слишком медленный
    if (out.length) {
      eqSheet.getRange(eqSheet.getLastRow() + 1, 1, out.length, headers.length).setValues(out);
    }

    // Сохраняем счётчики обратно в Meta
    for (var k in counters) {
      if (metaRowIndex[k]) updateRow(metaSheet, metaRowIndex[k], { value: counters[k] });
      else appendRow(metaSheet, { key: k, value: counters[k] });
    }

    var parts = [];
    for (var t in stats.byTab) parts.push(t + ": " + stats.byTab[t]);
    var message = "Импортировано позиций: " + out.length +
      " (" + parts.join(", ") + "). Склеено дублей по заводскому номеру: " + stats.merged +
      ". Пропущено (импортировано ранее): " + stats.alreadyImported + ".";
    Logger.log(message);
    try { SpreadsheetApp.getActiveSpreadsheet().toast(message, "Mifs Rent", 15); } catch (ignored) {}
    return message;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Очищает каталог и переносит инвентаризацию заново — нужно, если поменялась
 * схема ID или исправились правила разбора, а выдавать оборудование ещё не начали.
 *
 * Намеренно отказывается работать, когда в системе уже есть выдачи или дефекты:
 * их записи ссылаются на item_id, и перегенерация ID оставила бы историю
 * висеть на несуществующих позициях.
 */
function reimportInventory() {
  // Блокировку берём только на очистку и отпускаем до вызова importInventory:
  // тот берёт её сам, а вложенный захват той же блокировки повис бы до таймаута.
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var tx = readRows(getSheet(SHEETS.TRANSACTIONS));
    var defects = readRows(getSheet(SHEETS.DEFECTS));
    if (tx.length || defects.length) {
      var refuse = "Перезаливка отменена: в системе уже есть выдачи (" + tx.length +
        ") или дефекты (" + defects.length + "). Они ссылаются на ID предметов, " +
        "поэтому перегенерация ID сломала бы историю.";
      Logger.log(refuse);
      try { SpreadsheetApp.getActiveSpreadsheet().toast(refuse, "Mifs Rent", 15); } catch (ignored) {}
      return refuse;
    }

    var eqSheet = getSheet(SHEETS.EQUIPMENT);
    var lastRow = eqSheet.getLastRow();
    if (lastRow > 1) eqSheet.deleteRows(2, lastRow - 1);   // заголовок оставляем

    var metaSheet = getSheet(SHEETS.META);
    var metaLast = metaSheet.getLastRow();
    if (metaLast > 1) metaSheet.deleteRows(2, metaLast - 1);
  } finally {
    lock.releaseLock();
  }

  var message = "Каталог очищен. " + importInventory();
  Logger.log(message);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(message, "Mifs Rent", 15); } catch (ignored) {}
  return message;
}

function importTrim(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

// Заголовки исходной таблицы неровные: часть пустая, часть повторяется.
// Делаем ключи уникальными, иначе колонки затирают друг друга (так терялась вкладка ЗВУК).
function importHeaderKeys(headerRow) {
  var keys = [], used = {};
  for (var i = 0; i < headerRow.length; i++) {
    var h = importTrim(headerRow[i]);
    var key = (h && !used[h]) ? h : "col" + i;
    used[key] = true;
    keys.push(key);
  }
  return keys;
}

// Строки-разделители («Камеры», «Объективы») сделаны объединением ячеек на всю ширину.
function importMergedHeaderRows(sheet) {
  var rows = {};
  try {
    sheet.getDataRange().getMergedRanges().forEach(function (r) {
      if (r.getNumColumns() >= 3) rows[r.getRow()] = true;
    });
  } catch (ignored) {}
  return rows;
}

// Строка-заголовок группы: одно значение повторено в трёх и более колонках.
// У настоящей позиции колонки различаются (серийник, статус, заметки),
// поэтому порог в 3 совпадения её не заденет.
function importIsUniformRow(rowValues) {
  var filled = [];
  for (var i = 0; i < rowValues.length; i++) {
    var v = importTrim(rowValues[i]);
    if (v) filled.push(v);
  }
  if (filled.length < 3) return false;
  for (var j = 1; j < filled.length; j++) if (filled[j] !== filled[0]) return false;
  return true;
}

// "?", "2", "1" — это не серийники; по ним нельзя склеивать разные позиции.
function importCleanSerial(v) {
  var s = importTrim(v);
  return (s.length >= 5 && /\d/.test(s)) ? s : "";
}

function importStatus(cell) {
  var raw = importTrim(cell);
  var s = raw.toLowerCase();
  if (!s) return { status: "Available", note: "" };
  for (var i = 0; i < IMPORT_LOST.length; i++) {
    if (s.indexOf(IMPORT_LOST[i]) !== -1) return { status: "Retired", note: raw };
  }
  for (var j = 0; j < IMPORT_BROKEN.length; j++) {
    if (s.indexOf(IMPORT_BROKEN[j]) !== -1) return { status: "In Repair", note: raw };
  }
  if (s === "работает" || s === "найден" || s === "заменён") return { status: "Available", note: "" };
  return { status: "Available", note: raw };   // свободный текст сохраняем в заметках
}

function importCategory(tip, tab, name) {
  var t = (tip + " " + name).toLowerCase();
  if (tab === "ЗВУК") return "AUD";
  if (t.indexOf("объектив") !== -1 || t.indexOf("обьектив") !== -1 || t.indexOf("светофильтр") !== -1) return "LEN";
  if (t.indexOf("камера") !== -1 || t.indexOf("фотоаппарат") !== -1 || t.indexOf("фотоапарат") !== -1) return "CAM";
  if (t.indexOf("штатив") !== -1 || t.indexOf("клэмп") !== -1 || t.indexOf("обвес") !== -1 || t.indexOf("органайзер") !== -1) return "GRP";
  if (t.indexOf("монитор") !== -1 || t.indexOf("сендер") !== -1 || t.indexOf("радиофокус") !== -1) return "OTH";
  if (tab === "СВЕТ") return "LGT";
  var light = ["осветитель", "godox", "октобокс", "чайнабол", "nanlite", "модификатор", "софтбокс"];
  for (var i = 0; i < light.length; i++) if (t.indexOf(light[i]) !== -1) return "LGT";
  return "OTH";
}

// ---------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------

function doGet(e) {
  return ContentService
    .createTextOutput("Mifs Rent backend работает. Запросы принимаются через POST.")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return respond(envelope(false, null, "Некорректный запрос (не удалось разобрать JSON)", 400));
  }

  var endpoint = request.endpoint;
  var token = request.token || null;
  var payload = request.payload || {};

  try {
    var data;
    switch (endpoint) {
      case "/auth/login": data = handleAuthLogin(payload); break;
      case "/item/lookup": data = handleItemLookup(payload); break;
      case "/item/create": data = handleItemCreate(payload, token); break;
      case "/transaction/checkout": data = handleTransactionCheckout(payload, token); break;
      case "/transaction/checkin": data = handleTransactionCheckin(payload, token); break;
      case "/defect/report": data = handleDefectReport(payload, token); break;
      case "/defect/resolve": data = handleDefectResolve(payload, token); break;
      case "/equipment/list": data = handleEquipmentList(payload, token); break;
      case "/clients/list": data = handleClientsList(payload, token); break;
      case "/client/create": data = handleClientCreate(payload, token); break;
      case "/client/history": data = handleClientHistory(payload, token); break;
      case "/item/history": data = handleItemHistory(payload, token); break;
      case "/defects/list": data = handleDefectsList(payload, token); break;
      case "/staff/create": data = handleStaffCreate(payload, token); break;
      case "/staff/list": data = handleStaffList(payload, token); break;
      case "/staff/set-active": data = handleStaffSetActive(payload, token); break;
      default:
        throw apiError(404, "Неизвестный эндпоинт: " + endpoint);
    }
    return respond(envelope(true, data, null, 200));
  } catch (err) {
    if (err && err.isApiError) {
      return respond(envelope(false, null, err.message, err.status));
    }
    return respond(envelope(false, null, "Внутренняя ошибка сервера: " + (err && err.message ? err.message : err), 500));
  }
}

// ---------------------------------------------------------------------
// Хендлеры эндпоинтов
// ---------------------------------------------------------------------

function handleAuthLogin(payload) {
  var login = String(payload.login || "").trim().toLowerCase();
  var pin = String(payload.pin || "");
  if (!login || !pin) throw apiError(400, "Укажите логин и PIN");

  var sheet = getSheet(SHEETS.STAFF);
  var rows = readRows(sheet);
  var staffRow = null;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.login).trim().toLowerCase() === login && isTruthyCell(r.active)) {
      staffRow = r;
      break;
    }
  }
  var pinHash = hashPin(pin);
  if (!staffRow || String(staffRow.pin_hash) !== pinHash) {
    throw apiError(401, "Неверный логин или PIN");
  }

  var token = Utilities.getUuid();
  updateRow(sheet, staffRow.__row, {
    session_token: token,
    token_issued_at: new Date().toISOString(),
  });
  return { token: token, staff_id: staffRow.staff_id, full_name: staffRow.full_name, role: staffRow.role };
}

function handleItemLookup(payload) {
  var itemId = String(payload.item_id || "").trim();
  var sheet = getSheet(SHEETS.EQUIPMENT);
  var item = findRowByValue(sheet, "item_id", itemId);
  if (!item) throw apiError(404, "Предмет не найден");
  delete item.__row;

  var currentTransaction = null;
  if (item.current_transaction_id) {
    currentTransaction = findRowByValue(getSheet(SHEETS.TRANSACTIONS), "transaction_id", item.current_transaction_id);
    if (currentTransaction) delete currentTransaction.__row;
  }

  var openDefects = readRows(getSheet(SHEETS.DEFECTS))
    .filter(function (d) { return String(d.item_id) === itemId && d.status !== "Resolved"; })
    .map(function (d) { delete d.__row; return d; });

  var result = {};
  for (var key in item) result[key] = item[key];
  result.current_transaction = currentTransaction;
  result.open_defects = openDefects;
  return result;
}

function handleItemCreate(payload, token) {
  checkAuth(token);
  var category = String(payload.category || "OTH");
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var itemId = nextItemId();
    appendRow(getSheet(SHEETS.EQUIPMENT), {
      item_id: itemId,
      name: payload.name || "",
      category: category,
      serial_number: payload.serial_number || "",
      inventory_number: payload.inventory_number || "",
      status: "Available",
      condition_notes: payload.condition_notes || "",
      created_at: new Date().toISOString(),
      current_transaction_id: "",
    });
    return { item_id: itemId };
  } finally {
    lock.releaseLock();
  }
}

function handleTransactionCheckout(payload, token) {
  var staffRow = checkAuth(token);
  var itemId = String(payload.item_id || "").trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var eqSheet = getSheet(SHEETS.EQUIPMENT);
    var item = findRowByValue(eqSheet, "item_id", itemId);
    if (!item) throw apiError(404, "Предмет не найден");
    if (item.status !== "Available") throw apiError(409, "Предмет уже выдан или недоступен");

    var txId = nextId("transaction_id");
    appendRow(getSheet(SHEETS.TRANSACTIONS), {
      transaction_id: txId,
      item_id: itemId,
      client_id: payload.client_id,
      staff_out: staffRow.staff_id,
      staff_in: "",
      checked_out_at: new Date().toISOString(),
      expected_return_at: payload.expected_return_at || "",
      checked_in_at: "",
      status: "Open",
      notes: payload.notes || "",
    });
    updateRow(eqSheet, item.__row, { status: "Rented", current_transaction_id: txId });
    return { transaction_id: txId };
  } finally {
    lock.releaseLock();
  }
}

function handleTransactionCheckin(payload, token) {
  var staffRow = checkAuth(token);
  var itemId = String(payload.item_id || "").trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var eqSheet = getSheet(SHEETS.EQUIPMENT);
    var item = findRowByValue(eqSheet, "item_id", itemId);
    if (!item) throw apiError(404, "Предмет не найден");

    var txSheet = getSheet(SHEETS.TRANSACTIONS);
    var openTx = null;
    var txRows = readRows(txSheet);
    for (var i = 0; i < txRows.length; i++) {
      if (String(txRows[i].item_id) === itemId && txRows[i].status === "Open") { openTx = txRows[i]; break; }
    }
    if (!openTx) throw apiError(409, "Открытой выдачи для этого предмета не найдено");

    updateRow(txSheet, openTx.__row, {
      status: "Closed",
      checked_in_at: new Date().toISOString(),
      staff_in: staffRow.staff_id,
    });

    var defectId = null;
    var newStatus = "Available";
    if (payload.has_defect) {
      defectId = nextId("defect_id");
      appendRow(getSheet(SHEETS.DEFECTS), {
        defect_id: defectId,
        item_id: itemId,
        reported_by: staffRow.staff_id,
        related_transaction_id: openTx.transaction_id,
        description: payload.defect_description || "",
        severity: payload.defect_severity || "Minor",
        status: "Open",
        reported_at: new Date().toISOString(),
        resolved_at: "",
        resolution_notes: "",
      });
      newStatus = "In Repair";
    }
    updateRow(eqSheet, item.__row, { status: newStatus, current_transaction_id: "" });
    return { transaction_id: openTx.transaction_id, defect_id: defectId };
  } finally {
    lock.releaseLock();
  }
}

function handleDefectReport(payload, token) {
  var staffRow = checkAuth(token);
  var itemId = String(payload.item_id || "").trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var eqSheet = getSheet(SHEETS.EQUIPMENT);
    var item = findRowByValue(eqSheet, "item_id", itemId);
    if (!item) throw apiError(404, "Предмет не найден");

    var defectId = nextId("defect_id");
    appendRow(getSheet(SHEETS.DEFECTS), {
      defect_id: defectId,
      item_id: itemId,
      reported_by: staffRow.staff_id,
      related_transaction_id: "",
      description: payload.description || "",
      severity: payload.severity || "Minor",
      status: "Open",
      reported_at: new Date().toISOString(),
      resolved_at: "",
      resolution_notes: "",
    });
    if (payload.severity === "Out of Service") {
      updateRow(eqSheet, item.__row, { status: "In Repair" });
    }
    return { defect_id: defectId };
  } finally {
    lock.releaseLock();
  }
}

function handleDefectResolve(payload, token) {
  checkAuth(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var defSheet = getSheet(SHEETS.DEFECTS);
    var defect = findRowByValue(defSheet, "defect_id", payload.defect_id);
    if (!defect) throw apiError(404, "Дефект не найден");

    var newStatus = payload.status || "Resolved";
    var patch = { status: newStatus, resolution_notes: payload.resolution_notes || "" };
    if (newStatus === "Resolved") patch.resolved_at = new Date().toISOString();
    updateRow(defSheet, defect.__row, patch);

    if (newStatus === "Resolved") {
      var eqSheet = getSheet(SHEETS.EQUIPMENT);
      var item = findRowByValue(eqSheet, "item_id", defect.item_id);
      if (item) {
        var stillOpen = readRows(defSheet).some(function (d) {
          return String(d.item_id) === String(defect.item_id) &&
            d.status !== "Resolved" &&
            String(d.defect_id) !== String(defect.defect_id);
        });
        if (!stillOpen && item.status === "In Repair") {
          updateRow(eqSheet, item.__row, { status: "Available" });
        }
      }
    }
    return {};
  } finally {
    lock.releaseLock();
  }
}

function handleEquipmentList(payload, token) {
  checkAuth(token);
  var rows = readRows(getSheet(SHEETS.EQUIPMENT));
  if (payload.category && payload.category !== "all") {
    rows = rows.filter(function (r) { return r.category === payload.category; });
  }
  if (payload.status && payload.status !== "all") {
    rows = rows.filter(function (r) { return r.status === payload.status; });
  }
  return rows.map(function (r) {
    return {
      item_id: r.item_id, name: r.name, category: r.category, status: r.status,
      serial_number: r.serial_number, inventory_number: r.inventory_number,
    };
  });
}

function handleClientsList(payload, token) {
  checkAuth(token);
  return readRows(getSheet(SHEETS.CLIENTS)).map(function (r) { delete r.__row; return r; });
}

function handleClientCreate(payload, token) {
  checkAuth(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var clientId = nextId("client_id");
    appendRow(getSheet(SHEETS.CLIENTS), {
      client_id: clientId,
      client_name: payload.client_name || "",
      project_name: payload.project_name || "",
      phone: payload.phone || "",
      notes: payload.notes || "",
      created_at: new Date().toISOString(),
    });
    return { client_id: clientId };
  } finally {
    lock.releaseLock();
  }
}

function handleClientHistory(payload, token) {
  checkAuth(token);
  var rows = readRows(getSheet(SHEETS.TRANSACTIONS))
    .filter(function (t) { return String(t.client_id) === String(payload.client_id); })
    .map(function (t) { delete t.__row; return t; });
  return { transactions: rows };
}

function handleItemHistory(payload, token) {
  checkAuth(token);
  var itemId = String(payload.item_id || "").trim();
  var transactions = readRows(getSheet(SHEETS.TRANSACTIONS))
    .filter(function (t) { return String(t.item_id) === itemId; })
    .map(function (t) { delete t.__row; return t; });
  var defects = readRows(getSheet(SHEETS.DEFECTS))
    .filter(function (d) { return String(d.item_id) === itemId; })
    .map(function (d) { delete d.__row; return d; });
  return { transactions: transactions, defects: defects };
}

function handleDefectsList(payload, token) {
  checkAuth(token);
  var rows = readRows(getSheet(SHEETS.DEFECTS)).map(function (d) { delete d.__row; return d; });
  if (payload.status && payload.status !== "all") {
    rows = rows.filter(function (d) { return d.status === payload.status; });
  }
  return rows;
}

// --- Регистрация сотрудников: PIN хэшируется здесь, вручную считать не нужно ---

function handleStaffCreate(payload, token) {
  var login = String(payload.login || "").trim();
  var pin = String(payload.pin || "");
  if (!login || !pin) throw apiError(400, "Укажите логин и PIN");

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var sheet = getSheet(SHEETS.STAFF);
    var rows = readRows(sheet);
    var isBootstrap = rows.length === 0;
    if (!isBootstrap) {
      // Сюда попадают в двух случаях: админ добавляет сотрудника (нормально)
      // и кто-то повторно жмёт «создать первого администратора» на экране
      // входа, когда сотрудники уже заведены — во втором случае токена нет,
      // и общее «сессия недействительна» только запутает.
      if (!token) throw apiError(403, "Сотрудники уже есть, обратитесь к администратору");
      requireAdmin(token);
    }

    var loginLower = login.toLowerCase();
    var taken = rows.some(function (r) { return String(r.login).trim().toLowerCase() === loginLower; });
    if (taken) throw apiError(409, "Такой логин уже используется");

    var staffId = nextId("staff_id");
    appendRow(sheet, {
      staff_id: staffId,
      full_name: payload.full_name || login,
      login: login,
      pin_hash: hashPin(pin),
      telegram_id: payload.telegram_id || "",
      role: isBootstrap ? "Admin" : (payload.role || "Warehouse Staff"),
      active: true,
      session_token: "",
      token_issued_at: "",
    });
    return { staff_id: staffId };
  } finally {
    lock.releaseLock();
  }
}

function handleStaffList(payload, token) {
  requireAdmin(token);
  return readRows(getSheet(SHEETS.STAFF)).map(function (r) {
    return { staff_id: r.staff_id, full_name: r.full_name, login: r.login, role: r.role, active: isTruthyCell(r.active) };
  });
}

function handleStaffSetActive(payload, token) {
  requireAdmin(token);
  var sheet = getSheet(SHEETS.STAFF);
  var staffRow = findRowByValue(sheet, "staff_id", payload.staff_id);
  if (!staffRow) throw apiError(404, "Сотрудник не найден");
  updateRow(sheet, staffRow.__row, { active: !!payload.active });
  return {};
}

// ---------------------------------------------------------------------
// Общие хелперы
// ---------------------------------------------------------------------

function apiError(status, message) {
  var err = new Error(message);
  err.isApiError = true;
  err.status = status;
  return err;
}

function envelope(ok, data, error, status) {
  return { ok: ok, data: data, error: error, status: status };
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isTruthyCell(v) {
  return v === true || v === "TRUE" || v === "true" || v === 1;
}

function getSheet(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error("Не найдена вкладка '" + name + "'. Запустите функцию setupSheets() " +
      "в редакторе Apps Script — она создаст все нужные вкладки автоматически.");
  }
  return sheet;
}

function readRows(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = {};
    for (var c = 0; c < headers.length; c++) row[headers[c]] = values[i][c];
    row.__row = i + 1; // номер строки в листе (1-based, с учётом заголовка)
    rows.push(row);
  }
  return rows;
}

function findRowByValue(sheet, colName, value) {
  var rows = readRows(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][colName]) === String(value)) return rows[i];
  }
  return null;
}

function appendRow(sheet, rowObject) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) { return rowObject[h] !== undefined ? rowObject[h] : ""; });
  sheet.appendRow(row);
}

function updateRow(sheet, rowIndex, patchObject) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var range = sheet.getRange(rowIndex, 1, 1, headers.length);
  var values = range.getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (patchObject[headers[i]] !== undefined) values[i] = patchObject[headers[i]];
  }
  range.setValues([values]);
}

function nextId(key) {
  var sheet = getSheet(SHEETS.META);
  var row = findRowByValue(sheet, "key", key);
  var value = row ? Number(row.value) : 0;
  value += 1;
  if (row) {
    updateRow(sheet, row.__row, { value: value });
  } else {
    appendRow(sheet, { key: key, value: value });
  }
  return value;
}

// ID предмета — шестизначное число со сквозной нумерацией: 100001, 100002, ...
// Старт со 100000 гарантирует, что номер всегда ровно шесть цифр (запас до 999999).
// Категория в ID не кодируется — она лежит в отдельной колонке.
var ITEM_ID_START = 100000;

function nextItemId() {
  var sheet = getSheet(SHEETS.META);
  var row = findRowByValue(sheet, "key", "item_seq");
  var value = row ? Number(row.value) : ITEM_ID_START;
  if (!value || value < ITEM_ID_START) value = ITEM_ID_START;
  value += 1;
  if (row) updateRow(sheet, row.__row, { value: value });
  else appendRow(sheet, { key: "item_seq", value: value });
  return String(value);
}

function hashPin(pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pin), Utilities.Charset.UTF_8);
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    var h = b.toString(16);
    if (h.length < 2) h = "0" + h;
    hex += h;
  }
  return hex;
}

function checkAuth(token) {
  if (!token) throw apiError(401, "Сессия недействительна, войдите заново");
  var staffRow = findRowByValue(getSheet(SHEETS.STAFF), "session_token", token);
  if (!staffRow || !staffRow.session_token) throw apiError(401, "Сессия недействительна, войдите заново");
  var issuedAt = new Date(staffRow.token_issued_at).getTime();
  if (!issuedAt || Date.now() - issuedAt > SESSION_TTL_MS) {
    throw apiError(401, "Сессия истекла, войдите заново");
  }
  return staffRow;
}

function requireAdmin(token) {
  var staffRow = checkAuth(token);
  if (staffRow.role !== "Admin") {
    throw apiError(403, "Только администратор может добавлять сотрудников");
  }
  return staffRow;
}
