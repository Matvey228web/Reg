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
  CLIENTS: "Clients",          // legacy, см. комментарий к SCHEMA.Clients
  STUDENTS: "Students",
  ORDERS: "Orders",
  ORDER_ITEMS: "OrderItems",
  TRANSACTIONS: "Transactions",
  DEFECTS: "Defects",
  CATEGORIES: "Categories",
  INVENTORY: "Inventory",
  // Как читать чужую таблицу при импорте. Раньше и названия колонок, и правила
  // раскладки по категориям были прибиты в коде: чужая выгрузка с колонкой
  // «Название» вместо «Наименование» импортировалась пустой, и починить это
  // мог только тот, у кого открыт редактор Apps Script.
  IMPORT_MAP: "ImportMap",
  IMPORT_RULES: "ImportRules",
  META: "Meta",
};

// Значения по умолчанию для листа Categories. Сам справочник живёт в таблице
// (лист Categories) — оттуда его читает код и правит админка. Эти константы
// нужны при первом запуске и как запас, если лист опустел или побит.
//
// Числовой код — первые две цифры номера предмета. Менять его у категории, в
// которой уже есть техника, нельзя: номера напечатаны на этикетках.
// Состав справочника собран по тому, как каталог устроен у прокатных контор
// (Cameras / Lenses / Camera Support / Lighting / Grip & Electric / Monitors /
// Filters), и проверен на наших 628 позициях: при таком разборе «Другое»
// остаётся пустым, а «Свет» перестаёт быть корзиной из 203 позиций, где
// осветители лежат вперемешку с софтбоксами.
var CATEGORY_CODES = {
  CAM: "01",   // камеры
  LEN: "02",   // объективы
  LGT: "03",   // осветители (без модификаторов — они ниже)
  AUD: "04",   // звук
  GRP: "05",   // грип: мешки, флаги, струбцины, стойки
  OTH: "06",   // прочее
  // Расходники и навес (мешки, скотч, гели) — учитываются количеством,
  // а не поштучно. Код занят заранее, чтобы он не сдвинулся, когда
  // этикетки уже напечатаны; правила учёта количества дорабатываются отдельно.
  CNS: "07",
  SUP: "08",   // штативы, слайдеры, стедикамы
  MOD: "09",   // софтбоксы, октобоксы, чайнаболы, соты
  MON: "10",   // мониторы, беспроводное видео
  RIG: "11",   // клетки, матбоксы, радиофокус
  FLT: "12",   // фильтры
  PWR: "13",   // аккумуляторы, зарядки
  MED: "14",   // карты, ридеры, диски
};

// Названия для людей. Живут рядом с кодами только как умолчания для засева:
// после засева название правится в таблице и в админке.
// Категории, которые учитываются количеством, а не поштучно: у мешков, флагов и
// расходников нет и не будет личного номера — клеить QR на каждый сэндбэг никто
// не станет. Флаг живёт в таблице (колонка by_qty) и правится в «Настройках»;
// здесь — только значение при заведении категории.
var CATEGORY_BY_QTY = { GRP: true, CNS: true };

var CATEGORY_LABELS = {
  CAM: "Камеры",
  LEN: "Объективы",
  LGT: "Осветители",
  AUD: "Звук",
  GRP: "Грип",
  OTH: "Другое",
  CNS: "Расходники",
  SUP: "Штативы и поддержка",
  MOD: "Модификаторы света",
  MON: "Мониторы и видеотракт",
  RIG: "Обвес камеры",
  FLT: "Фильтры",
  PWR: "Питание",
  MED: "Носители",
};

// Единственное описание структуры таблицы: используется и при создании
// вкладок в setupSheets(), и как источник порядка колонок при записи строк.
var SCHEMA = {
  // qty / qty_out: для обычной техники это всегда 1 и 0 — строка описывает одну
  // физическую единицу. Для категорий с учётом количеством (мешки, флаги,
  // расходники) строка описывает всю кучу: qty штук всего, qty_out на руках.
  // Заводить сэндбэги по одному с личным QR никто не станет.
  Equipment: ["item_id", "name", "category", "model_code", "serial_number", "inventory_number", "status", "condition_notes", "created_at", "current_transaction_id", "qty", "qty_out"],
  Models: ["category", "model_code", "model_name", "created_at"],
  // Синонимы колонок исходной таблицы, через запятую. Проверяются по порядку,
  // первый совпавший выигрывает. Особые записи: colN — колонка по счёту
  // (col0 — первая), ВКЛАДКА:colN — то же, но только на этой вкладке.
  ImportMap: ["field", "aliases", "note"],
  // Правила раскладки по категориям. Проверяются сверху вниз, первое совпавшее
  // выигрывает — поэтому частные правила стоят выше общих. match: name — искать
  // в названии, type — в колонке «Тип», tab — имя вкладки целиком.
  ImportRules: ["category", "match", "keywords", "note"],
  Staff: ["staff_id", "full_name", "login", "pin_hash", "telegram_id", "role", "active", "session_token", "token_issued_at", "failed_attempts", "locked_until"],
  // Clients — предыдущая модель: справочник «клиент/проект», из которого
  // выбирали при выдаче. Заменён на Students + Orders (заказ приходит с сайта,
  // проект каждый раз новый). Лист и его эндпоинты оставлены, потому что на
  // client_id ссылаются старые строки журнала, а журнал мы не переписываем.
  Clients: ["client_id", "client_name", "project_name", "phone", "notes", "created_at"],

  // Арендатор. Повторяется от заказа к заказу, поэтому вынесен отдельно:
  // по нему видно историю. Опознаётся по телефону (см. normalizePhone).
  Students: ["student_id", "full_name", "phone", "tg_username", "created_at", "notes"],

  // Заказ с сайта. Персональных данных — минимум: даты рождения и адрес съёмок
  // отдельными колонками не раскладываются, они остаются внутри raw_text, где
  // их берёт печать акта и больше ничего.
  Orders: ["order_id", "order_no", "request_code", "student_id", "student_name",
           "student_phone", "student_tg", "is_adult", "guardian_name", "guardian_phone",
           "project", "issue_date", "return_date", "extra_input", "amount", "currency",
           "source_url", "status", "raw_text", "created_at", "created_by",
           "created_by_name", "closed_at"],

  // Строки состава заказа. Позиции на сайте названы моделями и идут с
  // количеством («4 x OSTERRIG SIRIUS 100CM»), а не нашими номерами, поэтому
  // строка и экземпляр — разные вещи: model_code сопоставляется с каталогом,
  // issued_qty считает, сколько из строки уже на руках.
  OrderItems: ["order_id", "line_no", "raw_name", "model_code", "category",
               "qty", "price", "total", "issued_qty", "note"],

  // qty / qty_in: сколько штук выдано этой записью и сколько уже вернули.
  // У поштучной техники это 1 и 0/1 — запись закрывается целиком.
  Transactions: ["transaction_id", "item_id", "client_id", "order_id", "order_line", "staff_out", "staff_out_name", "staff_in", "staff_in_name", "checked_out_at", "expected_return_at", "checked_in_at", "status", "notes", "qty", "qty_in"],
  Defects: ["defect_id", "item_id", "reported_by", "reported_by_name", "related_transaction_id", "description", "severity", "status", "reported_at", "resolved_at", "resolution_notes"],
  Categories: ["code", "num", "label", "by_qty", "created_at"],
  // Журнал сверок склада. Пишем только итог и расхождения, а не все 628
  // найденных позиций: строка «нашли то, что и ожидали» ничего не сообщает, а
  // лист пухнет на каждую сверку.
  Inventory: ["inventory_id", "kind", "item_id", "item_name", "expected_qty", "found_qty",
              "scope", "started_at", "finished_at", "staff_id", "staff_name"],
  Meta: ["key", "value"],
};

// Колонки-идентификаторы храним как текст. Без этого Google Sheets приводит
// строку, похожую на число, к числу: "010101" становится 10101 и напечатанный
// QR перестаёт находиться, а серийник "007" теряет нули. Ссылки на предмет в
// выдачах и дефектах — по той же причине: иначе история не сходится с каталогом.
// Номер заказа с сайта — десять цифр, а код заявки выглядит как
// "3288736:8358371482": длинное число уехало бы в экспоненту, а второе не число
// вовсе. Телефоны и ник — по той же причине (плюс «+» в начале). Даты держим
// строками "ГГГГ-ММ-ДД", чтобы Sheets не превращал их в дату со своим часовым
// поясом и день не сползал на соседний.
var TEXT_COLUMNS = {
  Equipment: ["item_id", "model_code", "serial_number", "inventory_number"],
  Categories: ["num"],
  Models: ["model_code"],
  Students: ["phone", "tg_username"],
  Orders: ["order_no", "request_code", "student_phone", "student_tg", "guardian_phone",
           "issue_date", "return_date"],
  OrderItems: ["model_code"],
  Transactions: ["item_id"],
  Defects: ["item_id"],
  // Журнал сверок: без этого номер 010101 записывался числом 10101 — ведущий
  // ноль съедала таблица, и поиск по номеру в журнале ничего не находил.
  Inventory: ["item_id"],
};

// Умолчания. Действующие значения живут в листе Meta и правятся в админке
// (см. SETTINGS_SPEC и getSettings) — здесь только то, с чего система стартует.
var SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

// Заполняет лист умолчаниями, если в нём нет ни одной строки данных.
function seedSheet(ss, name, rows) {
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() > 1 || !rows.length) return;
  var headers = sheetHeaders(sheet);
  var values = rows.map(function (r) {
    return headers.map(function (h) { return r[h] !== undefined ? r[h] : ""; });
  });
  prepareRows(sheet, 2, values.length);
  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
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

  // Карта колонок и правила категорий: засеваем только пустой лист. Если в нём
  // уже что-то есть — значит его правили руками, и затирать правку нельзя.
  seedSheet(ss, SHEETS.IMPORT_MAP, IMPORT_MAP_DEFAULTS);
  seedSheet(ss, SHEETS.IMPORT_RULES, IMPORT_RULES_DEFAULTS);

  // Справочник категорий засеваем умолчаниями при первом запуске. Существующие
  // номера предметов от этого не меняются: засеваем ровно те коды, по которым
  // они собраны.
  var catSheet = ss.getSheetByName(SHEETS.CATEGORIES);
  if (catSheet) {
    var now = new Date().toISOString();
    var existingRows = readRows(catSheet);
    var haveCode = {}, haveNum = {}, maxNum = 0;
    existingRows.forEach(function (r) {
      var c = String(r.code || "").trim();
      if (c) haveCode[c] = true;
      var n = Number(r.num);
      if (n) { haveNum[pad2(n)] = true; maxNum = Math.max(maxNum, n); }
    });

    // Категории из умолчаний, которых в листе ещё нет, дописываем. Раньше засев
    // работал только на пустом листе — то есть на уже работающей таблице новые
    // категории не появлялись вовсе, и добавлять их пришлось бы руками.
    // Номер берём свой, если он свободен: иначе он разошёлся бы с номерами
    // предметов, которые по нему собраны.
    var seeded = [];
    for (var code in CATEGORY_CODES) {
      if (haveCode[code]) continue;
      var num = CATEGORY_CODES[code];
      if (haveNum[num]) {
        maxNum += 1;
        num = pad2(maxNum);
      } else {
        maxNum = Math.max(maxNum, Number(num));
      }
      haveNum[num] = true;
      seeded.push({
        code: code, num: num, label: CATEGORY_LABELS[code] || code,
        by_qty: CATEGORY_BY_QTY[code] ? "TRUE" : "FALSE",
        created_at: now,
      });
    }

    if (seeded.length) {
      var catHeaders = sheetHeaders(catSheet);
      var catStart = catSheet.getLastRow() + 1;
      if (catStart < 2) catStart = 2;
      prepareRows(catSheet, catStart, seeded.length);
      catSheet.getRange(catStart, 1, seeded.length, catHeaders.length).setValues(
        seeded.map(function (row) {
          return catHeaders.map(function (h) { return row[h] !== undefined ? row[h] : ""; });
        }));
      filled.push(SHEETS.CATEGORIES + " (+" + seeded.length + ")");
    }
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

// Умолчания для листа ImportMap: как называются колонки в нашей исходной
// таблице. Засеваются один раз, дальше правятся прямо в таблице.
var IMPORT_MAP_DEFAULTS = [
  { field: "name", aliases: "Наименование, Название, Оборудование, col0, Тип",
    note: "Название позиции. col0 — первая колонка, если заголовка нет" },
  { field: "serial_number", aliases: "Заводской номер, Серийный номер, Serial, S/N",
    note: "Заводской номер" },
  { field: "inventory_number", aliases: "Инвентарный номер, Инв. номер, Инв номер",
    note: "Инвентарный номер колледжа" },
  { field: "type", aliases: "Тип, Категория",
    note: "Тип — по нему тоже определяется категория" },
  { field: "status", aliases: "Состояние, Статус, ЗВУК:col2",
    note: "Состояние. ЗВУК:col2 — на вкладке ЗВУК заголовка нет, состояние в третьей колонке" },
  { field: "kit", aliases: "Комплектация, Комплектация 13.04 наличие",
    note: "Комплектация — уходит в примечания" },
  { field: "notes", aliases: "Примечания, Комментарий", note: "Примечания" },
  { field: "storage", aliases: "Хранение", note: "Где лежит — уходит в примечания" },
];

// Умолчания для листа ImportRules — ровно та раскладка, что была прибита в
// коде и вычитана на 628 строках (CATEGORIES.md). Порядок важен: первое
// совпавшее правило выигрывает, поэтому частные стоят выше общих.
var IMPORT_RULES_DEFAULTS = [
  { category: "FLT", match: "name", keywords: "фильтр, b+w, поляриз, clear mrc" },
  { category: "FLT", match: "type", keywords: "светофильтр" },
  { category: "MON", match: "name", keywords: "tvlogic, swit, accsoon, cineview, монитор, сендер" },
  { category: "RIG", match: "name", keywords: "nucleus, tilta, матбокс, клетка, cage, follow focus, радиофокус" },
  { category: "MOD", match: "name", keywords: "чайнабол, октобокс, софтбокс, sb-ufw, cs-85, vsa-, соты, зонт, рассеиват, шторки, рефлектор" },
  { category: "SUP", match: "name", keywords: "штатив, greenbean, videomaster, hdv elite, слайдер, стедикам, гимбал, монопод, easyrig" },
  { category: "PWR", match: "name", keywords: "аккумулятор, зарядк, np-f, v-mount, блок питания, удлинител" },
  { category: "MED", match: "name", keywords: "карта памяти, cfexpress, ридер, card reader, ssd, накопител" },
  { category: "GRP", match: "name", keywords: "мешок, sandbag, флаг, струбцин, clamp, пена, стойка, журавл" },
  { category: "AUD", match: "tab", keywords: "ЗВУК" },
  { category: "AUD", match: "name", keywords: "hollyland, tascam, тascam, петличк, рекордер, микрофон, радиосистем" },
  // «sony a7», а не просто «a7»: двух символов слишком мало, они найдутся в
  // середине чужого названия и утащат в камеры что попало.
  { category: "CAM", match: "name", keywords: "burano, pyxis, blackmagic, ilce, ilme, fx-3, fx3, fx6, xa-60, c70, pmw, red one, komodo, alexa, sony a7, sony а7, камера, фотоаппарат, фотоапарат" },
  { category: "CAM", match: "type", keywords: "камера, фотоаппарат, фотоапарат" },
  { category: "LEN", match: "name", keywords: "объектив, обьектив, zenit, samyang, dzofilm, illumina, sigma, tamron, canon rf, canon ef, zenitar, selena, helios, mm" },
  { category: "LEN", match: "type", keywords: "объектив, обьектив" },
  { category: "LGT", match: "tab", keywords: "СВЕТ" },
  { category: "LGT", match: "name", keywords: "godox, nanlite, forza, осветител, knowled, aputure" },
];

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
  // Конфигурацию перечитываем: её могли поправить в таблице между запусками.
  IMPORT_CONFIG = null;
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var sourceId = importSourceId();
    var source;
    try {
      source = SpreadsheetApp.openById(sourceId);
    } catch (openErr) {
      // Без этого Apps Script says только «Unexpected error while getting the
      // method or property openById», и непонятно, что виноват один id.
      throw apiError(400, "Не удалось открыть исходную таблицу по идентификатору «" +
        sourceId + "». Проверьте «Идентификатор исходной таблицы для импорта» в " +
        "настройках приложения: он берётся из адреса таблицы между /d/ и /edit, " +
        "и у этого аккаунта должен быть к ней доступ.");
    }
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
    var stats = { merged: 0, alreadyImported: 0, noName: 0, byTab: {} };
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

        var name = importField(row, keys, tab, "name");
        var serial = importCleanSerial(importField(row, keys, tab, "serial_number"));
        var inventory = importField(row, keys, tab, "inventory_number");
        if (!name && !serial && !inventory) continue;
        // Пустое название на всей вкладке — верный признак, что ImportMap не
        // подходит этой таблице. Считаем и говорим об этом в отчёте, иначе
        // импорт молча заведёт шестьсот «[без названия]».
        if (!name) { stats.noName++; name = "[без названия] " + (serial || inventory); }
        // Сводим известные синонимы к одному имени до того, как по имени будут
        // определены категория и модель: иначе один аппарат разъедется на две
        // модели с разными блоками номеров.
        name = canonicalModelName(name);

        var importKey = tab + "#" + (i + 1);
        if (seenImport[importKey]) { stats.alreadyImported++; continue; }
        if (serial && seenSerial[serial]) { stats.merged++; continue; }
        if (serial) seenSerial[serial] = true;
        seenImport[importKey] = true;

        var st = importStatus(importField(row, keys, tab, "status"));
        var category = importCategory(importField(row, keys, tab, "type"), tab, name);

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
        var unitKey = "unit_" + categoryNum(category) + pad2(modelCode);
        counters[unitKey] = (counters[unitKey] || 0) + 1;
        if (counters[unitKey] > 99) {
          overflow.push(name + " (больше 99 экземпляров)");
          continue;
        }
        var itemId = buildItemId(category, modelCode, counters[unitKey]);

        var storage = importField(row, keys, tab, "storage");
        var notes = [
          importField(row, keys, tab, "kit"),
          importField(row, keys, tab, "notes"),
          st.note,
          storage ? "Хранение: " + storage : "",
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
      (stats.noName ? " БЕЗ НАЗВАНИЯ: " + stats.noName +
        " — похоже, колонка с названием называется иначе; поправьте лист ImportMap." : "") +
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

// Категория предмета при импорте — по НАЗВАНИЮ и вкладке исходной таблицы.
//
// Примечания сюда не входят намеренно, и это не мелочь: в них пишут «нужна
// клетка», «аккумулятор в комплекте», «нужен фильтр» — по ним камера уезжала в
// обвес, а объектив в питание. Проверено на живых данных: разбор по примечаниям
// отправил 76 камер в «Другое».
//
// Порядок правил — от частного к общему: «Godox SB-UFW120» это софтбокс, а не
// осветитель, хотя Godox делает и то и другое.
// Конфигурация импорта читается один раз за запуск: importCategory зовётся на
// каждую из 600+ строк, и лезть в таблицу на каждую было бы дороже самого
// импорта.
var IMPORT_CONFIG = null;

function importConfig() {
  if (IMPORT_CONFIG) return IMPORT_CONFIG;
  IMPORT_CONFIG = { fields: {}, rules: [] };

  readRows(getSheet(SHEETS.IMPORT_MAP)).forEach(function (r) {
    var field = String(r.field || "").trim();
    if (!field) return;
    IMPORT_CONFIG.fields[field] = splitList(r.aliases);
  });
  readRows(getSheet(SHEETS.IMPORT_RULES)).forEach(function (r) {
    var category = String(r.category || "").trim().toUpperCase();
    var words = splitList(r.keywords);
    if (!category || !words.length) return;
    IMPORT_CONFIG.rules.push({
      category: category,
      match: String(r.match || "name").trim().toLowerCase(),
      keywords: words.map(function (w) { return w.toLowerCase(); }),
    });
  });
  return IMPORT_CONFIG;
}

function splitList(value) {
  return String(value || "").split(",").map(function (x) { return x.trim(); })
    .filter(function (x) { return x; });
}

// Значение поля в строке исходной таблицы по списку синонимов из ImportMap.
// keys — заголовки этой вкладки в том виде, как их вернул importHeaderKeys.
function importField(row, keys, tab, field) {
  var aliases = importConfig().fields[field] || [];
  for (var i = 0; i < aliases.length; i++) {
    var alias = aliases[i];
    // «ВКЛАДКА:colN» — синоним, действующий только на одной вкладке: в нашей
    // выгрузке у «ЗВУК» нет заголовков вовсе, а на других вкладках третья
    // колонка означает совсем другое.
    var scoped = alias.indexOf(":");
    if (scoped !== -1) {
      if (alias.slice(0, scoped).trim().toUpperCase() !== String(tab).trim().toUpperCase()) continue;
      alias = alias.slice(scoped + 1).trim();
    }
    if (keys.indexOf(alias) === -1) continue;
    var value = row[alias];
    if (value) return value;
  }
  return "";
}

// Категория по правилам из листа ImportRules: сверху вниз, первое совпавшее
// выигрывает. Раньше это был столбик if-ов в коде — поменять раскладку мог
// только тот, у кого открыт редактор Apps Script.
function importCategory(tip, tab, name) {
  var haystacks = {
    name: String(name || "").toLowerCase(),
    type: String(tip || "").toLowerCase(),
  };
  var tabName = String(tab || "").trim().toLowerCase();
  var rules = importConfig().rules;
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (rule.match === "tab") {
      if (rule.keywords.indexOf(tabName) !== -1) return rule.category;
      continue;
    }
    var haystack = haystacks[rule.match];
    if (haystack === undefined) continue;
    if (has(haystack, rule.keywords)) return rule.category;
  }
  return "OTH";
}

function has(haystack, needles) {
  for (var i = 0; i < needles.length; i++) {
    if (haystack.indexOf(needles[i]) !== -1) return true;
  }
  return false;
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
      // Публичные маршруты — единственные без checkAuth: их зовёт сайт проката,
      // где посетитель не входит в систему. Защита от перебора лежит на Worker
      // перед таблицей (кэш и ограничение частоты); сюда наружу не уходит
      // ничего, по чему можно опознать конкретную единицу техники.
      case "/public/catalog": data = handlePublicCatalog(payload); break;
      case "/item/lookup": data = handleItemLookup(payload, token); break;
      case "/item/create": data = handleItemCreate(payload, token); break;
      case "/item/numbers": data = handleItemNumbers(payload, token); break;
      case "/transaction/checkout": data = handleTransactionCheckout(payload, token); break;
      case "/transaction/checkin": data = handleTransactionCheckin(payload, token); break;
      case "/defect/report": data = handleDefectReport(payload, token); break;
      case "/defect/resolve": data = handleDefectResolve(payload, token); break;
      case "/equipment/list": data = handleEquipmentList(payload, token); break;
      case "/models/list": data = handleModelsList(payload, token); break;
      case "/model/create": data = handleModelCreate(payload, token); break;
      case "/order/parse": data = handleOrderParse(payload, token); break;
      case "/order/create": data = handleOrderCreate(payload, token); break;
      case "/orders/list": data = handleOrdersList(payload, token); break;
      case "/order/card": data = handleOrderCard(payload, token); break;
      case "/order/update": data = handleOrderUpdate(payload, token); break;
      case "/order/line-update": data = handleOrderLineUpdate(payload, token); break;
      case "/students/list": data = handleStudentsList(payload, token); break;
      case "/student/history": data = handleStudentHistory(payload, token); break;
      // Ниже — предыдущая модель «клиент/проект». Осталась ради старых строк
      // журнала, новый интерфейс ей не пользуется.
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
      case "/staff/set-role": data = handleStaffSetRole(payload, token); break;
      case "/staff/transfer-owner": data = handleStaffTransferOwner(payload, token); break;
      case "/notify/test": data = handleNotifyTest(payload, token); break;
      case "/labels/send": data = handleLabelsSend(payload, token); break;
      case "/model/move": data = handleModelMove(payload, token); break;
      case "/notify/overdue": data = handleNotifyOverdue(payload, token); break;
      case "/inventory/save": data = handleInventorySave(payload, token); break;
      case "/inventory/list": data = handleInventoryList(payload, token); break;
      case "/settings/get": data = handleSettingsGet(payload, token); break;
      case "/settings/set": data = handleSettingsSet(payload, token); break;
      case "/category/create": data = handleCategoryCreate(payload, token); break;
      case "/category/update": data = handleCategoryUpdate(payload, token); break;
      case "/maintenance": data = handleMaintenance(payload, token); break;
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
      var limits = getSettings();
      var attempts = Number(staffRow.failed_attempts || 0) + 1;
      if (attempts >= limits.max_login_attempts) {
        updateRow(sheet, staffRow.__row, {
          failed_attempts: 0,
          locked_until: new Date(Date.now() + limits.login_lock_minutes * 60 * 1000).toISOString(),
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
  // Настройки и категории отдаём сразу здесь: бэкенд отвечает 5–8 секунд, и
  // отдельный запрос за ними на каждом экране стоил бы этих секунд заново.
  return {
    token: token,
    staff_id: staffRow.staff_id,
    full_name: staffRow.full_name,
    role: staffRow.role,
    is_owner: isOwnerId(staffRow.staff_id),
    settings: getSettings(),
    categories: categories(),
  };
}

// Токен обязателен. Раньше его тут не спрашивали, и это была дыра: адрес
// веб-приложения не секрет — он лежит в js/config.js и уезжает в браузер
// каждому, — а номера шестизначные и напечатаны на этикетках открыто. То есть
// кто угодно мог перебрать 010101, 010102… и вычитать весь склад вместе с тем,
// кто что взял и какие заметки оставил. Оба наших вызова идут после входа,
// и токен у них есть всегда.
function handleItemLookup(payload, token) {
  checkAuth(token);
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
  // Позиции, заведённые до появления количества, читаются как «одна штука»:
  // пустая ячейка не должна означать «ноль на складе».
  result.qty = itemQty(item);
  result.qty_out = Number(item.qty_out || 0);
  result.qty_free = result.qty - result.qty_out;
  result.by_qty = categoryByQty(item.category);
  return result;
}

// Исправление заводского и инвентарного номера у конкретной вещи.
//
// Зачем эндпоинт, а не правка в таблице руками: опечатку в номере находят уже
// после того, как вещь заведена, и в таблице её «поправят» в любой ячейке —
// в том числе в соседней строке или у другой вещи. Здесь же правка идёт по
// номеру вещи, под замком, и проверяется на главное — что такой номер не
// занят кем-то ещё.
//
// Почему проверка на занятость обязательна: по этим номерам технику ищут,
// когда она пропала, а повторный импорт исходной таблицы считает одинаковый
// заводской номер одной и той же вещью (см. seenSerial в importInventory) и
// вторую строку молча пропускает. То есть дубль — это не «некрасиво», а
// потерянная единица техники.
//
// Номер вещи (item_id) здесь не меняется: он собран из категории и модели, и
// меняется только переносом модели (/model/move) — иначе номер разойдётся с
// содержимым.
function handleItemNumbers(payload, token) {
  requireAdmin(token);
  var itemId = String(payload.item_id || "").trim();
  if (!itemId) throw apiError(400, "Не сказано, какой вещи править номера");

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var sheet = getSheet(SHEETS.EQUIPMENT);
    var rows = readRows(sheet);
    var item = null;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].item_id) === itemId) { item = rows[i]; break; }
    }
    if (!item) throw apiError(404, "Предмет не найден");

    // У позиции с учётом количеством одна строка на всю полку: личного номера
    // у неё нет по устройству, и заводской номер на ней означал бы, что вся
    // полка — одна вещь.
    if (categoryByQty(item.category)) {
      throw apiError(409, "Это позиция с учётом количеством — одна строка на всю " +
        "полку. Личных номеров у неё нет, вписывать их некуда.");
    }

    // Пришло только то, что прислали: пустая строка — это «стереть», а
    // отсутствие поля — «не трогать». Иначе правка одного номера обнуляла бы
    // второй.
    var next = {};
    ["serial_number", "inventory_number"].forEach(function (field) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) return;
      // Только пробелы по краям: чистилку импорта (importCleanSerial) здесь
      // применять нельзя — она выбрасывает всё короче пяти знаков и без цифр,
      // а человек, вписывающий номер руками, вписывает его осознанно.
      next[field] = String(payload[field] == null ? "" : payload[field]).trim();
    });
    if (!Object.prototype.hasOwnProperty.call(next, "serial_number") &&
        !Object.prototype.hasOwnProperty.call(next, "inventory_number")) {
      throw apiError(400, "Нечего править: ни заводского, ни инвентарного номера не прислано");
    }

    var LABELS = { serial_number: "заводской", inventory_number: "инвентарный" };
    for (var field in next) {
      if (!next[field]) continue;
      var taken = rows.filter(function (r) {
        return String(r.item_id) !== itemId &&
               String(r[field] || "").trim().toLowerCase() === next[field].toLowerCase();
      })[0];
      if (taken) {
        throw apiError(409, "Такой " + LABELS[field] + " номер уже стоит у вещи " +
          String(taken.item_id) + " («" + String(taken.name || "") + "»). Два одинаковых " +
          "номера — это потерянная вещь: по ним ищут технику, и повторный импорт " +
          "считает их одной и той же.");
      }
    }

    var changed = {};
    for (var f in next) {
      if (String(item[f] || "") !== next[f]) changed[f] = { was: String(item[f] || ""), now: next[f] };
    }
    if (Object.keys(changed).length) updateRow(sheet, item.__row, next);

    return {
      item_id: itemId,
      name: String(item.name || ""),
      serial_number: Object.prototype.hasOwnProperty.call(next, "serial_number")
        ? next.serial_number : String(item.serial_number || ""),
      inventory_number: Object.prototype.hasOwnProperty.call(next, "inventory_number")
        ? next.inventory_number : String(item.inventory_number || ""),
      changed: changed,
    };
  } finally {
    lock.releaseLock();
  }
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

// Перенос модели в другую категорию.
//
// Правила раскладки при импорте угадывают категорию по словам в названии, и
// часть моделей оседает не там. Поправить это в таблице руками нельзя: номер
// вещи XXYYZZ начинается с номера категории, и правка одной ячейки рассогласует
// номер с содержимым.
//
// Поэтому переносим С ПЕРЕНУМЕРАЦИЕЙ: вещи получают номера новой категории, и
// номер остаётся честным. Это возможно только пока этикетки не напечатаны —
// напечатанная этикетка со старым номером после такого переноса врёт. Когда
// печать начнётся, здесь понадобится развилка «сохранить номера или
// перенумеровать»; сейчас её нет намеренно, чтобы не давать выбор, за которым
// стоит молчаливая порча данных.
//
// Номер вещи — ссылка: на него смотрят журнал выдач, дефекты и сверки. Поэтому
// переписываем и их, иначе у вещи отвяжется вся история.
function handleModelMove(payload, token) {
  requireAdmin(token);
  var from = String(payload.category || "").trim().toUpperCase();
  var to = String(payload.to_category || "").trim().toUpperCase();
  var code = payload.model_code;

  if (!from || !to) throw apiError(400, "Укажите, какую модель и куда переносим");
  if (from === to) throw apiError(400, "Модель уже в этой категории");

  var cats = categories();
  var fromCat = null;
  var toCat = null;
  cats.forEach(function (c) {
    if (c.code === from) fromCat = c;
    if (c.code === to) toCat = c;
  });
  if (!fromCat) throw apiError(404, "Категория, из которой переносим, не найдена");
  if (!toCat) throw apiError(404, "Категория, в которую переносим, не найдена");

  // Способ учёта должен совпадать. То же правило, что в handleCategoryUpdate:
  // поштучная модель в категории «количеством» молча превратилась бы в «одну
  // штуку из кучи», и обратно это уже не разобрать.
  if (isTruthyCell(fromCat.by_qty) !== isTruthyCell(toCat.by_qty)) {
    throw apiError(409, "У категорий разный способ учёта: одна считается " +
      "количеством, другая — поштучно. Перенос превратил бы поштучные записи " +
      "в количество или наоборот, и разобрать это обратно было бы нечем.");
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var modelsSheet = getSheet(SHEETS.MODELS);
    var modelRows = readRows(modelsSheet);
    var source = null;
    for (var i = 0; i < modelRows.length; i++) {
      if (modelRows[i].category === from && pad2(Number(modelRows[i].model_code)) === pad2(Number(code))) {
        source = modelRows[i];
        break;
      }
    }
    if (!source) throw apiError(404, "Модель не найдена в этой категории");

    // Была ли такая модель в целевой категории ДО переноса — смотрим заранее:
    // findOrCreateModel её либо найдёт, либо создаст, и после вызова эти два
    // случая уже не различить, а человеку разница важна — слияние это не то же
    // самое, что переезд.
    var needle = normalizeModelName(source.model_name);
    var merged = modelRows.some(function (r) {
      return r.category === to && normalizeModelName(r.model_name) === needle;
    });
    // findOrCreateModel заодно СЛИВАЕТ дубли: если такая модель в целевой
    // категории уже есть, вернётся её код, и второй записи не появится.
    var target = findOrCreateModel(to, source.model_name);

    var eqSheet = getSheet(SHEETS.EQUIPMENT);
    var items = readRows(eqSheet).filter(function (r) {
      return r.category === from && pad2(Number(r.model_code)) === pad2(Number(code));
    });

    var renames = [];
    items.forEach(function (item) {
      var unit = nextUnitNumber(to, target.model_code);
      var newId = buildItemId(to, target.model_code, unit);
      renames.push({ old: String(item.item_id), fresh: newId });
      updateRow(eqSheet, item.__row, {
        item_id: newId,
        category: to,
        model_code: pad2(Number(target.model_code)),
      });
    });

    // Ссылки в журналах — колонкой целиком: updateRow читает и пишет диапазон
    // на каждую строку, и на сорока позициях это сотня обращений к листу.
    var map = {};
    renames.forEach(function (r) { map[r.old] = r.fresh; });
    var touched = 0;
    [SHEETS.TRANSACTIONS, SHEETS.DEFECTS, SHEETS.INVENTORY].forEach(function (name) {
      touched += remapItemIds(getSheet(name), map);
    });

    // Строка модели переехала или слилась — старой в справочнике быть не должно.
    modelsSheet.deleteRow(source.__row);

    return {
      ok: true,
      model_name: source.model_name,
      from: from,
      to: to,
      model_code: pad2(Number(target.model_code)),
      merged: merged,
      moved: renames.length,
      journal_rows: touched,
      renames: renames,
    };
  } finally {
    lock.releaseLock();
  }
}

// Подменяет номера вещей в колонке item_id по карте «старый → новый».
// Возвращает, сколько строк тронуто.
function remapItemIds(sheet, map) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var headers = sheetHeaders(sheet);
  var col = headers.indexOf("item_id") + 1;
  if (col < 1) return 0;
  var range = sheet.getRange(2, col, last - 1, 1);
  var values = range.getValues();
  var changed = 0;
  for (var i = 0; i < values.length; i++) {
    var v = String(values[i][0]);
    if (map[v] !== undefined) {
      values[i][0] = map[v];
      changed++;
    }
  }
  if (changed) range.setValues(values);
  return changed;
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
    // В категориях с учётом количеством одна строка описывает всю кучу, а не
    // одну вещь. Если такая позиция уже заведена — пополняем её, а не плодим
    // вторую: двадцать сэндбэгов это одна строка «20 штук», а не два склада по
    // десять, между которыми потом не разобраться.
    var byQty = categoryByQty(category);
    var qty = byQty ? Math.floor(Number(payload.qty || 1)) : 1;
    if (byQty && (!qty || qty < 1)) throw apiError(400, "Укажите количество — целое число от одного");

    var eqSheet = getSheet(SHEETS.EQUIPMENT);
    if (byQty) {
      var existing = readRows(eqSheet).filter(function (r) {
        return r.category === category && pad2(Number(r.model_code)) === pad2(model.model_code);
      })[0];
      if (existing) {
        updateRow(eqSheet, existing.__row, { qty: Number(existing.qty || 0) + qty });
        return { item_id: String(existing.item_id), qty: Number(existing.qty || 0) + qty, added: qty };
      }
    }

    var unit = nextUnitNumber(category, model.model_code);
    var itemId = buildItemId(category, model.model_code, unit);
    appendRow(eqSheet, {
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
      qty: qty,
      qty_out: 0,
    });
    return { item_id: itemId, qty: qty };
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

    // Позиция с учётом количеством выдаётся частями: на складе остаётся
    // остаток, и «уже выдан» к ней неприменимо — применимо «столько нет».
    var byQty = categoryByQty(item.category);
    var total = itemQty(item);
    var out = Number(item.qty_out || 0);
    var takeQty = byQty ? Math.floor(Number(payload.qty || 1)) : 1;
    if (byQty) {
      if (!takeQty || takeQty < 1) throw apiError(400, "Укажите количество — целое число от одного");
      if (item.status === "In Repair" || item.status === "Retired") {
        throw apiError(409, "Позиция снята с выдачи");
      }
      if (out + takeQty > total) {
        throw apiError(409, "На складе свободно " + (total - out) + " из " + total + " — больше выдать нельзя");
      }
    } else if (item.status !== "Available") {
      throw apiError(409, "Предмет уже выдан или недоступен");
    }

    // Выдача в счёт заказа: срок возврата берём из заказа, а сама выдача
    // списывается с подходящей строки состава.
    var orderId = "", orderLine = "", expectedReturn = payload.expected_return_at || "";
    if (payload.order_id) {
      var order = findRowByValue(getSheet(SHEETS.ORDERS), "order_id", String(payload.order_id));
      if (!order) throw apiError(404, "Заказ не найден");
      if (order.status === "Cancelled") throw apiError(409, "Заказ отменён, выдавать по нему нельзя");
      orderId = Number(order.order_id);
      if (!expectedReturn) expectedReturn = String(order.return_date || "");
      orderLine = claimOrderLine(orderId, item);
      updateRow(getSheet(SHEETS.ORDERS), order.__row, { status: "Issued" });
    }

    var txId = nextId("transaction_id", maxIdIn(getSheet(SHEETS.TRANSACTIONS), "transaction_id"));
    appendRow(getSheet(SHEETS.TRANSACTIONS), {
      transaction_id: txId,
      item_id: itemId,
      client_id: payload.client_id,
      order_id: orderId,
      order_line: orderLine,
      staff_out: staffRow.staff_id,
      staff_out_name: staffRow.full_name,
      staff_in: "",
      staff_in_name: "",
      checked_out_at: new Date().toISOString(),
      expected_return_at: expectedReturn,
      checked_in_at: "",
      status: "Open",
      notes: payload.notes || "",
      qty: takeQty,
      qty_in: 0,
    });
    if (byQty) {
      // Пока на складе что-то осталось, позиция остаётся доступной: иначе
      // выдача одного мешка закрыла бы все двадцать.
      var newOut = out + takeQty;
      updateRow(eqSheet, item.__row, {
        qty_out: newOut,
        status: newOut >= total ? "Rented" : "Available",
      });
    } else {
      updateRow(eqSheet, item.__row, { status: "Rented", current_transaction_id: txId });
    }
    return { transaction_id: txId, order_line: orderLine, qty: takeQty };
  } finally {
    lock.releaseLock();
  }
}

// Возврат по заказу: строка состава снова свободна, а если на руках больше
// ничего нет — заказ закрыт. Нужно обеим веткам приёма: мешки и флаги тоже
// выдаются по заказу, и заказ, закрытый лишь наполовину, ничем не лучше
// потерянной техники.
function settleOrderOnCheckin(openTx, txSheet) {
  if (!openTx.order_id) return;
  releaseOrderLine(openTx.order_id, openTx.order_line);
  var orderSheet = getSheet(SHEETS.ORDERS);
  var order = findRowByValue(orderSheet, "order_id", String(openTx.order_id));
  if (!order || order.status === "Cancelled") return;
  var stillOut = 0;
  readRows(txSheet).forEach(function (t) {
    if (String(t.order_id || "") === String(openTx.order_id) && t.status === "Open") stillOut += 1;
  });
  updateRow(orderSheet, order.__row, stillOut
    ? { status: "Issued", closed_at: "" }
    : { status: "Returned", closed_at: new Date().toISOString() });
}

// Заявка о дефекте при приёме. Вынесена из handleTransactionCheckin: приём
// поштучный и приём количеством — две ветки, а дефект в них один и тот же.
function reportDefect(itemId, staffRow, transactionId, payload) {
  var defectId = nextId("defect_id", maxIdIn(getSheet(SHEETS.DEFECTS), "defect_id"));
  appendRow(getSheet(SHEETS.DEFECTS), {
    defect_id: defectId,
    item_id: itemId,
    reported_by: staffRow.staff_id,
    reported_by_name: staffRow.full_name,
    related_transaction_id: transactionId,
    description: payload.defect_description || "",
    severity: payload.defect_severity || "Minor",
    status: "Open",
    reported_at: new Date().toISOString(),
    resolved_at: "",
    resolution_notes: "",
  });
  // В чат склада — только то, из-за чего техника выбывает из оборота. Сообщать
  // о каждой выдаче значит завалить чат и приучить его не читать.
  var item = findRowByValue(getSheet(SHEETS.EQUIPMENT), "item_id", itemId);
  tgNotify("Дефект: " + ((item && item.name) || itemId) + " (" + itemId + ")\n" +
    (payload.defect_description || "без описания") + "\n" +
    "Заявил: " + staffRow.full_name);
  return defectId;
}

// Списывает экземпляр с подходящей строки состава заказа и возвращает её номер.
// Если строки нет или она уже закрыта — «off-order», и выдача всё равно
// проходит: в заказе есть свободное поле, которым технику дописывают руками
// («+ 4 ковра гойда»), так что запретить выдачу вне состава значило бы
// запретить реальную работу склада.
function claimOrderLine(orderId, item) {
  var sheet = getSheet(SHEETS.ORDER_ITEMS);
  var rows = readRows(sheet);
  var itemModel = item.model_code === "" ? "" : pad2(Number(item.model_code));
  if (!itemModel) return "off-order";
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.order_id) !== String(orderId)) continue;
    if (!r.model_code || String(r.category) !== String(item.category)) continue;
    if (pad2(Number(r.model_code)) !== itemModel) continue;
    var issued = Number(r.issued_qty || 0);
    if (issued >= Number(r.qty || 0)) continue;
    updateRow(sheet, r.__row, { issued_qty: issued + 1 });
    return String(r.line_no);
  }
  return "off-order";
}

function releaseOrderLine(orderId, lineNo) {
  if (!orderId || !lineNo || String(lineNo) === "off-order") return;
  var sheet = getSheet(SHEETS.ORDER_ITEMS);
  var rows = readRows(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].order_id) !== String(orderId)) continue;
    if (String(rows[i].line_no) !== String(lineNo)) continue;
    var issued = Number(rows[i].issued_qty || 0);
    updateRow(sheet, rows[i].__row, { issued_qty: issued > 0 ? issued - 1 : 0 });
    return;
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
    var txRows = readRows(txSheet);
    var openList = txRows.filter(function (t) {
      return String(t.item_id) === itemId && t.status === "Open";
    });
    if (!openList.length) throw apiError(409, "Открытой выдачи для этого предмета не найдено");
    var openTx = openList[0];

    // Приём количеством: закрываем выдачи по очереди, начиная с самой ранней.
    // Одна запись журнала может закрыться не полностью — тогда в ней остаётся
    // то, что ещё на руках, и она ждёт следующего возврата.
    var byQty = categoryByQty(item.category);
    if (byQty) {
      var back = Math.floor(Number(payload.qty || 1));
      var onHands = openList.reduce(function (sum, t) {
        return sum + (Number(t.qty || 1) - Number(t.qty_in || 0));
      }, 0);
      if (!back || back < 1) throw apiError(400, "Укажите количество — целое число от одного");
      if (back > onHands) throw apiError(409, "На руках " + onHands + " — принять больше нельзя");

      var left = back;
      openList.forEach(function (t) {
        if (left <= 0) return;
        var remains = Number(t.qty || 1) - Number(t.qty_in || 0);
        var take = Math.min(remains, left);
        left -= take;
        var filled = Number(t.qty_in || 0) + take;
        updateRow(txSheet, t.__row, filled >= Number(t.qty || 1)
          ? { qty_in: filled, status: "Closed", checked_in_at: new Date().toISOString(),
              staff_in: staffRow.staff_id, staff_in_name: staffRow.full_name }
          : { qty_in: filled });
      });

      var total = itemQty(item);
      var newOut = Math.max(0, Number(item.qty_out || 0) - back);
      var defectIdQty = null;
      var statusQty = newOut >= total ? "Rented" : "Available";
      if (payload.has_defect) {
        defectIdQty = reportDefect(itemId, staffRow, openTx.transaction_id, payload);
        if (defectBlocksRental(payload.defect_severity || "Minor")) statusQty = "In Repair";
      }
      updateRow(eqSheet, item.__row, { qty_out: newOut, status: statusQty });
      settleOrderOnCheckin(openTx, txSheet);
      return { transaction_id: openTx.transaction_id, defect_id: defectIdQty, qty: back, qty_out: newOut };
    }

    updateRow(txSheet, openTx.__row, {
      status: "Closed",
      checked_in_at: new Date().toISOString(),
      staff_in: staffRow.staff_id,
      staff_in_name: staffRow.full_name,
    });

    settleOrderOnCheckin(openTx, txSheet);

    var defectId = null;
    var newStatus = "Available";
    if (payload.has_defect) {
      defectId = reportDefect(itemId, staffRow, openTx.transaction_id, payload);
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
    var total = itemQty(r);
    var out = Number(r.qty_out || 0);
    return {
      item_id: r.item_id, name: r.name, category: r.category, status: r.status,
      serial_number: r.serial_number, inventory_number: r.inventory_number,
      model_code: r.model_code === "" ? "" : pad2(Number(r.model_code)),
      qty: total, qty_out: out, qty_free: total - out,
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

// ---------------------------------------------------------------------
// Заказы: разбор сообщения с сайта, студенты, состав заказа
// ---------------------------------------------------------------------

// Телефон — то, по чему мы узнаём, что это тот же арендатор. В заказах он
// приходит как угодно: +79257868093, 8 925 786-80-93, 79257868093. Без
// приведения к одному виду один и тот же человек завёлся бы трижды и история
// аренд рассыпалась бы.
function normalizePhone(raw) {
  var digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.charAt(0) === "8") digits = "7" + digits.substring(1);
  if (digits.length === 10) digits = "7" + digits;
  return "+" + digits;
}

// Дата из формы приходит как 30.04.2026. Держим её строкой "2026-04-30":
// так она не зависит от часового пояса таблицы и не сползает на сутки.
function parseRuDate(raw) {
  var s = String(raw || "").trim();
  var m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (m) {
    return m[3] + "-" + pad2(Number(m[2])) + "-" + pad2(Number(m[1]));
  }
  // уже ISO — пропускаем как есть
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  return "";
}

function parseMoney(raw) {
  var s = String(raw || "").replace(/\s/g, "").replace(",", ".");
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Ключи полей формы приводим к одному виду: Phone_minors, phone_minor и
// "Phone Minors" должны находиться одинаково. Форма на сайте ещё меняется, и
// подбирать её точное написание мы не можем.
function normalizeFieldKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-zа-яё0-9]/g, "");
}

function pickField(fields, names) {
  for (var i = 0; i < names.length; i++) {
    var key = normalizeFieldKey(names[i]);
    if (fields[key] !== undefined && String(fields[key]).trim() !== "") {
      return String(fields[key]).trim();
    }
  }
  return "";
}

/**
 * Разбирает сообщение о заказе, которое бот сайта присылает в общий чат.
 * Возвращает {order_no, items, fields, amount, currency, source_url}, где
 * fields — словарь «нормализованный ключ → значение» со ВСЕМИ строками вида
 * «Ключ: значение». Разбираем именно словарём, а не списком известных полей:
 * форма на сайте в работе, и поле, которого мы не знаем, должно доехать до
 * человека, а не потеряться молча.
 */
function parseOrderMessage(text) {
  var raw = String(text || "");
  var out = {
    order_no: "", request_code: "", items: [], fields: {}, raw_keys: {},
    amount: 0, currency: "", source_url: "", raw_text: raw,
  };
  var lines = raw.split(/\r?\n/);

  // «4. OSTERRIG SIRIUS 100CM: 154000 (4 x 38500)» — название берём лениво, до
  // первого двоеточия; «x» бывает латинской, кириллической и знаком умножения.
  var itemRe = /^\s*(\d+)\s*[.)]\s*(.+?)\s*:\s*([\d\s.,]*)\s*\(\s*(\d+)\s*[x×х]\s*([\d\s.,]+)\s*\)\s*$/;
  var kvRe = /^\s*([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_ ]*?)\s*:\s*(.*)$/;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.replace(/\t/g, " ").trim();
    if (!trimmed) continue;

    var orderM = trimmed.match(/^Заказ\s*№\s*(\S+)/i);
    if (orderM) { out.order_no = orderM[1].trim(); continue; }

    if (/^https?:\/\//i.test(trimmed)) { out.source_url = trimmed; continue; }

    var itemM = trimmed.match(itemRe);
    if (itemM) {
      out.items.push({
        line_no: Number(itemM[1]),
        raw_name: itemM[2].trim(),
        total: parseMoney(itemM[3]),
        qty: Number(itemM[4]),
        price: parseMoney(itemM[5]),
      });
      continue;
    }

    var kvM = trimmed.match(kvRe);
    if (!kvM) continue;
    var key = kvM[1].trim();
    var value = kvM[2].trim();
    // «Информация о покупателе:» и «Дополнительная информация:» — заголовки
    // разделов, а не поля: у них пустое значение и пробел в названии.
    if (!value && key.indexOf(" ") !== -1) continue;
    out.fields[normalizeFieldKey(key)] = value;
    out.raw_keys[normalizeFieldKey(key)] = key;
  }

  var amountLine = pickField(out.fields, ["Сумма платежа"]);
  if (amountLine) {
    var am = amountLine.match(/^([\d\s.,]+)\s*(\S*)$/);
    if (am) {
      out.amount = parseMoney(am[1]);
      out.currency = (am[2] || "").trim();
    }
  }
  out.request_code = pickField(out.fields, ["Код заявки"]);
  return out;
}

/**
 * Из словаря полей делает строку заказа. Одна функция на оба пути приёма:
 * вставленное сообщение сначала превращается в словарь разбором, вебхук Tilda
 * отдаёт такой словарь сразу. Иначе второй путь пришлось бы писать заново.
 */
function mapOrderFields(fields) {
  var isAdultRaw = pickField(fields, ["Are_you_an_adult", "adult"]);
  var guardianName = pickField(fields, ["Full_name_guardian", "guardian_name"]);
  // Явный ответ формы важнее догадки; если поля нет — судим по наличию
  // взрослого: он появляется в заказе только у несовершеннолетнего.
  var isAdult = isAdultRaw
    ? !/^(нет|no|false)$/i.test(isAdultRaw)
    : !guardianName;

  return {
    // Имена полей для совершеннолетнего заказчика мы ещё не видели, поэтому
    // берём первое найденное из вероятных написаний. Если не нашлось ничего,
    // экран покажет разобранный словарь и попросит сопоставить руками.
    student_name: pickField(fields, ["Full_name_minor", "Full_name", "Full_name_adult", "ФИО"]),
    student_phone: normalizePhone(pickField(fields, ["Phone_minors", "Phone_minor", "Phone", "Phone_adult", "Телефон"])),
    student_tg: pickField(fields, ["Telegram_Minors", "Telegram_minor", "Telegram", "Telegram_adult"]),
    is_adult: isAdult ? "TRUE" : "FALSE",
    guardian_name: isAdult ? "" : guardianName,
    guardian_phone: isAdult ? "" : normalizePhone(pickField(fields, ["Phone_guardian", "guardian_phone"])),
    project: pickField(fields, ["Type_and_name_of_the_project", "project", "Проект"]),
    issue_date: parseRuDate(pickField(fields, ["Date_of_issue", "issue_date"])),
    return_date: parseRuDate(pickField(fields, ["Date_completion", "Date_of_completion", "return_date"])),
    extra_input: pickField(fields, ["Input", "Дополнительно"]),
  };
}

// Сопоставление строки заказа с каталогом. Точное совпадение берём сразу,
// иначе отдаём похожие и решает человек: ошибка здесь означает, что выдача
// спишется не с той строки заказа.
function matchOrderLine(rawName, modelRows) {
  var needle = normalizeModelName(rawName);
  if (!needle) return { model_code: "", category: "", suggestions: [] };
  var suggestions = [];
  for (var i = 0; i < modelRows.length; i++) {
    var candidate = normalizeModelName(modelRows[i].model_name);
    if (!candidate) continue;
    if (candidate === needle) {
      return {
        model_code: pad2(Number(modelRows[i].model_code)),
        category: modelRows[i].category,
        suggestions: [],
      };
    }
    if (suggestions.length < 5 &&
        (candidate.indexOf(needle) !== -1 || needle.indexOf(candidate) !== -1)) {
      suggestions.push({
        model_code: pad2(Number(modelRows[i].model_code)),
        category: modelRows[i].category,
        model_name: modelRows[i].model_name,
      });
    }
  }
  return { model_code: "", category: "", suggestions: suggestions };
}

// Разбор без записи: сначала человек смотрит, что распознано, потом
// подтверждает. За этим стоят чужие персональные данные и материальная
// ответственность — вслепую такое сохранять нельзя.
function handleOrderParse(payload, token) {
  checkAuth(token);
  var parsed = parseOrderMessage(payload.text);
  if (!parsed.order_no && !parsed.items.length) {
    throw apiError(400, "Не похоже на сообщение о заказе: ни номера, ни позиций не нашлось");
  }
  var mapped = mapOrderFields(parsed.fields);
  var modelRows = readRows(getSheet(SHEETS.MODELS));
  var items = parsed.items.map(function (line) {
    var match = matchOrderLine(line.raw_name, modelRows);
    return {
      line_no: line.line_no, raw_name: line.raw_name, qty: line.qty,
      price: line.price, total: line.total,
      model_code: match.model_code, category: match.category,
      suggestions: match.suggestions,
    };
  });

  var warnings = [];
  if (!mapped.student_name) warnings.push("Не распознано имя арендатора");
  if (!mapped.student_phone) warnings.push("Не распознан телефон арендатора — историю по нему будет не собрать");
  if (!parsed.order_no) warnings.push("Не распознан номер заказа");
  var unmatched = items.filter(function (i) { return !i.model_code; }).length;
  if (unmatched) {
    warnings.push("Не сопоставлено с каталогом позиций: " + unmatched +
      " — их можно выдавать количеством, без сканирования");
  }

  var order = mapped;
  order.order_no = parsed.order_no;
  order.request_code = parsed.request_code;
  order.amount = parsed.amount;
  order.currency = parsed.currency;
  order.source_url = parsed.source_url;
  order.raw_text = parsed.raw_text;

  var existing = parsed.order_no
    ? findRowByValue(getSheet(SHEETS.ORDERS), "order_no", parsed.order_no)
    : null;

  return {
    order: order, items: items, fields: parsed.fields, raw_keys: parsed.raw_keys,
    warnings: warnings,
    already_exists: existing ? Number(existing.order_id) : null,
  };
}

// Арендатор опознаётся по телефону. Без телефона заказ всё равно создаётся, но
// без привязки к студенту: связывать людей по совпадению ФИО — верный способ
// склеить двух разных однофамильцев.
function findOrCreateStudent(order) {
  var phone = normalizePhone(order.student_phone);
  var sheet = getSheet(SHEETS.STUDENTS);
  if (!phone) return { student_id: "", created: false };

  var rows = readRows(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (normalizePhone(rows[i].phone) === phone) {
      // Ник в Telegram и написание имени со временем меняются — подтягиваем
      // свежее из заказа, чтобы карточка не устаревала.
      var patch = {};
      if (order.student_name && String(rows[i].full_name).trim() !== order.student_name) {
        patch.full_name = order.student_name;
      }
      if (order.student_tg && String(rows[i].tg_username).trim() !== order.student_tg) {
        patch.tg_username = order.student_tg;
      }
      if (patch.full_name || patch.tg_username) updateRow(sheet, rows[i].__row, patch);
      return { student_id: Number(rows[i].student_id), created: false };
    }
  }

  var studentId = nextId("student_id", maxIdIn(sheet, "student_id"));
  appendRow(sheet, {
    student_id: studentId,
    full_name: order.student_name || "",
    phone: phone,
    tg_username: order.student_tg || "",
    created_at: new Date().toISOString(),
    notes: "",
  });
  return { student_id: studentId, created: true };
}

function handleOrderCreate(payload, token) {
  var staffRow = checkAuth(token);
  var orderNo = String(payload.order_no || "").trim();
  if (!orderNo) throw apiError(400, "Укажите номер заказа");
  if (!String(payload.student_name || "").trim()) throw apiError(400, "Укажите имя арендатора");

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var sheet = getSheet(SHEETS.ORDERS);
    // Один номер — один заказ. Иначе журнал перестаёт сходиться с сайтом, а
    // выдача списывается с чужой строки.
    var dup = findRowByValue(sheet, "order_no", orderNo);
    if (dup) throw apiError(409, "Заказ " + orderNo + " уже заведён (№" + dup.order_id + ")");

    var student = findOrCreateStudent(payload);
    var orderId = nextId("order_id", maxIdIn(sheet, "order_id"));
    var now = new Date().toISOString();

    appendRow(sheet, {
      order_id: orderId,
      order_no: orderNo,
      request_code: String(payload.request_code || ""),
      student_id: student.student_id,
      student_name: String(payload.student_name || "").trim(),
      student_phone: normalizePhone(payload.student_phone),
      student_tg: String(payload.student_tg || ""),
      is_adult: payload.is_adult === "FALSE" || payload.is_adult === false ? "FALSE" : "TRUE",
      guardian_name: String(payload.guardian_name || ""),
      guardian_phone: normalizePhone(payload.guardian_phone),
      project: String(payload.project || ""),
      issue_date: parseRuDate(payload.issue_date),
      return_date: parseRuDate(payload.return_date),
      extra_input: String(payload.extra_input || ""),
      amount: Number(payload.amount || 0),
      currency: String(payload.currency || ""),
      source_url: String(payload.source_url || ""),
      status: "New",
      raw_text: String(payload.raw_text || ""),
      created_at: now,
      created_by: staffRow.staff_id,
      created_by_name: staffRow.full_name,
      closed_at: "",
    });

    var lines = Array.isArray(payload.items) ? payload.items : [];
    if (lines.length) {
      var itemSheet = getSheet(SHEETS.ORDER_ITEMS);
      var headers = sheetHeaders(itemSheet);
      var start = itemSheet.getLastRow() + 1;
      prepareRows(itemSheet, start, lines.length);
      itemSheet.getRange(start, 1, lines.length, headers.length).setValues(
        lines.map(function (line, idx) {
          var row = {
            order_id: orderId,
            line_no: Number(line.line_no || idx + 1),
            raw_name: String(line.raw_name || ""),
            model_code: line.model_code ? pad2(Number(line.model_code)) : "",
            category: String(line.category || ""),
            qty: Number(line.qty || 1),
            price: Number(line.price || 0),
            total: Number(line.total || 0),
            issued_qty: 0,
            note: String(line.note || ""),
          };
          return headers.map(function (h) { return row[h] !== undefined ? row[h] : ""; });
        }));
    }

    return { order_id: orderId, student_id: student.student_id, student_created: student.created };
  } finally {
    lock.releaseLock();
  }
}

// Считает по журналу, что из заказов на руках. Один проход по всем выдачам на
// весь список: запрос на заказ превратил бы список в минуты ожидания.
function orderCounts(txRows) {
  var counts = {};
  txRows.forEach(function (t) {
    var id = String(t.order_id || "");
    if (!id) return;
    if (!counts[id]) counts[id] = { open: 0, total: 0 };
    counts[id].total += 1;
    if (t.status === "Open") counts[id].open += 1;
  });
  return counts;
}

// Статус заказа не вводится руками, а вытекает из выдач: рассинхронизация между
// «статусом» и журналом — это техника, которую считают возвращённой, пока она на
// руках. Отмена — единственное, что решает человек.
function orderStatus(orderRow, count) {
  if (orderRow.status === "Cancelled") return "Cancelled";
  var c = count || { open: 0, total: 0 };
  if (c.open > 0) return "Issued";
  if (c.total > 0) return "Returned";
  return "New";
}

function handleOrdersList(payload, token) {
  checkAuth(token);
  var counts = orderCounts(readRows(getSheet(SHEETS.TRANSACTIONS)));

  // Состав заказа строкой: на складе спрашивают «у кого сейчас OSTERRIG», и без
  // этого искать пришлось бы, открывая заказы по одному. Один проход по листу
  // на весь список, а не запрос на заказ.
  var itemsText = {};
  readRows(getSheet(SHEETS.ORDER_ITEMS)).forEach(function (line) {
    var key = String(line.order_id);
    itemsText[key] = (itemsText[key] ? itemsText[key] + ", " : "") + String(line.raw_name || "");
  });

  var rows = readRows(getSheet(SHEETS.ORDERS)).map(function (r) {
    var count = counts[String(r.order_id)] || { open: 0, total: 0 };
    return {
      order_id: r.order_id,
      order_no: String(r.order_no),
      request_code: String(r.request_code || ""),
      student_id: r.student_id,
      student_name: r.student_name,
      student_phone: String(r.student_phone || ""),
      student_tg: String(r.student_tg || ""),
      is_adult: isTruthyCell(r.is_adult),
      guardian_name: r.guardian_name || "",
      guardian_phone: String(r.guardian_phone || ""),
      project: r.project || "",
      issue_date: String(r.issue_date || ""),
      return_date: String(r.return_date || ""),
      extra_input: r.extra_input || "",
      amount: r.amount || 0,
      currency: r.currency || "",
      status: orderStatus(r, count),
      issued_open: count.open,
      issued_total: count.total,
      created_at: r.created_at,
      created_by_name: r.created_by_name || "",
      items_text: itemsText[String(r.order_id)] || "",
      // raw_text в список не отдаём: это всё сообщение целиком, включая даты
      // рождения. Оно нужно только в карточке одного заказа.
    };
  });

  if (payload.status && payload.status !== "all") {
    rows = rows.filter(function (r) { return r.status === payload.status; });
  }
  return rows;
}

function handleOrderCard(payload, token) {
  checkAuth(token);
  var orderId = String(payload.order_id || "");
  var order = findRowByValue(getSheet(SHEETS.ORDERS), "order_id", orderId);
  if (!order) throw apiError(404, "Заказ не найден");

  var txRows = readRows(getSheet(SHEETS.TRANSACTIONS)).filter(function (t) {
    return String(t.order_id || "") === orderId;
  });
  var items = readRows(getSheet(SHEETS.ORDER_ITEMS)).filter(function (r) {
    return String(r.order_id) === orderId;
  }).map(function (r) {
    return {
      line_no: Number(r.line_no), raw_name: r.raw_name,
      model_code: r.model_code === "" ? "" : pad2(Number(r.model_code)),
      category: r.category || "", qty: Number(r.qty || 0), price: Number(r.price || 0),
      total: Number(r.total || 0), issued_qty: Number(r.issued_qty || 0), note: r.note || "",
    };
  });

  delete order.__row;
  order.status = orderStatus(order, orderCounts(txRows)[orderId]);
  order.is_adult = isTruthyCell(order.is_adult);
  return {
    order: order,
    items: items,
    transactions: txRows.map(function (t) { delete t.__row; return t; }),
  };
}

// Правка заказа. Список полей закрытый: номер заказа, арендатор и состав
// правятся не здесь — номер приходит с сайта, а состав отдельным эндпоинтом.
var ORDER_EDITABLE = ["project", "issue_date", "return_date", "extra_input",
                      "guardian_name", "guardian_phone", "student_tg", "status"];

function handleOrderUpdate(payload, token) {
  checkAuth(token);
  var sheet = getSheet(SHEETS.ORDERS);
  var order = findRowByValue(sheet, "order_id", String(payload.order_id || ""));
  if (!order) throw apiError(404, "Заказ не найден");

  var patch = {};
  ORDER_EDITABLE.forEach(function (field) {
    if (payload[field] === undefined) return;
    if (field === "issue_date" || field === "return_date") {
      patch[field] = parseRuDate(payload[field]);
    } else if (field === "guardian_phone") {
      patch[field] = normalizePhone(payload[field]);
    } else if (field === "status") {
      // Руками можно только отменить или снять отмену: остальные статусы
      // считаются по журналу и вводу не подлежат.
      if (payload.status !== "Cancelled" && payload.status !== "New") {
        throw apiError(400, "Статус заказа считается по выдачам; руками можно только отменить");
      }
      patch.status = payload.status;
    } else {
      patch[field] = String(payload[field]);
    }
  });
  if (!Object.keys(patch).length) throw apiError(400, "Нечего менять");

  // Отменить заказ, по которому техника на руках, — значит потерять след этой
  // техники: сначала приём, потом отмена.
  if (patch.status === "Cancelled") {
    var counts = orderCounts(readRows(getSheet(SHEETS.TRANSACTIONS)));
    var count = counts[String(order.order_id)];
    if (count && count.open > 0) {
      throw apiError(409, "По заказу " + count.open + " позиций на руках — сначала примите их");
    }
  }

  updateRow(sheet, order.__row, patch);
  return { order_id: Number(order.order_id) };
}

// Правка строки состава: сопоставить с моделью каталога или отметить выданное
// количеством. Второе нужно для позиций, которых в каталоге поштучно нет —
// двадцать сэндбэгов никто не станет сканировать по одному.
function handleOrderLineUpdate(payload, token) {
  checkAuth(token);
  var sheet = getSheet(SHEETS.ORDER_ITEMS);
  var orderId = String(payload.order_id || "");
  var lineNo = String(payload.line_no || "");
  var rows = readRows(sheet);
  var line = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].order_id) === orderId && String(rows[i].line_no) === lineNo) {
      line = rows[i];
      break;
    }
  }
  if (!line) throw apiError(404, "Строка заказа не найдена");

  var patch = {};
  if (payload.model_code !== undefined) {
    patch.model_code = payload.model_code ? pad2(Number(payload.model_code)) : "";
    patch.category = String(payload.category || "");
  }
  if (payload.issued_qty !== undefined) {
    var issued = Number(payload.issued_qty);
    if (isNaN(issued) || issued < 0) throw apiError(400, "Выданное количество должно быть числом от нуля");
    if (issued > Number(line.qty || 0)) {
      throw apiError(400, "В заказе этой позиции " + line.qty + ", выдать больше нельзя");
    }
    patch.issued_qty = issued;
  }
  if (payload.note !== undefined) patch.note = String(payload.note);
  if (!Object.keys(patch).length) throw apiError(400, "Нечего менять");

  updateRow(sheet, line.__row, patch);
  return { order_id: Number(orderId), line_no: Number(lineNo) };
}

function handleStudentHistory(payload, token) {
  checkAuth(token);
  var studentId = String(payload.student_id || "");
  var counts = orderCounts(readRows(getSheet(SHEETS.TRANSACTIONS)));
  var orders = readRows(getSheet(SHEETS.ORDERS))
    .filter(function (r) { return String(r.student_id) === studentId; })
    .map(function (r) {
      return {
        order_id: r.order_id, order_no: String(r.order_no), project: r.project || "",
        issue_date: String(r.issue_date || ""), return_date: String(r.return_date || ""),
        status: orderStatus(r, counts[String(r.order_id)]),
      };
    });
  return { orders: orders };
}

function handleStudentsList(payload, token) {
  checkAuth(token);
  return readRows(getSheet(SHEETS.STUDENTS)).map(function (r) {
    delete r.__row;
    r.phone = String(r.phone || "");
    r.tg_username = String(r.tg_username || "");
    return r;
  });
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
      // Заводит сотрудников только главный администратор: учётная запись — это
      // доступ к складу, и раздавать его должен один человек, а не каждый, кому
      // однажды дали роль администратора.
      requireOwner(token);
    }

    var loginLower = login.toLowerCase();
    var taken = rows.some(function (r) { return String(r.login).trim().toLowerCase() === loginLower; });
    if (taken) throw apiError(409, "Такой логин уже используется");

    var staffId = nextId("staff_id", maxIdIn(sheet, "staff_id"));
    if (isBootstrap) {
      metaSet("bootstrap_done", new Date().toISOString());
      metaSet("owner_staff_id", staffId);   // первый администратор и есть главный
    }
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
  var owner = ownerId();
  return readRows(getSheet(SHEETS.STAFF)).map(function (r) {
    return {
      staff_id: r.staff_id, full_name: r.full_name, login: r.login, role: r.role,
      active: isTruthyCell(r.active),
      is_owner: !!owner && String(r.staff_id) === owner,
    };
  });
}

function handleStaffSetActive(payload, token) {
  requireAdmin(token);
  var sheet = getSheet(SHEETS.STAFF);
  var staffRow = findRowByValue(sheet, "staff_id", payload.staff_id);
  if (!staffRow) throw apiError(404, "Сотрудник не найден");
  if (isOwnerId(staffRow.staff_id)) {
    throw apiError(409, "Главного администратора отключить нельзя — права можно только передать");
  }
  var patch = { active: !!payload.active };
  // Отключение должно действовать сразу. Сессия живёт токеном в строке, и без
  // его сброса отключённый продолжал бы работать до конца срока сессии.
  if (!payload.active) {
    patch.session_token = "";
    patch.token_issued_at = "";
  }
  updateRow(sheet, staffRow.__row, patch);
  return { staff_id: staffRow.staff_id, full_name: staffRow.full_name, active: !!payload.active };
}

// Смена роли: повысить складского сотрудника до администратора и обратно.
function handleStaffSetRole(payload, token) {
  requireOwner(token);
  var role = String(payload.role || "");
  if (role !== "Admin" && role !== "Warehouse Staff") {
    throw apiError(400, "Роль — «Admin» или «Warehouse Staff»");
  }
  var sheet = getSheet(SHEETS.STAFF);
  var staffRow = findRowByValue(sheet, "staff_id", payload.staff_id);
  if (!staffRow) throw apiError(404, "Сотрудник не найден");
  if (isOwnerId(staffRow.staff_id)) {
    throw apiError(409, "Роль главного администратора не меняется — права можно только передать");
  }
  updateRow(sheet, staffRow.__row, { role: role });
  return { staff_id: staffRow.staff_id, full_name: staffRow.full_name, role: role };
}

// Передача главных прав. Единственный способ перестать быть главным
// администратором: удалить эту роль нельзя ни у себя, ни у другого.
function handleStaffTransferOwner(payload, token) {
  var me = requireOwner(token);
  var sheet = getSheet(SHEETS.STAFF);
  var target = findRowByValue(sheet, "staff_id", payload.staff_id);
  if (!target) throw apiError(404, "Сотрудник не найден");
  if (String(target.staff_id) === String(me.staff_id)) {
    throw apiError(409, "Вы и так главный администратор");
  }
  if (!isTruthyCell(target.active)) {
    throw apiError(409, "Передать права можно только действующему сотруднику");
  }
  // Главный администратор без прав администратора — противоречие, поэтому роль
  // поднимаем здесь же, а не оставляем это отдельным шагом, о котором забудут.
  if (target.role !== "Admin") updateRow(sheet, target.__row, { role: "Admin" });
  metaSet("owner_staff_id", target.staff_id);
  return { staff_id: target.staff_id, full_name: target.full_name };
}

// ---------------------------------------------------------------------
// Телеграм-бот: уведомления в чат склада
// ---------------------------------------------------------------------
//
// Токен живёт ТОЛЬКО в Script Properties (ключ TELEGRAM_BOT_TOKEN) и наружу не
// отдаётся ни одним эндпоинтом. Причина простая: токен бота — это полный доступ
// к нему, а настройки читает любой вошедший сотрудник.
//
// Если токена или чата нет — бот молча молчит. Уведомление не должно ронять
// выдачу: техника уже выдана, и отказ мессенджера не повод откатывать работу.

function botToken() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty("TELEGRAM_BOT_TOKEN") || "").trim();
  } catch (e) {
    return "";
  }
}

function notifyChatId() {
  return String(getSettings().notify_chat_id || "").trim();
}

// Возвращает, что произошло, — это нужно кнопке проверки связи. Обычные вызовы
// результат игнорируют.
function tgSend(text, chatIdOverride) {
  var token = botToken();
  var chatId = String(chatIdOverride || notifyChatId());
  if (!token) return { ok: false, reason: "no-token" };
  if (!chatId) return { ok: false, reason: "no-chat" };
  try {
    var res = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true }),
      muteHttpExceptions: true,
    });
    var body = JSON.parse(res.getContentText() || "{}");
    return body.ok ? { ok: true } : { ok: false, reason: "telegram", error: body.description || "" };
  } catch (e) {
    return { ok: false, reason: "network", error: String(e) };
  }
}

// Отправка файла. Отдельно от tgSend, потому что sendDocument — это multipart,
// а не JSON: тело собирает сам UrlFetchApp из объекта с блобом.
function tgSendDocument(blob, caption, chatIdOverride) {
  var token = botToken();
  var chatId = String(chatIdOverride || notifyChatId());
  if (!token) return { ok: false, reason: "no-token" };
  if (!chatId) return { ok: false, reason: "no-chat" };
  try {
    var res = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendDocument", {
      method: "post",
      payload: { chat_id: chatId, caption: String(caption || ""), document: blob },
      muteHttpExceptions: true,
    });
    var body = JSON.parse(res.getContentText() || "{}");
    return body.ok ? { ok: true } : { ok: false, reason: "telegram", error: body.description || "" };
  } catch (e) {
    return { ok: false, reason: "network", error: String(e) };
  }
}

// Этикетки из мини-приложения. Сохранить файл прямо на устройство из вебвью
// Telegram нельзя — атрибут download там не работает, — поэтому пачку забирает
// бот и кладёт в чат склада одним архивом. Картинки рисует телефон, сюда
// приходят готовые PNG в base64.
var LABELS_MAX_FILES = 30;
var LABELS_MAX_BYTES = 8 * 1024 * 1024;   // запас: sendDocument держит 50 МБ

function handleLabelsSend(payload, token) {
  checkAuth(token);
  var files = payload && payload.files;
  if (!files || !files.length) throw apiError(400, "Нечего отправлять: список файлов пуст.");
  if (files.length > LABELS_MAX_FILES) {
    throw apiError(400, "Сразу больше " + LABELS_MAX_FILES + " этикеток не отправляем. " +
      "Сузьте фильтры и повторите.");
  }

  var blobs = [];
  var total = 0;
  for (var i = 0; i < files.length; i++) {
    var name = String(files[i].name || ("label-" + (i + 1) + ".png"));
    var data = String(files[i].png_base64 || "");
    if (!data) throw apiError(400, "Файл «" + name + "» пришёл пустым.");
    var bytes;
    try {
      bytes = Utilities.base64Decode(data);
    } catch (e) {
      throw apiError(400, "Файл «" + name + "» повреждён при передаче.");
    }
    total += bytes.length;
    if (total > LABELS_MAX_BYTES) {
      throw apiError(400, "Слишком много данных за раз. Сузьте фильтры и повторите.");
    }
    blobs.push(Utilities.newBlob(bytes, "image/png", name));
  }

  // Одна этикетка уходит картинкой, несколько — архивом: тридцать отдельных
  // сообщений подряд в чате склада никому не нужны.
  var one = blobs.length === 1;
  var payloadBlob = one
    ? blobs[0]
    : Utilities.zip(blobs, "mifs-labels-" + new Date().toISOString().substring(0, 10) + ".zip");
  var caption = one
    ? "Этикетка: " + blobs[0].getName()
    : "Этикетки, " + blobs.length + " шт.";

  var res = tgSendDocument(payloadBlob, caption);
  if (res.ok) {
    return { ok: true, count: blobs.length,
             message: one ? "Этикетка отправлена в чат склада."
                          : blobs.length + " этикеток отправлены в чат склада одним архивом." };
  }
  if (res.reason === "no-token") {
    throw apiError(400, "Токен бота не задан. Apps Script → Project Settings → " +
      "Script Properties → добавьте свойство TELEGRAM_BOT_TOKEN со значением токена от BotFather.");
  }
  if (res.reason === "no-chat") {
    throw apiError(400, "Не указан чат: впишите числовой id чата склада в настройках " +
      "и сохраните.");
  }
  throw apiError(502, "Telegram отказал: " + (res.error || "неизвестная причина") +
    ". Чаще всего это значит, что бота не добавили в чат или id чата указан неверно.");
}

// Тихая отправка: всё, что зовётся по ходу работы склада, идёт через неё.
function tgNotify(text) {
  try { tgSend(text); } catch (e) { /* уведомление не важнее самой операции */ }
}

function handleNotifyTest(payload, token) {
  requireAdmin(token);
  var chat = String(payload.chat_id || "").trim();
  var res = tgSend("Проверка связи: приложение склада на связи с этим чатом.", chat);
  if (res.ok) return { ok: true, message: "Сообщение отправлено — проверьте чат." };
  if (res.reason === "no-token") {
    throw apiError(400, "Токен бота не задан. Apps Script → Project Settings → " +
      "Script Properties → добавьте свойство TELEGRAM_BOT_TOKEN со значением токена от BotFather.");
  }
  if (res.reason === "no-chat") {
    throw apiError(400, "Не указан чат: впишите числовой id чата склада в настройках " +
      "и сохраните.");
  }
  throw apiError(502, "Telegram отказал: " + (res.error || "неизвестная причина") +
    ". Чаще всего это значит, что бота не добавили в чат или id чата указан неверно.");
}

// Сводка просрочек. Вызывается кнопкой в админке и — если повесить временной
// триггер на dailyOverdueDigest — раз в сутки сама.
function overdueDigest() {
  var today = new Date().toISOString().substring(0, 10);
  var txRows = readRows(getSheet(SHEETS.TRANSACTIONS));
  var counts = orderCounts(txRows);
  var lines = [];
  readRows(getSheet(SHEETS.ORDERS)).forEach(function (o) {
    if (orderStatus(o, counts[String(o.order_id)]) !== "Issued") return;
    var due = String(o.return_date || "").substring(0, 10);
    if (!due || due >= today) return;
    var open = (counts[String(o.order_id)] || {}).open || 0;
    lines.push("№" + o.order_no + " · " + (o.student_name || "—") +
      " · вернуть до " + due + " · на руках " + open);
  });
  if (!lines.length) return { overdue: 0, message: "Просрочек нет." };
  var text = "Просроченные заказы — " + lines.length + ":\n" + lines.join("\n");
  var res = tgSend(text);
  return { overdue: lines.length, sent: res.ok, message: text };
}

// Отдельная функция для временного триггера: в редакторе Apps Script у
// триггера можно выбрать только функцию без аргументов.
function dailyOverdueDigest() {
  overdueDigest();
}

// ---------------------------------------------------------------------
// Инвентаризация: журнал сверок склада
// ---------------------------------------------------------------------
//
// Сверка НИЧЕГО НЕ МЕНЯЕТ в каталоге. Ненайденный предмет может лежать в чужой
// сумке, а не пропасть, и решать это должен человек. Наше дело — записать, что
// увидели, и когда.
//
// Пишем только итог и расхождения. Строка «ожидали найти и нашли» ничего не
// сообщает, а на 628 позициях каждая сверка добавляла бы столько же строк.

function handleNotifyOverdue(payload, token) {
  requireAdmin(token);
  return overdueDigest();
}

function handleInventorySave(payload, token) {
  var staffRow = checkAuth(token);
  var sheet = getSheet(SHEETS.INVENTORY);
  var id = nextId("inventory_id", maxIdIn(sheet, "inventory_id"));

  var found = payload.found || {};
  var missing = payload.missing || [];
  var unknown = payload.unknown || [];
  var equipment = readRows(getSheet(SHEETS.EQUIPMENT));
  var byId = {};
  equipment.forEach(function (r) { byId[String(r.item_id)] = r; });

  var scope = String(payload.scope || "all");
  var started = String(payload.started_at || "");
  var finished = String(payload.finished_at || new Date().toISOString());
  var foundIds = Object.keys(found);

  function row(kind, itemId, expectedQty, foundQty) {
    var item = byId[String(itemId)] || {};
    return {
      inventory_id: id, kind: kind,
      item_id: itemId === null || itemId === undefined ? "" : String(itemId),
      item_name: item.name || "",
      expected_qty: expectedQty === null ? "" : expectedQty,
      found_qty: foundQty === null ? "" : foundQty,
      scope: scope, started_at: started, finished_at: finished,
      staff_id: staffRow.staff_id, staff_name: staffRow.full_name,
    };
  }

  var rows = [row("summary", "", foundIds.length + missing.length, foundIds.length)];
  missing.forEach(function (itemId) {
    var item = byId[String(itemId)] || {};
    rows.push(row("missing", itemId, categoryByQty(item.category) ? itemQty(item) : 1, 0));
  });
  // Расхождение по количеству — только у штучных позиций: у поштучных «нашли»
  // это всегда единица.
  foundIds.forEach(function (itemId) {
    var item = byId[String(itemId)];
    if (!item || !categoryByQty(item.category)) return;
    var want = itemQty(item);
    var got = Math.floor(Number(found[itemId]));
    if (got !== want) rows.push(row("mismatch", itemId, want, got));
  });
  unknown.forEach(function (code) { rows.push(row("unknown", code, "", "")); });

  appendRows(sheet, rows);
  return {
    inventory_id: id,
    found: foundIds.length,
    missing: missing.length,
    unknown: unknown.length,
    written: rows.length,
  };
}

// Пачкой, а не по строке: на сверке с сотней расхождений построчная запись
// упирается в лимит времени Apps Script.
function appendRows(sheet, rowObjects) {
  if (!rowObjects.length) return;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values = rowObjects.map(function (obj) {
    return headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ""; });
  });
  var target = sheet.getLastRow() + 1;
  prepareRows(sheet, target, values.length);
  sheet.getRange(target, 1, values.length, headers.length).setValues(values);
}

function handleInventoryList(payload, token) {
  checkAuth(token);
  var rows = readRows(getSheet(SHEETS.INVENTORY));
  // Наружу отдаём итоги сверок, а не все их строки: список нужен, чтобы
  // выбрать сверку, а подробности читаются в самой таблице.
  return rows.filter(function (r) { return r.kind === "summary"; }).map(function (r) {
    delete r.__row;
    return r;
  }).reverse();
}

// ---------------------------------------------------------------------
// Настройки, категории и обслуживание — экран админки
// ---------------------------------------------------------------------

function handleSettingsGet(payload, token) {
  var me = checkAuth(token);
  var owner = ownerId();
  var ownerRow = owner ? findRowByValue(getSheet(SHEETS.STAFF), "staff_id", owner) : null;
  // Категории нужны любому вошедшему: без них не нарисовать ни каталог, ни
  // фильтры. Правка — отдельным эндпоинтом и только администратору.
  return {
    settings: getSettings(),
    categories: categories(),
    limits: settingsHints(),
    me: {
      staff_id: me.staff_id,
      full_name: me.full_name,
      role: me.role,
      is_owner: isOwnerId(me.staff_id),
    },
    owner: ownerRow ? { staff_id: ownerRow.staff_id, full_name: ownerRow.full_name } : null,
    // Сводка отдаётся здесь же, а не отдельным запросом: таблица отвечает
    // 5–8 секунд, и второй запрос ради пяти чисел стоил бы этих секунд заново.
    summary: warehouseSummary(),
    maintenance: {
      journal_archived_at: metaGet("journal_archived_at") || "",
      journal_trimmed_at: metaGet("journal_trimmed_at") || "",
    },
  };
}

// Что творится на складе одним взглядом: из чего состоит каталог, сколько на
// руках, что просрочено и что сломано. Считается по тем же листам, которые всё
// равно читаются — отдельного хранилища для этого заводить незачем.
// ---------------------------------------------------------------------
// Занятость по датам — то, на чём стоит бронь
// ---------------------------------------------------------------------

// Заказы, которые держат технику. Returned и Cancelled её отпустили.
var BOOKING_STATUSES = ["New", "Issued"];

/**
 * Сколько единиц каждой модели свободно на интервале [from, to].
 *
 * Считается по тому, что уже записано: даты лежат в Orders, модель и
 * количество — в OrderItems. Отдельной сущности «бронь» не нужно, и это
 * важно: два места, где записано одно и то же, рано или поздно разойдутся.
 *
 * Даты в таблице хранятся как YYYY-MM-DD (parseRuDate приводит к этому виду),
 * поэтому сравниваются строками — без разбора в Date и без часовых поясов,
 * на которых такие расчёты обычно и ломаются.
 *
 * Интервалы пересекаются, когда заказ начался не позже конца нашего интервала
 * и закончился не раньше его начала. День возврата считается занятым: вещь
 * приносят в конце дня, и выдать её в этот же день другому нельзя.
 *
 * Возвращает { "CAM|01": {total, booked, free, model_name} }.
 */
function availabilityFor(from, to) {
  var start = String(from || "").substring(0, 10);
  var end = String(to || "").substring(0, 10) || start;
  var out = {};

  // Сколько единиц есть физически. Списанное не предлагаем.
  readRows(getSheet(SHEETS.EQUIPMENT)).forEach(function (r) {
    if (r.status === "Retired") return;
    var key = r.category + "|" + (r.model_code === "" ? "" : pad2(Number(r.model_code)));
    if (!out[key]) out[key] = { total: 0, booked: 0, free: 0, model_name: r.name };
    out[key].total += itemQty(r);
  });

  var orders = {};
  readRows(getSheet(SHEETS.ORDERS)).forEach(function (o) {
    orders[String(o.order_id)] = o;
  });

  readRows(getSheet(SHEETS.ORDER_ITEMS)).forEach(function (line) {
    var order = orders[String(line.order_id)];
    if (!order) return;
    if (BOOKING_STATUSES.indexOf(String(order.status)) === -1) return;
    if (!bookingOverlaps(order, start, end)) return;
    var key = line.category + "|" + (line.model_code === "" ? "" : pad2(Number(line.model_code)));
    if (!out[key]) return;   // строка заказа, которую так и не сопоставили с каталогом
    out[key].booked += Math.max(0, Number(line.qty) || 0);
  });

  for (var key in out) {
    out[key].free = Math.max(0, out[key].total - out[key].booked);
  }
  return out;
}

// Пересекается ли заказ с интервалом.
//
// Отдельно про заказы без дат. Выданный без дат — это вещь, которая физически
// на руках и неизвестно когда вернётся: считаем занятой всегда, иначе витрина
// пообещает то, чего на полке нет. Новый без дат — наоборот, пропускаем:
// заявка, заведённая копипастом без сроков, иначе заблокировала бы модель
// навечно.
function bookingOverlaps(order, start, end) {
  var from = String(order.issue_date || "").substring(0, 10);
  var to = String(order.return_date || "").substring(0, 10);
  if (!from && !to) return String(order.status) === "Issued";
  if (!from) return to >= start;
  if (!to) return from <= end;
  return from <= end && to >= start;
}

/**
 * Публичный срез каталога: что за модель, сколько всего и сколько свободно.
 *
 * Собирается отдельной функцией, а не фильтрацией готового списка на стороне
 * сайта: фильтр на фронте означает, что номера всё равно уехали в браузер и их
 * видно в отладчике. Здесь их нет с самого начала — ни item_id, ни
 * serial_number, ни inventory_number. По ним ищут технику, когда она пропала.
 */
function handlePublicCatalog(payload) {
  var today = new Date().toISOString().substring(0, 10);
  var from = parseRuDate(payload.from) || today;
  var to = parseRuDate(payload.to) || from;
  // Перепутанные местами даты — обычная опечатка в форме, а не повод отказывать.
  if (to < from) { var swap = from; from = to; to = swap; }

  var avail = availabilityFor(from, to);

  // Название берём из справочника моделей: в Equipment оно повторяется у каждой
  // единицы и могло разъехаться, а Models — единственное место, где оно одно.
  var names = {};
  readRows(getSheet(SHEETS.MODELS)).forEach(function (m) {
    names[m.category + "|" + pad2(Number(m.model_code))] = m.model_name;
  });
  var labels = {};
  categories().forEach(function (c) { labels[c.code] = c.label; });

  var models = [];
  for (var key in avail) {
    var a = avail[key];
    if (!a.total) continue;
    var parts = key.split("|");
    models.push({
      category: parts[0],
      category_label: labels[parts[0]] || parts[0],
      model_code: parts[1],
      model_name: names[key] || a.model_name || "",
      total: a.total,
      free: a.free,
    });
  }
  models.sort(function (x, y) {
    if (x.category_label !== y.category_label) return x.category_label < y.category_label ? -1 : 1;
    return String(x.model_name).localeCompare(String(y.model_name), "ru");
  });
  return { from: from, to: to, models: models };
}

function warehouseSummary() {
  var today = new Date().toISOString().substring(0, 10);
  var out = {
    items: 0, available: 0, rented: 0, in_repair: 0, retired: 0,
    open_transactions: 0, overdue_transactions: 0,
    open_defects: 0,
    orders: 0, orders_new: 0, orders_issued: 0, orders_overdue: 0,
    staff: 0, staff_active: 0, admins: 0,
  };

  readRows(getSheet(SHEETS.EQUIPMENT)).forEach(function (r) {
    out.items += 1;
    if (r.status === "Available") out.available += 1;
    else if (r.status === "Rented") out.rented += 1;
    else if (r.status === "In Repair") out.in_repair += 1;
    else if (r.status === "Retired") out.retired += 1;
  });

  var txRows = readRows(getSheet(SHEETS.TRANSACTIONS));
  txRows.forEach(function (t) {
    if (t.status !== "Open") return;
    out.open_transactions += 1;
    var due = String(t.expected_return_at || "").substring(0, 10);
    if (due && due < today) out.overdue_transactions += 1;
  });

  readRows(getSheet(SHEETS.DEFECTS)).forEach(function (d) {
    if (d.status === "Open") out.open_defects += 1;
  });

  var counts = orderCounts(txRows);
  readRows(getSheet(SHEETS.ORDERS)).forEach(function (o) {
    out.orders += 1;
    var status = orderStatus(o, counts[String(o.order_id)]);
    if (status === "New") out.orders_new += 1;
    if (status === "Issued") {
      out.orders_issued += 1;
      if (o.return_date && String(o.return_date).substring(0, 10) < today) out.orders_overdue += 1;
    }
  });

  readRows(getSheet(SHEETS.STAFF)).forEach(function (r) {
    out.staff += 1;
    if (isTruthyCell(r.active)) out.staff_active += 1;
    if (r.role === "Admin") out.admins += 1;
  });

  return out;
}

function settingsHints() {
  var out = {};
  for (var key in SETTINGS_SPEC) out[key] = SETTINGS_SPEC[key].hint;
  return out;
}

function handleSettingsSet(payload, token) {
  requireAdmin(token);
  var incoming = payload.settings || {};
  var saved = {}, rejected = [];
  for (var key in incoming) {
    var spec = SETTINGS_SPEC[key];
    if (!spec) { rejected.push(key + ": неизвестная настройка"); continue; }
    var value = spec.text ? String(incoming[key]).trim() : Number(incoming[key]);
    if (!spec.text && !isFinite(value)) { rejected.push(key + ": нужно число"); continue; }
    if (!spec.check(value)) { rejected.push(key + ": " + spec.hint); continue; }
    metaSet("setting_" + key, value);
    saved[key] = value;
  }
  // Отказ не тихий: иначе человек поменял бы значение, увидел «сохранено» и
  // получил старое поведение.
  if (rejected.length) throw apiError(400, "Не сохранено — " + rejected.join("; "));
  return { settings: getSettings(), saved: saved };
}

// Сколько позиций уже собрано по этой категории. От этого зависит, можно ли
// менять её номер: номер вшит в номер предмета и уехал на этикетки.
function categoryUsage(code) {
  var num = categoryNum(code);
  return readRows(getSheet(SHEETS.EQUIPMENT)).filter(function (r) {
    return r.category === code || String(r.item_id).slice(0, 2) === num;
  }).length;
}

function handleCategoryCreate(payload, token) {
  requireAdmin(token);
  var code = String(payload.code || "").trim().toUpperCase();
  var label = String(payload.label || "").trim();
  if (!/^[A-Z]{3}$/.test(code)) throw apiError(400, "Код категории — три латинские буквы, например BAT");
  if (!label) throw apiError(400, "Укажите название категории");

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var existing = categories();
    if (existing.some(function (c) { return c.code === code; })) {
      throw apiError(409, "Категория с таким кодом уже есть");
    }
    // Номер выдаём сами, следующий свободный: заданный руками номер рано или
    // поздно совпал бы с чужим, а это два предмета с одинаковым номером.
    var maxNum = existing.reduce(function (m, c) { return Math.max(m, Number(c.num)); }, 0);
    if (maxNum >= 99) throw apiError(409, "Свободных номеров категорий больше нет (предел 99)");
    var num = pad2(maxNum + 1);

    appendRow(getSheet(SHEETS.CATEGORIES), {
      code: code, num: num, label: label,
      by_qty: isTruthyCell(payload.by_qty) ? "TRUE" : "FALSE",
      created_at: new Date().toISOString(),
    });
    return { code: code, num: num, label: label, by_qty: isTruthyCell(payload.by_qty) };
  } finally {
    lock.releaseLock();
  }
}

function handleCategoryUpdate(payload, token) {
  requireAdmin(token);
  var code = String(payload.code || "").trim().toUpperCase();
  var sheet = getSheet(SHEETS.CATEGORIES);
  var row = findRowByValue(sheet, "code", code);
  if (!row) throw apiError(404, "Категория не найдена");

  var patch = {};
  if (payload.label !== undefined) {
    var label = String(payload.label).trim();
    if (!label) throw apiError(400, "Название не может быть пустым");
    patch.label = label;   // название только для людей, меняется свободно
  }

  if (payload.num !== undefined && pad2(Number(payload.num)) !== pad2(Number(row.num))) {
    var used = categoryUsage(code);
    if (used) {
      throw apiError(409, "В категории уже " + used + " позиций. Номер вшит в их " +
        "номера и напечатан на этикетках — сменить его нельзя. Название менять можно.");
    }
    var wanted = pad2(Number(payload.num));
    if (!/^\d{2}$/.test(wanted) || Number(wanted) < 1) throw apiError(400, "Номер категории — две цифры от 01 до 99");
    if (categories().some(function (c) { return c.code !== code && c.num === wanted; })) {
      throw apiError(409, "Этот номер уже занят другой категорией");
    }
    patch.num = wanted;
  }

  // Переключение способа учёта меняет смысл уже заведённых строк: там, где была
  // одна вещь, вдруг оказывается «одна штука из кучи». На пустой категории это
  // безобидно, на заполненной — тихая порча данных.
  if (payload.by_qty !== undefined && isTruthyCell(payload.by_qty) !== isTruthyCell(row.by_qty)) {
    var filled = categoryUsage(code);
    if (filled) {
      throw apiError(409, "В категории уже " + filled + " позиций. Способ учёта " +
        "меняется только у пустой категории: иначе поштучные записи молча стали бы " +
        "количеством.");
    }
    patch.by_qty = isTruthyCell(payload.by_qty) ? "TRUE" : "FALSE";
  }

  if (!Object.keys(patch).length) return { code: code, changed: false };
  updateRow(sheet, row.__row, patch);
  return { code: code, changed: true };
}

// Обслуживание из приложения: те же функции, что в редакторе Apps Script.
// Нужны потому, что с телефона открывать редактор и жать «Run» мучительно.
function handleMaintenance(payload, token) {
  requireAdmin(token);
  var action = String(payload.action || "");
  if (action === "archive") return { message: archiveJournal() };
  if (action === "trim") return { message: trimJournal() };
  throw apiError(400, "Неизвестное действие обслуживания");
}

// Полное удаление сотрудника. История при этом не страдает: в журнале рядом с
// номером лежит имя, поэтому «кто выдавал» читается и после удаления строки.
function handleStaffDelete(payload, token) {
  var me = requireOwner(token);
  var sheet = getSheet(SHEETS.STAFF);
  var target = findRowByValue(sheet, "staff_id", payload.staff_id);
  if (!target) throw apiError(404, "Сотрудник не найден");

  if (String(target.staff_id) === String(me.staff_id)) {
    throw apiError(409, "Нельзя удалить самого себя");
  }
  // Отдельным сообщением: это не «нельзя удалить админа», а «эту роль не
  // удаляют вовсе». Спрашивают об этом именно так.
  if (isOwnerId(target.staff_id)) {
    throw apiError(409, "Главного администратора удалить нельзя — права можно только передать");
  }

  // Читаем строку заново прямо перед удалением. __row — это номер строки на
  // момент чтения листа; если между чтением и удалением лист сдвинулся, по
  // старому номеру удалился бы СОСЕД — например, тот, кто удаляет.
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var fresh = findRowByValue(sheet, "staff_id", payload.staff_id);
    if (!fresh) throw apiError(404, "Сотрудник не найден");
    if (String(fresh.staff_id) !== String(target.staff_id)) {
      throw apiError(409, "Список сотрудников изменился, откройте его заново");
    }
    sheet.deleteRow(fresh.__row);
    return { staff_id: fresh.staff_id, full_name: fresh.full_name };
  } finally {
    lock.releaseLock();
  }
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
  } else if (isOwnerId(targetId)) {
    // Иначе смена главных прав делается в обход передачи: сбросил PIN, вошёл
    // под ним — и ты главный.
    throw apiError(409, "PIN главного администратора меняет только он сам");
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

// ---------------------------------------------------------------------
// Справочник категорий и настройки
// ---------------------------------------------------------------------

// Категории читаем из листа Categories. Если лист пуст или побит — берём
// умолчания из константы: собрать номер предмета по сломанному справочнику
// хуже, чем собрать его по заведомо верному умолчанию.
function categories() {
  var rows = [];
  try {
    rows = readRows(getSheet(SHEETS.CATEGORIES));
  } catch (e) {
    rows = [];
  }
  var seen = {}, nums = {}, clean = [];
  rows.forEach(function (r) {
    var code = String(r.code || "").trim();
    var num = pad2(Number(r.num));
    if (!code || !/^\d{2}$/.test(num)) return;
    // Дубли кода или номера — это сломанный справочник: два предмета получили
    // бы один номер. Такую строку пропускаем.
    if (seen[code] || nums[num]) return;
    seen[code] = true;
    nums[num] = true;
    clean.push({
      code: code, num: num, label: String(r.label || code).trim() || code,
      by_qty: isTruthyCell(r.by_qty),
    });
  });
  if (clean.length) return clean;

  var fallback = [];
  for (var code in CATEGORY_CODES) {
    fallback.push({
      code: code, num: CATEGORY_CODES[code], label: CATEGORY_LABELS[code] || code,
      by_qty: !!CATEGORY_BY_QTY[code],
    });
  }
  return fallback;
}

// Количество у позиции. Пустая ячейка — это старая строка, заведённая до
// появления количества: она описывает одну вещь, а не ноль вещей.
function itemQty(item) {
  var n = Number(item.qty);
  return n > 0 ? n : 1;
}

function categoryByQty(code) {
  var found = categories().filter(function (c) { return c.code === code; })[0];
  return found ? !!found.by_qty : !!CATEGORY_BY_QTY[code];
}

function categoryNum(code) {
  var found = categories().filter(function (c) { return c.code === code; })[0];
  if (found) return found.num;
  var other = categories().filter(function (c) { return c.code === "OTH"; })[0];
  return other ? other.num : "06";
}

// Настройки: описаны в одном месте — имя, умолчание и проверка. Живут в Meta,
// правятся из админки. Проверка нужна, чтобы «0 попыток до блокировки» или
// отрицательный срок сессии нельзя было сохранить и запереть себя снаружи.
var SETTINGS_SPEC = {
  session_ttl_hours: {
    def: SESSION_TTL_MS / 3600000,
    check: function (v) { return v >= 1 && v <= 720; },
    hint: "от 1 часа до 30 суток",
  },
  max_login_attempts: {
    def: MAX_LOGIN_ATTEMPTS,
    check: function (v) { return v >= 3 && v <= 20; },
    hint: "от 3 до 20 попыток",
  },
  login_lock_minutes: {
    def: LOGIN_LOCK_MS / 60000,
    check: function (v) { return v >= 1 && v <= 1440; },
    hint: "от 1 минуты до суток",
  },
  import_source_id: {
    def: IMPORT_SOURCE_ID,
    text: true,
    check: function (v) { return v === "" || /^[A-Za-z0-9_-]{20,}$/.test(v); },
    hint: "идентификатор таблицы Google (из её адреса) или пусто",
  },
  // Куда бот пишет. Сам токен здесь не хранится и храниться не должен: он
  // лежит в Script Properties, потому что настройки отдаются всякому вошедшему,
  // а токен — это полный доступ к боту.
  notify_chat_id: {
    def: "",
    text: true,
    check: function (v) { return v === "" || /^-?\d{5,20}$/.test(v); },
    hint: "числовой id чата склада (у групп он отрицательный) или пусто — тогда бот молчит",
  },
  // Сайт проката. Пока адреса нет, кнопки на главной тоже нет: пустая кнопка,
  // ведущая в никуда, хуже её отсутствия. Только https: Telegram открывает
  // ссылку своим встроенным браузером, и http он либо не откроет, либо откроет
  // с предупреждением.
  site_url: {
    def: "",
    text: true,
    check: function (v) { return v === "" || /^https:\/\/[^\s]+$/.test(v); },
    hint: "адрес сайта проката целиком, начиная с https:// — или пусто",
  },
};

function getSettings() {
  var out = {};
  for (var key in SETTINGS_SPEC) {
    var spec = SETTINGS_SPEC[key];
    var raw = metaGet("setting_" + key);
    if (raw === "" || raw === null || raw === undefined) {
      out[key] = spec.def;
      continue;
    }
    out[key] = spec.text ? String(raw) : Number(raw);
    if (!spec.text && !isFinite(out[key])) out[key] = spec.def;
  }
  return out;
}

function sessionTtlMs() { return getSettings().session_ttl_hours * 60 * 60 * 1000; }
function importSourceId() { return getSettings().import_source_id || IMPORT_SOURCE_ID; }

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
  var cat = categoryNum(category);
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

// Одна и та же вещь бывает записана двумя разными именами: маркетинговым и
// каталожным. Sony A7 IV и Sony ILCE-7M4 — один и тот же аппарат, и без
// сведения он становится двумя моделями с разными кодами: 30 единиц получают
// номера из одного блока, 30 — из другого, хотя на полке это одна позиция.
//
// normalizeModelName такое не чинит и не должна: она приводит написание
// (регистр, дефисы, кириллические двойники), а «A7 IV = ILCE-7M4» — знание о
// технике, а не о буквах. Поэтому список ведётся руками.
//
// Слева — как называть в каталоге, справа — что считать тем же самым.
var MODEL_ALIASES = [
  { name: "Sony ILCE-7M4", aliases: ["Sony A7 IV", "Sony A7IV", "Sony Alpha 7 IV", "Sony A7 4"] },
];

var MODEL_ALIAS_INDEX = null;

function canonicalModelName(name) {
  if (!MODEL_ALIAS_INDEX) {
    MODEL_ALIAS_INDEX = {};
    MODEL_ALIASES.forEach(function (entry) {
      MODEL_ALIAS_INDEX[normalizeModelName(entry.name)] = entry.name;
      entry.aliases.forEach(function (alias) {
        MODEL_ALIAS_INDEX[normalizeModelName(alias)] = entry.name;
      });
    });
  }
  var found = MODEL_ALIAS_INDEX[normalizeModelName(name)];
  return found || String(name || "").trim();
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
  var key = "unit_" + categoryNum(category) + pad2(modelCode);
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
  var name = canonicalModelName(modelName);
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
  if (!issuedAt || Date.now() - issuedAt > sessionTtlMs()) {
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

// --- Главный администратор ---
//
// Он один на систему, и его нельзя ни удалить, ни отключить, ни понизить —
// права можно только передать. Иначе система теряется вместе с человеком: один
// администратор снимает другого, и войти становится некому.
//
// Хранится ключом в Meta, а не ролью в Staff: роль правится двумя кликами прямо
// в таблице, и «главным» стал бы кто угодно с доступом к файлу. Ключ меняется
// только передачей через приложение.
function ownerId() {
  var stored = String(metaGet("owner_staff_id") || "").trim();
  if (stored) return stored;
  // Таблицы, заведённые до появления главного администратора: им становится
  // самый первый созданный администратор — тот, с кого система началась.
  var admins = readRows(getSheet(SHEETS.STAFF)).filter(function (r) {
    return r.role === "Admin";
  });
  if (!admins.length) return "";
  admins.sort(function (a, b) { return Number(a.staff_id) - Number(b.staff_id); });
  metaSet("owner_staff_id", admins[0].staff_id);
  return String(admins[0].staff_id);
}

function isOwnerId(staffId) {
  var owner = ownerId();
  return !!owner && String(staffId) === owner;
}

function requireOwner(token) {
  var staffRow = checkAuth(token);
  if (!isOwnerId(staffRow.staff_id)) {
    throw apiError(403, "Действие доступно только главному администратору");
  }
  return staffRow;
}
