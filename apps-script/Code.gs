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
  MODELS: "Models",
  STAFF: "Staff",
  CLIENTS: "Clients",
  TRANSACTIONS: "Transactions",
  DEFECTS: "Defects",
  META: "Meta",
};

// Числовые коды категорий — первые две цифры номера предмета.
// Порядок менять нельзя: коды уже напечатаны на этикетках.
var CATEGORY_CODES = {
  CAM: "01",   // камеры
  LEN: "02",   // объективы
  LGT: "03",   // свет
  AUD: "04",   // звук
  GRP: "05",   // грип и штативы
  OTH: "06",   // прочее
  // Расходники и навес (мешки, скотч, гели) — учитываются количеством,
  // а не поштучно. Код занят заранее, чтобы он не сдвинулся, когда
  // этикетки уже напечатаны; правила учёта количества дорабатываются отдельно.
  CNS: "07",
};

// Единственное описание структуры таблицы: используется и при создании
// вкладок в setupSheets(), и как источник порядка колонок при записи строк.
var SCHEMA = {
  Equipment: ["item_id", "name", "category", "model_code", "serial_number", "inventory_number", "status", "condition_notes", "created_at", "current_transaction_id"],
  Models: ["category", "model_code", "model_name", "created_at"],
  Staff: ["staff_id", "full_name", "login", "pin_hash", "telegram_id", "role", "active", "session_token", "token_issued_at", "failed_attempts", "locked_until"],
  Clients: ["client_id", "client_name", "project_name", "phone", "notes", "created_at"],
  Transactions: ["transaction_id", "item_id", "client_id", "staff_out", "staff_out_name", "staff_in", "staff_in_name", "checked_out_at", "expected_return_at", "checked_in_at", "status", "notes"],
  Defects: ["defect_id", "item_id", "reported_by", "reported_by_name", "related_transaction_id", "description", "severity", "status", "reported_at", "resolved_at", "resolution_notes"],
  Meta: ["key", "value"],
};

// Колонки-идентификаторы храним как текст. Без этого Google Sheets приводит
// строку, похожую на число, к числу: "010101" становится 10101 и напечатанный
// QR перестаёт находиться, а серийник "007" теряет нули. Ссылки на предмет в
// выдачах и дефектах — по той же причине: иначе история не сходится с каталогом.
var TEXT_COLUMNS = {
  Equipment: ["item_id", "model_code", "serial_number", "inventory_number"],
  Models: ["model_code"],
  Transactions: ["item_id"],
  Defects: ["item_id"],
};

var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов, как в js/config.js

// PIN — всего 4 цифры, это 10 000 вариантов: без ограничения попыток его
// подобрали бы скриптом за минуты, а адрес бэкенда открыт всем.
var MAX_LOGIN_ATTEMPTS = 5;
var LOGIN_LOCK_MS = 15 * 60 * 1000;
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
  var extended = [];

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
    } else {
      // Лист уже с данными: дописываем только появившиеся в схеме колонки.
      // Без этого новое поле молча терялось бы при записи — строки
      // раскладываются по заголовкам, которых в листе ещё нет.
      var existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
        .map(function (h) { return String(h).trim(); });
      var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
      if (missing.length) {
        sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
        extended.push(name + " (+" + missing.join(", ") + ")");
      }
    }
  }

  // Текстовый формат для колонок с ведущими нулями — на всю существующую сетку,
  // чтобы ручной ввод прямо в таблице тоже не терял нули.
  for (var sheetName in TEXT_COLUMNS) {
    var target = ss.getSheetByName(sheetName);
    if (!target) continue;
    prepareRows(target, 1, target.getMaxRows ? target.getMaxRows() : 1000);
  }

  // Таблицы, где администратор был создан до появления отметки, закрываем
  // здесь: иначе достаточно очистить лист Staff, чтобы снова стать админом
  // без пароля.
  var staffSheet = ss.getSheetByName(SHEETS.STAFF);
  if (staffSheet && readRows(staffSheet).length && !metaGet("bootstrap_done")) {
    metaSet("bootstrap_done", "migrated:" + new Date().toISOString());
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
    "; заголовки проставлены: " + filled.length +
    (extended.length ? "; дописаны колонки: " + extended.join(", ") : "") + ".";
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
  // Структуру приводим в соответствие со схемой сами: если вкладка или колонка
  // появились в новой версии кода, полагаться на то, что setupSheets запустили
  // руками, нельзя — импорт упадёт на середине.
  setupSheets();
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
      // Только счётчики экземпляров. Раньше сюда попадали все ключи Meta, и
      // обратная запись превращала нечисловые значения в 0 — так затиралась
      // отметка bootstrap_done, то есть снова открывалось создание
      // администратора без пароля.
      var key = String(r.key);
      if (key.indexOf("unit_") !== 0) return;
      counters[key] = Number(r.value) || 0;
      metaRowIndex[key] = r.__row;
    });

    // Порядок колонок берём из самого листа: новые поля дописываются в конец,
    // поэтому позиция в SCHEMA не совпадает с позицией в таблице.
    var headers = sheetHeaders(eqSheet);
    var out = [];
    var stats = { merged: 0, alreadyImported: 0, byTab: {} };
    var now = new Date().toISOString();

    // Справочник моделей строим в памяти: на 600+ позиций обращаться к вкладке
    // Models на каждую строку слишком дорого по времени Apps Script.
    var modelSheet = getSheet(SHEETS.MODELS);
    var modelIndex = {};        // категория|нормализованное имя -> код модели
    var modelMax = {};          // категория -> максимальный занятый код
    var newModels = [];
    readRows(modelSheet).forEach(function (r) {
      modelIndex[r.category + "|" + normalizeModelName(r.model_name)] = Number(r.model_code);
      modelMax[r.category] = Math.max(modelMax[r.category] || 0, Number(r.model_code));
    });
    var overflow = [];

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

        // Модель: ищем среди уже известных по нормализованному названию,
        // иначе заводим новую и запоминаем, чтобы дописать во вкладку Models.
        var modelKey = category + "|" + normalizeModelName(name);
        var modelCode = modelIndex[modelKey];
        if (!modelCode) {
          modelCode = (modelMax[category] || 0) + 1;
          if (modelCode > 99) {
            overflow.push("моделей в категории " + category);
            continue;
          }
          modelMax[category] = modelCode;
          modelIndex[modelKey] = modelCode;
          // pad2 — чтобы код модели в справочнике выглядел так же, как в
          // каталоге и внутри номера предмета: "01", а не "1".
          newModels.push({ category: category, model_code: pad2(modelCode), model_name: name, created_at: now });
        }

        // Номер экземпляра внутри модели. Счётчики держим в памяти: 600+
        // обращений к вкладке Meta по одному не уложились бы в лимит времени.
        var unitKey = "unit_" + CATEGORY_CODES[category] + pad2(modelCode);
        counters[unitKey] = (counters[unitKey] || 0) + 1;
        if (counters[unitKey] > 99) {
          overflow.push(name + " (больше 99 экземпляров)");
          continue;
        }
        var itemId = buildItemId(category, modelCode, counters[unitKey]);

        var notes = [
          row["Комплектация"] || row["Комплектация 13.04 наличие"] || "",
          row["Примечания"] || "",
          st.note,
          row["Хранение"] ? "Хранение: " + row["Хранение"] : "",
          "Импорт: " + importKey,
        ].filter(function (x) { return x; }).join(" / ");

        var record = {
          item_id: itemId, name: name, category: category, model_code: pad2(modelCode),
          serial_number: serial, inventory_number: inventory, status: st.status,
          condition_notes: notes, created_at: now, current_transaction_id: "",
        };
        out.push(headers.map(function (h) { return record[h] !== undefined ? record[h] : ""; }));
        stats.byTab[tab] = (stats.byTab[tab] || 0) + 1;
      }
    });

    // Запись одним махом — построчный appendRow на 600+ позиций слишком медленный
    if (out.length) {
      var eqStart = eqSheet.getLastRow() + 1;
      prepareRows(eqSheet, eqStart, out.length);
      eqSheet.getRange(eqStart, 1, out.length, headers.length).setValues(out);
    }

    // Справочник моделей — тоже одной записью
    if (newModels.length) {
      var mHeaders = sheetHeaders(modelSheet);
      var mRows = newModels.map(function (m) {
        return mHeaders.map(function (h) { return m[h] !== undefined ? m[h] : ""; });
      });
      var mStart = modelSheet.getLastRow() + 1;
      prepareRows(modelSheet, mStart, mRows.length);
      modelSheet.getRange(mStart, 1, mRows.length, mHeaders.length).setValues(mRows);
    }

    // Сохраняем счётчики обратно в Meta
    for (var k in counters) {
      if (metaRowIndex[k]) updateRow(metaSheet, metaRowIndex[k], { value: counters[k] });
      else appendRow(metaSheet, { key: k, value: counters[k] });
    }

    var parts = [];
    for (var t in stats.byTab) parts.push(t + ": " + stats.byTab[t]);
    var message = "Импортировано позиций: " + out.length +
      " (" + parts.join(", ") + "). Моделей в справочнике: " + newModels.length +
      ". Склеено дублей по заводскому номеру: " + stats.merged +
      ". Пропущено (импортировано ранее): " + stats.alreadyImported + "." +
      (overflow.length ? " НЕ ПОМЕСТИЛОСЬ (кончились номера): " + overflow.join("; ") : "");
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
  // Сначала догоняем структуру до схемы — иначе очистка успеет удалить каталог,
  // а следующий же вызов getSheet() упадёт на вкладке, которой ещё нет,
  // и данные останутся стёртыми.
  setupSheets();
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

    // Чистим содержимое, а не удаляем строки: сетка после импорта имеет размер
    // ровно по данным, а Google Sheets не даёт удалить все незакреплённые
    // строки. Заодно сохраняются форматы колонок и это быстрее удаления сотен
    // строк. Заголовок (строка 1) остаётся на месте.
    [SHEETS.EQUIPMENT, SHEETS.MODELS].forEach(function (name) {
      var sheet = getSheet(name);
      var last = sheet.getLastRow();
      if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).clearContent();
    });

    // В Meta стираем только счётчики экземпляров (unit_*), которые пересоберёт
    // импорт. Остальное трогать нельзя: там счётчики staff_id, client_id,
    // transaction_id и defect_id, а сотрудники и клиенты перезаливку
    // переживают — сбросив счётчик, мы выдали бы новому сотруднику номер уже
    // работающего. Там же отметка bootstrap_done: стерев её, мы бы заново
    // открыли создание администратора без пароля.
    var metaSheet = getSheet(SHEETS.META);
    var keep = readRows(metaSheet).filter(function (row) {
      return String(row.key) && String(row.key).indexOf("unit_") !== 0;
    }).map(function (row) { return { key: row.key, value: row.value }; });
    var metaLast = metaSheet.getLastRow();
    if (metaLast > 1) metaSheet.getRange(2, 1, metaLast - 1, metaSheet.getLastColumn()).clearContent();
    keep.forEach(function (row) { appendRow(metaSheet, row); });
  } finally {
    lock.releaseLock();
  }

  var message = "Каталог очищен. " + importInventory();
  Logger.log(message);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(message, "Mifs Rent", 15); } catch (ignored) {}
  return message;
}

// ---------------------------------------------------------------------
// Архив журнала: выгрузка в файл и подрезка таблицы
// ---------------------------------------------------------------------

var ARCHIVE_FOLDER_NAME = "Mifs Rent — архив";

/**
 * Выгружает журнал (Transactions и Defects) в CSV-файлы на Google Диск.
 * Запускать перед подрезкой таблицы: без выгрузки подрезка откажется работать.
 * Ничего не удаляет — только сохраняет.
 */
function archiveJournal() {
  var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  var folders = DriveApp.getFoldersByName(ARCHIVE_FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(ARCHIVE_FOLDER_NAME);

  var saved = [];
  [SHEETS.TRANSACTIONS, SHEETS.DEFECTS].forEach(function (name) {
    var sheet = getSheet(name);
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return; // только заголовок — выгружать нечего
    var csv = values.map(function (row) {
      return row.map(csvCell).join(",");
    }).join("\n");
    var file = folder.createFile(name + "-" + stamp + ".csv", csv, MimeType.CSV);
    saved.push({ sheet: name, rows: values.length - 1, fileId: file.getId(), name: file.getName() });
  });

  // Отметку читает trimJournal: подрезать можно только то, что уже выгружено.
  metaSet("journal_archived_at", new Date().toISOString());
  metaSet("journal_archived_rows", saved.reduce(function (n, s) { return n + s.rows; }, 0));

  var message = saved.length
    ? "Журнал выгружен в папку «" + ARCHIVE_FOLDER_NAME + "»: " +
      saved.map(function (s) { return s.name + " (" + s.rows + " строк)"; }).join(", ")
    : "Журнал пуст, выгружать нечего.";
  Logger.log(message);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(message, "Mifs Rent", 15); } catch (ignored) {}
  return message;
}

function csvCell(value) {
  var text = value === null || value === undefined ? "" : String(value);
  // Кавычки, запятые и переводы строк ломают CSV, если не заэкранировать
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * Подрезает журнал: удаляет завершённые записи, оставляя работу в процессе.
 * Работает только после успешной выгрузки — иначе данные просто потерялись бы.
 * Незакрытые выдачи и неустранённые дефекты не трогает никогда.
 */
function trimJournal() {
  var archivedAt = metaGet("journal_archived_at");
  if (!archivedAt) {
    var refuse = "Подрезка отменена: журнал ни разу не выгружался. " +
      "Сначала запустите archiveJournal(), иначе данные будут потеряны безвозвратно.";
    Logger.log(refuse);
    try { SpreadsheetApp.getActiveSpreadsheet().toast(refuse, "Mifs Rent", 15); } catch (ignored) {}
    return refuse;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  var removed = { Transactions: 0, Defects: 0 };
  try {
    // Транзакции: удаляем только закрытые. Открытая выдача — техника на руках.
    removed.Transactions = trimSheetRows(getSheet(SHEETS.TRANSACTIONS), function (row) {
      return row.status === "Closed";
    });
    // Дефекты: удаляем только устранённые.
    removed.Defects = trimSheetRows(getSheet(SHEETS.DEFECTS), function (row) {
      return row.status === "Resolved";
    });
  } finally {
    lock.releaseLock();
  }

  // Отметку снимаем: следующая подрезка потребует новой выгрузки.
  metaSet("journal_archived_at", "");
  metaSet("journal_trimmed_at", new Date().toISOString());

  var message = "Журнал подрезан. Удалено: выдач " + removed.Transactions +
    ", дефектов " + removed.Defects + ". Незакрытые записи оставлены на месте. " +
    "Для следующей подрезки нужна новая выгрузка.";
  Logger.log(message);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(message, "Mifs Rent", 15); } catch (ignored) {}
  return message;
}

// Удаляет строки, подходящие под условие, снизу вверх — иначе номера строк
// съезжают по ходу удаления и удаляется не то, что выбрали.
function trimSheetRows(sheet, shouldRemove) {
  var rows = readRows(sheet);
  var doomed = rows.filter(shouldRemove).map(function (r) { return r.__row; });
  doomed.sort(function (a, b) { return b - a; });
  doomed.forEach(function (rowIndex) { sheet.deleteRow(rowIndex); });
  return doomed.length;
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
      case "/models/list": data = handleModelsList(payload, token); break;
      case "/model/create": data = handleModelCreate(payload, token); break;
      case "/clients/list": data = handleClientsList(payload, token); break;
      case "/client/create": data = handleClientCreate(payload, token); break;
      case "/client/history": data = handleClientHistory(payload, token); break;
      case "/item/history": data = handleItemHistory(payload, token); break;
      case "/defects/list": data = handleDefectsList(payload, token); break;
      case "/staff/create": data = handleStaffCreate(payload, token); break;
      case "/staff/list": data = handleStaffList(payload, token); break;
      case "/staff/set-active": data = handleStaffSetActive(payload, token); break;
      case "/staff/set-pin": data = handleStaffSetPin(payload, token); break;
      case "/staff/delete": data = handleStaffDelete(payload, token); break;
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
  // Ищем по логину независимо от активности: счётчик попыток надо вести и для
  // отключённого сотрудника, а наружу в обоих случаях отдаём одно и то же
  // «неверный логин или PIN», чтобы не подсказывать, какие логины существуют.
  var staffRow = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].login).trim().toLowerCase() === login) {
      staffRow = rows[i];
      break;
    }
  }

  if (staffRow) {
    var lockedUntil = staffRow.locked_until ? new Date(staffRow.locked_until).getTime() : 0;
    if (lockedUntil && lockedUntil > Date.now()) {
      var minutes = Math.ceil((lockedUntil - Date.now()) / 60000);
      throw apiError(429, "Слишком много неверных попыток. Вход заблокирован ещё на " +
        minutes + " мин.");
    }
  }

  var pinHash = hashPin(pin);
  var pinOk = staffRow && String(staffRow.pin_hash) === pinHash && isTruthyCell(staffRow.active);
  if (!pinOk) {
    if (staffRow) {
      var attempts = Number(staffRow.failed_attempts || 0) + 1;
      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        updateRow(sheet, staffRow.__row, {
          failed_attempts: 0,
          locked_until: new Date(Date.now() + LOGIN_LOCK_MS).toISOString(),
        });
      } else {
        updateRow(sheet, staffRow.__row, { failed_attempts: attempts });
      }
    }
    throw apiError(401, "Неверный логин или PIN");
  }

  var token = Utilities.getUuid();
  updateRow(sheet, staffRow.__row, {
    session_token: token,
    token_issued_at: new Date().toISOString(),
    failed_attempts: 0,
    locked_until: "",
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

function handleModelsList(payload, token) {
  checkAuth(token);
  var rows = readRows(getSheet(SHEETS.MODELS));
  if (payload.category && payload.category !== "all") {
    rows = rows.filter(function (r) { return r.category === payload.category; });
  }
  return rows.map(function (r) {
    // Наружу отдаём тот же вид, в котором код лежит в таблице и стоит внутри
    // номера предмета: "04". Иначе фронтенд и таблица говорят о модели
    // по-разному, и сравнение строкой однажды промахнётся.
    return { category: r.category, model_code: pad2(Number(r.model_code)), model_name: r.model_name };
  }).sort(function (a, b) { return String(a.model_name).localeCompare(String(b.model_name)); });
}

function handleModelCreate(payload, token) {
  checkAuth(token);
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var category = String(payload.category || "OTH");
    return findOrCreateModel(category, payload.model_name);
  } finally {
    lock.releaseLock();
  }
}

function handleItemCreate(payload, token) {
  checkAuth(token);
  var category = String(payload.category || "OTH");
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    // Модель можно передать кодом (выбор из списка) или названием (новая модель).
    var model = payload.model_code
      ? modelByCode(category, payload.model_code)
      : findOrCreateModel(category, payload.model_name || payload.name);
    var unit = nextUnitNumber(category, model.model_code);
    var itemId = buildItemId(category, model.model_code, unit);
    appendRow(getSheet(SHEETS.EQUIPMENT), {
      item_id: itemId,
      name: model.model_name,
      category: category,
      model_code: pad2(model.model_code),
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

    var txId = nextId("transaction_id", maxIdIn(getSheet(SHEETS.TRANSACTIONS), "transaction_id"));
    appendRow(getSheet(SHEETS.TRANSACTIONS), {
      transaction_id: txId,
      item_id: itemId,
      client_id: payload.client_id,
      staff_out: staffRow.staff_id,
      staff_out_name: staffRow.full_name,
      staff_in: "",
      staff_in_name: "",
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
      staff_in_name: staffRow.full_name,
    });

    var defectId = null;
    var newStatus = "Available";
    if (payload.has_defect) {
      defectId = nextId("defect_id", maxIdIn(getSheet(SHEETS.DEFECTS), "defect_id"));
      appendRow(getSheet(SHEETS.DEFECTS), {
        defect_id: defectId,
        item_id: itemId,
        reported_by: staffRow.staff_id,
        reported_by_name: staffRow.full_name,
        related_transaction_id: openTx.transaction_id,
        description: payload.defect_description || "",
        severity: payload.defect_severity || "Minor",
        status: "Open",
        reported_at: new Date().toISOString(),
        resolved_at: "",
        resolution_notes: "",
      });
      if (defectBlocksRental(payload.defect_severity || "Minor")) newStatus = "In Repair";
    }
    updateRow(eqSheet, item.__row, { status: newStatus, current_transaction_id: "" });
    return { transaction_id: openTx.transaction_id, defect_id: defectId };
  } finally {
    lock.releaseLock();
  }
}

// Одно правило для всех путей заявки о дефекте. Раньше приём с дефектом всегда
// уводил предмет в ремонт, а отдельная заявка — только при «не работает»: один и
// тот же дефект давал разный результат, и серьёзная поломка оставляла технику
// доступной к выдаче. Царапина снимать камеру с аренды не должна, а «серьёзный»
// и «не работает» — должны.
function defectBlocksRental(severity) {
  return severity === "Major" || severity === "Out of Service";
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

    var severity = payload.severity || "Minor";
    var defectId = nextId("defect_id", maxIdIn(getSheet(SHEETS.DEFECTS), "defect_id"));
    appendRow(getSheet(SHEETS.DEFECTS), {
      defect_id: defectId,
      item_id: itemId,
      reported_by: staffRow.staff_id,
      reported_by_name: staffRow.full_name,
      related_transaction_id: "",
      description: payload.description || "",
      severity: severity,
      status: "Open",
      reported_at: new Date().toISOString(),
      resolved_at: "",
      resolution_notes: "",
    });
    // Предмет на руках у клиента не трогаем — статус пересчитается при приёме;
    // списанный не возвращаем в оборот.
    var status = item.status;
    if (defectBlocksRental(severity) && status === "Available") {
      status = "In Repair";
      updateRow(eqSheet, item.__row, { status: status });
    }
    return { defect_id: defectId, status: status };
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
        // Считаем только дефекты, снимающие с выдачи: иначе одна непочиненная
        // царапина держала бы предмет в ремонте навсегда.
        var stillOpen = readRows(defSheet).some(function (d) {
          return String(d.item_id) === String(defect.item_id) &&
            d.status !== "Resolved" &&
            String(d.defect_id) !== String(defect.defect_id) &&
            defectBlocksRental(d.severity);
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
      model_code: r.model_code === "" ? "" : pad2(Number(r.model_code)),
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
    var clientId = nextId("client_id", maxIdIn(getSheet(SHEETS.CLIENTS), "client_id"));
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
    // Самозагрузка первого администратора — без токена, но ровно один раз за
    // жизнь таблицы: отметку в Meta не сотрёт даже очистка листа Staff. Иначе
    // достаточно было бы удалить строку сотрудника, чтобы путь «стань админом
    // без пароля» открылся снова, и узнать об этом было бы негде.
    // Если доступ администратора потерян, владелец таблицы удаляет строку
    // bootstrap_done на листе Meta — это осознанное действие, а не открытый
    // эндпоинт.
    var isBootstrap = rows.length === 0 && !metaGet("bootstrap_done");
    if (!isBootstrap) {
      if (!token) {
        throw apiError(403, rows.length
          ? "Сотрудники уже есть, обратитесь к администратору"
          : "Первый администратор уже создавался. Чтобы завести его заново, " +
            "удалите строку bootstrap_done на листе Meta.");
      }
      requireAdmin(token);
    }

    var loginLower = login.toLowerCase();
    var taken = rows.some(function (r) { return String(r.login).trim().toLowerCase() === loginLower; });
    if (taken) throw apiError(409, "Такой логин уже используется");

    var staffId = nextId("staff_id", maxIdIn(sheet, "staff_id"));
    if (isBootstrap) metaSet("bootstrap_done", new Date().toISOString());
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

// Полное удаление сотрудника. История при этом не страдает: в журнале рядом с
// номером лежит имя, поэтому «кто выдавал» читается и после удаления строки.
function handleStaffDelete(payload, token) {
  var me = requireAdmin(token);
  var sheet = getSheet(SHEETS.STAFF);
  var target = findRowByValue(sheet, "staff_id", payload.staff_id);
  if (!target) throw apiError(404, "Сотрудник не найден");

  if (String(target.staff_id) === String(me.staff_id)) {
    throw apiError(409, "Нельзя удалить самого себя");
  }
  // Иначе в систему стало бы невозможно войти как администратор.
  if (target.role === "Admin") {
    var admins = readRows(sheet).filter(function (r) {
      return r.role === "Admin" && isTruthyCell(r.active);
    });
    if (admins.length <= 1) throw apiError(409, "Это последний администратор, удалить нельзя");
  }

  sheet.deleteRow(target.__row);
  return { staff_id: target.staff_id, full_name: target.full_name };
}

// Смена PIN. Себе — с подтверждением текущего PIN (чтобы чужой человек не сменил
// его с незаблокированного телефона), сотруднику — только администратором.
// В обоих случаях старая сессия становится недействительной: тому, кому PIN
// сбросили, придётся войти заново.
function handleStaffSetPin(payload, token) {
  var me = checkAuth(token);
  var newPin = String(payload.pin || "").trim();
  if (!/^\d{4,6}$/.test(newPin)) throw apiError(400, "PIN — от 4 до 6 цифр");

  var sheet = getSheet(SHEETS.STAFF);
  var targetId = payload.staff_id === undefined || payload.staff_id === null || payload.staff_id === ""
    ? me.staff_id
    : payload.staff_id;
  var isSelf = String(targetId) === String(me.staff_id);

  var staffRow = isSelf ? me : findRowByValue(sheet, "staff_id", targetId);
  if (!staffRow) throw apiError(404, "Сотрудник не найден");

  if (isSelf) {
    // Именно 403, а не 401: сессия в порядке, неверен введённый текущий PIN.
    // На 401 клиент считает сессию протухшей и выбрасывает на экран входа —
    // человек терял бы сессию из-за опечатки.
    if (hashPin(String(payload.current_pin || "")) !== String(staffRow.pin_hash)) {
      throw apiError(403, "Текущий PIN указан неверно");
    }
  } else if (me.role !== "Admin") {
    throw apiError(403, "Менять PIN другому сотруднику может только администратор");
  }

  var patch = {
    pin_hash: hashPin(newPin),
    failed_attempts: 0,
    locked_until: "",
    session_token: "",
    token_issued_at: "",
  };
  var result = {};
  if (isSelf) {
    // Свою сессию продлеваем новым токеном, иначе человек сменил бы PIN и
    // тут же вылетел на экран входа.
    var fresh = Utilities.getUuid();
    patch.session_token = fresh;
    patch.token_issued_at = new Date().toISOString();
    result.token = fresh;
  }
  updateRow(sheet, staffRow.__row, patch);
  return result;
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

// Фактические заголовки листа — источник порядка колонок при любой записи.
function sheetHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
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
  // Пишем через диапазон, а не appendRow: строке нужно сначала выставить
  // текстовый формат, иначе новая строка за пределами сетки формат колонки не
  // наследует и "010208" уедет в число 10208.
  var target = sheet.getLastRow() + 1;
  prepareRows(sheet, target, 1);
  sheet.getRange(target, 1, 1, headers.length).setValues([row]);
}

// Подготовка строк под запись: доращивает сетку до нужного размера и ставит
// текстовый формат колонкам-идентификаторам. Оба шага обязательны именно перед
// записью: сетка после импорта имеет размер ровно по данным, а строка,
// появившаяся за её пределами, формат колонки не наследует — и "010104"
// превращается в число 10104. Позиции колонок берём из фактического заголовка:
// он может отличаться от порядка в схеме, если колонки досыпались к уже
// заполненному листу.
function prepareRows(sheet, startRow, numRows) {
  if (numRows < 1) return;
  var needed = startRow + numRows - 1;
  var max = sheet.getMaxRows();
  if (max < needed) sheet.insertRowsAfter(max, needed - max);

  var cols = TEXT_COLUMNS[sheet.getName()];
  if (!cols || !cols.length) return;
  var head = sheetHeaders(sheet);
  cols.forEach(function (colName) {
    var idx = head.indexOf(colName);
    if (idx === -1) return;
    sheet.getRange(startRow, idx + 1, numRows, 1).setNumberFormat("@");
  });
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

function maxIdIn(sheet, column) {
  return readRows(sheet).reduce(function (max, row) {
    var n = Number(row[column]);
    return n > max ? n : max;
  }, 0);
}

// Лист Meta — хранилище «ключ: значение» для счётчиков и отметок.
function metaGet(key) {
  var row = findRowByValue(getSheet(SHEETS.META), "key", key);
  return row ? row.value : "";
}

function metaSet(key, value) {
  var sheet = getSheet(SHEETS.META);
  var row = findRowByValue(sheet, "key", key);
  if (row) updateRow(sheet, row.__row, { value: value });
  else appendRow(sheet, { key: key, value: value });
}

// minimum — подстраховка: если счётчик в Meta потерялся, номер всё равно не
// совпадёт с уже существующим (сотрудников и клиентов перезаливка не удаляет).
function nextId(key, minimum) {
  var sheet = getSheet(SHEETS.META);
  var row = findRowByValue(sheet, "key", key);
  var value = Math.max(row ? Number(row.value) : 0, Number(minimum || 0));
  value += 1;
  if (row) {
    updateRow(sheet, row.__row, { value: value });
  } else {
    appendRow(sheet, { key: key, value: value });
  }
  return value;
}

// ID предмета — шесть цифр вида XXYYZZ:
//   XX — категория (см. CATEGORY_CODES), YY — модель внутри категории,
//   ZZ — порядковый номер экземпляра этой модели.
// Например 010201 = камера (01), модель Canon C70 (02), экземпляр первый (01).
function buildItemId(category, modelCode, unitNumber) {
  var cat = CATEGORY_CODES[category] || CATEGORY_CODES.OTH;
  return cat + pad2(modelCode) + pad2(unitNumber);
}

function pad2(n) {
  var s = String(n);
  while (s.length < 2) s = "0" + s;
  return s;
}

// Нормализуем название модели, чтобы «GODOX SL 300 R» и «Godox SL300 R»
// считались одной моделью: в реальных складских таблицах одна и та же вещь
// записана по-разному, и без этого модель разъехалась бы на два кода.
function normalizeModelName(name) {
  var s = String(name || "").toLowerCase();
  s = s.replace(/[\s\-_.]+/g, "");
  // кириллические двойники латиницы — частая причина «двух» одинаковых моделей
  s = s.replace(/с/g, "c").replace(/о/g, "o").replace(/р/g, "p")
       .replace(/е/g, "e").replace(/а/g, "a").replace(/х/g, "x")
       .replace(/в/g, "b").replace(/к/g, "k").replace(/м/g, "m")
       .replace(/т/g, "t").replace(/у/g, "y");
  return s;
}

// Следующий свободный код модели в категории (YY). 99 моделей на категорию.
function nextModelCode(category) {
  var rows = readRows(getSheet(SHEETS.MODELS));
  var used = {};
  var max = 0;
  rows.forEach(function (r) {
    if (r.category !== category) return;
    var code = Number(r.model_code);
    used[code] = true;
    if (code > max) max = code;
  });
  if (max >= 99) {
    throw apiError(409, "В категории закончились коды моделей (99). Нужна отдельная категория.");
  }
  return max + 1;
}

// Следующий номер экземпляра модели (ZZ). Счётчик не переиспользует номера:
// списанная единица не отдаёт свой номер следующей, иначе старая этикетка
// однажды указала бы на другую вещь.
function nextUnitNumber(category, modelCode) {
  var key = "unit_" + CATEGORY_CODES[category] + pad2(modelCode);
  var value = nextId(key);
  if (value > 99) {
    throw apiError(409, "У этой модели исчерпаны номера экземпляров (99). Заведите её как отдельную модель.");
  }
  return value;
}

function modelByCode(category, modelCode) {
  var rows = readRows(getSheet(SHEETS.MODELS));
  var code = Number(modelCode);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].category === category && Number(rows[i].model_code) === code) {
      return { model_code: code, model_name: rows[i].model_name };
    }
  }
  throw apiError(404, "Модель не найдена в справочнике");
}

// Находит модель по названию или заводит новую. Возвращает {model_code, model_name}.
function findOrCreateModel(category, modelName) {
  var name = String(modelName || "").trim();
  if (!name) throw apiError(400, "Укажите название модели");
  var needle = normalizeModelName(name);
  var rows = readRows(getSheet(SHEETS.MODELS));
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].category === category && normalizeModelName(rows[i].model_name) === needle) {
      return { model_code: Number(rows[i].model_code), model_name: rows[i].model_name };
    }
  }
  var code = nextModelCode(category);
  appendRow(getSheet(SHEETS.MODELS), {
    category: category, model_code: pad2(code), model_name: name, created_at: new Date().toISOString(),
  });
  return { model_code: code, model_name: name };
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
    throw apiError(403, "Действие доступно только администратору");
  }
  return staffRow;
}
