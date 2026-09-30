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
  // Журнал служебных событий: ошибки сервера, отказы Telegram, несобравшиеся
  // акты. Владелец решил, что такое в чат склада не идёт — там только заявки и
  // акты, — а служебное лежит здесь и смотрится в самой таблице.
  LOGS: "Logs",
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
  MON: "Мониторы и трансляция",
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
  // section: витрина сайта делится на разделы КИНО и ФОТО, и делится по
  // модели, а не по категории: объектив и камера служат и тому и другому.
  // Значения CINE, PHOTO или "CINE,PHOTO". Пусто — не размечено, и такая
  // модель видна в обоих разделах: забытая отметка не должна прятать
  // технику с витрины.
  // price: стоимость единицы для акта о материальной ответственности. Нигде
  // больше её нет — ни в исходной таблице колледжа, ни в заявках с сайта.
  // Пусто — акт ставит прочерк, а не ноль: ноль в таком документе означает
  // «вещь ничего не стоит», а это неправда.
  Models: ["category", "model_code", "model_name", "created_at", "section", "price"],
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
           "project", "issue_date", "issue_time", "return_date", "return_time",
           "extra_input", "amount", "currency",
           "source_url", "status", "raw_text", "created_at", "created_by",
           // archived_at: заказ убран с глаз, но не из таблицы. Удалять записи
           // о договорённостях нельзя — «мало ли что», и это правильно.
           // act_url: акт сдачи-приёмки. Собирается сам при появлении заказа,
           // ссылка уходит в чат и остаётся в строке — чтобы не собирать
           // документ заново на каждый взгляд на заказ.
           "created_by_name", "closed_at", "archived_at", "act_url"],

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
  // Журнал служебных событий (см. logEvent). context — JSON с подробностями,
  // обрезанный: ячейка не резиновая, а стек на пару экранов читать некому.
  Logs: ["timestamp", "kind", "endpoint", "reason", "message", "context"],
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
  // Журнал — целиком текст: время строкой не сползает в дату с чужим поясом, а
  // код ошибки Telegram «400» не становится числом.
  Logs: ["timestamp", "kind", "endpoint", "reason", "message", "context"],
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

// ---------------------------------------------------------------------
// Ночное обслуживание: копия таблицы и подрезка журнала Logs
// ---------------------------------------------------------------------
// Работает без разработчика: setupTriggers() один раз запускается руками из
// редактора (как setupSheets), дальше dailyMaintenance идёт сам каждую ночь.
// В чат ничего не пишет — неудачи только в лист Logs (logEvent).
// Об успехе строку не пишем: копия видна в папке на Диске, а журнал, куда
// каждую ночь ложится «всё хорошо», распухает и прячет настоящие отказы.

var BACKUP_FOLDER_NAME = "Mifs Rent — копии";
var BACKUP_KEEP = 14;          // сколько последних копий держать в папке
var LOGS_KEEP_DAYS = 90;       // сколько дней держать строки журнала Logs
var MAINTENANCE_HOUR = 3;      // час запуска, по часовому поясу скрипта

// Точка входа для триггера. Каждый шаг в своём try: сломанная копия не должна
// отменять подрезку журнала, и наоборот. Наружу не бросаем — иначе Google
// шлёт владельцу письмо об ошибке триггера, а разбирать его некому.
function dailyMaintenance() {
  try { dailyBackup(); } catch (e) {
    logEvent("backup", "dailyMaintenance", "exception", e && e.message ? e.message : String(e));
  }
  try { trimLogs(); } catch (e) {
    logEvent("maintenance", "trimLogs", "exception", e && e.message ? e.message : String(e));
  }
}

/**
 * Копирует всю таблицу в папку «Mifs Rent — копии» под именем
 * «Mifs Rent ГГГГ-ММ-ДД» и оставляет в папке только BACKUP_KEEP свежих копий,
 * остальные — в корзину Диска (оттуда их ещё 30 дней можно достать).
 * Неудачу пишет в Logs и не бросает.
 */
function dailyBackup() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // Папка — как в archiveJournal: нашли по имени или создали.
    var folders = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
    var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER_NAME);
    var name = "Mifs Rent " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    DriveApp.getFileById(ss.getId()).makeCopy(name, folder);

    var copies = [];
    var it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (!f.isTrashed()) copies.push(f);
    }
    copies.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
    var trashed = 0;
    copies.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); trashed++; });

    var message = "Копия «" + name + "» сохранена в папку «" + BACKUP_FOLDER_NAME +
      "». Убрано старых копий: " + trashed + ".";
    Logger.log(message);
    return message;
  } catch (e) {
    var err = e && e.message ? e.message : String(e);
    logEvent("backup", "dailyBackup", "failed", err, { folder: BACKUP_FOLDER_NAME });
    Logger.log("Копия таблицы не сделана: " + err);
    return "Копия таблицы не сделана: " + err;
  }
}

// Удаляет из Logs строки старше LOGS_KEEP_DAYS дней. Строку с нечитаемой
// датой оставляем: лучше лишняя строка, чем потерянная.
function trimLogs() {
  var cutoff = Date.now() - LOGS_KEEP_DAYS * 24 * 60 * 60 * 1000;
  var removed = trimSheetRows(getSheet(SHEETS.LOGS), function (row) {
    var t = new Date(row.timestamp).getTime();
    return !isNaN(t) && t < cutoff;
  });
  Logger.log("Журнал Logs подрезан: удалено строк " + removed + ".");
  return removed;
}

/**
 * Ставит ночной триггер обслуживания. Запускать руками из редактора, как
 * setupSheets; повторный запуск безопасен. Снимает прежние триггеры
 * dailyMaintenance и убранного dailyOverdueDigest, затем ставит один новый.
 */
function setupTriggers() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === "dailyMaintenance" || h === "dailyOverdueDigest") {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  // atHour — по часовому поясу скрипта; Google сам выбирает минуту в пределах часа.
  ScriptApp.newTrigger("dailyMaintenance").timeBased().everyDays(1).atHour(MAINTENANCE_HOUR).create();

  var message = "Триггеры: снято старых " + removed + ", поставлен ежедневный dailyMaintenance " +
    "около " + MAINTENANCE_HOUR + ":00 (" + Session.getScriptTimeZone() + "): копия таблицы в папку «" +
    BACKUP_FOLDER_NAME + "» (хранится " + BACKUP_KEEP + ") и подрезка Logs старше " +
    LOGS_KEEP_DAYS + " дней.";
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
      case "/public/order": data = handlePublicOrder(payload); break;
      case "/act/template": data = handleActTemplate(payload, token); break;
      case "/act/build": data = handleActBuild(payload, token); break;
      case "/item/lookup": data = handleItemLookup(payload, token); break;
      case "/item/create": data = handleItemCreate(payload, token); break;
      case "/item/numbers": data = handleItemNumbers(payload, token); break;
      case "/transaction/checkout": data = handleTransactionCheckout(payload, token); break;
      case "/transaction/checkin": data = handleTransactionCheckin(payload, token); break;
      case "/defect/report": data = handleDefectReport(payload, token); break;
      case "/defect/resolve": data = handleDefectResolve(payload, token); break;
      case "/equipment/list": data = handleEquipmentList(payload, token); break;
      case "/models/list": data = handleModelsList(payload, token); break;
      case "/models/sections": data = handleModelsSections(payload, token); break;
      case "/models/price": data = handleModelsPrice(payload, token); break;
      case "/model/create": data = handleModelCreate(payload, token); break;
      case "/order/parse": data = handleOrderParse(payload, token); break;
      case "/order/create": data = handleOrderCreate(payload, token); break;
      case "/orders/list": data = handleOrdersList(payload, token); break;
      case "/order/card": data = handleOrderCard(payload, token); break;
      case "/order/update": data = handleOrderUpdate(payload, token); break;
      case "/order/line-update": data = handleOrderLineUpdate(payload, token); break;
      case "/order/issue": data = handleOrderIssue(payload, token); break;
      case "/order/archive": data = handleOrderArchive(payload, token); break;
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
      case "/notify/chats": data = handleNotifyChats(payload, token); break;
      case "/notify/hello": data = handleNotifyHello(payload, token); break;
      case "/notify/webhook": data = handleNotifyWebhook(payload, token); break;
      // Прежняя проверка связи остаётся: выложенное приложение обновляется
      // не в ту же секунду, что таблица, и ручка не должна исчезать из-под него.
      case "/notify/test": data = handleNotifyTest(payload, token); break;
      case "/labels/send": data = handleLabelsSend(payload, token); break;
      case "/model/move": data = handleModelMove(payload, token); break;
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
    // Непредвиденная ошибка — в журнал. Только имя ручки, текст и стек: ни
    // токена, ни тела запроса (там телефоны и ФИО).
    logEvent("error", endpoint, "exception", err && err.message ? err.message : String(err),
      err && err.stack ? { stack: String(err.stack) } : "");
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

  var pinOk = staffRow && verifyPin(pin, staffRow.pin_hash) && isTruthyCell(staffRow.active);
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
  var fresh = {
    session_token: token,
    token_issued_at: new Date().toISOString(),
    failed_attempts: 0,
    locked_until: "",
  };
  // Запись в старом формате переезжает на новый прямо здесь: строку мы всё
  // равно перезаписываем, так что лишнего обращения к таблице не будет.
  if (isLegacyPinHash(staffRow.pin_hash)) fresh.pin_hash = makePinHash(pin);
  updateRow(sheet, staffRow.__row, fresh);
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
// Проверка на занятость обязательна: по этим номерам ищут технику, а повторный
// импорт считает одинаковый заводской номер одной и той же вещью (seenSerial в
// importInventory) и вторую строку пропускает — то есть дубль означает
// потерянную единицу.
//
// item_id здесь не меняется: он собран из категории и модели и меняется только
// переносом модели (/model/move).
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

var SECTIONS = ["CINE", "PHOTO"];

// Раздел хранится строкой через запятую. Наружу и внутрь ходит тот же вид:
// "CINE", "PHOTO", "CINE,PHOTO" или пусто.
function normalizeSection(value) {
  var parts = String(value || "").toUpperCase().split(/[,;\s]+/);
  var out = [];
  SECTIONS.forEach(function (code) {
    if (parts.indexOf(code) !== -1) out.push(code);
  });
  return out.join(",");
}

// Пустое значение законно — это «не размечено». Незнакомое отклоняем: молча
// проглоченная опечатка спрячет позицию из обоих разделов.
function checkSection(value) {
  var raw = String(value || "").trim();
  if (!raw) return "";
  var clean = normalizeSection(raw);
  if (!clean) {
    throw apiError(400, "Неизвестный раздел: " + raw + ". Допустимо CINE, PHOTO или оба.");
  }
  return clean;
}

// Дописать недостающие колонки в лист, ничего не тронув.
//
// Нужно, чтобы новая колонка появлялась сама, а не требовала человека с
// редактором Apps Script: строки пишутся по заголовкам, и без заголовка
// значение молча теряется.
function ensureColumns(sheet, names) {
  var existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var missing = names.filter(function (n) { return existing.indexOf(n) === -1; });
  if (!missing.length) return 0;
  sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  return missing.length;
}

// Разметка моделей по разделам витрины, пачкой.
//
// Пачкой, а не по одной: 85 моделей по запросу — это 85 раз по 5–8 секунд,
// то есть час ожидания вместо одного действия.
function handleModelsSections(payload, token) {
  requireAdmin(token);
  var list = payload.models;
  if (!list || !list.length) throw apiError(400, "Нечего размечать: список пуст");

  // Значения проверяем ДО записи: иначе половина уедет в таблицу, а вторая
  // упадёт на опечатке, и понять, что применилось, будет уже нельзя.
  var wanted = list.map(function (row) {
    return {
      category: String(row.category || "").trim().toUpperCase(),
      model_code: pad2(Number(row.model_code)),
      section: checkSection(row.section),
    };
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var sheet = getSheet(SHEETS.MODELS);
    ensureColumns(sheet, ["section"]);
    var rows = readRows(sheet);
    var byKey = {};
    rows.forEach(function (r) {
      byKey[r.category + "|" + pad2(Number(r.model_code))] = r;
    });

    var changed = 0, missing = [];
    wanted.forEach(function (w) {
      var row = byKey[w.category + "|" + w.model_code];
      if (!row) { missing.push(w.category + "·" + w.model_code); return; }
      if (normalizeSection(row.section) === w.section) return;
      updateRow(sheet, row.__row, { section: w.section });
      changed += 1;
    });
    return { changed: changed, asked: wanted.length, missing: missing };
  } finally {
    lock.releaseLock();
  }
}

// Цена модели — для акта о материальной ответственности. Отдельным
// эндпоинтом, а не вместе с разделом: раздел правит витрину, цена — документ,
// и путать их в одном запросе незачем.
function handleModelsPrice(payload, token) {
  requireAdmin(token);
  var category = String(payload.category || "").trim().toUpperCase();
  var code = pad2(Number(payload.model_code));
  // Пустая строка — «цены нет», и это допустимо: акт поставит прочерк.
  var raw = String(payload.price === undefined || payload.price === null ? "" : payload.price).trim();
  var price = raw === "" ? "" : Number(raw.replace(/\s/g, "").replace(",", "."));
  if (price !== "" && (!isFinite(price) || price < 0)) {
    throw apiError(400, "Цена — неотрицательное число или пусто");
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var sheet = getSheet(SHEETS.MODELS);
    ensureColumns(sheet, ["price"]);
    var row = null;
    readRows(sheet).forEach(function (r) {
      if (r.category === category && pad2(Number(r.model_code)) === code) row = r;
    });
    if (!row) throw apiError(404, "Такой модели нет: " + category + "·" + code);
    updateRow(sheet, row.__row, { price: price });
    return { category: category, model_code: code, price: price };
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
    return { category: r.category, model_code: pad2(Number(r.model_code)),
             model_name: r.model_name, section: normalizeSection(r.section),
             // Цена для акта. Пустая строка, а не ноль: «не задана» и «ничего
             // не стоит» — разные вещи, и в акте они выглядят по-разному.
             price: r.price === "" || r.price === null || r.price === undefined
               ? "" : Number(r.price) };
  }).sort(function (a, b) { return String(a.model_name).localeCompare(String(b.model_name)); });
}

// Перенос модели в другую категорию — С ПЕРЕНУМЕРАЦИЕЙ вещей: номер XXYYZZ
// начинается с номера категории, и без перенумерации он разойдётся с
// содержимым.
//
// Это возможно, только пока этикетки не напечатаны: напечатанная этикетка со
// старым номером после переноса врёт. Когда печать начнётся, понадобится
// развилка «сохранить номера или перенумеровать».
//
// Номер вещи — ссылка: на него смотрят журнал выдач, дефекты и сверки. Их
// переписываем тоже, иначе у вещи отвяжется вся история.
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
// «10:00» из чего угодно похожего. Мусор отбрасываем: пустое поле честнее
// выдуманного времени.
function normalizeTime(value) {
  var m = String(value || "").match(/(\d{1,2})\s*[:.\-]?\s*(\d{2})/);
  if (!m) return "";
  var h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return "";
  return (h < 10 ? "0" + h : String(h)) + ":" + (min < 10 ? "0" + min : String(min));
}

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
    // Время — просто «10:00». Отдельной колонкой, а не приклеенным к дате:
    // дату складу надо сравнивать, а время он читает глазами.
    issue_time: normalizeTime(pickField(fields, ["Time_of_issue", "issue_time"])),
    return_date: parseRuDate(pickField(fields, ["Date_completion", "Date_of_completion", "return_date"])),
    return_time: normalizeTime(pickField(fields, ["Time_completion", "Time_of_completion", "return_time"])),
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
  var res = writeOrder(payload, staffRow.staff_id, staffRow.full_name);
  res.act_url = autoAct(res.order_id, staffRow.full_name);
  return res;
}

// Акт собирается сам, как только заказ появился, и ссылка уходит в чат — так
// это и работало до переделки. Кнопки «собрать акт» нет и не будет: акт нужен
// всегда, а значит его незачем просить.
//
// Отдельно от записи заказа и после снятия замка: копия документа делается
// секунды, и держать на это время замок — значит подвесить всех остальных.
// Неудача акта заказ не отменяет: заказ уже записан, а причина уходит в журнал
// Logs — в чат склада служебное не пишем.
function autoAct(orderId, masterName) {
  var settings = getSettings();
  if (!String(settings.act_template_id || "")) return "";
  try {
    var res = buildAct(orderId, masterName || "");
    return res.url;
  } catch (err) {
    logEvent("act", "autoAct", "build-failed", err && err.message ? err.message : String(err),
      { order_id: orderId });
    return "";
  }
}

// Запись заказа. Одна на два пути: складмен вставляет сообщение руками, сайт
// присылает заявку сам. Разница только в авторе строки.
function writeOrder(payload, authorId, authorName) {
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
      issue_time: normalizeTime(payload.issue_time),
      return_date: parseRuDate(payload.return_date),
      return_time: normalizeTime(payload.return_time),
      extra_input: String(payload.extra_input || ""),
      amount: Number(payload.amount || 0),
      currency: String(payload.currency || ""),
      source_url: String(payload.source_url || ""),
      status: "New",
      raw_text: String(payload.raw_text || ""),
      created_at: now,
      created_by: authorId,
      created_by_name: authorName,
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
      archived_at: String(r.archived_at || ""),
      // Ссылка на акт — чтобы открыть документ прямо из списка, не заходя в
      // заказ: на складе его открывают перед выдачей, а не после чтения
      // карточки.
      act_url: String(r.act_url || ""),
      // raw_text в список не отдаём: это всё сообщение целиком, включая даты
      // рождения. Оно нужно только в карточке одного заказа.
    };
  });

  // Архив по умолчанию не показываем, но и не прячем навсегда: отдельным
  // запросом он открывается целиком.
  rows = rows.filter(function (r) {
    return payload.archived ? !!r.archived_at : !r.archived_at;
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
var ORDER_EDITABLE = ["project", "issue_date", "issue_time", "return_date", "return_time", "extra_input",
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
      pin_hash: makePinHash(pin),
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
// Токен (TELEGRAM_BOT_TOKEN) живёт в двух серверных хранилищах — Script
// Properties (таблица) и Worker Secrets (вебхук). В репозиторий и в браузер он
// не попадает и ни одним эндпоинтом не отдаётся. Причина простая: токен бота —
// это полный доступ к нему, а настройки читает любой вошедший сотрудник.
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

// Тема форума для рода сообщений: "orders" — заявки, "acts" — акты. Всё
// остальное — General (пустая строка).
function notifyThreadId(kind) {
  var key = kind === "orders" ? "notify_thread_orders" : kind === "acts" ? "notify_thread_acts" : "";
  return key ? String(getSettings()[key] || "").trim() : "";
}

// Возвращает, что произошло, — это нужно кнопке проверки связи. Обычные вызовы
// результат игнорируют.
//
// kind выбирает тему форума (см. notifyThreadId). Тема берётся только для чата
// из настроек: у явно названного чата (приветствие, проверка связи) своих тем
// мы не знаем. Если Telegram отказал при заданной теме — её удалили или
// закрыли, — пробуем ещё раз без неё, в General: заявка не должна пропасть из-за
// темы. Тогда в ответе fallback: true.
//
// Неудача и откат в General пишутся в журнал Logs (tgSendLog), не в чат.
function tgSend(text, chatIdOverride, kind) {
  return tgSendLog(tgSendRaw(text, chatIdOverride, kind), chatIdOverride, kind);
}

// Кнопки приветствия и проверки связи (явный чат или род не задан) про «нет
// токена» и «не выбран чат» и так отвечают человеку через notifyRefusal —
// журналу там сказать нечего. Остальное — отказ Telegram, сеть, откат из темы в
// General — пишется всегда: иначе заявка, не дошедшая до чата, пропала бы молча.
function tgSendLog(res, chatIdOverride, kind) {
  var fromButton = !!chatIdOverride || !kind;
  var setupGap = res.reason === "no-token" || res.reason === "no-chat";
  if (!res.ok && !(setupGap && fromButton)) {
    logEvent("telegram", "sendMessage", res.reason, res.error || "",
      { kind: kind || "", fallback: !!res.fallback });
  } else if (res.fallback) {
    logEvent("telegram", "sendMessage", "fallback",
      "Тема форума не приняла сообщение, ушло в General. Проверьте id темы в настройках.",
      { kind: kind || "", thread: notifyThreadId(kind) });
  }
  return res;
}

function tgSendRaw(text, chatIdOverride, kind) {
  var token = botToken();
  var chatId = String(chatIdOverride || notifyChatId());
  if (!token) return { ok: false, reason: "no-token" };
  if (!chatId) return { ok: false, reason: "no-chat" };
  var thread = chatIdOverride ? "" : notifyThreadId(kind);
  function send(withThread) {
    var msg = { chat_id: chatId, text: text, parse_mode: "HTML", disable_web_page_preview: true };
    if (withThread) msg.message_thread_id = Number(thread);
    var res = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(msg),
      muteHttpExceptions: true,
    });
    return JSON.parse(res.getContentText() || "{}");
  }
  try {
    var body = send(!!thread);
    var fallback = false;
    if (!body.ok && thread) {
      body = send(false);
      fallback = true;
    }
    var out = body.ok ? { ok: true } : { ok: false, reason: "telegram", error: body.description || "" };
    if (fallback) out.fallback = true;
    return out;
  } catch (e) {
    return { ok: false, reason: "network", error: String(e) };
  }
}

// Этикетки в чат больше не отправляем: владелец решил, что картинки в Telegram
// не идут ни в каком виде. Ручка остаётся ради закэшированных версий
// приложения — вместо молчаливого «неизвестный эндпоинт» они покажут, куда
// теперь нажимать.
function handleLabelsSend(payload, token) {
  checkAuth(token);
  throw apiError(410, "Отправка этикеток в чат отключена. В Telegram сохраняйте по одной " +
    "(кнопка «Сохранить»), пачкой — кнопкой «Печать» или откройте приложение в браузере.");
}

// Экранирование для parse_mode "HTML": всё, что пришло из таблицы, формы или
// от сотрудника, идёт в сообщение только через неё. Скопировано с escapeHtml
// из app/js/util.js.
function tgEscape(str) {
  return String(str === undefined || str === null ? "" : str).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Блок «Покупатель» в сообщении о новой заявке. Отдельно, чтобы владелец мог
// дописать поля в одном месте. Берёт только то, что есть в fields, пустое
// пропускает. Взрослый — ФИО, телефон, ник; несовершеннолетний — сначала
// представитель, затем сам арендатор.
function tgOrderBuyerBlock(fields) {
  var adult = String(fields.is_adult).toUpperCase() !== "FALSE";
  var lines = [];
  function add(label, value) {
    value = String(value || "").trim();
    if (value) lines.push((label ? label + ": " : "") + tgEscape(value));
  }
  if (adult) {
    add("", fields.student_name);
    add("Телефон", fields.student_phone);
    add("Telegram", fields.student_tg);
  } else {
    add("Представитель", fields.guardian_name);
    add("Телефон представителя", fields.guardian_phone);
    add("Несовершеннолетний", fields.student_name);
    add("Телефон", fields.student_phone);
    add("Telegram", fields.student_tg);
  }
  return lines.join("\n");
}

// Предел Telegram на одно сообщение.
var TG_MAX_LEN = 4096;

// Текст сообщения о новой заявке с сайта — раскладка прежних сообщений Tilda.
// Не влезает в предел — режем список позиций, а не итог, покупателя и ссылку.
function tgOrderMessage(parsed, fields, siteUrl) {
  var items = parsed.items || [];
  var total = 0;
  var itemLines = items.map(function (it, i) {
    var sum = Math.round(Number(it.total) || 0);
    var unit = Number(it.price) || 0;
    total += sum;
    return (i + 1) + ". " + tgEscape(it.raw_name) + ": " + sum + " (" +
      (Number(it.qty) || 0) + " x " + (unit ? unit : "0.00") + ")";
  });

  var tail = ["<b>Сумма: " + total + " RUB</b>", ""];
  var buyer = tgOrderBuyerBlock(fields);
  tail.push("<b>Покупатель</b>");
  if (buyer) tail.push(buyer);
  tail.push("");

  function when(d, t) { return d ? d + (t ? " " + t : "") : ""; }
  var from = when(fields.issue_date, fields.issue_time);
  var to = when(fields.return_date, fields.return_time);
  if (from || to) tail.push("<b>Даты:</b> " + tgEscape(from || "—") + " — " + tgEscape(to || "—"));
  if (String(fields.project || "").trim()) tail.push("Проект: " + tgEscape(String(fields.project).trim()));
  var extra = String(fields.extra_input || "").trim();
  if (extra) tail.push("Дополнительно: " + tgEscape(extra.length > 500 ? extra.substring(0, 500) + "…" : extra));
  if (siteUrl) {
    tail.push("");
    tail.push('<a href="' + tgEscape(siteUrl) + '">Открыть заказ на сайте</a>');
  }

  var head = "<b>Заказ №" + tgEscape(parsed.order_no) + "</b>";
  var tailText = tail.join("\n");
  var shown = itemLines.slice();
  function build() {
    var body = shown.slice();
    if (shown.length < itemLines.length) {
      body.push("… и ещё " + (itemLines.length - shown.length) + " поз.");
    }
    return [head].concat(body).join("\n") + "\n" + tailText;
  }
  var text = build();
  while (text.length > TG_MAX_LEN && shown.length) {
    shown.pop();
    text = build();
  }
  return text;
}

// Откуда берётся id чата. Раньше инструкция звала открыть в браузере адрес
// getUpdates со вставленным токеном — то есть носить токен по адресной строке
// и истории браузера, а в Telegram на телефоне id чата попросту не показывают.
// Теперь спрашивает сам бэкенд: токен остаётся в Script Properties, а человеку
// достаётся список чатов, из которых бот слышал сообщения.
function handleNotifyChats(payload, token) {
  requireAdmin(token);
  var botTok = botToken();
  if (!botTok) {
    throw apiError(400, "Токен бота не задан. Apps Script → Project Settings → " +
      "Script Properties → добавьте свойство TELEGRAM_BOT_TOKEN со значением токена от BotFather.");
  }

  // Сначала — как зовут бота. Спрашиваем, а не держим в настройке: имя есть у
  // Telegram, и человеку незачем его где-то искать, чтобы написать команду.
  // Заодно проверяется сам токен: неверный виден здесь, а не в ту минуту,
  // когда бот должен был написать о просрочке.
  var me = telegramCall(botTok, "getMe");
  if (!me.ok) {
    throw apiError(502, "Telegram не признал токен: " +
      (me.description || "неизвестная причина") +
      ". Проверьте TELEGRAM_BOT_TOKEN в Script Properties — возможно, токен " +
      "отозван или скопирован не целиком.");
  }
  var username = String((me.result || {}).username || "");
  var command = username ? "/id@" + username : "/id";

  // Опрос остаётся для случая, когда постоянная связь выключена. При
  // включённом вебхуке Telegram запрещает getUpdates — и это не поломка, а
  // новый порядок: чаты помнит Worker и подставляет их в этот же ответ.
  var body = telegramCall(botTok, "getUpdates?limit=100");
  var webhookOn = false;
  if (!body.ok) {
    if (Number(body.error_code) === 409) body = { result: [] };
    else throw apiError(502, "Telegram отказал: " + (body.description || "неизвестная причина"));
    webhookOn = true;
  }

  // Один чат — одна строка, самое свежее сообщение сверху. В группе бот с
  // включённой приватностью слышит только команды и служебные сообщения,
  // поэтому и просим написать в чат «/id@бот».
  var seen = {};
  var chats = [];
  (body.result || []).forEach(function (u) {
    var msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
    var chat = msg && msg.chat;
    if (!chat || seen[String(chat.id)]) return;
    seen[String(chat.id)] = true;
    chats.push({
      chat_id: String(chat.id),
      title: String(chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
        chat.username || "без названия"),
      type: String(chat.type || ""),
      at: msg.date ? new Date(msg.date * 1000).toISOString() : "",
    });
  });
  chats.reverse();

  return {
    chats: chats,
    current: String(getSettings().notify_chat_id || ""),
    bot: {
      username: username,
      name: String((me.result || {}).first_name || ""),
    },
    command: command,
    webhook: webhookOn,
    hint: chats.length ? "" : (webhookOn ?
      "Пока ни одного чата. Добавьте " + (username ? "@" + username : "своего бота") +
        " в группу склада и напишите там «" + command + "» — бот ответит сам, " +
        "и чат появится здесь." :
      "Бот пока не слышал ни одного сообщения. Добавьте " +
        (username ? "@" + username : "своего бота") + " в группу склада и напишите там «" +
        command + "» — команду он слышит даже с включённой приватностью. " +
        "Если и после этого пусто — включите постоянную связь: опрос отдаёт " +
        "сообщения один раз и не дольше суток."),
  };
}

// Постоянная связь с Telegram. Вебхук — это «Telegram сам присылает события на
// наш адрес» вместо «мы по кнопке спрашиваем, не говорил ли кто чего за сутки».
// Второе оказалось ненадёжным: события живут 24 часа, и любой второй опрос
// забирает их себе навсегда — список чатов выглядел пустым при живом боте.
//
// Три действия: включить, выключить (возврат к опросу) и спросить состояние.
// Последнее — честный ответ на «связка жива?»: Telegram сам говорит, сколько
// событий ждёт доставки и что не получилось в последний раз.
function handleNotifyWebhook(payload, token) {
  requireAdmin(token);
  var botTok = botToken();
  if (!botTok) notifyRefusal({ reason: "no-token" });

  var mode = String(payload.mode || "status");

  if (mode === "on") {
    // Адрес Worker спрашивать не нужно: пустая настройка подменяется значением
    // по умолчанию (getSettings), а непустую не примет проверка формата. То
    // есть здесь всегда либо наш нынешний адрес, либо заведомо годный чужой.
    var base = String(getSettings().api_url || "").trim().replace(/\/+$/, "");
    var secret = webhookSecret(botTok);
    var set = telegramPost(botTok, "setWebhook", {
      url: base + "/tg/" + secret,
      // Тот же отпечаток уходит заголовком: Worker сверяет и адрес, и его.
      secret_token: secret,
      // Копившиеся события не нужны: чаты найдутся по первому же сообщению, а
      // отвечать на команды недельной давности незачем.
      drop_pending_updates: true,
    });
    if (!set.ok) {
      throw apiError(502, "Telegram не принял адрес: " +
        (set.description || "неизвестная причина"));
    }
    return webhookState(botTok, "Постоянная связь включена. Напишите в чате «/id» — " +
      "бот ответит сам.");
  }

  if (mode === "off") {
    var off = telegramPost(botTok, "deleteWebhook", {});
    if (!off.ok) {
      throw apiError(502, "Telegram отказал: " + (off.description || "неизвестная причина"));
    }
    return webhookState(botTok, "Постоянная связь выключена: вернулись к опросу по кнопке.");
  }

  return webhookState(botTok, "");
}

// Секрет вебхука не хранится нигде: он считается из токена бота, который есть и
// у таблицы, и у Worker. Поэтому его нечего копировать между Cloudflare и
// Apps Script и нечего потерять; смена токена меняет адрес сама.
function webhookSecret(botTok) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, botTok,
    Utilities.Charset.UTF_8);
  var out = "";
  for (var i = 0; i < 16; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

function webhookState(botTok, message) {
  var info = telegramCall(botTok, "getWebhookInfo");
  var r = (info.ok && info.result) || {};
  return {
    message: message,
    on: !!String(r.url || ""),
    url: String(r.url || ""),
    pending: Number(r.pending_update_count || 0),
    last_error: String(r.last_error_message || ""),
    last_error_at: r.last_error_date ?
      new Date(r.last_error_date * 1000).toISOString() : "",
  };
}

// setWebhook и deleteWebhook меняют состояние, поэтому POST, а не GET, как у
// telegramCall: адрес вебхука в строке запроса светился бы в журналах.
function telegramPost(botTok, method, body) {
  var res;
  try {
    res = UrlFetchApp.fetch("https://api.telegram.org/bot" + botTok + "/" + method, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(body || {}),
      muteHttpExceptions: true,
    });
  } catch (e) {
    throw apiError(502, "Не получилось спросить Telegram: " + e);
  }
  return JSON.parse(res.getContentText() || "{}");
}

// Один запрос к Telegram. Отдельно, потому что ручка спрашивает дважды —
// сначала имя бота, потом сообщения, — и разбор ответа у них общий.
function telegramCall(botTok, method) {
  var res;
  try {
    res = UrlFetchApp.fetch("https://api.telegram.org/bot" + botTok + "/" + method,
      { muteHttpExceptions: true });
  } catch (e) {
    throw apiError(502, "Не получилось спросить Telegram: " + e);
  }
  return JSON.parse(res.getContentText() || "{}");
}

// Первое, что бот говорит в чате. Раньше это была «Проверка связи: приложение
// склада на связи с этим чатом» — отчёт для того, кто нажал кнопку, а не
// сообщение для чата: из него не понять, кто написал и чего ждать дальше.
//
// Здесь бот представляется и перечисляет, о чём будет писать. Последняя строка
// с id чата — не для красоты: по ней видно, что чат тот самый, а не соседний.
function helloText(chatId) {
  var link = String(getSettings().app_link || "").trim();
  var out = [
    "Здравствуйте! Я бот склада Mifs Rent.",
    "",
    "Буду писать сюда:",
    "• новые заявки с сайта",
    "• ссылки на акты сдачи-приёмки",
    "",
  ];
  // Сообщения бота — HTML, поэтому литералы и значения экранируются.
  // Обещать кнопку, которой нет, хуже, чем промолчать: ссылка печатается
  // только когда её задали в настройках.
  if (link) out.push("Склад: " + tgEscape(link));
  out.push("Этот чат: " + tgEscape(chatId));
  return out.join("\n");
}

function handleNotifyHello(payload, token) {
  requireAdmin(token);
  var chat = String(payload.chat_id || "").trim() || notifyChatId();
  var res = tgSend(helloText(chat), chat);
  if (res.ok) return { ok: true, message: "Бот поздоровался — посмотрите в чате." };
  return notifyRefusal(res);
}

function handleNotifyTest(payload, token) {
  requireAdmin(token);
  var chat = String(payload.chat_id || "").trim();
  var res = tgSend("Проверка связи: приложение склада на связи с этим чатом.", chat);
  if (res.ok) return { ok: true, message: "Сообщение отправлено — проверьте чат." };
  return notifyRefusal(res);
}

// Почему бот не написал. Причин три, и путать их нельзя: токен, чат и отказ
// самого Telegram лечатся в разных местах. Текст один на все ручки, которые
// шлют в чат, — иначе одна и та же беда объяснялась бы по-разному.
function notifyRefusal(res) {
  if (res.reason === "no-token") {
    throw apiError(400, "Токен бота не задан. Apps Script → Project Settings → " +
      "Script Properties → добавьте свойство TELEGRAM_BOT_TOKEN со значением токена от BotFather.");
  }
  if (res.reason === "no-chat") {
    throw apiError(400, "Не выбран чат склада: нажмите «Найти чат склада» и " +
      "укажите, в какой группе работает бот.");
  }
  throw apiError(502, "Telegram отказал: " + (res.error || "неизвестная причина") +
    ". Чаще всего это значит, что бота не добавили в чат или id чата указан неверно.");
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
  var names = {}, sections = {};
  readRows(getSheet(SHEETS.MODELS)).forEach(function (m) {
    var key = m.category + "|" + pad2(Number(m.model_code));
    names[key] = m.model_name;
    sections[key] = normalizeSection(m.section);
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
      section: sections[key] || "",
      total: a.total,
      free: a.free,
    });
  }
  models.sort(function (x, y) {
    if (x.category_label !== y.category_label) return x.category_label < y.category_label ? -1 : 1;
    return String(x.model_name).localeCompare(String(y.model_name), "ru");
  });
  // Принимает ли склад заявки. Сайту это нужно заранее: показывать кнопку,
  // которая заведомо откажет, хуже, чем сразу предложить скопировать текст.
  // Наружу уходит только «да/нет» — ничего лишнего.
  return {
    from: from, to: to, models: models,
    orders_open: Number(getSettings().public_orders) === 1 ? 1 : 0,
  };
}

// Заявка прямо с сайта. Это единственная ручка, в которую пишут без входа,
// поэтому она устроена скучно и узко:
//
// — выключена, пока администратор не включит (настройка public_orders);
// — берёт ровно тот текст, который сайт и так показывает студенту, и разбирает
//   его тем же разбором, что и вставленное складменом сообщение: новых путей
//   для данных не появляется;
// — со складом ничего не делает. Строка в «Заказах» со статусом New — это
//   заявка, а не выдача; технику по-прежнему списывает человек;
// — повтор той же заявки возвращает уже созданную, а не вторую копию: ответ
//   идёт 5–20 секунд, и человек нажимает кнопку второй раз.
//
// Уведомление в чат — следствие записи, а не способ доставки: если Telegram
// недоступен, заявка всё равно в таблице.
function handlePublicOrder(payload) {
  var settings = getSettings();
  if (Number(settings.public_orders) !== 1) {
    throw apiError(403, "Приём заявок с сайта выключен");
  }
  // Поле-ловушка: в форме его не видно, человек его не заполнит.
  if (String(payload.trap || "").trim()) throw apiError(400, "Заявка не принята");

  var text = String(payload.raw_text || "");
  if (text.length < 20) throw apiError(400, "Заявка пустая");
  if (text.length > 4000) throw apiError(400, "Заявка слишком длинная");

  var parsed = parseOrderMessage(text);
  if (!parsed.order_no) throw apiError(400, "В заявке нет номера");
  if (!parsed.items.length) throw apiError(400, "В заявке нет ни одной позиции");
  if (parsed.items.length > 40) throw apiError(400, "Слишком много позиций в одной заявке");

  var fields = mapOrderFields(parsed.fields);
  if (!String(fields.student_name || "").trim()) throw apiError(400, "Укажите ФИО");
  if (!String(fields.student_phone || "").trim()) throw apiError(400, "Укажите телефон");

  var sheet = getSheet(SHEETS.ORDERS);
  var dup = findRowByValue(sheet, "order_no", parsed.order_no);
  if (dup) {
    if (String(dup.raw_text || "") === text) {
      return { order_id: dup.order_id, order_no: dup.order_no, repeat: true };
    }
    throw apiError(409, "Заявка с таким номером уже есть. Обновите страницу и отправьте заново");
  }

  publicOrderQuotaTake(Number(settings.public_orders_per_hour));

  var order = writeOrder({
    order_no: parsed.order_no,
    request_code: parsed.order_no,
    student_name: fields.student_name,
    student_phone: fields.student_phone,
    student_tg: fields.student_tg,
    is_adult: fields.is_adult,
    guardian_name: fields.guardian_name,
    guardian_phone: fields.guardian_phone,
    project: fields.project,
    issue_date: fields.issue_date,
    return_date: fields.return_date,
    extra_input: fields.extra_input,
    source_url: String(payload.source_url || ""),
    raw_text: text,
    items: parsed.items,
  }, "", "сайт");

  // В чат — сообщение в том виде, в каком владелец раньше получал заявки из
  // Tilda: состав, сумма, покупатель, даты. Владелец решил, что данные
  // покупателя в чате нужны (раньше ФИО и телефоны детей не множили по чатам).
  // Тело собирает tgOrderMessage, блок покупателя — tgOrderBuyerBlock.
  //
  // Ссылка — из настройки site_url; не задана — строки со ссылкой нет вовсе.
  var actUrl = autoAct(order.order_id, "");

  // Сборка текста внутри try: сбой уведомления не должен ронять приём заявки.
  try {
    tgSend(tgOrderMessage(parsed, fields, String(settings.site_url || "").trim()), "", "orders");
  } catch (e) { /* заявка уже записана, уведомление не важнее её */ }

  return { order_id: order.order_id, order_no: parsed.order_no, repeat: false,
           act_url: actUrl };
}

// Предел на приём заявок. Считаем в кэше: он живёт час и переживает вызовы, а
// заводить под счётчик строку в таблице — это ещё одно обращение к ней на
// каждую заявку.
function publicOrderQuotaTake(limit) {
  var cache = CacheService.getScriptCache();
  var slot = "public_orders_" + Math.floor(Date.now() / 3600000);
  var used = Number(cache.get(slot) || 0);
  if (used >= limit) {
    throw apiError(429, "Сейчас заявки с сайта не принимаются, попробуйте позже");
  }
  cache.put(slot, String(used + 1), 3900);
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

// Из ссылки — идентификатор. Google даёт их в трёх видах: /document/d/<id>/edit,
// /folders/<id>, ?id=<id>. Уже идентификатор — оставляем как есть.
function driveIdFrom(value) {
  var v = String(value || "").trim();
  var m = v.match(/\/(?:d|folders)\/([A-Za-z0-9_-]{20,})/) ||
          v.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : v;
}

function handleSettingsSet(payload, token) {
  requireAdmin(token);
  var incoming = payload.settings || {};
  var saved = {}, rejected = [];
  for (var key in incoming) {
    var spec = SETTINGS_SPEC[key];
    if (!spec) { rejected.push(key + ": неизвестная настройка"); continue; }
    var value = spec.text ? String(incoming[key]).trim() : Number(incoming[key]);
    // Приведение до проверки: из Google люди копируют ссылку целиком, а не
    // идентификатор из её середины. Отказывать за это — издевательство.
    if (spec.clean) value = spec.clean(value);
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
    if (!verifyPin(String(payload.current_pin || ""), staffRow.pin_hash)) {
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
    pin_hash: makePinHash(newPin),
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

// Запись в журнал Logs. Служебное — ошибки, отказы Telegram, несобравшийся акт —
// в чат склада не идёт никогда: там только заявки и акты.
//
// Замок не берём: журнал зовётся и изнутри операций, которые замок уже держат
// (tgSend из buildAct, autoAct), и ждать самого себя не нужно. Цена — две
// одновременные записи могут попасть в одну строку журнала; для журнала это
// приемлемо, для заказа — нет, поэтому заказы пишутся под замком.
//
// Всё тело в try: журнал не должен ронять операцию. Листа нет (после выкладки
// не запускали setupSheets) — молча пропускаем.
var LOG_CONTEXT_MAX = 2000;

function logEvent(kind, endpoint, reason, message, context) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.LOGS);
    if (!sheet) return;
    var ctx = "";
    if (context !== undefined && context !== null && context !== "") {
      ctx = typeof context === "string" ? context : JSON.stringify(context);
      if (ctx.length > LOG_CONTEXT_MAX) ctx = ctx.substring(0, LOG_CONTEXT_MAX) + "…";
    }
    appendRow(sheet, {
      timestamp: new Date().toISOString(),
      kind: String(kind || ""),
      endpoint: String(endpoint || ""),
      reason: String(reason || ""),
      message: logRedact(String(message === undefined || message === null ? "" : message)),
      context: logRedact(ctx),
    });
  } catch (e) { /* журнал не важнее самой операции */ }
}

// Токен бота в журнал не пишем: адрес Telegram несёт его внутри
// (api.telegram.org/bot<токен>/…), и сетевая ошибка UrlFetchApp цитирует адрес.
function logRedact(str) {
  return str.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<token>");
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
  // Темы форума в группе склада: заявки и акты — каждый в свою ленту. Пусто —
  // сообщение уходит в General, как до появления тем.
  notify_thread_orders: {
    def: "",
    text: true,
    check: function (v) { return v === "" || /^\d{1,10}$/.test(v); },
    hint: "номер темы «ЗАЯВКИ» (из /id внутри темы) или пусто — тогда в General",
  },
  notify_thread_acts: {
    def: "",
    text: true,
    check: function (v) { return v === "" || /^\d{1,10}$/.test(v); },
    hint: "номер темы «АКТЫ» (из /id внутри темы) или пусто — тогда в General",
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
  // Ссылка на мини-приложение вида https://t.me/<бот>/<приложение>. Заводится
  // в BotFather командой /newapp, поэтому код её знать не может. Бот вставляет
  // её в сообщение о новой заявке — из чата открывается сразу приложение.
  app_link: {
    def: "",
    text: true,
    check: function (v) { return v === "" || /^https:\/\/t\.me\/[^\s]+$/.test(v); },
    hint: "https://t.me/ваш_бот/имя_приложения или пусто",
  },
  // Адрес Worker: через него ходит приложение, и на него же Telegram присылает
  // события бота. По умолчанию — нынешний; настройкой, а не константой, потому
  // что при передаче системы колледжу (#41) Worker будет свой, и переставить
  // вебхук нужно будет без выкладки.
  api_url: {
    def: "https://mifs-rent-api.odintsovmatvey08.workers.dev",
    text: true,
    check: function (v) { return v === "" || /^https:\/\/[^\s]+$/.test(v); },
    hint: "адрес Worker целиком, начиная с https:// — на него Telegram присылает события бота",
  },

  // Шаблон акта в Google Docs и папка для готовых. Пусто — акт не собирается
  // вовсе, и карточка заказа это объясняет: молча отдавать пустой документ
  // хуже, чем сказать, что шаблона нет.
  act_template_id: {
    def: "",
    text: true,
    clean: driveIdFrom,
    check: function (v) { return v === "" || /^[A-Za-z0-9_-]{20,}$/.test(v); },
    hint: "ссылка на документ-шаблон или пусто",
  },
  act_folder_id: {
    def: "",
    text: true,
    clean: driveIdFrom,
    check: function (v) { return v === "" || /^[A-Za-z0-9_-]{20,}$/.test(v); },
    hint: "ссылка на папку для готовых актов или пусто — тогда рядом с таблицей",
  },
  // Кто подписывает акт. В настройках, а не в коде: мастера и директора
  // меняют, и правка фамилии не должна требовать выкладки.
  act_master: {
    def: "",
    text: true,
    check: function (v) { return v === "" || v.length <= 120; },
    hint: "ФИО мастера целиком или пусто — тогда подставится вошедший",
  },
  act_director: {
    def: "",
    text: true,
    check: function (v) { return v === "" || v.length <= 120; },
    hint: "как указывать директора в договоре, например «Директора Керзиной О.А.»",
  },

  // Приём заявок прямо с сайта. Выключено по умолчанию намеренно: это
  // единственная ручка, в которую можно писать без входа, и включать её должен
  // человек, а не выкладка кода.
  public_orders: {
    def: 0,
    text: false,
    check: function (v) { return v === 0 || v === 1; },
    hint: "1 — сайт отправляет заявку сам, 0 — только копипастом",
  },
  // Сколько заявок с сайта принимаем в час. Опознать посетителя нечем: Apps
  // Script не сообщает его адрес, поэтому предел общий на всех. Мусор он не
  // остановит, но не даст завалить таблицу за одну ночь.
  public_orders_per_hour: {
    def: 20,
    text: false,
    check: function (v) { return v >= 1 && v <= 200; },
    hint: "от 1 до 200",
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

// Хранение PIN. Раньше здесь был голый SHA-256 от четырёх цифр: вариантов
// десять тысяч, так что утёкшая таблица означала бы, что подобраны сразу все
// и мгновенно. Соли не было — одинаковые PIN давали одинаковые строки, и один
// перебор вскрывал всех разом.
//
// Онлайн-подбор у нас и так закрыт блокировкой после неверных попыток. Здесь
// речь об утечке самой таблицы, и главное — люди ставят один код везде: PIN
// из таблицы может оказаться кодом от карты. Достать его оттуда быть не должно.
//
// Формат: v2$<повторов>$<соль>$<хеш>. Число повторов лежит в самой строке, а
// не в константе, поэтому поднять его потом можно, ничего не сломав.
//
// Главное здесь — соль, а не повторы: голый SHA-256 от четырёх цифр это
// фактически открытый текст, таблица на десять тысяч строк считается за
// мгновение и разом подходит ко всем сотрудникам. Соль убивает и готовые
// таблицы, и возможность увидеть, у кого PIN совпадает.
//
// Повторов немного намеренно: Utilities.computeDigest каждый раз уходит за
// пределы JS, и цикл на десятки тысяч шагов добавил бы секунды ко входу.
// Настоящий запас даёт не число повторов, а PIN из шести цифр вместо четырёх
// (разрешены и те, и другие): четыре цифры не спасёт никакое хеширование.
// Померить скорость на своём проекте — benchPin() в конце файла.
var PIN_ROUNDS = 1000;

function sha256hex(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    var h = b.toString(16);
    if (h.length < 2) h = "0" + h;
    hex += h;
  }
  return hex;
}

function pinDigest(pin, salt, rounds) {
  var acc = sha256hex(String(salt) + ":" + String(pin));
  for (var i = 0; i < rounds; i++) acc = sha256hex(acc + ":" + salt);
  return acc;
}

function makePinHash(pin) {
  var salt = Utilities.getUuid().replace(/-/g, "");
  return "v2$" + PIN_ROUNDS + "$" + salt + "$" + pinDigest(pin, salt, PIN_ROUNDS);
}

function verifyPin(pin, stored) {
  var s = String(stored || "");
  if (!s) return false;
  var parts = s.split("$");
  if (parts[0] === "v2" && parts.length === 4) {
    var rounds = Number(parts[1]);
    if (!rounds || rounds < 1) return false;
    return sameString(pinDigest(pin, parts[2], rounds), parts[3]);
  }
  // Прежний формат — голый SHA-256. Принимаем, иначе после выкладки в систему
  // не войдёт никто; вход по нему тут же перезапишет PIN по-новому.
  return sameString(hashPinLegacy(pin), s);
}

function hashPinLegacy(pin) { return sha256hex(pin); }

function isLegacyPinHash(stored) {
  return !!String(stored || "") && String(stored).indexOf("v2$") !== 0;
}

// Без раннего выхода: время сравнения не должно зависеть от того, сколько
// знаков совпало.
function sameString(a, b) {
  var x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  var diff = 0;
  for (var i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
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

// Сколько стоит хеширование PIN на этом проекте. Запускается из редактора
// Apps Script (кнопка Run), наружу не выведено. Если вход стал заметно
// дольше — уменьшите PIN_ROUNDS, старые записи от этого не испортятся.
function benchPin() {
  var started = Date.now();
  makePinHash("123456");
  var ms = Date.now() - started;
  Logger.log("PIN_ROUNDS=" + PIN_ROUNDS + " → " + ms + " мс на один хеш");
  return ms;
}

// ---- Акт сдачи-приёмки ----

// Сумма прописью. В старом акте под числом стояла приписка «!Прописать
// буквами!» — её и закрываем. Согласование родов и падежей тут не украшение:
// «476718 рублей» в документе о материальной ответственности читается как
// недоделка, а так и было.
var WORDS_UNITS_M = ["", "один", "два", "три", "четыре", "пять", "шесть",
                     "семь", "восемь", "девять"];
var WORDS_UNITS_F = ["", "одна", "две", "три", "четыре", "пять", "шесть",
                     "семь", "восемь", "девять"];
var WORDS_TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать",
                   "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать",
                   "восемнадцать", "девятнадцать"];
var WORDS_TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят",
                  "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
var WORDS_HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот",
                      "шестьсот", "семьсот", "восемьсот", "девятьсот"];

// Разряды: слово в трёх формах и род. Тысяча женского рода — «одна тысяча».
var WORDS_SCALE = [
  { forms: ["", "", ""], female: false },
  { forms: ["тысяча", "тысячи", "тысяч"], female: true },
  { forms: ["миллион", "миллиона", "миллионов"], female: false },
  { forms: ["миллиард", "миллиарда", "миллиардов"], female: false },
];

function pluralRu(n, one, few, many) {
  var abs = Math.abs(n) % 100, last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

// Одна группа из трёх цифр словами.
function tripleInWords(value, female) {
  var out = [];
  var hundreds = Math.floor(value / 100);
  var rest = value % 100;
  if (hundreds) out.push(WORDS_HUNDREDS[hundreds]);
  if (rest >= 10 && rest < 20) {
    out.push(WORDS_TEENS[rest - 10]);
  } else {
    var tens = Math.floor(rest / 10);
    var units = rest % 10;
    if (tens) out.push(WORDS_TENS[tens]);
    if (units) out.push((female ? WORDS_UNITS_F : WORDS_UNITS_M)[units]);
  }
  return out.join(" ");
}

function numberInWords(value) {
  var n = Math.floor(Math.abs(Number(value) || 0));
  if (!n) return "ноль";
  var groups = [];
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  var parts = [];
  for (var i = groups.length - 1; i >= 0; i--) {
    var group = groups[i];
    if (!group) continue;
    var scale = WORDS_SCALE[i] || WORDS_SCALE[0];
    parts.push(tripleInWords(group, scale.female));
    if (scale.forms[0]) {
      parts.push(pluralRu(group, scale.forms[0], scale.forms[1], scale.forms[2]));
    }
  }
  return parts.join(" ");
}

// «476 718 рублей 00 копеек» словами, с большой буквы — так пишут в актах.
function moneyInWords(value) {
  var total = Math.round((Number(value) || 0) * 100);
  var rubles = Math.floor(total / 100);
  var kopeks = total % 100;
  var words = numberInWords(rubles);
  var text = words + " " + pluralRu(rubles, "рубль", "рубля", "рублей") +
    " " + (kopeks < 10 ? "0" + kopeks : String(kopeks)) + " " +
    pluralRu(kopeks, "копейка", "копейки", "копеек");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Разряды пробелами: 476718 → «476 718». В документе так читается, а не
// пересчитывается пальцем.
function moneyDigits(value) {
  var n = Math.round(Number(value) || 0);
  var s = String(Math.abs(n));
  var out = "";
  for (var i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += " ";
    out += s[i];
  }
  return (n < 0 ? "−" : "") + out;
}

// Шаблон акта — тот самый документ, что прислал колледж: HTML-выгрузка того
// же файла, из которой убраны данные студента, а на месте значений стоят
// подстановки. Лежит файлом рядом с кодом (apps-script/act-template.html) и
// попадает под версии вместе с остальным.
//
// Почему выгрузка, а не рисование документа кодом: у акта своя вёрстка —
// рамки, шрифты, ширины столбцов, серая шапка таблицы. Нарисованный заново
// документ выглядел бы «примерно так же», а это документ о материальной
// ответственности, и в нём «примерно» не годится.
var ACT_PLACEHOLDERS = ["{{НОМЕР}}", "{{ДАТА}}", "{{ФИО}}", "{{ТЕЛЕФОН}}",
  "{{ПРОЕКТ}}", "{{С}}", "{{ПО}}", "{{СУММА}}", "{{СУММА_СЛОВАМИ}}",
  "{{МАСТЕР}}", "{{МАСТЕР_КРАТКО}}", "{{ДИРЕКТОР}}", "{{ПОЗИЦИИ}}"];

function buildActTemplate() {
  var html = HtmlService.createHtmlOutputFromFile("act-template").getContent();
  var id = htmlToDoc(html, "Шаблон акта — Mifs Rent");

  // Проверяем, что получилось: преобразование делает Google, и молча отдать
  // документ, в котором половина подстановок потерялась, нельзя — по нему
  // потом собираются акты. Не сошлось — убираем черновик и говорим почему.
  var text = DocumentApp.openById(id).getBody().getText();
  var missing = ACT_PLACEHOLDERS.filter(function (k) { return text.indexOf(k) === -1; });
  if (missing.length) {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* остался в Диске */ }
    throw apiError(502, "Шаблон собрался неправильно: не нашлись " + missing.join(", "));
  }
  return id;
}

// HTML в Google-документ. DocumentApp так не умеет, а Диск умеет: загрузка с
// mimeType документа конвертирует на своей стороне. Токен берём у самого
// скрипта — он и так ходит в Диск через DriveApp.
function htmlToDoc(html, name) {
  var boundary = "mifs" + Date.now();
  var meta = { name: name, mimeType: "application/vnd.google-apps.document" };
  var payload =
    "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(meta) + "\r\n" +
    "--" + boundary + "\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n" +
    html + "\r\n--" + boundary + "--";
  // Байтами, а не строкой: иначе UrlFetchApp отправит тело в latin-1 и вся
  // кириллица приедет вопросительными знаками.
  var res = UrlFetchApp.fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "post",
      contentType: "multipart/related; boundary=" + boundary,
      payload: Utilities.newBlob(payload).getBytes(),
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code >= 300) {
    var msg = "";
    try { msg = JSON.parse(body).error.message || ""; } catch (e) { msg = body.slice(0, 200); }
    // Так Google отвечает, когда в облачном проекте скрипта не включён доступ
    // к Диску. Это разовая настройка владельца, и ссылка на неё есть в самом
    // ответе — вытаскиваем номер проекта и говорим человеку одну фразу вместо
    // страницы английского текста.
    var proj = (msg.match(/project (\d+)/) || [])[1];
    if (code === 403 && proj) {
      throw apiError(409, "Google просит один раз разрешить доступ к Диску. " +
        "Откройте https://console.cloud.google.com/apis/library/drive.googleapis.com?project=" +
        proj + " — нажмите Enable, вернитесь и создайте шаблон снова.");
    }
    throw apiError(502, "Диск не принял шаблон (" + code + "): " + msg);
  }
  var data = JSON.parse(body || "{}");
  if (!data.id) throw apiError(502, "Диск не вернул идентификатор шаблона");
  return data.id;
}

// Создание шаблона. Только главный администратор: документ становится частью
// делопроизводства колледжа, и заводить его должен тот, кто за это отвечает.
function handleActTemplate(payload, token) {
  requireOwner(token);
  var current = String(getSettings().act_template_id || "");
  if (current && !payload.replace) {
    throw apiError(409, "Шаблон уже есть. Правьте его как обычный документ, " +
      "а пересоздать можно с подтверждением — прежний при этом останется в Диске");
  }
  var id = buildActTemplate();
  metaSet("setting_act_template_id", id);
  return { template_id: id, url: "https://docs.google.com/document/d/" + id + "/edit" };
}

// Состав акта: по строке на позицию. Именно это в старом документе не было
// сделано — все пятнадцать наименований лежали в одной ячейке с припиской
// «!Расставить по ячейкам!».
function actLines(orderId) {
  var items = readRows(getSheet(SHEETS.ORDER_ITEMS)).filter(function (r) {
    return String(r.order_id) === String(orderId);
  });
  items.sort(function (a, b) { return Number(a.line_no) - Number(b.line_no); });

  var txRows = readRows(getSheet(SHEETS.TRANSACTIONS)).filter(function (t) {
    return String(t.order_id || "") === String(orderId);
  });
  var equipment = readRows(getSheet(SHEETS.EQUIPMENT));
  var byId = {};
  equipment.forEach(function (e) { byId[String(e.item_id)] = e; });

  var models = readRows(getSheet(SHEETS.MODELS));
  var priceOf = {};
  models.forEach(function (m) {
    priceOf[String(m.category) + "-" + pad2(Number(m.model_code))] = Number(m.price || 0);
  });

  return items.map(function (r) {
    // Заводские номера — только реально выданного. Выдачи не было — столбец
    // пустой: вписать туда номер «который выдадим» значит соврать в документе.
    var serials = txRows
      .filter(function (t) { return String(t.order_line) === String(r.line_no); })
      .map(function (t) {
        var e = byId[String(t.item_id)];
        return e ? String(e.serial_number || e.inventory_number || "").trim() : "";
      })
      .filter(function (v) { return v; });

    var qty = Number(r.qty || 1);
    // Цена из заявки главнее: в старых заказах с Tilda она настоящая. Иначе
    // берём цену модели. Нет ни там, ни там — прочерк, а не ноль.
    var unit = Number(r.price || 0);
    if (!unit && r.model_code !== "" && r.category) {
      unit = priceOf[String(r.category) + "-" + pad2(Number(r.model_code))] || 0;
    }
    var sum = Number(r.total || 0) || unit * qty;

    return {
      name: String(r.raw_name || "").trim(),
      qty: qty,
      serials: serials.join(", "),
      sum: sum,
      priced: sum > 0,
    };
  });
}

// Сборка акта. Шаблон копируется, подстановки заменяются, таблица позиций
// заполняется построчно, файл получает имя «<дата> <ФИО>» — как было.
// Ручной путь остался запаской: настройки поправили, шаблон появился — акт по
// давнему заказу собирается этой ручкой. В приложении кнопки нет.
function handleActBuild(payload, token) {
  var staffRow = checkAuth(token);
  return buildAct(String(payload.order_id || ""), staffRow.full_name);
}

function buildAct(orderId, masterName) {
  var settings = getSettings();
  var templateId = String(settings.act_template_id || "");
  if (!templateId) {
    throw apiError(409, "Шаблон акта не создан. Настройки → «Акт сдачи-приёмки» → «Создать шаблон»");
  }

  orderId = String(orderId || "");
  var order = findRowByValue(getSheet(SHEETS.ORDERS), "order_id", orderId);
  if (!order) throw apiError(404, "Заказ не найден");

  var lines = actLines(orderId);
  if (!lines.length) throw apiError(409, "В заказе нет ни одной позиции");

  var stamp = actStamp();
  var fio = String(order.student_name || "").trim() || "без имени";
  var total = lines.reduce(function (sum, l) { return sum + l.sum; }, 0);
  var unpriced = lines.filter(function (l) { return !l.priced; }).length;

  var copy;
  try {
    var file = DriveApp.getFileById(templateId);
    var folderId = String(settings.act_folder_id || "");
    copy = folderId
      ? file.makeCopy(stamp + " " + fio, DriveApp.getFolderById(folderId))
      : file.makeCopy(stamp + " " + fio);
  } catch (err) {
    throw apiError(502, "Не удалось скопировать шаблон: " + err.message +
      ". Проверьте идентификатор шаблона в настройках");
  }

  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();

  fillActItems(body, lines);

  var fields = {
    "{{НОМЕР}}": String(order.order_no || orderId),
    "{{ДАТА}}": stamp,
    "{{ФИО}}": fio,
    "{{ТЕЛЕФОН}}": String(order.student_phone || ""),
    "{{ПРОЕКТ}}": String(order.project || ""),
    "{{С}}": humanRuDate(order.issue_date),
    "{{ПО}}": humanRuDate(order.return_date),
    "{{СУММА}}": total ? moneyDigits(total) : "—",
    "{{СУММА_СЛОВАМИ}}": total ? moneyInWords(total) : "Стоимость не указана",
    "{{МАСТЕР}}": String(settings.act_master || masterName || ""),
    "{{МАСТЕР_КРАТКО}}": shortName(String(settings.act_master || masterName || "")),
    "{{ДИРЕКТОР}}": String(settings.act_director || "Директора"),
  };
  for (var key in fields) {
    body.replaceText(escapeForReplace(key), fields[key]);
  }

  doc.saveAndClose();
  var url = "https://docs.google.com/document/d/" + copy.getId() + "/edit";

  // Ссылку держим в строке заказа: карточка показывает её без обращения к
  // Диску, и повторная сборка не плодит документы на один заказ.
  updateRow(getSheet(SHEETS.ORDERS), order.__row, { act_url: url });

  // Сообщение в HTML: заголовок жирным, ссылка — кликабельной.
  tgSend("<b>АКТ от " + tgEscape(stamp) + "</b> " + tgEscape(fio) + "\n" +
    '<a href="' + tgEscape(url) + '">Открыть акт</a>', "", "acts");

  return {
    url: url, document_id: copy.getId(), lines: lines.length,
    total: total, unpriced: unpriced,
  };
}

// Заполнение таблицы позиций. Таблицу находим по подстановке в ней самой:
// привязываться к «третьей таблице от начала» нельзя — шаблон правят руками.
function fillActItems(body, lines) {
  var tables = body.getTables();
  var target = null;
  for (var i = 0; i < tables.length; i++) {
    if (tables[i].getText().indexOf("{{ПОЗИЦИИ}}") !== -1) { target = tables[i]; break; }
  }
  if (!target) {
    throw apiError(409, "В шаблоне не найдена таблица позиций: в одной из её ячеек " +
      "должно стоять {{ПОЗИЦИИ}}");
  }

  // Строка-образец задаёт оформление; дописываем по одной на позицию и
  // удаляем образец последним, чтобы таблица не осталась без строк.
  var sample = null;
  for (var r = 0; r < target.getNumRows(); r++) {
    if (target.getRow(r).getText().indexOf("{{ПОЗИЦИИ}}") !== -1) { sample = r; break; }
  }

  lines.forEach(function (line, idx) {
    var row = target.appendTableRow();
    var cells = [
      String(idx + 1),
      line.name,
      String(line.qty),
      line.serials,
      line.priced ? moneyDigits(line.sum) : "—",
    ];
    cells.forEach(function (text) { row.appendTableCell(text); });
  });

  target.removeRow(sample);
}

// «2026-09-28 22:44:10» — тем же видом, что в имени прежних файлов.
function actStamp() {
  var d = new Date();
  function two(n) { return n < 10 ? "0" + n : String(n); }
  return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " +
    two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
}

// «2026-10-01» → «01-10-2026г.» — как в старом акте.
function humanRuDate(value) {
  var s = String(value || "").trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + "-" + m[2] + "-" + m[1] + "г." : s;
}

// «Гриднев Егор Олегович» → «Гриднев Е.О.»
function shortName(full) {
  var parts = String(full || "").trim().split(/\s+/);
  if (parts.length < 2) return String(full || "");
  var initials = "";
  for (var i = 1; i < parts.length && i < 3; i++) initials += parts[i].charAt(0) + ".";
  return parts[0] + " " + initials;
}

// replaceText принимает регулярное выражение, а в подстановках фигурные скобки.
function escapeForReplace(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Выдача по заявке без сканирования. Сканер — правильный путь: он не даёт
// выдать не то. Но бывает, что вещь уже в руках, а этикетка не читается, или
// весь заказ собран заранее — и тогда упираться в скан значит стоять.
//
// Предметы выбираются сами: свободные, этой же модели, по порядку номеров.
// Дальше всё идёт через ту же выдачу, что и со сканера, — с теми же
// проверками состояния, количества и списания со строки заказа.
function handleOrderIssue(payload, token) {
  checkAuth(token);
  var orderId = String(payload.order_id || "");
  var order = findRowByValue(getSheet(SHEETS.ORDERS), "order_id", orderId);
  if (!order) throw apiError(404, "Заказ не найден");
  if (order.status === "Cancelled") throw apiError(409, "Заказ отменён, выдавать по нему нельзя");

  var lineNo = Number(payload.line_no || 0);
  var line = null;
  readRows(getSheet(SHEETS.ORDER_ITEMS)).forEach(function (r) {
    if (String(r.order_id) === orderId && Number(r.line_no) === lineNo) line = r;
  });
  if (!line) throw apiError(404, "Такой строки в заказе нет");
  if (!line.category || line.model_code === "") {
    throw apiError(409, "Позиция не сопоставлена с моделью. Сопоставьте её в заказе, " +
      "иначе выдавать нечего: система не знает, что это за вещь");
  }

  var category = String(line.category);
  var model = pad2(Number(line.model_code));
  var left = Number(line.qty || 1) - Number(line.issued_qty || 0);
  if (left < 1) throw apiError(409, "По этой строке уже всё выдано");
  // Количество не задано — выдаём столько, сколько свободно, но не больше
  // остатка по строке. Отказ «свободна одна, а нужно три» заставлял бы
  // складмена считать самому, хотя выдать одну он всё равно хочет.
  var asked = payload.qty === undefined || payload.qty === null || payload.qty === "";
  var want = asked ? left : Math.floor(Number(payload.qty));
  if (!want || want < 1) throw apiError(400, "Количество — целое число от одного");
  if (want > left) throw apiError(409, "По этой строке осталось выдать " + left);

  // Позиция «количеством» — одна строка на складе, выдаётся сразу нужным
  // числом. Поштучная — столько выдач, сколько предметов.
  var byQty = categoryByQty(category);
  var free = readRows(getSheet(SHEETS.EQUIPMENT)).filter(function (e) {
    if (String(e.category) !== category) return false;
    if (e.model_code === "" || pad2(Number(e.model_code)) !== model) return false;
    return byQty ? itemQty(e) - Number(e.qty_out || 0) > 0 : e.status === "Available";
  });
  free.sort(function (a, b) { return String(a.item_id) < String(b.item_id) ? -1 : 1; });

  if (!free.length) {
    throw apiError(409, "Свободных «" + String(line.raw_name || model) +
      "» на складе нет — ни одной");
  }

  var issued = [];
  if (byQty) {
    var spare = itemQty(free[0]) - Number(free[0].qty_out || 0);
    if (asked) want = Math.min(want, spare);
    if (spare < want) throw apiError(409, "Свободно только " + spare + " из " + want);
    handleTransactionCheckout({
      item_id: free[0].item_id, order_id: orderId, qty: want,
      notes: "Выдано по заявке без сканирования",
    }, token);
    issued.push({ item_id: free[0].item_id, qty: want });
  } else {
    if (asked) want = Math.min(want, free.length);
    if (free.length < want) {
      throw apiError(409, "Свободно только " + free.length + " из " + want);
    }
    for (var i = 0; i < want; i++) {
      handleTransactionCheckout({
        item_id: free[i].item_id, order_id: orderId,
        notes: "Выдано по заявке без сканирования",
      }, token);
      issued.push({ item_id: free[i].item_id, qty: 1 });
    }
  }

  // Сколько осталось по строке после этой выдачи — чтобы приложение сказало
  // правду, а не «выдано» на строке, где ещё две единицы.
  var rest = left - want;
  return { order_id: Number(orderId), line_no: lineNo, issued: issued, left: rest };
}

// Архив заказа. Не удаление: заказ — запись о договорённости, и стирать её
// нельзя даже когда она явно лишняя (проверка связи, дубль, опечатка).
// Мало ли что: через полгода понадобится показать, что именно было.
//
// Возврат из архива — тем же эндпоинтом с back: true.
function handleOrderArchive(payload, token) {
  requireAdmin(token);
  var orderId = String(payload.order_id || "");
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    var sheet = getSheet(SHEETS.ORDERS);
    ensureColumns(sheet, ["archived_at"]);
    var order = findRowByValue(sheet, "order_id", orderId);
    if (!order) throw apiError(404, "Заказ не найден");

    if (payload.back) {
      updateRow(sheet, order.__row, { archived_at: "" });
      return { order_id: Number(orderId), archived_at: "" };
    }

    // Вещь на руках — заказ убирать с глаз нельзя: по нему ещё ждут возврата.
    var open = readRows(getSheet(SHEETS.TRANSACTIONS)).filter(function (t) {
      return String(t.order_id || "") === orderId && t.status === "Open";
    });
    if (open.length) {
      throw apiError(409, "По этому заказу " + open.length +
        " ед. на руках — сначала примите их обратно");
    }

    var now = new Date().toISOString();
    updateRow(sheet, order.__row, { archived_at: now });
    return { order_id: Number(orderId), archived_at: now };
  } finally {
    lock.releaseLock();
  }
}
