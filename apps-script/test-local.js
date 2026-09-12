// Локальная проверка бэкенда (Code.gs) без Google-аккаунта.
//
// Запуск:  node apps-script/test-local.js
//
// Ниже — мини-эмулятор тех частей Google Apps Script API, которые использует
// Code.gs (SpreadsheetApp, Utilities, LockService, ContentService). Настоящий
// Code.gs загружается как есть и прогоняется через полный сценарий работы
// склада, поэтому ошибки в логике видны сразу, до деплоя в Google.
//
// Этот файл нужен только разработчику — в Apps Script его вставлять не надо.
const fs = require('fs');
const crypto = require('crypto');

class FakeSheet {
  constructor(name, data = [], merges = []) {
    this.name = name; this.data = data; this.merges = merges; this.frozen = 0;
    // Формат хранится по конкретной ячейке ("строка:колонка"), а не по колонке:
    // в настоящем Sheets строка, появившаяся за пределами сетки, формат колонки
    // не наследует — именно из-за этого номера теряли ведущий ноль.
    this.cellFormats = {};
    this.maxRows = Math.max(data.length, 1000);   // размер сетки
  }
  _fmt(row, col) { return this.cellFormats[row + ':' + col]; }
  _dropFormats(row) {
    Object.keys(this.cellFormats).forEach((k) => {
      if (Number(k.split(':')[0]) === row) delete this.cellFormats[k];
    });
  }
  getName() { return this.name; }
  setFrozenRows(n) { this.frozen = n; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.data.length ? Math.max(...this.data.map(r => r.length)) : 0; }
  getMaxRows() { return this.maxRows; }
  _ensure(row, col) {
    while (this.data.length < row) this.data.push([]);
    const r = this.data[row - 1];
    while (r.length < col) r.push('');
  }
  getRange(row, col, numRows, numCols) {
    numRows = numRows || 1; numCols = numCols || 1;
    const sheet = this;
    return {
      getValue() {
        const r = sheet.data[row - 1];
        return r && r[col - 1] !== undefined ? r[col - 1] : '';
      },
      getValues() {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const r = sheet.data[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < numCols; j++) line.push(r[col - 1 + j] !== undefined ? r[col - 1 + j] : '');
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        // Запись за пределами сетки расширяет её, как в настоящем Sheets,
        // и новые строки приходят с форматом по умолчанию — формат колонки
        // они не наследуют.
        for (let i = 0; i < values.length; i++) {
          if (row + i > sheet.maxRows) sheet._dropFormats(row + i);
        }
        sheet.maxRows = Math.max(sheet.maxRows, row + values.length - 1);
        for (let i = 0; i < values.length; i++) {
          sheet._ensure(row + i, col + values[i].length - 1);
          for (let j = 0; j < values[i].length; j++) {
            const colIdx = col - 1 + j;
            let v = values[i][j];
            // Строка, похожая на число, приводится к числу, если у ЭТОЙ ячейки
            // формат не текстовый: "010101" превращается в 10101.
            if (sheet._fmt(row + i, colIdx) !== '@' && typeof v === 'string' && /^\d+$/.test(v)) {
              v = Number(v);
            }
            sheet.data[row - 1 + i][colIdx] = v;
          }
        }
      },
      clearContent() {
        for (let i = 0; i < numRows; i++) {
          const r = sheet.data[row - 1 + i];
          if (!r) continue;
          for (let j = 0; j < numCols; j++) r[col - 1 + j] = '';
        }
        // как в Sheets: строки остаются, но getLastRow считается по данным
        while (sheet.data.length && sheet.data[sheet.data.length - 1].every(c => c === '')) sheet.data.pop();
        return this;
      },
      setNumberFormat(fmt) {
        for (let i = 0; i < numRows; i++) {
          for (let j = 0; j < numCols; j++) sheet.cellFormats[(row + i) + ':' + (col - 1 + j)] = fmt;
        }
        return this;
      },
      getMergedRanges() {
        return sheet.merges.map(m => ({ getRow: () => m.row, getNumColumns: () => m.cols }));
      },
    };
  }
  getDataRange() {
    const width = this.getLastColumn();
    return this.getRange(1, 1, Math.max(this.data.length, 1), Math.max(width, 1));
  }
  appendRow(row) {
    // Как в Sheets: запись идёт в строку без текстового формата, поэтому
    // "010104" приводится к числу — прогоняем через тот же setValues.
    const target = this.getLastRow() + 1;
    this.getRange(target, 1, 1, row.length).setValues([row.slice()]);
  }
  insertRowsAfter(afterRow, howMany) {
    // новые строки формата не несут — как при доращивании сетки в Sheets
    this.maxRows = Math.max(this.maxRows, afterRow + howMany);
    for (let r = afterRow + 1; r <= afterRow + howMany; r++) this._dropFormats(r);
  }
  deleteRows(start, howMany) {
    // Настоящий Sheets отказывается оставить лист без незакреплённых строк
    if (this.maxRows - howMany < this.frozen + 1) {
      throw new Error('Sorry, it is not possible to delete all non-frozen rows.');
    }
    this.data.splice(start - 1, howMany);
    this.maxRows -= howMany;
    // удалённых строк больше нет — их формат тоже исчезает
    for (let r = this.maxRows + 1; r <= this.maxRows + howMany; r++) this._dropFormats(r);
  }
}

class FakeSpreadsheet {
  constructor(sheets) { this.sheets = sheets || [new FakeSheet('Sheet1')]; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  toast() {}
}

const spreadsheet = new FakeSpreadsheet();

// Синтетическая «старая таблица инвентаризации» для проверки importInventory().
// Специально воспроизводит все особенности реальных складских файлов:
// объединённые строки-заголовки групп, вкладку без заголовков колонок,
// мусорные «серийники», одинаковые названия у разных единиц, дубли между вкладками.
const sourceSpreadsheet = new FakeSpreadsheet([
  new FakeSheet('КИНО', [
    ['№', 'Тип', 'Наименование', 'Заводской номер', 'Инвентарный номер', 'Состояние', 'Хранение', 'Примечания'],
    ['Камеры', '', '', '', '', '', '', ''],                                    // объединённый заголовок группы
    ['1', 'Видеокамера', 'Canon C70', '273679500132', '1013400892', 'Работает', '105', ''],
    ['2', 'Видеокамера', 'Canon C70', '273679500130', '1013400891', 'Не работает', '105', 'Ремонт экрана'],
    ['3', 'Кинообъектив', 'ЛОМО 35mm', '210231', '', '', '', 'Нужна крышка'],
    ['4', 'Видеокамера', 'Red One', '?', '', 'Потерян', '', ''],               // мусорный «серийник»
    ['Объективы', 'Объективы', 'Объективы', 'Объективы', 'Объективы', 'Объективы', 'Объективы', 'Объективы'],
  ], [{ row: 2, cols: 8 }]),
  new FakeSheet('КИНО (копия)', [
    ['№', 'Тип', 'Наименование', 'Заводской номер', 'Инвентарный номер', 'Состояние', 'Хранение', 'Примечания'],
    ['1', 'Видеокамера', 'Canon C70', '273679500132', '', '', '', ''],          // дубль по заводскому номеру
    ['2', 'Видеоштатив', 'GreenBean HDV', '', '', 'Работает', '', ''],
  ]),
  new FakeSheet('ЗВУК', [
    ['', 'Заводской номер', ''],                                                // у колонки с названием нет заголовка
    ['HOLLYLAND LARK MAX', '1', 'Запакован'],
    ['HOLLYLAND LARK MAX', '2', ''],
    ['HOLLYLAND LARK MAX', '3', 'Сломан, нет петлички'],
  ]),
  new FakeSheet('СВЕТ', [
    ['№', 'Тип', 'Наименование', 'Заводской номер', 'Инвентарный номер', 'Состояние', 'Хранение', 'Примечания'],
    ['1', 'Осветитель светодиодный', 'Godox SL300', '', '1013500001', 'Работает', '', ''],
    ['2', 'Чайнаболл', 'Чайнаболл', '', '', '', '', ''],                        // одинаковые названия —
    ['3', 'Чайнаболл', 'Чайнаболл', '', '', '', '', ''],                        // это разные физические единицы
    ['4', 'Чайнаболл', 'Чайнаболл', '', '', 'Разбит', '', ''],
  ]),
]);

global.SpreadsheetApp = {
  getActiveSpreadsheet: () => spreadsheet,
  openById: () => sourceSpreadsheet,
};
global.Logger = { log: () => {} };
global.LockService = {
  getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
};
global.Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest(_alg, str) {
    const buf = crypto.createHash('sha256').update(String(str), 'utf8').digest();
    // Apps Script отдаёт знаковые байты (-128..127) — воспроизводим это
    return Array.from(buf).map(b => (b > 127 ? b - 256 : b));
  },
  getUuid: () => crypto.randomUUID(),
};
global.ContentService = {
  MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
  createTextOutput(text) {
    return { _text: text, setMimeType() { return this; }, getContent() { return this._text; } };
  },
};

// Загружаем настоящий Code.gs в глобальную область
const code = fs.readFileSync(require('path').join(__dirname, 'Code.gs'), 'utf8');
(0, eval)(code);

// ---- Хелперы теста ----
let failures = 0;
function check(label, cond, extra) {
  if (cond) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function call(endpoint, payload, token) {
  const res = doPost({ postData: { contents: JSON.stringify({ endpoint, token, payload: payload || {} }) } });
  return JSON.parse(res.getContent());
}
// Обрезает пустой хвост сетки — так лист и оказывается размером ровно по данным
function trimGrid(sheet) {
  const spare = sheet.getMaxRows() - sheet.getLastRow();
  if (spare > 0) sheet.deleteRows(sheet.getLastRow() + 1, spare);
}
function dumpSheet(name) {
  const s = spreadsheet.getSheetByName(name);
  return s ? s.data : null;
}

console.log('\n== setupSheets ==');
const setupMsg = setupSheets();
console.log('  ' + setupMsg);
check('создано 7 вкладок', spreadsheet.getSheets().length === 7, spreadsheet.getSheets().map(s => s.name));
check('Sheet1 удалён', !spreadsheet.getSheetByName('Sheet1'));
check('заголовки Equipment верны',
  JSON.stringify(dumpSheet('Equipment')[0]) === JSON.stringify(SCHEMA.Equipment), dumpSheet('Equipment')[0]);
check('заголовки Meta верны',
  JSON.stringify(dumpSheet('Meta')[0]) === JSON.stringify(SCHEMA.Meta));

console.log('\n== setupSheets повторно (идемпотентность) ==');
spreadsheet.getSheetByName('Clients').appendRow([1, 'Тест Клиент', 'Проект', '', '', '']);
setupSheets();
check('вкладок по-прежнему 7', spreadsheet.getSheets().length === 7);
check('данные Clients не затёрты', dumpSheet('Clients').length === 2, dumpSheet('Clients'));
check('заголовки Clients на месте', dumpSheet('Clients')[0][0] === 'client_id');

console.log('\n== bootstrap первого администратора ==');
let r = call('/staff/create', { full_name: 'Матвей', login: 'Matvey', pin: '4321' });
check('создан без токена', r.ok === true, r);
check('staff_id = 1', r.data && r.data.staff_id === 1, r.data);
const staffRow = dumpSheet('Staff')[1];
check('роль принудительно Admin', staffRow[SCHEMA.Staff.indexOf('role')] === 'Admin', staffRow);
check('PIN сохранён как хэш, не в открытом виде',
  staffRow[SCHEMA.Staff.indexOf('pin_hash')] === crypto.createHash('sha256').update('4321').digest('hex'));

console.log('\n== bootstrap закрывается после первой записи ==');
r = call('/staff/create', { full_name: 'Чужой', login: 'hacker', pin: '0000' });
check('второй bootstrap без токена отклонён', r.ok === false && r.status === 403, r);

console.log('\n== вход ==');
r = call('/auth/login', { login: 'matvey', pin: '4321' });   // намеренно строчными
check('логин регистронезависимый', r.ok === true, r);
const token = r.ok ? r.data.token : null;
check('вернулась роль Admin', r.ok && r.data.role === 'Admin');
r = call('/auth/login', { login: 'Matvey', pin: '9999' });
check('неверный PIN отклонён', r.ok === false && r.status === 401, r);

console.log('\n== добавление сотрудника администратором ==');
r = call('/staff/create', { full_name: 'Иван', login: 'ivan', pin: '1111', role: 'Warehouse Staff' }, token);
check('сотрудник создан', r.ok === true && r.data.staff_id === 2, r);
r = call('/staff/create', { full_name: 'Дубль', login: 'IVAN', pin: '2222' }, token);
check('дубль логина отклонён (409)', r.ok === false && r.status === 409, r);
r = call('/staff/list', {}, token);
check('в списке 2 сотрудника', r.ok && r.data.length === 2, r.data);
check('pin_hash не утекает в /staff/list', r.ok && r.data.every(s => s.pin_hash === undefined));

console.log('\n== не-админ не может управлять сотрудниками ==');
const ivanLogin = call('/auth/login', { login: 'ivan', pin: '1111' });
const ivanToken = ivanLogin.ok ? ivanLogin.data.token : null;
r = call('/staff/list', {}, ivanToken);
check('сотруднику склада отказано (403)', r.ok === false && r.status === 403, r);
r = call('/item/create', { name: 'Sony FX6', category: 'CAM' }, ivanToken);
check('но обычные операции ему доступны', r.ok === true, r);
const itemId = r.ok ? r.data.item_id : null;
check('ID вида XXYYZZ: камера, модель 01, экземпляр 01', itemId === '010101', itemId);

console.log('\n== генерация ID и справочник моделей ==');
const id2 = call('/item/create', { name: 'Sigma 24-70', category: 'LEN' }, token).data.item_id;
const id3 = call('/item/create', { name: 'Canon C70', category: 'CAM' }, token).data.item_id;
check('другая категория — свой блок номеров', id2 === '020101', id2);
check('вторая модель в категории получает код 02', id3 === '010201', id3);
check('ID всегда ровно 6 цифр', /^\d{6}$/.test(id2) && /^\d{6}$/.test(id3), [id2, id3]);

const dupModel = call('/item/create', { name: 'Sony FX6', category: 'CAM' }, token).data.item_id;
check('второй экземпляр той же модели — тот же YY, следующий ZZ', dupModel === '010102', dupModel);
const caseVariant = call('/item/create', { name: 'sony  fx-6', category: 'CAM' }, token).data.item_id;
check('разнописание названия не плодит новую модель', caseVariant === '010103', caseVariant);

const models = call('/models/list', { category: 'CAM' }, token);
check('справочник моделей отдаётся', models.ok && models.data.length === 2, models.data);

console.log('\n== выдача / приём ==');
const clientId = call('/client/create', { client_name: 'ООО Реклама', project_name: 'Ролик' }, token).data.client_id;
r = call('/transaction/checkout', { item_id: itemId, client_id: clientId, notes: 'на 3 дня' }, token);
check('выдача прошла', r.ok === true, r);
r = call('/item/lookup', { item_id: itemId });
check('статус стал Rented', r.ok && r.data.status === 'Rented', r.data && r.data.status);
check('current_transaction подтянулась', r.ok && r.data.current_transaction !== null);
r = call('/transaction/checkout', { item_id: itemId, client_id: clientId }, token);
check('повторная выдача отклонена (409)', r.ok === false && r.status === 409, r);

r = call('/transaction/checkin', { item_id: itemId, has_defect: true, defect_description: 'Царапина', defect_severity: 'Major' }, token);
check('приём с дефектом прошёл', r.ok === true && r.data.defect_id === 1, r);
r = call('/item/lookup', { item_id: itemId });
check('статус стал In Repair', r.ok && r.data.status === 'In Repair', r.data && r.data.status);
check('current_transaction очищена', r.ok && r.data.current_transaction === null);
check('дефект виден как открытый', r.ok && r.data.open_defects.length === 1);

console.log('\n== закрытие дефекта возвращает предмет в строй ==');
r = call('/defect/resolve', { defect_id: 1, status: 'Resolved', resolution_notes: 'Отполировали' }, token);
check('дефект закрыт', r.ok === true, r);
r = call('/item/lookup', { item_id: itemId });
check('статус вернулся в Available', r.ok && r.data.status === 'Available', r.data && r.data.status);

console.log('\n== история ==');
r = call('/item/history', { item_id: itemId }, token);
check('в истории 1 выдача и 1 дефект',
  r.ok && r.data.transactions.length === 1 && r.data.defects.length === 1, r.data);
r = call('/client/history', { client_id: clientId }, token);
check('история клиента непуста', r.ok && r.data.transactions.length === 1, r.data);

console.log('\n== списки и фильтры ==');
r = call('/equipment/list', { category: 'CAM' }, token);
check('фильтр по категории работает', r.ok && r.data.length === 4, r.data.length);
r = call('/equipment/list', { status: 'Available' }, token);
check('фильтр по статусу работает', r.ok && r.data.every(i => i.status === 'Available'), r.data);
r = call('/defects/list', { status: 'Resolved' }, token);
check('фильтр дефектов работает', r.ok && r.data.length === 1, r.data);

console.log('\n== отключение сотрудника ==');
r = call('/staff/set-active', { staff_id: 2, active: false }, token);
check('сотрудник отключён', r.ok === true, r);
r = call('/auth/login', { login: 'ivan', pin: '1111' });
check('отключённый не может войти', r.ok === false && r.status === 401, r);

console.log('\n== авторизация ==');
r = call('/equipment/list', {}, 'мусорный-токен');
check('битый токен отклонён (401)', r.ok === false && r.status === 401, r);
r = call('/equipment/list', {}, null);
check('без токена отклонено (401)', r.ok === false && r.status === 401, r);
r = call('/неизвестный', {}, token);
check('неизвестный эндпоинт → 404', r.ok === false && r.status === 404, r);

console.log('\n== формат ответа ==');
r = call('/clients/list', {}, token);
check('конверт {ok,data,error,status}',
  'ok' in r && 'data' in r && 'error' in r && 'status' in r, Object.keys(r));
check('doGet отвечает текстом', doGet({}).getContent().indexOf('Mifs Rent') === 0);

console.log('\n== импорт старой инвентаризации ==');
const importMsg = importInventory();
console.log('  ' + importMsg);
const eqRows = readRows(getSheet(SHEETS.EQUIPMENT));
const imported = eqRows.filter(r => String(r.condition_notes || '').indexOf('Импорт:') !== -1);
const byName = n => imported.filter(r => r.name === n);

check('импортировано 12 позиций', imported.length === 12, imported.map(r => r.name));
check('дубль по заводскому номеру склеен (Canon C70 из двух вкладок)', byName('Canon C70').length === 2);
check('одинаковые названия без серийника НЕ склеиваются', byName('Чайнаболл').length === 3, byName('Чайнаболл').length);
check('вкладка без заголовков колонок разобрана (ЗВУК)', byName('HOLLYLAND LARK MAX').length === 3);
check('объединённая строка-заголовок пропущена', byName('Камеры').length === 0);
check('строка-заголовок из одинаковых ячеек пропущена', byName('Объективы').length === 0);

const cat = n => (byName(n)[0] || {}).category;
check('категория камеры → CAM', cat('Canon C70') === 'CAM', cat('Canon C70'));
check('категория объектива → LEN', cat('ЛОМО 35mm') === 'LEN', cat('ЛОМО 35mm'));
check('категория штатива → GRP', cat('GreenBean HDV') === 'GRP', cat('GreenBean HDV'));
check('категория звука → AUD', cat('HOLLYLAND LARK MAX') === 'AUD', cat('HOLLYLAND LARK MAX'));
check('категория света → LGT', cat('Чайнаболл') === 'LGT', cat('Чайнаболл'));

const st = s => imported.filter(r => r.status === s).length;
check('«Не работает» / «Сломан» / «Разбит» → In Repair', st('In Repair') === 3, st('In Repair'));
check('«Потерян» → Retired', st('Retired') === 1, st('Retired'));
check('остальные → Available', st('Available') === 8, st('Available'));
check('мусорный серийник "?" отброшен',
  byName('Red One')[0] && byName('Red One')[0].serial_number === '', byName('Red One')[0]);
check('инвентарный номер сохранён без потери цифр',
  byName('Canon C70').some(r => String(r.inventory_number) === '1013400892'),
  byName('Canon C70').map(r => r.inventory_number));
check('исходная вкладка и строка записаны в заметки',
  /Импорт: ЗВУК#\d+/.test(byName('HOLLYLAND LARK MAX')[0].condition_notes));
check('item_id уникальны', new Set(imported.map(r => r.item_id)).size === imported.length);
check('все ID шестизначные', imported.every(r => /^\d{6}$/.test(String(r.item_id))),
  imported.map(r => r.item_id).slice(0, 5));
check('одинаковые единицы делят код модели, различаясь хвостом',
  byName('Чайнаболл').map(r => r.item_id).sort().join(',') === '030201,030202,030203',
  byName('Чайнаболл').map(r => r.item_id));
// 3 модели завели тесты выше + 6 новых принёс импорт (Canon C70 переиспользован)
check('импорт пополнил справочник моделей, не задвоив Canon C70',
  readRows(getSheet(SHEETS.MODELS)).length === 9, readRows(getSheet(SHEETS.MODELS)).map(m => m.model_name));

console.log('\n== повторный импорт не создаёт дублей ==');
importInventory();
const after = readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.condition_notes || '').indexOf('Импорт:') !== -1);
check('после повторного запуска позиций столько же', after.length === 12, after.length);

console.log('\n== перезаливка каталога ==');
const beforeReimport = readRows(getSheet(SHEETS.EQUIPMENT)).length;
const refused = reimportInventory();
check('отказывается работать, когда есть выдачи/дефекты', /отменена/.test(refused), refused);
check('каталог при отказе не тронут',
  readRows(getSheet(SHEETS.EQUIPMENT)).length === beforeReimport);

// чистим историю — имитируем склад, где выдавать ещё не начинали
getSheet(SHEETS.TRANSACTIONS).deleteRows(2, getSheet(SHEETS.TRANSACTIONS).getLastRow() - 1);
getSheet(SHEETS.DEFECTS).deleteRows(2, getSheet(SHEETS.DEFECTS).getLastRow() - 1);
const redone = reimportInventory();
const afterRows = readRows(getSheet(SHEETS.EQUIPMENT));
check('на чистой истории перезаливка проходит', /Каталог очищен/.test(redone), redone);
check('позиции не задвоились', afterRows.length === 12, afterRows.length);
check('нумерация начата заново', afterRows[0].item_id === '010101', afterRows[0].item_id);
check('справочник моделей тоже пересобран',
  readRows(getSheet(SHEETS.MODELS)).length === 7, readRows(getSheet(SHEETS.MODELS)).length);

console.log('\n== устаревшая структура таблицы не оставляет каталог пустым ==');
// Воспроизводим аварию: в таблице нет вкладки, появившейся в новой версии схемы.
// Раньше reimportInventory успевал стереть Equipment и падал на getSheet('Models'),
// оставляя склад без каталога.
spreadsheet.deleteSheet(spreadsheet.getSheetByName('Models'));
check('вкладка Models удалена для теста', !spreadsheet.getSheetByName('Models'));
let crashed = null;
try { reimportInventory(); } catch (e) { crashed = e.message; }
check('перезаливка не падает на отсутствующей вкладке', crashed === null, crashed);
check('вкладка Models восстановлена', !!spreadsheet.getSheetByName('Models'));
const healed = readRows(getSheet(SHEETS.EQUIPMENT));
check('каталог не остался пустым', healed.length === 12, healed.length);

console.log('\n== номер не теряет ведущий ноль ==');
const eqAfter = readRows(getSheet(SHEETS.EQUIPMENT));
const first = eqAfter[0];
check('item_id остался строкой с ведущим нулём', first.item_id === '010101', first.item_id);
const lookedUp = call('/item/lookup', { item_id: '010101' });
check('предмет находится по своему номеру', lookedUp.ok === true, lookedUp);

console.log('\n== порядок колонок в листе может не совпадать со схемой ==');
// Воспроизводим то, что делает setupSheets на уже заполненном листе: новая колонка
// дописывается в конец, а не встаёт на своё место в схеме. Пакетная запись обязана
// ориентироваться на заголовки листа, иначе значения уезжают в соседние колонки.
const eq = getSheet(SHEETS.EQUIPMENT);
eq.deleteRows(2, eq.getLastRow() - 1);
const reordered = SCHEMA.Equipment.filter(h => h !== 'model_code').concat(['model_code']);
eq.data[0] = reordered.slice();
getSheet(SHEETS.TRANSACTIONS).deleteRows(2, getSheet(SHEETS.TRANSACTIONS).getLastRow() - 1);
getSheet(SHEETS.DEFECTS).deleteRows(2, getSheet(SHEETS.DEFECTS).getLastRow() - 1);
importInventory();

const shifted = readRows(getSheet(SHEETS.EQUIPMENT));
const canon = shifted.filter(r => r.name === 'Canon C70')[0];
check('serial_number содержит заводской номер, а не код модели',
  String(canon.serial_number) === '273679500132', canon.serial_number);
check('status содержит статус, а не инвентарный номер',
  canon.status === 'Available' || canon.status === 'In Repair', canon.status);
check('inventory_number содержит инвентарный номер',
  String(canon.inventory_number) === '1013400892', canon.inventory_number);
check('model_code заполнен', String(canon.model_code).length === 2, canon.model_code);

console.log('\n== перезаливка на сетке, обрезанной ровно по данным ==');
// Настоящий Sheets не даёт оставить лист без незакреплённых строк. После
// импорта сетка Equipment оказалась размером ровно по данным, и очистка через
// deleteRows падала с «Sorry, it is not possible to delete all non-frozen rows».
[SHEETS.EQUIPMENT, SHEETS.MODELS, SHEETS.META].forEach((n) => trimGrid(getSheet(n)));
getSheet(SHEETS.TRANSACTIONS).getRange(2, 1, Math.max(getSheet(SHEETS.TRANSACTIONS).getLastRow() - 1, 1), 10).clearContent();
getSheet(SHEETS.DEFECTS).getRange(2, 1, Math.max(getSheet(SHEETS.DEFECTS).getLastRow() - 1, 1), 10).clearContent();
let tightError = null;
let tightMsg = null;
try { tightMsg = reimportInventory(); } catch (e) { tightError = e.message; }
check('перезаливка не падает на сетке размером по данным', tightError === null, tightError);
check('каталог пересобран', readRows(getSheet(SHEETS.EQUIPMENT)).length === 12,
  readRows(getSheet(SHEETS.EQUIPMENT)).length);
check('заголовок Equipment на месте', dumpSheet('Equipment')[0][0] === 'item_id', dumpSheet('Equipment')[0]);

console.log('\n== предмет, добавленный после импорта, сохраняет ведущий ноль ==');
// Строка, появившаяся за пределами сетки, формат колонки не наследует: без
// выставления формата перед записью "010104" уехало бы в число 10104 и
// напечатанный QR перестал бы находиться.
const eqTail = getSheet(SHEETS.EQUIPMENT);
trimGrid(eqTail);
const addedId = call('/item/create', { name: 'Sony Burano 8k', category: 'CAM' }, token).data.item_id;
const addedRow = readRows(eqTail).filter(r => r.name === 'Sony Burano 8k')[0];
check('item_id записан строкой с ведущим нулём', addedRow.item_id === addedId && /^0\d{5}$/.test(String(addedRow.item_id)),
  addedRow.item_id);
const addedLookup = call('/item/lookup', { item_id: addedId });
check('добавленный предмет находится по номеру', addedLookup.ok === true, addedLookup);
check('model_code добавленного предмета остался двузначным',
  String(addedRow.model_code).length === 2, addedRow.model_code);

console.log('\n== код модели в справочнике и в каталоге выглядит одинаково ==');
// Справочник и каталог хранят одну и ту же величину. Пока она где-то лежит
// числом 1, а где-то строкой "01", любое сравнение строкой сломается молча —
// тот же класс ошибки, что мы ловили на ведущих нулях в номерах.
const modelRows = readRows(getSheet(SHEETS.MODELS));
check('все коды моделей — двузначные строки',
  modelRows.every(m => /^\d{2}$/.test(String(m.model_code))),
  modelRows.map(m => m.model_code));
const eqForModels = readRows(getSheet(SHEETS.EQUIPMENT));
check('код модели в каталоге в том же виде',
  eqForModels.every(r => /^\d{2}$/.test(String(r.model_code))),
  eqForModels.slice(0, 5).map(r => r.model_code));
// модель, заведённая из приложения, а не импортом — тот же вид
const freshId = call('/item/create', { name: 'Arri Alexa 35', category: 'CAM' }, token).data.item_id;
const freshModelCode = String(freshId).slice(2, 4);
const freshModel = readRows(getSheet(SHEETS.MODELS))
  .filter(m => m.model_name === 'Arri Alexa 35')[0];
check('новая модель из приложения записана с ведущим нулём',
  /^\d{2}$/.test(String(freshModel.model_code)), freshModel.model_code);
check('код модели в справочнике совпадает с номером предмета',
  String(freshModel.model_code) === freshModelCode, [freshModel.model_code, freshId]);
const byCode = call('/models/list', { category: 'CAM' }, token);
check('модель по-прежнему находится по коду',
  byCode.ok && byCode.data.some(m => String(m.model_code) === String(freshModel.model_code)), byCode.data);
const reuse = call('/item/create', { model_code: freshModel.model_code, category: 'CAM' }, token);
check('по коду из справочника создаётся следующий экземпляр той же модели',
  reuse.ok && String(reuse.data.item_id).slice(0, 4) === String(freshId).slice(0, 4),
  reuse.ok ? reuse.data.item_id : reuse);

console.log('\n' + (failures ? '❌ ПРОВАЛОВ: ' + failures : '✅ Все проверки пройдены'));
process.exit(failures ? 1 : 0);
