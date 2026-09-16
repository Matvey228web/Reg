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
  deleteRow(row) { this.deleteRows(row, 1); }
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
  base64Decode(str) {
    return Array.from(Buffer.from(String(str), 'base64')).map(b => (b > 127 ? b - 256 : b));
  },
  newBlob(bytes, type, name) {
    const buf = Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b)));
    return { _buf: buf, _type: type, _name: name,
             getName() { return this._name; }, getBytes() { return Array.from(this._buf); } };
  },
  // Настоящий zip не нужен: проверяем, что архив собирается из всех блобов и
  // получает имя. Содержимое архива Telegram проверит сам.
  zip(blobs, name) {
    return { _zip: blobs, _name: name, getName() { return this._name; },
             getBytes() { return [].concat(...blobs.map(b => b.getBytes())); } };
  },
};

// Подставная сеть: наружу из тестов ничего не уходит, но видно, что ушло бы.
const sent = [];
global.UrlFetchApp = {
  fetch(url, opts) {
    sent.push({ url, opts });
    return { getContentText: () => JSON.stringify({ ok: true, result: {} }) };
  },
};
let scriptProps = {};
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
    setProperty: (k, v) => { scriptProps[k] = v; },
  }),
};
global.ContentService = {
  MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
  createTextOutput(text) {
    return { _text: text, setMimeType() { return this; }, getContent() { return this._text; } };
  },
};

// Диск: папки и файлы держим в памяти — проверяем, что выгрузка реально
// создаёт файл с нужным числом строк, а не только рапортует об успехе.
const drive = { folders: {} };
function fakeFolder(name) {
  if (!drive.folders[name]) drive.folders[name] = { name, files: [] };
  const folder = drive.folders[name];
  return {
    createFile(fileName, content) {
      const file = { name: fileName, content, id: 'file-' + (folder.files.length + 1) };
      folder.files.push(file);
      return { getId: () => file.id, getName: () => file.name };
    },
  };
}
global.DriveApp = {
  getFoldersByName(name) {
    const exists = !!drive.folders[name];
    let taken = false;
    return {
      hasNext: () => exists && !taken,
      next: () => { taken = true; return fakeFolder(name); },
    };
  },
  createFolder: (name) => fakeFolder(name),
};
global.MimeType = { CSV: 'text/csv' };

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
check('создано 14 вкладок', spreadsheet.getSheets().length === 14, spreadsheet.getSheets().map(s => s.name));
check('Sheet1 удалён', !spreadsheet.getSheetByName('Sheet1'));
check('заголовки Equipment верны',
  JSON.stringify(dumpSheet('Equipment')[0]) === JSON.stringify(SCHEMA.Equipment), dumpSheet('Equipment')[0]);
check('заголовки Meta верны',
  JSON.stringify(dumpSheet('Meta')[0]) === JSON.stringify(SCHEMA.Meta));

console.log('\n== setupSheets повторно (идемпотентность) ==');
spreadsheet.getSheetByName('Clients').appendRow([1, 'Тест Клиент', 'Проект', '', '', '']);
setupSheets();
check('вкладок по-прежнему 14', spreadsheet.getSheets().length === 14);
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
r = call('/item/lookup', { item_id: itemId }, token);
check('статус стал Rented', r.ok && r.data.status === 'Rented', r.data && r.data.status);
check('current_transaction подтянулась', r.ok && r.data.current_transaction !== null);
r = call('/transaction/checkout', { item_id: itemId, client_id: clientId }, token);
check('повторная выдача отклонена (409)', r.ok === false && r.status === 409, r);

r = call('/transaction/checkin', { item_id: itemId, has_defect: true, defect_description: 'Царапина', defect_severity: 'Major' }, token);
check('приём с дефектом прошёл', r.ok === true && r.data.defect_id === 1, r);
r = call('/item/lookup', { item_id: itemId }, token);
check('статус стал In Repair', r.ok && r.data.status === 'In Repair', r.data && r.data.status);
check('current_transaction очищена', r.ok && r.data.current_transaction === null);
check('дефект виден как открытый', r.ok && r.data.open_defects.length === 1);

console.log('\n== закрытие дефекта возвращает предмет в строй ==');
r = call('/defect/resolve', { defect_id: 1, status: 'Resolved', resolution_notes: 'Отполировали' }, token);
check('дефект закрыт', r.ok === true, r);
r = call('/item/lookup', { item_id: itemId }, token);
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
// Отключение должно действовать сразу, а не когда истечёт срок сессии: иначе
// человек с уже открытым приложением продолжает работать.
check('прежняя сессия отключённого больше не действует',
  call('/equipment/list', {}, ivanToken).status === 401);

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
check('категория штатива → SUP (поддержка, а не грип)', cat('GreenBean HDV') === 'SUP', cat('GreenBean HDV'));
check('категория звука → AUD', cat('HOLLYLAND LARK MAX') === 'AUD', cat('HOLLYLAND LARK MAX'));
// Чайнаболл — модификатор, а не осветитель: раньше он лежал в одной куче
// со светом, и «Свет» разрастался до 203 позиций.
check('чайнаболл → MOD, а не в общую кучу света', cat('Чайнаболл') === 'MOD', cat('Чайнаболл'));

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
  byName('Чайнаболл').map(r => r.item_id).sort().join(',') === '090101,090102,090103',
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
const lookedUp = call('/item/lookup', { item_id: '010101' }, token);
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
const addedLookup = call('/item/lookup', { item_id: addedId }, token);
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

console.log('\n== перезаливка каталога не ломает счётчики и доступ ==');
// Раньше перезаливка чистила Meta целиком, а импорт вдобавок превращал
// нечисловые значения в 0. Сотрудники и клиенты перезаливку переживают, а их
// счётчики обнулялись — новый сотрудник получал номер уже работающего. Тем же
// путём затиралась отметка bootstrap_done, то есть снова открывался путь
// «стань администратором без пароля».
const staffBefore = readRows(getSheet(SHEETS.STAFF)).map(x => x.staff_id);
const flagBefore = metaGet('bootstrap_done');
check('отметка bootstrap_done поставлена при создании первого админа', !!flagBefore, flagBefore);
reimportInventory();
check('отметка bootstrap_done уцелела после перезаливки',
  metaGet('bootstrap_done') === flagBefore, [flagBefore, metaGet('bootstrap_done')]);
check('сотрудники перезаливку пережили',
  JSON.stringify(readRows(getSheet(SHEETS.STAFF)).map(x => x.staff_id)) === JSON.stringify(staffBefore),
  readRows(getSheet(SHEETS.STAFF)).map(x => x.staff_id));
r = call('/staff/create', { full_name: 'Новый', login: 'newbie', pin: '3333' }, token);
check('новому сотруднику достаётся свободный номер, а не номер работающего',
  r.ok && staffBefore.indexOf(r.data.staff_id) === -1, [staffBefore, r.data]);
r = call('/client/create', { client_name: 'Второй клиент', project_name: 'Тест' }, token);
check('новому клиенту тоже достаётся свободный номер', r.ok && r.data.client_id !== clientId,
  [clientId, r.data]);

console.log('\n== дефект снимает с выдачи по серьёзности, одинаково на всех путях ==');
// Раньше приём с дефектом всегда уводил в ремонт, а отдельная заявка — только
// при «не работает»: серьёзная поломка оставляла технику доступной к выдаче.
const status = (id) => call('/item/lookup', { item_id: id }, token).data.status;
const dItem = call('/item/create', { name: 'Aputure 600d', category: 'LGT' }, token).data.item_id;

r = call('/defect/report', { item_id: dItem, description: 'Царапина на корпусе', severity: 'Minor' }, token);
check('незначительный дефект принят', r.ok === true, r);
check('...и предмет остаётся доступным', status(dItem) === 'Available', status(dItem));

r = call('/defect/report', { item_id: dItem, description: 'Не держит фокус', severity: 'Major' }, token);
check('серьёзный дефект снимает с выдачи', status(dItem) === 'In Repair', status(dItem));
check('новый статус вернулся в ответе заявки', r.ok && r.data.status === 'In Repair', r.data);
check('предмет в ремонте выдать нельзя',
  call('/transaction/checkout', { item_id: dItem, client_id: clientId }, token).status === 409);

const majorDefect = call('/item/lookup', { item_id: dItem }, token)
  .data.open_defects.filter(d => d.severity === 'Major')[0];
r = call('/defect/resolve', { defect_id: majorDefect.defect_id, resolution_notes: 'Починили' }, token);
check('серьёзный дефект закрыт', r.ok === true, r);
check('предмет снова доступен, хотя царапина ещё открыта', status(dItem) === 'Available', status(dItem));
check('незначительный дефект остался в открытых',
  call('/item/lookup', { item_id: dItem }, token).data.open_defects.length === 1);

call('/defect/report', { item_id: dItem, description: 'Не включается', severity: 'Out of Service' }, token);
check('«не работает» снимает с выдачи', status(dItem) === 'In Repair', status(dItem));

const cItem = call('/item/create', { name: 'Godox VL150', category: 'LGT' }, token).data.item_id;
call('/transaction/checkout', { item_id: cItem, client_id: clientId }, token);
r = call('/transaction/checkin',
  { item_id: cItem, has_defect: true, defect_description: 'Пыль на линзе', defect_severity: 'Minor' }, token);
check('приём с незначительным дефектом прошёл', r.ok === true, r);
check('...и предмет сразу доступен снова', status(cItem) === 'Available', status(cItem));

console.log('\n== смена PIN ==');
const petrId = call('/staff/create',
  { full_name: 'Пётр', login: 'petr', pin: '1234', role: 'Warehouse Staff' }, token).data.staff_id;
let petrToken = call('/auth/login', { login: 'petr', pin: '1234' }).data.token;
check('слишком короткий PIN отклонён',
  call('/staff/set-pin', { pin: '12', current_pin: '1234' }, petrToken).status === 400);
// 403, а не 401: сессия цела, ошибся человек — иначе клиент выбросил бы его на вход
check('неверный текущий PIN отклонён, но сессия не рушится',
  call('/staff/set-pin', { pin: '5555', current_pin: '0000' }, petrToken).status === 403);
check('...и токен после этого ещё живой', call('/equipment/list', {}, petrToken).ok === true);
r = call('/staff/set-pin', { pin: '5555', current_pin: '1234' }, petrToken);
check('свой PIN сменён', r.ok === true, r);
check('взамен выдан новый токен, человек не вылетает из приложения', r.ok && !!r.data.token, r.data);
check('старый токен больше не действует', call('/equipment/list', {}, petrToken).status === 401);
check('старый PIN не пускает', call('/auth/login', { login: 'petr', pin: '1234' }).status === 401);
petrToken = call('/auth/login', { login: 'petr', pin: '5555' }).data.token;
check('новый PIN пускает', !!petrToken);

r = call('/staff/set-pin', { staff_id: petrId, pin: '7777' }, token);
check('администратор сбрасывает PIN сотруднику без текущего PIN', r.ok === true, r);
check('сессия сотрудника при сбросе обнуляется', call('/equipment/list', {}, petrToken).status === 401);
petrToken = call('/auth/login', { login: 'petr', pin: '7777' }).data.token;
check('сотрудник склада не может менять PIN другому',
  call('/staff/set-pin', { staff_id: 1, pin: '9999' }, petrToken).status === 403);

console.log('\n== защита от перебора PIN ==');
for (let i = 0; i < 5; i++) call('/auth/login', { login: 'petr', pin: '0000' });
r = call('/auth/login', { login: 'petr', pin: '7777' });
check('после 5 промахов не пускает даже верный PIN', r.ok === false && r.status === 429, r);
const petrRow = () => readRows(getSheet(SHEETS.STAFF)).filter(x => x.login === 'petr')[0];
updateRow(getSheet(SHEETS.STAFF), petrRow().__row,
  { locked_until: new Date(Date.now() - 1000).toISOString() });
r = call('/auth/login', { login: 'petr', pin: '7777' });
check('когда блокировка истекла, вход снова работает', r.ok === true, r);
check('счётчик промахов обнулён удачным входом', Number(petrRow().failed_attempts || 0) === 0,
  petrRow().failed_attempts);

console.log('\n== справочник категорий живёт в таблице ==');
const catSheet = getSheet(SHEETS.CATEGORIES);
check('лист категорий засеян умолчаниями', readRows(catSheet).length === 14,
  readRows(catSheet).map(c => c.code));
check('номера категорий двузначные строки',
  readRows(catSheet).every(c => /^\d{2}$/.test(String(c.num))),
  readRows(catSheet).map(c => c.num));
check('камера по-прежнему 01', categoryNum('CAM') === '01', categoryNum('CAM'));

// Побитый справочник не должен ломать номера предметов: два одинаковых номера
// означали бы два предмета с одним item_id.
const catBackup = catSheet.data.map(r => r.slice());
updateRow(catSheet, 2, { num: '02' });   // теперь у CAM и LEN одинаковый номер
check('дубль номера отбрасывается, а не собирает битый номер',
  categories().every((c, i, all) => all.filter(x => x.num === c.num).length === 1),
  categories().map(c => c.code + ':' + c.num));
catSheet.data = catBackup.map(r => r.slice());
check('справочник восстановлен', categoryNum('CAM') === '01');

// Справочник на живой таблице: раньше засев работал только на пустом листе,
// поэтому новые категории на работающей таблице не появлялись вообще.
const catRowsBefore = readRows(catSheet).length;
const camNumBefore = categoryNum('CAM');
trimSheetRows(catSheet, function (row) { return String(row.code) === 'MED'; });
check('категория удалена из листа вручную', readRows(catSheet).length === catRowsBefore - 1);
setupSheets();
check('недостающая категория дописана миграцией',
  readRows(catSheet).length === catRowsBefore &&
  readRows(catSheet).some(function (c) { return String(c.code) === 'MED'; }),
  readRows(catSheet).map(function (c) { return c.code; }));
check('номера существующих категорий миграция не трогает', categoryNum('CAM') === camNumBefore);
check('повторный запуск ничего не дублирует',
  (setupSheets(), readRows(catSheet).length) === catRowsBefore, readRows(catSheet).length);

// Категория берётся по названию. В примечаниях складские пишут «нужна клетка» и
// «аккумулятор в комплекте» — по ним камера уезжала в обвес, а объектив в питание.
check('камера остаётся камерой, даже если в примечании «нужна клетка»',
  importCategory('', 'КИНО', 'Sony Burano 8k') === 'CAM');
check('софтбокс Godox не считается осветителем',
  importCategory('', 'СВЕТ', 'Godox SB-UFW120') === 'MOD', importCategory('', 'СВЕТ', 'Godox SB-UFW120'));
check('радиосистема не уезжает в фильтры из-за букв «nd» в названии',
  importCategory('', 'ЗВУК', 'HOLLYLAND LARK MAX') === 'AUD',
  importCategory('', 'ЗВУК', 'HOLLYLAND LARK MAX'));
check('монитор отделён от «прочего»',
  importCategory('', 'КИНО', 'Tvlogic F-7HS') === 'MON');
check('мешки и флаги попадают в грип',
  importCategory('', '', 'SANDBAG BIG') === 'GRP' && importCategory('', '', 'ФЛАГ БОЛЬШОЙ') === 'GRP');

console.log('\n== штучные позиции: учёт количеством ==');
// Двадцать сэндбэгов — это одна строка «20 штук», а не двадцать номеров с QR.
r = call('/item/create', { name: 'SANDBAG BIG', category: 'GRP', qty: 20 }, token);
check('позиция заведена количеством', r.ok === true && r.data.qty === 20, r.data);
const bagId = r.data.item_id;
r = call('/item/create', { name: 'SANDBAG BIG', category: 'GRP', qty: 5 }, token);
check('повторное заведение пополняет ту же строку, а не плодит вторую',
  r.ok && r.data.item_id === bagId && r.data.qty === 25, r.data);
check('на складе одна строка сэндбэгов',
  readRows(getSheet(SHEETS.EQUIPMENT)).filter(e => e.name === 'SANDBAG BIG').length === 1);

r = call('/item/lookup', { item_id: bagId }, token);
check('карточка отдаёт количество и остаток',
  r.ok && r.data.qty === 25 && r.data.qty_out === 0 && r.data.qty_free === 25 && r.data.by_qty === true,
  r.data);

r = call('/transaction/checkout', { item_id: bagId, qty: 4 }, token);
check('выдали четыре штуки', r.ok === true && r.data.qty === 4, r);
r = call('/item/lookup', { item_id: bagId }, token);
check('остаток уменьшился, позиция осталась доступной',
  r.ok && r.data.qty_out === 4 && r.data.qty_free === 21 && r.data.status === 'Available', r.data);

r = call('/transaction/checkout', { item_id: bagId, qty: 30 }, token);
check('выдать больше, чем есть, нельзя (409)', r.ok === false && r.status === 409, r);
check('в отказе сказано, сколько свободно', /свободно 21 из 25/.test(String(r.error)), r.error);

// Вторая выдача — чтобы проверить, что приём закрывает записи по очереди.
call('/transaction/checkout', { item_id: bagId, qty: 6 }, token);
r = call('/transaction/checkin', { item_id: bagId, qty: 7 }, token);
check('приняли семь штук', r.ok === true && r.data.qty === 7 && r.data.qty_out === 3, r.data);
const bagTx = readRows(getSheet(SHEETS.TRANSACTIONS)).filter(t => String(t.item_id) === String(bagId));
check('первая выдача закрыта целиком',
  bagTx[0].status === 'Closed' && Number(bagTx[0].qty_in) === 4, bagTx[0]);
check('вторая закрыта частично и осталась открытой',
  bagTx[1].status === 'Open' && Number(bagTx[1].qty_in) === 3, bagTx[1]);
r = call('/transaction/checkin', { item_id: bagId, qty: 99 }, token);
check('принять больше, чем на руках, нельзя (409)', r.ok === false && r.status === 409, r);

// Когда выдали всё — позиция занята; вернули одну — снова доступна.
call('/transaction/checkout', { item_id: bagId, qty: 22 }, token);
r = call('/item/lookup', { item_id: bagId }, token);
check('выдали всё — позиция «в аренде»', r.ok && r.data.status === 'Rented' && r.data.qty_free === 0, r.data);
call('/transaction/checkin', { item_id: bagId, qty: 1 }, token);
r = call('/item/lookup', { item_id: bagId }, token);
check('вернули одну — снова доступна', r.ok && r.data.status === 'Available' && r.data.qty_free === 1, r.data);

// Поштучная техника количеством не считается.
r = call('/item/lookup', { item_id: itemId }, token);
check('обычная камера остаётся поштучной', r.ok && r.data.by_qty === false && r.data.qty === 1, r.data);

console.log('\n== способ учёта категории ==');
r = call('/category/update', { code: 'GRP', by_qty: false }, token);
check('у заполненной категории способ учёта не меняется (409)', r.ok === false && r.status === 409, r);
r = call('/category/update', { code: 'MED', by_qty: true }, token);
check('у пустой категории меняется', r.ok === true, r);
check('...и это видно в справочнике',
  categories().filter(c => c.code === 'MED')[0].by_qty === true);

// Одна камера под двумя именами. Нормализация написания такое не ловит:
// «A7 IV» и «ILCE-7M4» — разные буквы, но один аппарат.
check('маркетинговое имя сводится к каталожному',
  canonicalModelName('Sony A7 iv') === 'Sony ILCE-7M4', canonicalModelName('Sony A7 iv'));
check('каталожное имя остаётся собой',
  canonicalModelName('Sony ILCE-7M4') === 'Sony ILCE-7M4');
check('разное написание синонима тоже сводится',
  canonicalModelName('SONY  a7-iv') === 'Sony ILCE-7M4', canonicalModelName('SONY  a7-iv'));
check('незнакомая модель не трогается',
  canonicalModelName('  Canon C70 ') === 'Canon C70', canonicalModelName('  Canon C70 '));
check('7RM3 и 7RM3A остаются разными моделями',
  canonicalModelName('Sony ILCE 7RM3') !== canonicalModelName('Sony ILCE-7RM3A'));

// И то же самое через создание предмета: оба имени должны лечь в одну модель.
const aliasA = call('/item/create', { name: 'Sony ILCE-7M4', category: 'CAM' }, token).data.item_id;
const aliasB = call('/item/create', { name: 'Sony A7 IV', category: 'CAM' }, token).data.item_id;
check('оба имени дают один код модели, разные экземпляры',
  aliasA.slice(0, 4) === aliasB.slice(0, 4) && aliasA !== aliasB, [aliasA, aliasB]);
check('в каталоге записано каталожное имя',
  findRowByValue(getSheet(SHEETS.EQUIPMENT), 'item_id', aliasB).name === 'Sony ILCE-7M4',
  findRowByValue(getSheet(SHEETS.EQUIPMENT), 'item_id', aliasB).name);

console.log('\n== настройки: чтение, проверка, сохранение ==');
let cfg = call('/settings/get', {}, token);
check('настройки отдаются вошедшему', cfg.ok === true, cfg);
check('умолчания на месте', cfg.data.settings.session_ttl_hours === 12 &&
  cfg.data.settings.max_login_attempts === 5, cfg.data.settings);
check('категории приходят вместе с настройками', cfg.data.categories.length === 14);
// Отдельная учётка: повторный вход аннулирует прежний токен, и войди мы здесь
// под администратором — сломали бы сессию, которой пользуются проверки ниже.
call('/staff/create', { full_name: 'Проба', login: 'probe', pin: '9876', role: 'Warehouse Staff' }, token);
const probeLogin = call('/auth/login', { login: 'probe', pin: '9876' });
check('настройки и категории приезжают уже при входе',
  !!probeLogin.data.settings && !!probeLogin.data.categories, probeLogin.data);
const probeToken = probeLogin.data.token;
check('повторный вход выкидывает прежнюю сессию',
  !!call('/auth/login', { login: 'probe', pin: '9876' }).data.token &&
  call('/equipment/list', {}, probeToken).status === 401);

r = call('/settings/set', { settings: { max_login_attempts: 0 } }, token);
check('недопустимое значение отклонено с объяснением',
  r.ok === false && r.status === 400 && /от 3 до 20/.test(r.error), r);
check('...и не сохранилось', call('/settings/get', {}, token).data.settings.max_login_attempts === 5);
r = call('/settings/set', { settings: { session_ttl_hours: 24, max_login_attempts: 7 } }, token);
check('допустимые значения сохранены', r.ok === true && r.data.settings.session_ttl_hours === 24, r);
check('неизвестная настройка отклонена',
  call('/settings/set', { settings: { hack: 1 } }, token).status === 400);
// Ивана к этому моменту уже отключили, и его сессия аннулирована — отказ
// приходит на входе, до проверки роли.
check('сотрудник склада настройки менять не может',
  call('/settings/set', { settings: { session_ttl_hours: 2 } }, ivanToken).status === 401);

console.log('\n== категории: добавление и защита номера ==');
r = call('/category/create', { code: 'BAT', label: 'Аккумуляторы' }, token);
check('категория добавлена', r.ok === true, r);
check('номер выдан следующий свободный (15)', r.ok && r.data.num === '15', r.data);
check('дубль кода отклонён',
  call('/category/create', { code: 'BAT', label: 'Ещё раз' }, token).status === 409);
check('кривой код отклонён',
  call('/category/create', { code: 'X', label: 'Короткий' }, token).status === 400);
r = call('/category/create', { code: 'GEL', label: 'Гели и скотч', by_qty: true }, token);
check('новую категорию можно сразу завести количеством', r.ok === true && r.data.by_qty === true, r.data);
r = call('/category/update', { code: 'BAT', label: 'Аккумуляторы и зарядки' }, token);
check('название меняется свободно', r.ok === true, r);
r = call('/category/update', { code: 'BAT', num: 15 }, token);
check('номер у пустой категории сменить можно', r.ok === true, r);

// А вот у занятой — нельзя: номер вшит в item_id и напечатан на этикетках
check('в камерах есть позиции', categoryUsage('CAM') > 0, categoryUsage('CAM'));
r = call('/category/update', { code: 'CAM', num: 20 }, token);
check('номер занятой категории сменить нельзя', r.ok === false && r.status === 409, r);
check('в отказе объяснено почему', /этикетк/.test(String(r.error)), r.error);
check('номер камеры не изменился', categoryNum('CAM') === '01');
check('существующие номера предметов целы',
  readRows(getSheet(SHEETS.EQUIPMENT)).every(i => /^\d{6}$/.test(String(i.item_id))));

console.log('\n== удаление сотрудника ==');
// Удаляем полностью, но история не должна обезличиться: в журнале рядом с
// номером лежит имя, иначе после удаления строки было бы не прочитать, кто
// выдавал технику.
const delItem = call('/item/create', { name: 'Aputure 300x', category: 'LGT' }, token).data.item_id;
const victim = call('/staff/create',
  { full_name: 'Игорь Уволенный', login: 'igor', pin: '1212', role: 'Warehouse Staff' }, token).data;
const victimToken = call('/auth/login', { login: 'igor', pin: '1212' }).data.token;
call('/transaction/checkout', { item_id: delItem, client_id: clientId }, victimToken);
call('/transaction/checkin', { item_id: delItem, has_defect: true,
  defect_description: 'Скол на корпусе', defect_severity: 'Minor' }, victimToken);

check('в журнале выдач сохранилось имя сотрудника',
  readRows(getSheet(SHEETS.TRANSACTIONS)).some(t => t.staff_out_name === 'Игорь Уволенный'),
  readRows(getSheet(SHEETS.TRANSACTIONS)).map(t => t.staff_out_name));
check('в журнале дефектов сохранилось имя сотрудника',
  readRows(getSheet(SHEETS.DEFECTS)).some(d => d.reported_by_name === 'Игорь Уволенный'));

check('сотрудник склада не может удалять сотрудников',
  call('/staff/delete', { staff_id: victim.staff_id }, victimToken).status === 403);
check('себя удалить нельзя', call('/staff/delete', { staff_id: 1 }, token).status === 409,
  call('/staff/delete', { staff_id: 1 }, token));
r = call('/staff/delete', { staff_id: victim.staff_id }, token);
check('администратор удалил сотрудника', r.ok === true, r);
check('сотрудник исчез из списка',
  call('/staff/list', {}, token).data.every(x => x.staff_id !== victim.staff_id));
check('войти под удалённым нельзя', call('/auth/login', { login: 'igor', pin: '1212' }).status === 401);
check('история после удаления по-прежнему называет имя, а не номер',
  readRows(getSheet(SHEETS.TRANSACTIONS)).some(t => t.staff_out_name === 'Игорь Уволенный'));

console.log('\n== выгрузка журнала и подрезка ==');
// Подрезать таблицу без выгрузки нельзя: данные потерялись бы безвозвратно.
r = trimJournal();
check('подрезка без выгрузки отклонена', /отменена/.test(r), r);
const txBefore = readRows(getSheet(SHEETS.TRANSACTIONS)).length;
check('в журнале есть записи для выгрузки', txBefore > 0, txBefore);

r = archiveJournal();
check('выгрузка прошла', /выгружен/.test(r), r);
check('файл появился в папке архива',
  (drive.folders['Mifs Rent — архив'] || { files: [] }).files.length > 0,
  Object.keys(drive.folders));
const csv = drive.folders['Mifs Rent — архив'].files[0].content;
check('в файле есть заголовок и строки', csv.split('\n').length === txBefore + 1,
  [csv.split('\n').length, txBefore + 1]);
check('имя сотрудника попало в выгрузку', csv.indexOf('Игорь Уволенный') !== -1);

// оставляем одну открытую выдачу — подрезка не должна её тронуть
const keepItem = call('/item/create', { name: 'Godox VL300', category: 'LGT' }, token).data.item_id;
call('/transaction/checkout', { item_id: keepItem, client_id: clientId }, token);
const openBefore = readRows(getSheet(SHEETS.TRANSACTIONS)).filter(t => t.status === 'Open').length;
r = trimJournal();
check('подрезка после выгрузки прошла', /подрезан/.test(r), r);
const txAfter = readRows(getSheet(SHEETS.TRANSACTIONS));
check('закрытые выдачи удалены', txAfter.every(t => t.status !== 'Closed'),
  txAfter.map(t => t.status));
check('открытая выдача осталась на месте',
  txAfter.filter(t => t.status === 'Open').length === openBefore, txAfter.length);
check('устранённые дефекты удалены',
  readRows(getSheet(SHEETS.DEFECTS)).every(d => d.status !== 'Resolved'));
r = trimJournal();
check('повторная подрезка снова требует выгрузки', /отменена/.test(r), r);

console.log('\n== обслуживание из приложения ==');
check('сотрудник склада обслуживание не запускает',
  call('/maintenance', { action: 'archive' }, ivanToken).status === 401);
check('неизвестное действие отклонено',
  call('/maintenance', { action: 'drop-everything' }, token).status === 400);
r = call('/maintenance', { action: 'trim' }, token);
check('подрезка через эндпоинт так же требует выгрузки',
  r.ok === true && /отменена/.test(r.data.message), r);
r = call('/maintenance', { action: 'archive' }, token);
check('выгрузка через эндпоинт работает', r.ok === true && /выгружен|пуст/.test(r.data.message), r);


console.log('\n== заказы: разбор живого сообщения бота ==');
// Настоящее сообщение из общего чата. Держим его в тесте целиком: разбор должен
// ломаться здесь, а не на складе.
const BOT_MESSAGE = [
  'Заказ №1525686941',
  '\t1.\tGODOX OCTABOX 120: 0 (1 x 0.00)',
  '\t2.\tGODOX KNOWLED M600BI: 0 (1 x 0.00)',
  '\t3.\tGODOX KNOWLED MG1200BI: 0 (1 x 0.00)',
  '\t4.\tOSTERRIG SIRIUS 100CM: 154000 (4 x 38500)',
  '\t5.\tСОТЫ РАСТЕР OSTERRIG SIRIUS 100CM: 0 (1 x 0.00)',
  '\t6.\tSANDBAG BIG: 50000 (20 x 2500)',
  '\t7.\tФЛАГ БОЛЬШОЙ: 4800 (1 x 4800)',
  '\t8.\tПЕНА БЕЛАЯ/SILVER: 3500 (1 x 3500)',
  '\t9.\tSUPER CLAMP: 1750 (1 x 1750)',
  'Сумма платежа: 214050 RUB',
  'Платежная система: (none)',
  '',
  'Информация о покупателе:',
  'Are_you_an_adult: Нет',
  'Full_name_guardian: Ильина-Ноткина Елена Борисовна',
  'Date_of_birth_guardian: 07.09.1980',
  'Phone_guardian: +79257868093',
  'Full_name_minor: Ильина-Ноктина Полина Ильинична',
  'Date_of_birth_minor: 18.11.2008',
  'Phone_minors: +79257868093',
  'Telegram_Minors: @poliviks_notkina',
  'Date_of_issue: 30.04.2026',
  'Date_completion: 03.05.2026',
  'Type_and_name_of_the_project: км',
  'Equipment_use_addresses: шипила',
  'Input: + 4 ковра гойда',
  '',
  'Дополнительная информация:',
  'Код заявки: 3288736:8358371482',
  'Код блока: rec1685127891',
  'Форма: Cart',
  'https://alexeyshishkin.ru/mifs_rent/220/reservation/cinema#!/tab/687538023-3',
].join('\n');

// Две позиции из заказа заводим в каталог, чтобы проверить сопоставление.
const osterrig1 = call('/item/create', { name: 'OSTERRIG SIRIUS 100CM', category: 'LGT' }, token).data.item_id;
const osterrig2 = call('/item/create', { name: 'OSTERRIG SIRIUS 100CM', category: 'LGT' }, token).data.item_id;
call('/item/create', { name: 'GODOX OCTABOX 120', category: 'LGT' }, token);

r = call('/order/parse', { text: BOT_MESSAGE }, token);
check('сообщение разобрано', r.ok === true, r);
const parsed = r.ok ? r.data : { order: {}, items: [], warnings: [] };
check('номер заказа строкой', parsed.order.order_no === '1525686941', parsed.order.order_no);
check('код заявки с двоеточием не потерян',
  parsed.order.request_code === '3288736:8358371482', parsed.order.request_code);
check('разобрано 9 строк состава', parsed.items.length === 9, parsed.items.length);
check('количество из строки «4 x 38500» прочитано',
  parsed.items[3].qty === 4 && parsed.items[3].price === 38500, parsed.items[3]);
check('двадцать сэндбэгов — это количество, а не двадцать строк',
  parsed.items[5].qty === 20 && parsed.items[5].raw_name === 'SANDBAG BIG', parsed.items[5]);
check('заказчик несовершеннолетний', parsed.order.is_adult === 'FALSE', parsed.order.is_adult);
check('арендатор — ребёнок, а не представитель',
  parsed.order.student_name === 'Ильина-Ноктина Полина Ильинична', parsed.order.student_name);
check('представитель распознан',
  parsed.order.guardian_name === 'Ильина-Ноткина Елена Борисовна', parsed.order.guardian_name);
check('телефоны приведены к одному виду',
  parsed.order.student_phone === '+79257868093' && parsed.order.guardian_phone === '+79257868093',
  [parsed.order.student_phone, parsed.order.guardian_phone]);
check('ник Telegram взят как есть', parsed.order.student_tg === '@poliviks_notkina', parsed.order.student_tg);
check('даты переведены в ISO',
  parsed.order.issue_date === '2026-04-30' && parsed.order.return_date === '2026-05-03',
  [parsed.order.issue_date, parsed.order.return_date]);
check('дописанное руками поле Input сохранено',
  parsed.order.extra_input === '+ 4 ковра гойда', parsed.order.extra_input);
check('проект прочитан', parsed.order.project === 'км', parsed.order.project);
check('сумма и валюта прочитаны',
  parsed.order.amount === 214050 && parsed.order.currency === 'RUB',
  [parsed.order.amount, parsed.order.currency]);
check('ссылка на заказ сохранена как непрозрачная строка',
  /^https:\/\/alexeyshishkin\.ru\//.test(parsed.order.source_url), parsed.order.source_url);
// Персональных данных — минимум: даты рождения отдельными полями не раскладываем.
check('даты рождения не попадают в поля заказа',
  parsed.order.student_birth_date === undefined && parsed.order.guardian_birth_date === undefined,
  Object.keys(parsed.order));
check('но исходное сообщение сохранено целиком для акта',
  /Date_of_birth_minor/.test(parsed.order.raw_text));
check('неизвестные поля формы доехали до человека',
  parsed.fields['equipmentuseaddresses'] === 'шипила', parsed.fields['equipmentuseaddresses']);
check('позиция из каталога сопоставлена автоматически',
  parsed.items[3].model_code !== '' && parsed.items[3].category === 'LGT', parsed.items[3]);
check('несопоставленные позиции названы в предупреждениях',
  parsed.warnings.some(w => /Не сопоставлено/.test(w)), parsed.warnings);
r = call('/order/parse', { text: 'Привет, а склад открыт?' }, token);
check('не-заказ отклонён с внятной ошибкой', r.ok === false && r.status === 400, r);

console.log('\n== заказы: создание и один номер — один заказ ==');
r = call('/order/create', Object.assign({}, parsed.order, { items: parsed.items }), token);
check('заказ создан', r.ok === true, r);
const orderId = r.ok ? r.data.order_id : null;
check('студент заведён', r.ok && r.data.student_id === 1 && r.data.student_created === true, r.data);
r = call('/order/create', Object.assign({}, parsed.order, { items: parsed.items }), token);
check('повторный номер заказа отклонён (409)', r.ok === false && r.status === 409, r);

// Тот же человек, телефон записан иначе — история должна остаться одной.
r = call('/order/create', {
  order_no: '1525686942', student_name: 'Ильина-Ноктина Полина Ильинична',
  student_phone: '8 (925) 786-80-93', is_adult: 'FALSE',
  guardian_name: 'Ильина-Ноткина Елена Борисовна', guardian_phone: '89257868093',
  issue_date: '10.05.2026', return_date: '12.05.2026', items: [],
}, token);
check('телефон в другом формате нашёл того же студента',
  r.ok === true && r.data.student_id === 1 && r.data.student_created === false, r.data);
const secondOrderId = r.ok ? r.data.order_id : null;

const ordersSheetRow = readRows(getSheet(SHEETS.ORDERS))[0];
check('длинный номер заказа лежит в таблице строкой, без экспоненты',
  typeof ordersSheetRow.order_no === 'string' && ordersSheetRow.order_no === '1525686941',
  ordersSheetRow.order_no);

console.log('\n== заказы: выдача в счёт заказа ==');
r = call('/transaction/checkout', { item_id: osterrig1, order_id: orderId }, token);
check('выдача по заказу прошла', r.ok === true, r);
check('выдача списалась с четвёртой строки состава', r.ok && r.data.order_line === '4', r.data);
let card = call('/order/card', { order_id: orderId }, token);
check('в строке состава отмечено «выдано 1 из 4»',
  card.ok && card.data.items[3].issued_qty === 1 && card.data.items[3].qty === 4, card.data && card.data.items[3]);
const openTx = readRows(getSheet(SHEETS.TRANSACTIONS)).filter(t => t.status === 'Open' && String(t.item_id) === String(osterrig1))[0];
check('срок возврата подставлен из заказа',
  openTx && String(openTx.expected_return_at) === '2026-05-03', openTx && openTx.expected_return_at);
r = call('/orders/list', { status: 'all' }, token);
const listed = r.ok ? r.data.filter(o => o.order_id === orderId)[0] : null;
check('статус заказа стал «выдан»', listed && listed.status === 'Issued', listed && listed.status);
check('в списке видно, сколько на руках', listed && listed.issued_open === 1, listed && listed.issued_open);
check('raw_text в список не отдаётся', listed && listed.raw_text === undefined, listed && Object.keys(listed));

// «+ 4 ковра гойда» в заказе доказывает, что технику дописывают руками:
// выдать не входящее в состав можно, но это должно быть видно.
const offOrderItem = call('/item/create', { name: 'Ковёр гойда', category: 'GRP' }, token).data.item_id;
r = call('/transaction/checkout', { item_id: offOrderItem, order_id: orderId }, token);
check('позицию вне состава выдать можно', r.ok === true, r);
check('но она помечена как выданная вне заказа', r.ok && r.data.order_line === 'off-order', r.data);

r = call('/order/update', { order_id: orderId, status: 'Cancelled' }, token);
check('заказ с техникой на руках отменить нельзя (409)', r.ok === false && r.status === 409, r);

console.log('\n== заказы: приём и закрытие ==');
r = call('/transaction/checkin', { item_id: osterrig1 }, token);
check('приём прошёл', r.ok === true, r);
card = call('/order/card', { order_id: orderId }, token);
check('строка состава снова свободна', card.ok && card.data.items[3].issued_qty === 0, card.data && card.data.items[3]);
check('заказ ещё не закрыт — второй предмет на руках',
  card.ok && card.data.order.status === 'Issued', card.ok && card.data.order.status);
r = call('/transaction/checkin', { item_id: offOrderItem }, token);
check('приём второго предмета прошёл', r.ok === true, r);
card = call('/order/card', { order_id: orderId }, token);
check('заказ закрылся сам, когда вернули всё',
  card.ok && card.data.order.status === 'Returned', card.ok && card.data.order.status);
check('отметка о закрытии поставлена', card.ok && String(card.data.order.closed_at) !== '', card.ok && card.data.order.closed_at);
check('в карточке заказа сохранились все девять строк состава',
  card.ok && card.data.items.length === 9, card.ok && card.data.items.length);
r = call('/order/update', { order_id: orderId, status: 'Cancelled' }, token);
check('после возврата заказ отменяется', r.ok === true, r);

console.log('\n== заказы: количеством, без сканирования ==');
// Сэндбэги и пена поштучно в каталоге не значатся — такие строки закрываются
// количеством вручную.
r = call('/order/line-update', { order_id: orderId, line_no: 6, issued_qty: 20 }, token);
check('строку можно закрыть количеством', r.ok === true, r);
r = call('/order/line-update', { order_id: orderId, line_no: 6, issued_qty: 21 }, token);
check('больше, чем в заказе, выдать нельзя', r.ok === false && r.status === 400, r);
r = call('/order/line-update', { order_id: orderId, line_no: 5, model_code: 1, category: 'LGT' }, token);
check('строку можно сопоставить с моделью руками', r.ok === true, r);

console.log('\n== заказы: история студента и старый журнал ==');
r = call('/student/history', { student_id: 1 }, token);
check('у студента два заказа', r.ok && r.data.orders.length === 2, r.ok && r.data.orders.length);
r = call('/students/list', {}, token);
check('телефон студента отдаётся строкой с плюсом',
  r.ok && r.data[0].phone === '+79257868093', r.ok && r.data[0].phone);
const legacyTx = readRows(getSheet(SHEETS.TRANSACTIONS)).filter(t => t.client_id && !t.order_id)[0];
check('старые строки журнала с client_id читаются после добавления колонок',
  !!legacyTx && String(legacyTx.item_id) !== '', legacyTx && legacyTx.transaction_id);

console.log('\n== заказы: перезалив каталога их не трогает ==');
const ordersBefore = readRows(getSheet(SHEETS.ORDERS)).length;
const studentsBefore = readRows(getSheet(SHEETS.STUDENTS)).length;
const linesBefore = readRows(getSheet(SHEETS.ORDER_ITEMS)).length;
metaSet('journal_archived_at', '');
reimportInventory();
check('заказы на месте после перезалива', readRows(getSheet(SHEETS.ORDERS)).length === ordersBefore,
  [ordersBefore, readRows(getSheet(SHEETS.ORDERS)).length]);
check('студенты на месте', readRows(getSheet(SHEETS.STUDENTS)).length === studentsBefore);
check('состав заказов на месте', readRows(getSheet(SHEETS.ORDER_ITEMS)).length === linesBefore);

console.log('\n== главный администратор ==');
// Всё, ради чего он заведён: его нельзя ни удалить, ни отключить, ни понизить,
// а удаление обязано убирать именно того, кого выбрали.
// Повторный вход выдаёт новый токен и гасит прежний, поэтому дальше работаем
// именно им.
const ownerLogin = call('/auth/login', { login: 'matvey', pin: '4321' }).data;
check('вход сообщает, что вы главный', ownerLogin.is_owner === true, ownerLogin);
const ownerToken = ownerLogin.token;
r = call('/staff/list', {}, ownerToken);
check('в списке отмечен главный',
  r.ok && r.data.filter(s2 => s2.is_owner).length === 1 &&
  String(r.data.filter(s2 => s2.is_owner)[0].staff_id) === '1', r.data);

r = call('/staff/delete', { staff_id: 1 }, ownerToken);
check('себя удалить нельзя', r.ok === false && r.status === 409, r);
r = call('/staff/set-active', { staff_id: 1, active: false }, ownerToken);
check('главного нельзя отключить', r.ok === false && r.status === 409, r);
check('в отказе сказано про передачу прав', /передать/.test(String(r.error)), r.error);
r = call('/staff/set-role', { staff_id: 1, role: 'Warehouse Staff' }, ownerToken);
check('главного нельзя понизить', r.ok === false && r.status === 409, r);

// Трое подряд: удаляем среднего и смотрим, что соседи целы. Именно здесь
// вылезал бы сдвиг строк — «удалил другого, а отключился сам».
call('/staff/create', { full_name: 'Первый', login: 'one', pin: '1111' }, ownerToken);
call('/staff/create', { full_name: 'Второй', login: 'two', pin: '2222' }, ownerToken);
call('/staff/create', { full_name: 'Третий', login: 'three', pin: '3333' }, ownerToken);
const two = call('/staff/list', {}, ownerToken).data.filter(s2 => s2.login === 'two')[0];
r = call('/staff/delete', { staff_id: two.staff_id }, ownerToken);
check('удалён именно выбранный', r.ok === true && r.data.full_name === 'Второй', r);
let staffAfter = call('/staff/list', {}, ownerToken).data.map(s2 => s2.login);
check('соседи на месте', staffAfter.indexOf('one') !== -1 && staffAfter.indexOf('three') !== -1, staffAfter);
check('удалённого в списке нет', staffAfter.indexOf('two') === -1, staffAfter);
check('удаляющий на месте и работает', call('/staff/list', {}, ownerToken).ok === true);
check('строка сотрудника удалена из листа, а не помечена',
  readRows(getSheet(SHEETS.STAFF)).filter(s2 => s2.login === 'two').length === 0);
check('журнал выдач не пострадал: имена в нём остались',
  readRows(getSheet(SHEETS.TRANSACTIONS)).every(t => t.staff_out_name !== undefined));

console.log('\n== права обычного администратора ==');
call('/staff/set-role', { staff_id: call('/staff/list', {}, ownerToken).data
  .filter(s2 => s2.login === 'one')[0].staff_id, role: 'Admin' }, ownerToken);
const oneToken = call('/auth/login', { login: 'one', pin: '1111' }).data.token;
check('обычный админ сотрудников не заводит',
  call('/staff/create', { full_name: 'Никто', login: 'nobody', pin: '5555' }, oneToken).status === 403);
check('обычный админ сотрудников не удаляет',
  call('/staff/delete', { staff_id: 3 }, oneToken).status === 403);
check('обычный админ не сбрасывает PIN главному',
  call('/staff/set-pin', { staff_id: 1, pin: '9999' }, oneToken).status === 409);
check('обычный админ настройки менять по-прежнему может',
  call('/settings/set', { settings: { session_ttl_hours: 12 } }, oneToken).ok === true);

console.log('\n== передача главных прав ==');
r = call('/staff/transfer-owner', { staff_id: 1 }, ownerToken);
check('себе передать нельзя', r.ok === false && r.status === 409, r);
const three = call('/staff/list', {}, ownerToken).data.filter(s2 => s2.login === 'three')[0];
call('/staff/set-active', { staff_id: three.staff_id, active: false }, ownerToken);
r = call('/staff/transfer-owner', { staff_id: three.staff_id }, ownerToken);
check('отключённому передать нельзя', r.ok === false && r.status === 409, r);
call('/staff/set-active', { staff_id: three.staff_id, active: true }, ownerToken);

r = call('/staff/transfer-owner', { staff_id: three.staff_id }, ownerToken);
check('права переданы', r.ok === true && r.data.full_name === 'Третий', r);
const owners = call('/staff/list', {}, ownerToken).data;
check('главный теперь другой',
  String(owners.filter(s2 => s2.is_owner)[0].staff_id) === String(three.staff_id), owners);
check('новый главный стал администратором',
  owners.filter(s2 => s2.login === 'three')[0].role === 'Admin', owners);
check('прежний главный остался администратором',
  owners.filter(s2 => String(s2.login).toLowerCase() === 'matvey')[0].role === 'Admin', owners);
check('прежний главный сотрудников больше не заводит',
  call('/staff/create', { full_name: 'Никто', login: 'nobody', pin: '5555' }, ownerToken).status === 403);
const threeToken = call('/auth/login', { login: 'three', pin: '3333' }).data.token;
check('новый главный сотрудников заводит',
  call('/staff/create', { full_name: 'Новичок', login: 'rookie', pin: '6666' }, threeToken).ok === true);
check('теперь нельзя удалить нового главного',
  call('/staff/delete', { staff_id: three.staff_id }, threeToken).status === 409);
// Возвращаем права назад, чтобы дальнейшие проверки шли от прежнего владельца.
call('/staff/transfer-owner', { staff_id: 1 }, threeToken);

console.log('\n== сводка для панели ==');
r = call('/settings/get', {}, ownerToken);
check('сводка отдаётся вместе с настройками', r.ok && !!r.data.summary, r.data && Object.keys(r.data));
check('в сводке есть каталог и заказы',
  r.data.summary.items > 0 && r.data.summary.orders >= 0, r.data.summary);
check('сводка знает, сколько сотрудников',
  r.data.summary.staff === call('/staff/list', {}, ownerToken).data.length, r.data.summary);
check('панель знает, кто главный', r.data.me.is_owner === true && String(r.data.owner.staff_id) === '1', r.data.me);

console.log('\n== занятость по датам: ядро брони ==');
// К этому месту прежний токен уже отозван проверками смены PIN и выхода —
// берём действующий прямо из листа Staff, а не выдумываем новый логин.
const liveToken = readRows(getSheet(SHEETS.STAFF))
  .map(r => String(r.session_token || '')).filter(Boolean)[0];
// Готовим чистую модель: три единицы одной модели и заказы поверх них.
const availCat = 'LGT';
const availIds = [];
for (let i = 0; i < 3; i++) {
  availIds.push(call('/item/create', { name: 'Arri SkyPanel S60', category: availCat }, liveToken).data.item_id);
}
const availModel = availCat + '|' + String(availIds[0]).substring(2, 4);
const freeOn = (from, to) => {
  const a = availabilityFor(from, to)[availModel];
  return a ? a.free : null;
};
check('пока заказов нет — свободны все три', freeOn('2026-03-03', '2026-03-07') === 3,
      availabilityFor('2026-03-03', '2026-03-07')[availModel]);

// Заказ на 3–7 марта, две штуки.
const ordersSheet = getSheet(SHEETS.ORDERS);
const linesSheet = getSheet(SHEETS.ORDER_ITEMS);
const bookId = nextId('order_id', maxIdIn(ordersSheet, 'order_id'));
appendRow(ordersSheet, { order_id: bookId, order_no: 'B-1', status: 'New',
                         issue_date: '2026-03-03', return_date: '2026-03-07',
                         student_name: 'Тест', created_at: new Date().toISOString() });
appendRow(linesSheet, { order_id: bookId, line_no: 1, raw_name: 'Arri SkyPanel S60',
                        model_code: String(availIds[0]).substring(2, 4), category: availCat,
                        qty: 2, issued_qty: 0 });

check('внутри интервала занято две', freeOn('2026-03-04', '2026-03-05') === 1, freeOn('2026-03-04', '2026-03-05'));
check('края интервала тоже заняты', freeOn('2026-03-07', '2026-03-09') === 1, freeOn('2026-03-07', '2026-03-09'));
check('до заказа свободны все', freeOn('2026-03-01', '2026-03-02') === 3, freeOn('2026-03-01', '2026-03-02'));
check('после заказа свободны все', freeOn('2026-03-08', '2026-03-10') === 3, freeOn('2026-03-08', '2026-03-10'));
check('заказ целиком внутри запроса тоже считается', freeOn('2026-02-01', '2026-04-01') === 1,
      freeOn('2026-02-01', '2026-04-01'));

// Возвращённый заказ место отпускает.
updateRow(ordersSheet, findRowByValue(ordersSheet, 'order_id', bookId).__row, { status: 'Returned' });
check('возвращённый заказ не держит место', freeOn('2026-03-04', '2026-03-05') === 3,
      freeOn('2026-03-04', '2026-03-05'));
updateRow(ordersSheet, findRowByValue(ordersSheet, 'order_id', bookId).__row, { status: 'Cancelled' });
check('отменённый тоже', freeOn('2026-03-04', '2026-03-05') === 3, freeOn('2026-03-04', '2026-03-05'));

// Выданный без дат — вещь на руках, считаем занятой всегда.
updateRow(ordersSheet, findRowByValue(ordersSheet, 'order_id', bookId).__row,
          { status: 'Issued', issue_date: '', return_date: '' });
check('выданный без дат занимает любой интервал', freeOn('2027-01-01', '2027-01-02') === 1,
      freeOn('2027-01-01', '2027-01-02'));
// А новый без дат — нет: иначе заявка без сроков заблокирует модель навсегда.
updateRow(ordersSheet, findRowByValue(ordersSheet, 'order_id', bookId).__row, { status: 'New' });
check('новый без дат ничего не держит', freeOn('2027-01-01', '2027-01-02') === 3,
      freeOn('2027-01-01', '2027-01-02'));

// Списанное не предлагаем.
updateRow(ordersSheet, findRowByValue(ordersSheet, 'order_id', bookId).__row, { status: 'Cancelled' });
const eqSheetAvail = getSheet(SHEETS.EQUIPMENT);
updateRow(eqSheetAvail, findRowByValue(eqSheetAvail, 'item_id', availIds[0]).__row, { status: 'Retired' });
check('списанная единица из наличия исчезла', freeOn('2026-03-04', '2026-03-05') === 2,
      freeOn('2026-03-04', '2026-03-05'));

console.log('\n== публичный срез каталога ==');
// Главное здесь — не «список отдаётся», а что наружу не уходит ничего, по чему
// опознают конкретную единицу: по инвентарному номеру технику ищут, когда она
// пропала, и публиковать его нельзя.
const pub = call('/public/catalog', { from: '2026-03-04', to: '2026-03-05' });
check('публичный маршрут работает без токена', pub.ok, pub);
check('модели отданы', pub.ok && pub.data.models.length > 0, pub.ok && pub.data.models.length);
const pubJson = JSON.stringify(pub.data);
check('в ответе нет инвентарных и заводских номеров',
      !/serial_number|inventory_number|item_id/.test(pubJson), pubJson.substring(0, 200));
const pubSky = pub.ok && pub.data.models.filter(m => m.model_name === 'Arri SkyPanel S60')[0];
check('у модели видно всего и свободно',
      !!pubSky && pubSky.total === 2 && pubSky.free === 2, pubSky);
check('категория пришла с человеческой подписью',
      !!pubSky && pubSky.category === 'LGT' && !!pubSky.category_label, pubSky);

// Заказ на эти даты должен уменьшить свободное — это то, ради чего всё.
const pubOrderId = nextId('order_id', maxIdIn(getSheet(SHEETS.ORDERS), 'order_id'));
appendRow(getSheet(SHEETS.ORDERS), { order_id: pubOrderId, order_no: 'B-2', status: 'New',
  issue_date: '2026-03-04', return_date: '2026-03-06', student_name: 'Тест',
  created_at: new Date().toISOString() });
appendRow(getSheet(SHEETS.ORDER_ITEMS), { order_id: pubOrderId, line_no: 1,
  raw_name: 'Arri SkyPanel S60', model_code: String(availIds[0]).substring(2, 4),
  category: 'LGT', qty: 1, issued_qty: 0 });
const pub2 = call('/public/catalog', { from: '2026-03-05', to: '2026-03-05' });
const pubSky2 = pub2.data.models.filter(m => m.model_name === 'Arri SkyPanel S60')[0];
check('заказ на эти даты уменьшил свободное', pubSky2.free === 1 && pubSky2.total === 2, pubSky2);
const pub3 = call('/public/catalog', { from: '2026-05-01', to: '2026-05-02' });
const pubSky3 = pub3.data.models.filter(m => m.model_name === 'Arri SkyPanel S60')[0];
check('на другие даты всё свободно', pubSky3.free === 2, pubSky3);

// Мелочи, на которых обычно и спотыкается публичная форма.
check('без дат считается на сегодня',
      call('/public/catalog', {}).data.from === new Date().toISOString().substring(0, 10),
      call('/public/catalog', {}).data.from);
check('русские даты понимаются',
      call('/public/catalog', { from: '05.03.2026', to: '05.03.2026' }).data.from === '2026-03-05');
check('перепутанные местами даты не ломают ответ',
      call('/public/catalog', { from: '2026-03-09', to: '2026-03-04' }).data.from === '2026-03-04');

console.log('\n== журнал сверки не теряет ведущий ноль ==');
// Номер 010101 таблица охотно записывает числом 10101, и тогда поиск по номеру
// в журнале не находит ничего. Лечится форматом «@» через TEXT_COLUMNS.
const invItems = readRows(getSheet(SHEETS.EQUIPMENT));
const zeroItem = invItems.filter(r => String(r.item_id).charAt(0) === '0')[0];
check('в каталоге есть номер с ведущим нулём', !!zeroItem, invItems.slice(0, 3).map(r => r.item_id));
const invRes = call('/inventory/save', {
  scope: 'all',
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  found: {},
  missing: [String(zeroItem.item_id)],
  unknown: [],
}, liveToken);
check('сверка записалась', invRes.ok, invRes);
const invRows = readRows(getSheet(SHEETS.INVENTORY));
const missRow = invRows.filter(r => r.kind === 'missing')[0];
check('номер в журнале остался строкой с нулём',
      String(missRow.item_id) === String(zeroItem.item_id), {
        want: String(zeroItem.item_id), got: String(missRow.item_id) });
check('в журнале есть итоговая строка', invRows.some(r => r.kind === 'summary'), invRows.map(r => r.kind));

console.log('\n== схема импорта живёт в таблице, а не в коде ==');
check('лист ImportMap засеян умолчаниями',
      readRows(getSheet(SHEETS.IMPORT_MAP)).length === IMPORT_MAP_DEFAULTS.length,
      readRows(getSheet(SHEETS.IMPORT_MAP)).length);
check('лист ImportRules засеян умолчаниями',
      readRows(getSheet(SHEETS.IMPORT_RULES)).length === IMPORT_RULES_DEFAULTS.length,
      readRows(getSheet(SHEETS.IMPORT_RULES)).length);
// Засев только пустого листа: правку руками setupSheets затирать не имеет права.
getSheet(SHEETS.IMPORT_MAP).getRange(2, 2, 1, 1).setValues([['Название товара']]);
setupSheets();
check('повторный setupSheets не затирает правку в ImportMap',
      readRows(getSheet(SHEETS.IMPORT_MAP))[0].aliases === 'Название товара',
      readRows(getSheet(SHEETS.IMPORT_MAP))[0].aliases);
getSheet(SHEETS.IMPORT_MAP).getRange(2, 2, 1, 1).setValues([[IMPORT_MAP_DEFAULTS[0].aliases]]);
IMPORT_CONFIG = null;

// Раскладка по категориям вычитана на 628 реальных строках (CATEGORIES.md).
// Переезд правил из кода в лист ImportRules не должен был её изменить —
// проверяем на именах, каждое из которых закрывает своё правило.
const catCases = [
  ['B+W поляризационный', '', '', 'FLT'],
  ['Нечто', 'светофильтр', '', 'FLT'],
  ['TVLogic 058W', '', '', 'MON'],
  ['Tilta Nucleus-M', '', '', 'RIG'],
  ['Чайнабол 65см', '', '', 'MOD'],
  ['Штатив GreenBean', '', '', 'SUP'],
  ['Аккумулятор V-mount', '', '', 'PWR'],
  ['CFexpress 128', '', '', 'MED'],
  ['SANDBAG BIG', '', '', 'GRP'],
  ['Безымянная железка', '', 'ЗВУК', 'AUD'],
  ['Tascam DR-60', '', '', 'AUD'],
  ['Sony BURANO 8K', '', '', 'CAM'],
  ['Нечто', 'фотоаппарат', '', 'CAM'],
  ['Sigma 24-70mm', '', '', 'LEN'],
  ['Нечто', 'объектив', '', 'LEN'],
  ['Безымянная железка', '', 'СВЕТ', 'LGT'],
  ['Godox VL150', '', '', 'LGT'],
  ['Ковёр гойда', '', '', 'OTH'],
];
const catWrong = catCases.filter(([name, type, tab, want]) => importCategory(type, tab, name) !== want)
  .map(([name, type, tab, want]) => `${name}|${type}|${tab}: ждали ${want}, вышло ${importCategory(type, tab, name)}`);
check('правила из листа дают ту же раскладку, что прибитый код', catWrong.length === 0, catWrong);

// Приоритет задаётся порядком строк: «стойка» в GRP стоит выше правил света,
// поэтому «Стойка Godox» — грип, а не осветитель. Если кто-то переставит
// строки в таблице, это изменится — и это ровно то, ради чего лист заведён.
check('первое совпавшее правило выигрывает', importCategory('', '', 'Стойка Godox') === 'GRP',
      importCategory('', '', 'Стойка Godox'));

// Синонимы колонок. col0 — колонка по счёту, «ВКЛАДКА:colN» — только на своей
// вкладке: в нашей выгрузке у «ЗВУК» заголовков нет вовсе, а на других
// вкладках третья колонка означает совсем другое.
const keysNamed = ['Наименование', 'Заводской номер', 'Состояние'];
const rowNamed = { 'Наименование': 'Sony FX6', 'Заводской номер': 'SN-1', 'Состояние': 'не работает' };
check('колонка находится по основному имени',
      importField(rowNamed, keysNamed, 'КИНО', 'name') === 'Sony FX6');
const keysAlias = ['Название', 'Serial'];
const rowAlias = { 'Название': 'Canon C70', 'Serial': 'SN-2' };
check('и по синониму тоже', importField(rowAlias, keysAlias, 'КИНО', 'name') === 'Canon C70' &&
      importField(rowAlias, keysAlias, 'КИНО', 'serial_number') === 'SN-2');
const keysBlank = ['col0', 'col1', 'col2'];
const rowBlank = { col0: 'Петличка', col1: '', col2: 'сломан' };
check('без заголовков берётся колонка по счёту',
      importField(rowBlank, keysBlank, 'ЗВУК', 'name') === 'Петличка');
check('привязанный к вкладке синоним работает на своей вкладке',
      importField(rowBlank, keysBlank, 'ЗВУК', 'status') === 'сломан');
check('и молчит на чужой',
      importField(rowBlank, keysBlank, 'КИНО', 'status') === '',
      importField(rowBlank, keysBlank, 'КИНО', 'status'));

// Правка листа подхватывается без правки кода — ради этого всё и делалось.
spreadsheet.getSheetByName('ImportRules').appendRow(['CNS', 'name', 'гойда', 'тест']);
IMPORT_CONFIG = null;
check('добавленное в таблицу правило работает сразу',
      importCategory('', '', 'Ковёр гойда') === 'CNS', importCategory('', '', 'Ковёр гойда'));
spreadsheet.getSheetByName('ImportRules').deleteRow(spreadsheet.getSheetByName('ImportRules').getLastRow());
IMPORT_CONFIG = null;

console.log('\n== самозагрузка первого администратора закрыта навсегда ==');
// Раньше защита держалась на «в Staff есть строки»: почистив лист, кто угодно
// снова стал бы администратором без пароля.
const staffSheet = getSheet(SHEETS.STAFF);
staffSheet.getRange(2, 1, staffSheet.getLastRow() - 1, staffSheet.getLastColumn()).clearContent();
check('лист Staff пуст', readRows(staffSheet).length === 0, readRows(staffSheet).length);
r = call('/staff/create', { full_name: 'Чужой', login: 'intruder', pin: '0000' });
check('на пустом Staff администратора без токена не создать', r.ok === false && r.status === 403, r);
check('в отказе сказано, как владелец таблицы вернёт доступ',
  /bootstrap_done/.test(String(r.error)), r.error);

const flagRow = readRows(getSheet(SHEETS.META)).filter(m => m.key === 'bootstrap_done')[0];
check('отметка bootstrap_done стоит в Meta', !!flagRow, flagRow);
updateRow(getSheet(SHEETS.META), flagRow.__row, { key: '', value: '' });
r = call('/staff/create', { full_name: 'Матвей', login: 'matvey', pin: '4321' });
check('после удаления отметки вручную самозагрузка снова доступна', r.ok === true, r);

console.log('\n== перенос модели в другую категорию ==');
// Номер вещи начинается с номера категории, поэтому переносим с перенумерацией.
// Главное, что здесь проверяется: у вещи не отвязывается история — на номер
// ссылаются журнал выдач, дефекты и сверки.
const mvLogin = call('/auth/login', { login: 'matvey', pin: '4321' });
const mvToken = mvLogin.ok ? mvLogin.data.token : null;
check('вход перед переносом', mvLogin.ok === true, mvLogin);

// Заводим модель в «Камерах» и две её единицы.
let mv = call('/item/create', { category: 'CAM', model_name: 'Гоупро Тест', serial_number: 'S1' }, mvToken);
check('первая единица заведена', mv.ok === true, mv);
const mvId1 = mv.ok ? mv.data.item_id : null;
mv = call('/item/create', { category: 'CAM', model_name: 'Гоупро Тест', serial_number: 'S2' }, mvToken);
const mvId2 = mv.ok ? mv.data.item_id : null;
check('вторая единица заведена и номера соседние',
  mvId1 && mvId2 && mvId1.slice(0, 4) === mvId2.slice(0, 4) && mvId1 !== mvId2, [mvId1, mvId2]);
const mvCode = mvId1.slice(2, 4);

// Выдаём первую и заводим ей дефект — чтобы было что отвязываться.
const mvOrder = call('/order/create', {
  order_no: '900900', student_name: 'Тестов Тест', student_phone: '+70000000000',
  issue_date: '2026-09-01', return_date: '2026-09-10',
}, mvToken);
check('заказ для переноса создан', mvOrder.ok === true, mvOrder);
mv = call('/transaction/checkout', {
  item_id: mvId1, order_id: mvOrder.data.order_id, expected_return_at: '2026-09-10',
}, mvToken);
check('единица выдана', mv.ok === true, mv);
mv = call('/defect/report', { item_id: mvId1, description: 'Тестовая царапина', severity: 'Minor' }, mvToken);
check('дефект заведён', mv.ok === true, mv);

const mvTxBefore = readRows(getSheet(SHEETS.TRANSACTIONS)).filter(r => String(r.item_id) === mvId1).length;
const mvDfBefore = readRows(getSheet(SHEETS.DEFECTS)).filter(r => String(r.item_id) === mvId1).length;
check('в журналах есть строки на эту вещь', mvTxBefore > 0 && mvDfBefore > 0, [mvTxBefore, mvDfBefore]);

// Переносим в «Объективы».
mv = call('/model/move', { category: 'CAM', model_code: mvCode, to_category: 'LEN' }, mvToken);
check('перенос прошёл', mv.ok === true, mv);
check('перенесены обе единицы', mv.ok && mv.data.moved === 2, mv.data);
const mvLenNum = categories().filter(c => c.code === 'LEN')[0].num;
const mvFresh = mv.data.renames.map(r => r.fresh);
check('новые номера начинаются с номера новой категории',
  mvFresh.every(id => id.slice(0, 2) === mvLenNum), [mvFresh, mvLenNum]);
check('старых номеров в каталоге не осталось',
  readRows(getSheet(SHEETS.EQUIPMENT)).every(r => String(r.item_id) !== mvId1 && String(r.item_id) !== mvId2),
  [mvId1, mvId2]);
check('категория у вещей сменилась',
  readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => mvFresh.indexOf(String(r.item_id)) !== -1)
    .every(r => r.category === 'LEN'));
check('строки модели в прежней категории больше нет',
  readRows(getSheet(SHEETS.MODELS)).every(r => !(r.category === 'CAM' && pad2(Number(r.model_code)) === mvCode)));

// Самое важное: история не отвязалась.
const mvNewId1 = mv.data.renames.filter(r => r.old === mvId1)[0].fresh;
check('журнал выдач переписан на новый номер',
  readRows(getSheet(SHEETS.TRANSACTIONS)).filter(r => String(r.item_id) === mvNewId1).length === mvTxBefore,
  readRows(getSheet(SHEETS.TRANSACTIONS)).filter(r => String(r.item_id) === mvNewId1).length);
check('дефекты переписаны на новый номер',
  readRows(getSheet(SHEETS.DEFECTS)).filter(r => String(r.item_id) === mvNewId1).length === mvDfBefore);
check('на старый номер в журналах ссылок не осталось',
  readRows(getSheet(SHEETS.TRANSACTIONS)).every(r => String(r.item_id) !== mvId1) &&
  readRows(getSheet(SHEETS.DEFECTS)).every(r => String(r.item_id) !== mvId1));
check('сколько строк журналов тронуто — сказано', mv.data.journal_rows >= mvTxBefore + mvDfBefore, mv.data.journal_rows);
r = call('/item/lookup', { item_id: mvNewId1 }, mvToken);
check('карточка по новому номеру открывается с историей',
  r.ok === true && r.data.open_defects.length === mvDfBefore, r.ok && r.data.open_defects.length);

// Новая единица после переноса получает номер, который ещё не занят.
mv = call('/item/create', { category: 'LEN', model_name: 'Гоупро Тест', serial_number: 'S3' }, mvToken);
check('следующая единица не столкнулась с перенесёнными',
  mv.ok === true && mvFresh.indexOf(mv.data.item_id) === -1, [mv.ok && mv.data.item_id, mvFresh]);

console.log('-- отказы --');
r = call('/model/move', { category: 'LEN', model_code: '01', to_category: 'LEN' }, mvToken);
check('в ту же категорию не переносим', r.ok === false && r.status === 400, r);
r = call('/model/move', { category: 'LEN', model_code: '99', to_category: 'CAM' }, mvToken);
check('несуществующая модель — 404', r.ok === false && r.status === 404, r);
r = call('/model/move', { category: 'LEN', model_code: '01', to_category: 'ZZZ' }, mvToken);
check('несуществующая категория — 404', r.ok === false && r.status === 404, r);
// GRP считается количеством, CAM — поштучно.
r = call('/model/move', { category: 'CAM', model_code: '01', to_category: 'GRP' }, mvToken);
check('в категорию с другим способом учёта — отказ',
  r.ok === false && r.status === 409 && /количеством/.test(String(r.error)), r);
// Своего сотрудника, а не «ивана» из проверок выше: его токен к этому месту
// уже отозван, и проверка в if молча не выполнялась — то есть её не было.
const mvStaffNew = call('/staff/create', {
  full_name: 'Складмен Переноса', login: 'movecheck', pin: '5555', role: 'Warehouse Staff',
}, mvToken);
check('сотрудник склада для проверки прав заведён', mvStaffNew.ok === true, mvStaffNew);
const mvStaffLogin = call('/auth/login', { login: 'movecheck', pin: '5555' });
check('он вошёл', mvStaffLogin.ok === true, mvStaffLogin);
r = call('/model/move', { category: 'LEN', model_code: '01', to_category: 'CAM' },
         mvStaffLogin.ok ? mvStaffLogin.data.token : 'нет-токена');
check('сотруднику склада перенос запрещён', r.ok === false && r.status === 403, r);

console.log('-- слияние дублей --');
// Та же модель уже есть в целевой категории: должна слиться, а не задвоиться.
mv = call('/item/create', { category: 'CAM', model_name: 'Двойник Тест', serial_number: 'D1' }, mvToken);
const mvDupCam = mv.ok ? mv.data.item_id.slice(2, 4) : null;
mv = call('/item/create', { category: 'LEN', model_name: 'Двойник Тест', serial_number: 'D2' }, mvToken);
check('одноимённые модели заведены в двух категориях', mv.ok === true, mv);
const mvLenBefore = readRows(getSheet(SHEETS.MODELS)).filter(r => r.category === 'LEN').length;
mv = call('/model/move', { category: 'CAM', model_code: mvDupCam, to_category: 'LEN' }, mvToken);
check('перенос-слияние прошёл', mv.ok === true, mv);
check('система сказала, что это слияние', mv.ok && mv.data.merged === true, mv.data);
check('в целевой категории моделей не прибавилось',
  readRows(getSheet(SHEETS.MODELS)).filter(r => r.category === 'LEN').length === mvLenBefore,
  readRows(getSheet(SHEETS.MODELS)).filter(r => r.category === 'LEN').length);

console.log('\n== карточку предмета без входа не прочитать ==');
// Адрес веб-приложения не секрет, а номера напечатаны на этикетках: без
// проверки токена кто угодно перебрал бы 010101, 010102… и вычитал склад.
r = call('/item/lookup', { item_id: '010101' });
check('без токена карточка не отдаётся', r.ok === false && r.status === 401, r);

console.log('\n== этикетки уходят ботом ==');
// Сохранить файл прямо на устройство из вебвью Telegram нельзя, поэтому пачку
// забирает бот. Проверяем разбор входа и то, что уходит в Telegram.
// Входим заново: к этому месту прежние токены уже отозваны сменой PIN, выходом
// и чисткой листа Staff в проверках выше.
const labelLogin = call('/auth/login', { login: 'matvey', pin: '4321' });
check('вход перед отправкой этикеток', labelLogin.ok === true, labelLogin);
const labelToken = labelLogin.ok ? labelLogin.data.token : null;
const png = Buffer.from('PNG-заглушка').toString('base64');

scriptProps = {};
r = call('/labels/send', { files: [{ name: 'a.png', png_base64: png }] }, labelToken);
check('без токена бота — понятный отказ, а не молчание',
  r.ok === false && /TELEGRAM_BOT_TOKEN/.test(String(r.error)), r);

scriptProps.TELEGRAM_BOT_TOKEN = '123:ABC';
metaSet('setting_notify_chat_id', '');
r = call('/labels/send', { files: [{ name: 'a.png', png_base64: png }] }, labelToken);
check('без чата — тоже понятный отказ', r.ok === false && /id чата/.test(String(r.error)), r);

metaSet('setting_notify_chat_id', '-1001234567890');
sent.length = 0;
r = call('/labels/send', { files: [{ name: 'a.png', png_base64: png }] }, labelToken);
check('одна этикетка уходит', r.ok === true && r.data.count === 1, r);
check('ушла именно в sendDocument', /\/sendDocument$/.test(sent[0].url), sent[0] && sent[0].url);
check('чат взят из настроек', sent[0].opts.payload.chat_id === '-1001234567890', sent[0].opts.payload.chat_id);
check('картинка дошла целой',
  Buffer.from(sent[0].opts.payload.document.getBytes().map(b => (b < 0 ? b + 256 : b)))
    .toString() === 'PNG-заглушка',
  sent[0].opts.payload.document.getName());

sent.length = 0;
r = call('/labels/send', { files: [
  { name: 'a.png', png_base64: png }, { name: 'b.png', png_base64: png },
] }, labelToken);
check('несколько этикеток уходят одним архивом',
  r.ok === true && r.data.count === 2 && /\.zip$/.test(sent[0].opts.payload.document.getName()),
  sent[0] && sent[0].opts.payload.document.getName());

r = call('/labels/send', { files: [] }, labelToken);
check('пустой список отклонён', r.ok === false && r.status === 400, r);
r = call('/labels/send', { files: [{ name: 'a.png', png_base64: '' }] }, labelToken);
check('пустой файл отклонён', r.ok === false && /пустым/.test(String(r.error)), r);
r = call('/labels/send', {
  files: Array.from({ length: 31 }, (_, i) => ({ name: i + '.png', png_base64: png })),
}, labelToken);
check('больше тридцати за раз не берём', r.ok === false && /30/.test(String(r.error)), r);
r = call('/labels/send', { files: [{ name: 'a.png', png_base64: png }] }, 'чужой-токен');
check('без входа этикетки не отправить', r.ok === false && r.status === 401, r);  // недействительная сессия — 401, не 403

console.log('\n' + (failures ? '❌ ПРОВАЛОВ: ' + failures : '✅ Все проверки пройдены'));
process.exit(failures ? 1 : 0);
