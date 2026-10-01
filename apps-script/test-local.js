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
const path = require('path');
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
  getId() { return 'ss-main'; }
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
// Кэш скрипта. Время жизни не изображаем: в проверках важно, что счётчик
// растёт и что предел срабатывает, а не что запись истекает через час.
const cacheStore = new Map();
global.CacheService = {
  getScriptCache: () => ({
    get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
    put: (k, v) => { cacheStore.set(k, String(v)); },
    remove: (k) => { cacheStore.delete(k); },
  }),
};
global.__cacheStore = cacheStore;

// Google Docs и Диск. Заглушки простые, но не пустые: они хранят строки и
// таблицы, потому что проверять надо именно раскладку позиций по ячейкам —
// ровно то, что в старом акте не было сделано.
function makeDocBody() {
  const body = {
    items: [],           // абзацы и таблицы по порядку
    clear() { body.items.length = 0; return body; },
    appendParagraph(text) {
      if (text && text.kind === 'p') text = text.text;
      const p = { kind: 'p', text: String(text),
        setHeading() { return p; }, setAlignment() { return p; },
        setItalic() { return p; }, setBold() { return p; },
        setGlyphType() { return p; },
        setText(v) { p.text = String(v); return p; },
        asParagraph() { return p; }, getChild() { return p; },
        editAsText() { return p; } };
      body.items.push(p);
      return p;
    },
    appendListItem(text) { return body.appendParagraph(text); },
    appendPageBreak() { return body.appendParagraph('\f'); },
    appendTable(rows) {
      if (rows && rows.kind === 't') rows = rows.grid;
      const grid = (rows || []).map((r) => r.slice());
      const table = {
        kind: 't', grid,
        getText: () => grid.map((r) => r.join(' ')).join('\n'),
        getNumRows: () => grid.length,
        getRow: (i) => ({
          getText: () => grid[i].join(' '),
          getCell: (j) => ({
            setText: (v) => { grid[i][j] = String(v); },
            getChild: () => ({ asParagraph: () => ({ setAlignment() {} }) }),
          }),
          editAsText: () => ({ setBold() {} }),
          appendTableCell: (v) => { grid[i].push(String(v)); return table.getRow(i); },
          getParentRow: () => table.getRow(i),
        }),
        appendTableRow() {
          grid.push([]);
          const idx = grid.length - 1;
          const row = {
            appendTableCell: (v) => { grid[idx].push(String(v)); return row; },
            getParentRow: () => row,
            editAsText: () => ({ setBold() {} }),
          };
          return row;
        },
        removeRow(i) { grid.splice(i, 1); },
      };
      body.items.push(table);
      return table;
    },
    getTables: () => body.items.filter((i) => i.kind === 't'),
    // Обход детей — для пересборки акта в том же документе (resetActBody):
    // тело шаблона перекладывается поэлементно, копиями.
    getNumChildren: () => body.items.length,
    getChild: (i) => {
      const el = body.items[i];
      return {
        getType: () => (el.kind === 't' ? 'TABLE' : 'PARAGRAPH'),
        copy: () => (el.kind === 't' ? { kind: 't', grid: el.grid.map((r) => r.slice()) }
          : { kind: 'p', text: el.text }),
        removeFromParent() { body.items.splice(body.items.indexOf(el), 1); },
      };
    },
    getChildIndex: (el) => body.items.indexOf(el),
    insertParagraph(idx, text) {
      const p = body.appendParagraph(text);
      body.items.pop();
      body.items.splice(idx, 0, p);
      return p;
    },
    replaceText(pattern, value) {
      const re = new RegExp(pattern, 'g');
      body.items.forEach((i) => {
        if (i.kind === 'p') i.text = i.text.replace(re, value);
        else i.grid.forEach((row) => {
          for (let j = 0; j < row.length; j++) row[j] = String(row[j]).replace(re, value);
        });
      });
      return body;
    },
    getText: () => body.items.map((i) => (i.kind === 'p' ? i.text : i.getText())).join('\n'),
  };
  return body;
}

// Шаблон акта читается из репозитория — тот самый файл, который выкладывается
// в проект Apps Script. Значит проверки идут по настоящему документу колледжа,
// а не по выдумке теста.
global.HtmlService = {
  createHtmlOutputFromFile(name) {
    const file = path.join(__dirname, name + '.html');
    const html = fs.readFileSync(file, 'utf8');
    return { getContent: () => html };
  },
};
// Триггеры проекта держим списком — setupTriggers проверяется на повторный запуск.
const triggers = [];
global.ScriptApp = {
  getOAuthToken: () => 'test-token',
  getProjectTriggers: () => triggers.slice(),
  deleteTrigger(t) { triggers.splice(triggers.indexOf(t), 1); },
  newTrigger(handler) {
    const t = { handler, getHandlerFunction: () => handler };
    const chain = {
      timeBased: () => chain,
      everyDays(n) { t.days = n; return chain; },
      atHour(h) { t.hour = h; return chain; },
      create() { triggers.push(t); return t; },
    };
    return chain;
  },
};
global.Session = { getScriptTimeZone: () => 'Europe/Moscow' };

// Преобразование HTML в документ у Google на стороне Диска. Здесь — грубый
// разбор той же разметки: абзацы абзацами, таблицы сетками. Этого хватает,
// чтобы проверить и подстановки, и расстановку позиций по ячейкам.
function docFromHtml(html) {
  const body = makeDocBody();
  const strip = (s) => s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
  const inner = (html.match(/<body[^>]*>([\s\S]*)<\/body>/) || [null, html])[1];
  const blocks = inner.split(/(<table[\s\S]*?<\/table>)/);
  blocks.forEach((block) => {
    if (!block) return;
    if (block.startsWith('<table')) {
      const rows = (block.match(/<tr[\s\S]*?<\/tr>/g) || []).map((tr) =>
        (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(strip));
      if (rows.length) body.appendTable(rows);
      return;
    }
    block.split(/<\/(?:p|li|h1|h2|h3|div)>/).forEach((piece) => {
      const text = strip(piece);
      if (text) body.appendParagraph(text);
    });
  });
  return body;
}

const docs = new Map();
global.DocumentApp = {
  ElementType: { PARAGRAPH: 'PARAGRAPH', TABLE: 'TABLE', LIST_ITEM: 'LIST_ITEM' },
  ParagraphHeading: { HEADING1: 'h1', HEADING2: 'h2' },
  HorizontalAlignment: { CENTER: 'center' },
  GlyphType: { NUMBER: 'number' },
  create(name) {
    const id = 'doc' + (docs.size + 1);
    const doc = { id, name, body: makeDocBody(),
      getBody: () => doc.body, getId: () => id, getName: () => doc.name, saveAndClose() {} };
    docs.set(id, doc);
    return doc;
  },
  openById(id) {
    const doc = docs.get(id);
    if (!doc) throw new Error('нет документа ' + id);
    return doc;
  },
};
global.__docs = docs;
global.Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest(_alg, str) {
    const buf = crypto.createHash('sha256').update(String(str), 'utf8').digest();
    // Apps Script отдаёт знаковые байты (-128..127) — воспроизводим это
    return Array.from(buf).map(b => (b > 127 ? b - 256 : b));
  },
  getUuid: () => crypto.randomUUID(),
  // Часовой пояс здесь не учитываем: проверяется только вид имени копии.
  formatDate: (d, _tz, _fmt) => d.toISOString().slice(0, 10),
  base64Decode(str) {
    return Array.from(Buffer.from(String(str), 'base64')).map(b => (b > 127 ? b - 256 : b));
  },
  // Настоящий newBlob принимает и строку, и массив байтов. Строку берёт
  // шаблон акта: из неё собирается тело multipart-запроса к Диску.
  newBlob(bytes, type, name) {
    const buf = typeof bytes === 'string'
      ? Buffer.from(bytes, 'utf8')
      : Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b)));
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
// Что Telegram «ответит» на getUpdates. Тест подставляет свои сообщения.
let __telegramUpdates = [];
// И на getMe: имя бота, которое приложение показывает вместе с командой.
// Тест подменяет его, чтобы проверить и отказ по неверному токену.
let __telegramMe = { ok: true, result: { username: 'mifs_rent_bot', first_name: 'Mifs Rent' } };
// Состояние вебхука на стороне Telegram: setWebhook его ставит, deleteWebhook
// снимает, getWebhookInfo рассказывает. Пока он стоит, настоящий Telegram
// отвечает на getUpdates отказом 409 — это и воспроизводим, иначе проверка
// «опрос больше не нужен» ничего не проверяла бы.
let __telegramWebhook = { url: '', pending_update_count: 0, last_error_message: '' };
let __telegramSetReply = { ok: true, result: true };
// Ответ на sendMessage: тест подставляет функцию от тела запроса, чтобы
// Telegram «отказал» — например, в удалённую тему форума. null — обычный ответ.
let __telegramSendReply = null;
global.UrlFetchApp = {
  fetch(url, opts) {
    sent.push({ url, opts });
    if (__telegramSendReply && /\/sendMessage$/.test(url)) {
      const reply = __telegramSendReply(JSON.parse(opts.payload));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(reply) };
    }
    // Загрузка документа в Диск: разбираем multipart так же, как это сделал бы
    // Google, и складываем получившийся документ в набор — дальше по нему
    // собирается акт.
    if (/\/getMe$/.test(url)) {
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(__telegramMe),
      };
    }
    if (/\/setWebhook$/.test(url)) {
      if (__telegramSetReply.ok) {
        const asked = JSON.parse(opts.payload);
        __telegramWebhook = { url: String(asked.url || ''), pending_update_count: 0,
          last_error_message: '', secret_token: String(asked.secret_token || '') };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(__telegramSetReply),
      };
    }
    if (/\/deleteWebhook$/.test(url)) {
      __telegramWebhook = { url: '', pending_update_count: 0, last_error_message: '' };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: true }) };
    }
    if (/\/getWebhookInfo$/.test(url)) {
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, result: __telegramWebhook }),
      };
    }
    if (/getUpdates/.test(url)) {
      // При установленном вебхуке опрос запрещён — ровно так это и выглядит.
      const reply = __telegramWebhook.url
        ? { ok: false, error_code: 409,
            description: "Conflict: can't use getUpdates method while webhook is active" }
        : { ok: true, result: __telegramUpdates };
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(reply),
      };
    }
    if (/upload\/drive\/v3\/files/.test(url)) {
      const raw = Buffer.from(opts.payload).toString('utf8');
      const meta = JSON.parse(raw.match(/\{[\s\S]*?\}/)[0]);
      const html = raw.split(/Content-Type: text\/html; charset=UTF-8\r\n\r\n/)[1]
        .replace(/\r\n--mifs\d+--\s*$/, '');
      const id = 'doc' + (__docs.size + 1);
      const body = docFromHtml(html);
      __docs.set(id, { id, name: meta.name, body,
        getBody: () => body, getId: () => id, saveAndClose() {} });
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ id }),
      };
    }
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: {} }),
    };
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
    // Копия таблицы (dailyBackup): дата создания задаётся тестом через __driveNow.
    _addCopy(fileName) {
      const file = { name: fileName, id: 'file-' + (folder.files.length + 1),
                     created: global.__driveNow || new Date(), trashed: false };
      folder.files.push(file);
      return { getId: () => file.id, getName: () => file.name };
    },
    getFiles() {
      let i = 0;
      const list = folder.files.slice();
      return {
        hasNext: () => i < list.length,
        next: () => {
          const f = list[i++];
          return { getName: () => f.name, isTrashed: () => !!f.trashed,
                   getDateCreated: () => f.created || new Date(0),
                   setTrashed(v) { f.trashed = v; } };
        },
      };
    },
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
  // Документы акта: копия шаблона живёт в том же наборе, что и сам шаблон.
  getFileById(id) {
    if (id === 'ss-main') {
      if (global.__driveFail) throw new Error(global.__driveFail);
      return { makeCopy: (name, folder) => folder._addCopy(name) };
    }
    const doc = docs.get(id);
    if (!doc) throw new Error('нет файла ' + id);
    return {
      makeCopy(name) {
        const copyId = 'doc' + (docs.size + 1);
        const body = makeDocBody();
        doc.body.items.forEach((i) => {
          if (i.kind === 'p') body.appendParagraph(i.text);
          else body.appendTable(i.grid.map((r) => r.slice()));
        });
        const copy = { id: copyId, name, body,
          getBody: () => body, getId: () => copyId, getName: () => name, saveAndClose() {} };
        docs.set(copyId, copy);
        return copy;
      },
    };
  },
  getFolderById(id) { return { id }; },
};
global.MimeType = { CSV: 'text/csv' };

// Загружаем настоящий Code.gs в глобальную область
const code = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
(0, eval)(code);

// ---- Хелперы теста ----
let failures = 0;
function check(label, cond, extra) {
  if (cond) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
// Строки журнала Logs (служебные события, которые в чат не идут).
const logRows = () => readRows(getSheet(SHEETS.LOGS));
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
check('создано 16 вкладок (с журналом Logs и объявлениями)', spreadsheet.getSheets().length === 16 && !!spreadsheet.getSheetByName('Logs'), spreadsheet.getSheets().map(s => s.name));
check('Sheet1 удалён', !spreadsheet.getSheetByName('Sheet1'));
check('заголовки Equipment верны',
  JSON.stringify(dumpSheet('Equipment')[0]) === JSON.stringify(SCHEMA.Equipment), dumpSheet('Equipment')[0]);
check('заголовки Meta верны',
  JSON.stringify(dumpSheet('Meta')[0]) === JSON.stringify(SCHEMA.Meta));

console.log('\n== setupSheets повторно (идемпотентность) ==');
spreadsheet.getSheetByName('Clients').appendRow([1, 'Тест Клиент', 'Проект', '', '', '']);
setupSheets();
check('вкладок по-прежнему 16', spreadsheet.getSheets().length === 16);
check('данные Clients не затёрты', dumpSheet('Clients').length === 2, dumpSheet('Clients'));
check('заголовки Clients на месте', dumpSheet('Clients')[0][0] === 'client_id');

console.log('\n== bootstrap первого администратора ==');
let r = call('/staff/create', { full_name: 'Матвей', login: 'Matvey', pin: '4321' });
check('создан без токена', r.ok === true, r);
check('staff_id = 1', r.data && r.data.staff_id === 1, r.data);
const staffRow = dumpSheet('Staff')[1];
check('роль принудительно Admin', staffRow[SCHEMA.Staff.indexOf('role')] === 'Admin', staffRow);
const storedPin = staffRow[SCHEMA.Staff.indexOf('pin_hash')];
check('PIN сохранён не в открытом виде', storedPin !== '4321' && !/4321/.test(storedPin), storedPin);
// Голый SHA-256 от четырёх цифр подбирается перебором десяти тысяч вариантов
// за секунды, поэтому в таблице его быть не должно.
check('PIN не голый SHA-256',
  storedPin !== crypto.createHash('sha256').update('4321').digest('hex'), storedPin);
check('у PIN есть соль и число повторов',
  /^v2\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(storedPin), storedPin);

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

// Пока единица на руках, модель не переносим: принимать её будут по старой
// наклейке. Отказ — до первой записи: ни номеров, ни строки модели в LEN.
const mvLenModelsBefore = readRows(getSheet(SHEETS.MODELS)).filter(r => r.category === 'LEN').length;
mv = call('/model/move', { category: 'CAM', model_code: mvCode, to_category: 'LEN' }, mvToken);
check('модель с выданной единицей не переносится — 409 с числом на руках',
  mv.ok === false && mv.status === 409 && /На руках 1 вещь/.test(String(mv.error)), mv);
check('после отказа номера и справочник не тронуты',
  readRows(getSheet(SHEETS.EQUIPMENT)).some(r => String(r.item_id) === mvId1) &&
  readRows(getSheet(SHEETS.MODELS)).filter(r => r.category === 'LEN').length === mvLenModelsBefore);
mv = call('/transaction/checkin', { item_id: mvId1 }, mvToken);
check('единица принята', mv.ok === true, mv);

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

console.log('\n== этикетки в чат не уходят ==');
// Владелец решил: картинки этикеток в Telegram не идут ни в каком виде. Ручка
// оставлена ради закэшированных версий приложения — они получают 410 с
// объяснением, куда теперь нажимать, а в Telegram не уходит ничего.
// Входим заново: к этому месту прежние токены уже отозваны сменой PIN, выходом
// и чисткой листа Staff в проверках выше.
const labelLogin = call('/auth/login', { login: 'matvey', pin: '4321' });
check('вход перед отправкой этикеток', labelLogin.ok === true, labelLogin);
const labelToken = labelLogin.ok ? labelLogin.data.token : null;
const png = Buffer.from('PNG-заглушка').toString('base64');

scriptProps.TELEGRAM_BOT_TOKEN = '123:ABC';
metaSet('setting_notify_chat_id', '-1001234567890');
sent.length = 0;
r = call('/labels/send', { files: [{ name: 'a.png', png_base64: png }] }, labelToken);
check('одна этикетка — 410 с объяснением',
  r.ok === false && r.status === 410 && /Отправка этикеток в чат отключена/.test(String(r.error)) &&
  /«Печать»/.test(String(r.error)), r);
r = call('/labels/send', { files: [
  { name: 'a.png', png_base64: png }, { name: 'b.png', png_base64: png },
] }, labelToken);
check('пачка — тоже 410', r.ok === false && r.status === 410, r);
check('в Telegram не ушло ни одного запроса', sent.length === 0, sent.map((x) => x.url));
check('sendDocument не звали', !sent.some((x) => /sendDocument/.test(x.url)));
r = call('/labels/send', { files: [{ name: 'a.png', png_base64: png }] }, 'чужой-токен');
check('без входа — 401, а не 410', r.ok === false && r.status === 401, r);

console.log('\n== исправление номеров у вещи ==');
// Опечатку в заводском номере находят, когда вещь уже в таблице. Главное, что
// здесь проверяется: номер вещи не трогается, а дубль номера не проходит —
// по этим номерам ищут технику, и повторный импорт считает одинаковые номера
// одной и той же вещью.
const numLogin = call('/auth/login', { login: 'matvey', pin: '4321' });
const numToken = numLogin.ok ? numLogin.data.token : null;
check('вход перед правкой номеров', numLogin.ok === true, numLogin);

let num = call('/item/create', {
  category: 'CAM', model_name: 'Номерная Тест', serial_number: 'SN-ПЕРВЫЙ', inventory_number: 'ИНВ-1',
}, numToken);
check('вещь с номерами заведена', num.ok === true, num);
const numId = num.ok ? num.data.item_id : null;
num = call('/item/create', {
  category: 'CAM', model_name: 'Номерная Тест', serial_number: 'SN-ЗАНЯТ', inventory_number: 'ИНВ-2',
}, numToken);
const numOther = num.ok ? num.data.item_id : null;
check('вторая вещь для проверки дубля заведена', !!numOther, num);

num = call('/item/numbers', { item_id: numId, serial_number: 'SN-ИСПРАВЛЕН' }, numToken);
check('заводской номер исправлен', num.ok === true && num.data.serial_number === 'SN-ИСПРАВЛЕН', num);
check('сказано, что именно изменилось',
  num.ok && num.data.changed.serial_number &&
  num.data.changed.serial_number.was === 'SN-ПЕРВЫЙ' &&
  num.data.changed.serial_number.now === 'SN-ИСПРАВЛЕН', num.data);
check('второй номер не тронут: его не присылали',
  num.ok && num.data.inventory_number === 'ИНВ-1' && !num.data.changed.inventory_number, num.data);
let numRow = readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numId)[0];
check('в таблице лежит исправленный номер', numRow && numRow.serial_number === 'SN-ИСПРАВЛЕН', numRow);
check('номер вещи не изменился', numRow && String(numRow.item_id) === numId, numRow);

num = call('/item/numbers', { item_id: numId, serial_number: '  SN-С-ПРОБЕЛАМИ  ' }, numToken);
check('пробелы по краям срезаны', num.ok === true && num.data.serial_number === 'SN-С-ПРОБЕЛАМИ', num);
// Чистилка импорта выбрасывает всё короче пяти знаков и без цифр. Человек,
// вписывающий номер руками, вписывает его осознанно — здесь она не работает.
num = call('/item/numbers', { item_id: numId, serial_number: 'АБ' }, numToken);
check('короткий номер принят как есть', num.ok === true && num.data.serial_number === 'АБ', num);

num = call('/item/numbers', { item_id: numId, serial_number: 'SN-ЗАНЯТ' }, numToken);
check('занятый заводской номер не принят',
  num.ok === false && num.status === 409 && num.error.indexOf(numOther) !== -1, num);
num = call('/item/numbers', { item_id: numId, serial_number: 'sn-занят' }, numToken);
check('занятость проверяется без учёта регистра', num.ok === false && num.status === 409, num);
num = call('/item/numbers', { item_id: numId, inventory_number: 'ИНВ-2' }, numToken);
check('занятый инвентарный номер не принят', num.ok === false && num.status === 409, num);
numRow = readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numId)[0];
check('после отказа в таблице ничего не поменялось',
  numRow && numRow.serial_number === 'АБ' && numRow.inventory_number === 'ИНВ-1', numRow);

num = call('/item/numbers', { item_id: numId, serial_number: 'АБ' }, numToken);
check('свой же номер занятым не считается', num.ok === true, num);
num = call('/item/numbers', { item_id: numId, inventory_number: '' }, numToken);
check('пустое поле стирает номер',
  num.ok === true && num.data.inventory_number === '' &&
  num.data.changed.inventory_number.was === 'ИНВ-1', num);

num = call('/item/numbers', { item_id: numId }, numToken);
check('без номеров — понятный отказ, а не молчаливая запись',
  num.ok === false && num.status === 400, num);
num = call('/item/numbers', { item_id: '999999', serial_number: 'X' }, numToken);
check('несуществующая вещь — 404', num.ok === false && num.status === 404, num);

// У полки с учётом количеством одна строка на все штуки: личного номера нет.
num = call('/item/create', { category: 'GRP', model_name: 'Мешки Тест', qty: 5 }, numToken);
check('полка с учётом количеством заведена', num.ok === true, num);
const numBulkId = num.ok ? num.data.item_id : null;
num = call('/item/numbers', { item_id: numBulkId, serial_number: 'SN-ПОЛКА' }, numToken);
check('полке номер не вписать',
  num.ok === false && num.status === 409 && /количеством/.test(String(num.error)), num);

const numStaff = call('/staff/create', {
  full_name: 'Складмен Номеров', login: 'numcheck', pin: '7777', role: 'Warehouse Staff',
}, numToken);
check('сотрудник склада для проверки прав заведён', numStaff.ok === true, numStaff);
const numStaffLogin = call('/auth/login', { login: 'numcheck', pin: '7777' });
check('он вошёл', numStaffLogin.ok === true, numStaffLogin);
num = call('/item/numbers', { item_id: numId, serial_number: 'SN-ЧУЖОЙ' },
           numStaffLogin.ok ? numStaffLogin.data.token : 'нет-токена');
check('сотруднику склада правка номеров запрещена', num.ok === false && num.status === 403, num);
num = call('/item/numbers', { item_id: numId, serial_number: 'SN-ЧУЖОЙ' }, 'чужой-токен');
check('без входа номера не исправить', num.ok === false && num.status === 401, num);
numRow = readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numId)[0];
check('после всех отказов номер остался прежним', numRow && numRow.serial_number === 'АБ', numRow);

console.log('\n== правка карточки вещи (/item/update) ==');
// Сделано как блок «исправление номеров» выше и на тех же вещах. Главное:
// поля применяются только присланные, галочка «ко всем вещам модели» правит
// справочник и все вещи модели, а смену категории делает только главный
// администратор — и тогда у вещи новый номер, а журналы переписаны на него.
let upd = call('/item/update', {
  item_id: numId, name: '  Номерная Тест (Б)  ', serial_number: 'SN-UPD',
  inventory_number: 'ИНВ-UPD', condition_notes: 'Царапина на корпусе',
}, numToken);
check('админ правит название, номера и состояние', upd.ok === true &&
  upd.data.item.name === 'Номерная Тест (Б)' && upd.data.item.serial_number === 'SN-UPD' &&
  upd.data.item.inventory_number === 'ИНВ-UPD' &&
  upd.data.item.condition_notes === 'Царапина на корпусе', upd);
check('ответ — строка каталога (с qty_free и model_code)', upd.ok &&
  upd.data.item.qty_free === 1 && upd.data.item.item_id === numId && !!upd.data.item.model_code, upd.data);
check('номер вещи не изменился', upd.ok && upd.data.item_id === numId && upd.data.moved === null, upd.data);
check('без галочки соседняя вещь модели не переименована',
  readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numOther)[0].name === 'Номерная Тест');
check('без галочки справочник моделей не тронут',
  readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'CAM' && r.model_name === 'Номерная Тест'));

upd = call('/item/update', { item_id: numId, serial_number: 'SN-ЗАНЯТ' }, numToken);
check('занятый номер — 409', upd.ok === false && upd.status === 409 && upd.error.indexOf(numOther) !== -1, upd);
upd = call('/item/update', { item_id: numId }, numToken);
check('без полей — 400', upd.ok === false && upd.status === 400, upd);
upd = call('/item/update', { item_id: numId, name: '   ' }, numToken);
check('пустое название — 400', upd.ok === false && upd.status === 400, upd);
upd = call('/item/update', { item_id: '999999', name: 'X' }, numToken);
check('несуществующая вещь — 404', upd.ok === false && upd.status === 404, upd);
upd = call('/item/update', { item_id: numId, qty: 3 }, numToken);
check('поштучной вещи количество не задать', upd.ok === false && upd.status === 400, upd);
upd = call('/item/update', { item_id: numId, name: 'Чужая правка' },
           numStaffLogin.ok ? numStaffLogin.data.token : 'нет-токена');
check('сотруднику склада правка запрещена (403)', upd.ok === false && upd.status === 403, upd);
upd = call('/item/update', { item_id: numId, name: 'Чужая правка' }, 'чужой-токен');
check('без входа — 401', upd.ok === false && upd.status === 401, upd);

// Количество у полки: не меньше одного и не меньше того, что на руках.
const updBulkRow = readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numBulkId)[0];
updateRow(getSheet(SHEETS.EQUIPMENT), updBulkRow.__row, { qty_out: 3 });
upd = call('/item/update', { item_id: numBulkId, qty: 2 }, numToken);
check('количество меньше выданного — 409 с объяснением',
  upd.ok === false && upd.status === 409 && /На руках сейчас 3/.test(upd.error), upd);
upd = call('/item/update', { item_id: numBulkId, qty: 0 }, numToken);
check('ноль — 400', upd.ok === false && upd.status === 400, upd);
upd = call('/item/update', { item_id: numBulkId, qty: '2.5' }, numToken);
check('дробное — 400', upd.ok === false && upd.status === 400, upd);
upd = call('/item/update', { item_id: numBulkId, qty: 8 }, numToken);
check('количество полки поправлено', upd.ok === true && upd.data.item.qty === 8 &&
  upd.data.item.qty_out === 3 && upd.data.item.qty_free === 5, upd);
upd = call('/item/update', { item_id: numBulkId, serial_number: 'SN-ПОЛКА' }, numToken);
check('полке номер не вписать', upd.ok === false && upd.status === 409, upd);
updateRow(getSheet(SHEETS.EQUIPMENT), updBulkRow.__row, { qty_out: 0 });

// Галочка: название уходит в справочник и во все вещи модели.
upd = call('/item/update', { item_id: numId, name: 'Номерная Модель', all_model: true }, numToken);
check('название модели сменено', upd.ok === true && upd.data.all_model === true, upd);
check('переименованы обе вещи модели', upd.ok && upd.data.renamed === 2, upd.data);
check('у соседней вещи новое название',
  readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numOther)[0].name === 'Номерная Модель');
check('строка справочника переименована, старой нет',
  readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'CAM' && r.model_name === 'Номерная Модель') &&
  !readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'CAM' && r.model_name === 'Номерная Тест'));
upd = call('/item/update', { item_id: numId, serial_number: 'SN-ВСЕМ', all_model: true }, numToken);
check('с галочкой номера не принимаются', upd.ok === false && upd.status === 400, upd);
upd = call('/item/update', { item_id: numId, name: 'Canon C70', all_model: true }, numToken);
check('название другой модели этой категории — 409', upd.ok === false && upd.status === 409, upd);

// Название проходит через MODEL_ALIASES, как при импорте. «Sony A7 IV» — это
// «Sony ILCE-7M4», а она в CAM уже есть (aliasA): переименованием в синоним
// получились бы две модели одного аппарата.
check('модель Sony ILCE-7M4 по-прежнему в CAM',
  readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'CAM' && r.model_name === 'Sony ILCE-7M4'));
upd = call('/item/update', { item_id: numId, name: 'Sony A7 IV', all_model: true }, numToken);
check('переименование в синоним другой модели — 409 с каноническим именем',
  upd.ok === false && upd.status === 409 && /одна и та же модель/.test(upd.error) &&
  /Sony ILCE-7M4/.test(upd.error), upd);
check('после отказа название не тронуто',
  readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numId)[0].name === 'Номерная Модель');
// Синоним своей же модели: записывается каноническим именем, как при импорте.
upd = call('/item/update', { item_id: aliasA, name: 'Sony Alpha 7 IV', all_model: true }, numToken);
check('синоним своей модели принят и записан каноническим',
  upd.ok === true && upd.data.stored_name === 'Sony ILCE-7M4' && upd.data.renamed === 0, upd);
check('в справочнике и у вещей осталось каноническое имя',
  readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'CAM' && r.model_name === 'Sony ILCE-7M4') &&
  readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === aliasB)[0].name === 'Sony ILCE-7M4');

// Категория — только главному администратору.
const updAdmin = call('/staff/create', {
  full_name: 'Админ Правки', login: 'updadmin', pin: '8888', role: 'Admin',
}, numToken);
check('обычный администратор заведён', updAdmin.ok === true, updAdmin);
const updOne = call('/auth/login', { login: 'updadmin', pin: '8888' });
check('обычный администратор вошёл', updOne.ok === true && updOne.data.role === 'Admin' &&
  !updOne.data.is_owner, updOne);
upd = call('/item/update', { item_id: numId, category: 'LEN' }, updOne.ok ? updOne.data.token : '');
check('обычному админу смена категории — 403', upd.ok === false && upd.status === 403, upd);
upd = call('/item/update', { item_id: numId, name: 'Не должно записаться', category: 'LEN' },
           updOne.ok ? updOne.data.token : '');
check('и остальная правка из того же запроса не записалась',
  upd.ok === false && readRows(getSheet(SHEETS.EQUIPMENT))
    .filter(r => String(r.item_id) === numId)[0].name === 'Номерная Модель');
upd = call('/item/update', { item_id: numId, category: 'CAM', name: 'Номерная Модель' },
           updOne.ok ? updOne.data.token : '');
check('та же категория — не смена, обычному админу можно', upd.ok === true, upd);

// История у вещи, чтобы было что переписывать: выдача с приёмом и дефект.
const updOrder = call('/order/create', {
  order_no: '900901', student_name: 'Тестов Правка', student_phone: '+70000000001',
  issue_date: '2026-09-01', return_date: '2026-09-10',
}, numToken);
check('заказ для проверки переноса создан', updOrder.ok === true, updOrder);
call('/transaction/checkout', { item_id: numId, order_id: updOrder.data.order_id, expected_return_at: '2026-09-10' }, numToken);
call('/transaction/checkin', { item_id: numId }, numToken);
call('/defect/report', { item_id: numId, description: 'Перед переносом', severity: 'Minor' }, numToken);
const updTxBefore = readRows(getSheet(SHEETS.TRANSACTIONS)).filter(r => String(r.item_id) === numId).length;
const updDfBefore = readRows(getSheet(SHEETS.DEFECTS)).filter(r => String(r.item_id) === numId).length;
check('в журналах есть строки вещи', updTxBefore > 0 && updDfBefore > 0, [updTxBefore, updDfBefore]);

// Выданную вещь не переносим.
r = call('/transaction/checkout', { item_id: numOther, order_id: updOrder.data.order_id, expected_return_at: '2026-09-10' }, numToken);
check('вторая вещь выдана', r.ok === true, r);
upd = call('/item/update', { item_id: numOther, category: 'LEN' }, numToken);
check('выданную вещь не перенести — 409', upd.ok === false && upd.status === 409 && /выдана/.test(upd.error), upd);
upd = call('/item/update', { item_id: numId, category: 'GRP' }, numToken);
check('в категорию с другим учётом — 409', upd.ok === false && upd.status === 409 && /способ учёта/.test(upd.error), upd);

const updCamModel = upd.ok ? null : readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numId)[0].model_code;
upd = call('/item/update', { item_id: numId, category: 'LEN' }, numToken);
check('главный администратор перенёс одну вещь', upd.ok === true, upd);
const updNewId = upd.ok ? upd.data.item_id : '';
const updLenNum = categories().filter(c => c.code === 'LEN')[0].num;
check('у вещи новый номер в новой категории', updNewId !== numId && updNewId.slice(0, 2) === updLenNum &&
  upd.data.old_item_id === numId && upd.data.item.item_id === updNewId && upd.data.item.category === 'LEN', upd.data);
check('старого номера в каталоге нет',
  !readRows(getSheet(SHEETS.EQUIPMENT)).some(r => String(r.item_id) === numId));
check('журнал выдач переписан на новый номер',
  readRows(getSheet(SHEETS.TRANSACTIONS)).filter(r => String(r.item_id) === updNewId).length === updTxBefore &&
  !readRows(getSheet(SHEETS.TRANSACTIONS)).some(r => String(r.item_id) === numId));
check('дефекты переписаны на новый номер',
  readRows(getSheet(SHEETS.DEFECTS)).filter(r => String(r.item_id) === updNewId).length === updDfBefore);
check('в новой категории заведена модель с тем же названием',
  readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'LEN' && r.model_name === 'Номерная Модель'));
check('в старой модели осталась вторая вещь — её строка на месте', upd.ok && upd.data.moved.model_removed === false &&
  readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'CAM' && pad2(Number(r.model_code)) === pad2(Number(updCamModel))));

// Вся модель — тоже нет, пока вторая вещь на руках. И название из того же
// запроса не записывается: проверка стоит до первой записи.
upd = call('/item/update', { item_id: numOther, name: 'Не должно записаться', category: 'LEN', all_model: true }, numToken);
check('модель с выданной вещью целиком не перенести — 409',
  upd.ok === false && upd.status === 409 && /На руках 1 вещь этой модели/.test(upd.error), upd);
check('и название модели из того же запроса не записалось',
  readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numOther)[0].name === 'Номерная Модель');

call('/transaction/checkin', { item_id: numOther }, numToken);
upd = call('/item/update', { item_id: numOther, category: 'LEN' }, numToken);
check('после приёма вторая вещь переносится', upd.ok === true, upd);
check('она попала в ту же модель', upd.ok && upd.data.item.model_code === updNewId.slice(2, 4), upd.data);
check('опустевшая модель удалена из справочника', upd.ok && upd.data.moved.model_removed === true &&
  !readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'CAM' && pad2(Number(r.model_code)) === pad2(Number(updCamModel))));

// Полка переносится только целиком — тем же путём, что /model/move.
upd = call('/item/update', { item_id: numBulkId, category: 'GEL' }, numToken);
check('полку по одной не перенести — 409', upd.ok === false && upd.status === 409, upd);
// С полки что-то выдано — переносить нельзя ни ручкой модели, ни галочкой.
updateRow(getSheet(SHEETS.EQUIPMENT), updBulkRow.__row, { qty_out: 2 });
r = call('/model/move', { category: updBulkRow.category, model_code: pad2(Number(updBulkRow.model_code)), to_category: 'GEL' }, numToken);
check('полку с выданным не перенести через /model/move — 409',
  r.ok === false && r.status === 409 && /На руках 2 шт\./.test(String(r.error)), r);
upd = call('/item/update', { item_id: numBulkId, category: 'GEL', all_model: true }, numToken);
check('и галочкой тоже — 409', upd.ok === false && upd.status === 409 && /На руках 2 шт\./.test(upd.error), upd);
updateRow(getSheet(SHEETS.EQUIPMENT), updBulkRow.__row, { qty_out: 0 });
upd = call('/item/update', { item_id: numBulkId, category: 'GEL', all_model: true }, numToken);
check('с галочкой полка переехала вместе с моделью', upd.ok === true && upd.data.item.category === 'GEL' &&
  upd.data.item_id !== numBulkId && upd.data.moved && upd.data.moved.moved === 1, upd);

console.log('\n== разделы витрины: КИНО и ФОТО ==');
// Раздел — свойство модели, а не категории: объектив служит и кино, и фото.
// Проверяем главное: незнакомое значение не записывается, пустое законно, и
// неразмеченная модель не исчезает с витрины.
const secLogin = call('/auth/login', { login: 'matvey', pin: '4321' });
const secToken = secLogin.ok ? secLogin.data.token : null;
check('вход перед разметкой', secLogin.ok === true, secLogin);

let sec = call('/item/create', { category: 'CAM', model_name: 'Разделовая Тест' }, secToken);
check('модель для разметки заведена', sec.ok === true, sec);
const secCode = sec.ok ? sec.data.item_id.slice(2, 4) : null;

sec = call('/models/list', { category: 'CAM' }, secToken);
const secModel = sec.ok ? sec.data.filter(m => m.model_code === secCode)[0] : null;
check('новая модель приходит без разметки', secModel && secModel.section === '', secModel);

sec = call('/models/sections', {
  models: [{ category: 'CAM', model_code: secCode, section: 'CINE,PHOTO' }],
}, secToken);
check('разметка применилась', sec.ok === true && sec.data.changed === 1, sec);
sec = call('/models/list', { category: 'CAM' }, secToken);
check('модель теперь в обоих разделах',
  sec.data.filter(m => m.model_code === secCode)[0].section === 'CINE,PHOTO',
  sec.data.filter(m => m.model_code === secCode)[0]);

sec = call('/models/sections', {
  models: [{ category: 'CAM', model_code: secCode, section: 'photo' }],
}, secToken);
check('регистр не важен', sec.ok === true, sec);
check('повтор той же разметки ничего не меняет',
  call('/models/sections', { models: [{ category: 'CAM', model_code: secCode, section: 'PHOTO' }] },
       secToken).data.changed === 0, 'ожидали changed=0');

sec = call('/models/sections', {
  models: [{ category: 'CAM', model_code: secCode, section: 'ЗВУК' }],
}, secToken);
check('незнакомый раздел отклонён', sec.ok === false && sec.status === 400, sec);
sec = call('/models/list', { category: 'CAM' }, secToken);
check('после отказа разметка прежняя',
  sec.data.filter(m => m.model_code === secCode)[0].section === 'PHOTO',
  sec.data.filter(m => m.model_code === secCode)[0]);

sec = call('/models/sections', {
  models: [{ category: 'CAM', model_code: secCode, section: '' }],
}, secToken);
check('разметку можно снять', sec.ok === true && sec.data.changed === 1, sec);

sec = call('/models/sections', {
  models: [{ category: 'CAM', model_code: '99', section: 'CINE' }],
}, secToken);
check('несуществующая модель названа, а не проглочена',
  sec.ok === true && sec.data.missing.length === 1, sec.data);
sec = call('/models/sections', { models: [] }, secToken);
check('пустой список отклонён', sec.ok === false && sec.status === 400, sec);

const secStaff = call('/staff/create', {
  full_name: 'Складмен Разделов', login: 'seccheck', pin: '8888', role: 'Warehouse Staff',
}, secToken);
check('сотрудник склада заведён', secStaff.ok === true, secStaff);
const secStaffLogin = call('/auth/login', { login: 'seccheck', pin: '8888' });
sec = call('/models/sections', { models: [{ category: 'CAM', model_code: secCode, section: 'CINE' }] },
           secStaffLogin.ok ? secStaffLogin.data.token : 'нет-токена');
check('сотруднику склада разметка запрещена', sec.ok === false && sec.status === 403, sec);

// Публичный каталог отдаёт раздел — из него он попадает в снимок сайта.
const secPublic = call('/public/catalog', {});
check('публичный каталог отдаёт раздел',
  secPublic.ok === true && secPublic.data.models.every(m => 'section' in m),
  secPublic.ok ? secPublic.data.models[0] : secPublic);

console.log('\n== заявка с сайта ==');
const siteAdmin = call('/auth/login', { login: 'Matvey', pin: '4321' }).data.token;
const siteCat = call('/public/catalog', {}).data.models[0];
function siteText(no, extra) {
  return [
    'Заказ №' + no,
    '1. ' + siteCat.model_name + ': 0 (2 x 0)',
    '',
    'Информация о покупателе:',
    'Are_you_an_adult: Да',
    'Full_name_minor: Петров Пётр Петрович',
    'Phone_minors: +79990001122',
    'Telegram_Minors: @petrov',
    'Type_and_name_of_the_project: курсовая',
  ].concat(extra || []).concat([
    'Date_of_issue: 01.10.2026',
    'Date_completion: 05.10.2026',
  ]).join('\n');
}

// Включено по умолчанию (решение владельца): заявка с сайта — основной путь.
// Но выключатель работает: сохранённый 0 закрывает ручку, а не теряется в
// «пусто — значит умолчание».
check('по умолчанию приём заявок включён',
  getSettings().public_orders === 1 && handlePublicCatalog({}).orders_open === 1,
  getSettings().public_orders);
check('выключается настройкой',
  call('/settings/set', { settings: { public_orders: 0 } }, siteAdmin).ok === true);
check('сохранённый ноль читается как ноль, а не как умолчание',
  getSettings().public_orders === 0 && handlePublicCatalog({}).orders_open === 0,
  getSettings().public_orders);
let so = call('/public/order', { raw_text: siteText('260101-1111') });
check('выключено — отказ', so.ok === false && so.status === 403, so);

check('включается обратно',
  call('/settings/set', { settings: { public_orders: 1 } }, siteAdmin).ok === true);

so = call('/public/order', { raw_text: siteText('260101-1111') });
check('заявка принята', so.ok === true && so.data.order_no === '260101-1111', so);
const siteOrderId = so.ok ? so.data.order_id : null;

const siteCard = call('/order/card', { order_id: siteOrderId }, siteAdmin);
check('заказ виден складу', siteCard.ok === true, card);
check('автор строки — сайт', siteCard.ok && siteCard.data.order.created_by_name === 'сайт',
  siteCard.ok && siteCard.data.order.created_by_name);
check('статус New, а не выдача', siteCard.ok && siteCard.data.order.status === 'New',
  siteCard.ok && siteCard.data.order.status);
check('ФИО и телефон разобраны',
  siteCard.ok && siteCard.data.order.student_name === 'Петров Пётр Петрович' &&
  siteCard.ok && siteCard.data.order.student_phone === '+79990001122', siteCard.ok && siteCard.data.order);
check('позиция на месте', siteCard.ok && siteCard.data.items.length === 1, siteCard.ok && siteCard.data.items);

// Ответ идёт 5–20 секунд, и человек нажимает кнопку второй раз.
so = call('/public/order', { raw_text: siteText('260101-1111') });
check('повтор возвращает ту же заявку',
  so.ok === true && so.data.order_id === siteOrderId && so.data.repeat === true, so);
check('вторая копия не появилась',
  call('/orders/list', {}, siteAdmin).data.filter((o) => o.order_no === '260101-1111').length === 1);

// Тот же номер с другим содержимым — это уже не повтор, а столкновение.
so = call('/public/order', { raw_text: siteText('260101-1111', ['Input: другое']) });
check('тот же номер с другим текстом отклонён', so.ok === false && so.status === 409, so);

check('ловушка отсекает заявку',
  call('/public/order', { raw_text: siteText('260101-2222'), trap: 'бот' }).status === 400);
check('пустая заявка отклонена', call('/public/order', { raw_text: '' }).status === 400);
check('без номера отклонена',
  call('/public/order', { raw_text: siteText('260101-3333').replace(/^Заказ.*\n/, '') }).status === 400);
check('без позиций отклонена',
  call('/public/order', { raw_text: siteText('260101-4444').replace(/^1\..*\n/m, '') }).status === 400);
check('без ФИО отклонена',
  call('/public/order', { raw_text: siteText('260101-5555').replace(/^Full_name_minor.*\n/m, '') }).status === 400);
check('слишком длинная отклонена',
  call('/public/order', { raw_text: siteText('260101-6666') + '\n' + 'я'.repeat(4000) }).status === 400);

console.log('\n== сообщение бота о заявке (HTML) ==');
// Раскладка прежних сообщений Tilda, только в HTML. Данные выдуманные.
const siteTg = () => {
  const msgs = sent.filter((r) => /sendMessage/.test(r.url));
  return msgs.length ? JSON.parse(msgs[msgs.length - 1].opts.payload) : null;
};
function botOrderText(no, itemLines, buyerLines) {
  return ['Заказ №' + no].concat(itemLines).concat(['', 'Информация о покупателе:'])
    .concat(buyerLines).concat([
      'Type_and_name_of_the_project: курсовая',
      'Date_of_issue: 01.10.2026', 'Time_of_issue: 10:00',
      'Date_completion: 05.10.2026', 'Time_completion: 18:00',
    ]).join('\n');
}
const adultBuyer = ['Are_you_an_adult: Да', 'Full_name_minor: Тестов Тест Тестович',
  'Phone_minors: +70000000000', 'Telegram_Minors: @testov'];
metaSet('setting_site_url', 'https://example.test/site?a=1&b=2');
sent.length = 0;
so = call('/public/order', { raw_text: botOrderText('270101-0001', [
  '1. ' + siteCat.model_name + ': 77000 (2 x 38500)',
  '2. Бесплатная вещь: 0 (1 x 0)',
], adultBuyer) });
check('заявка для сообщения принята', so.ok === true, so);
let tgm = siteTg();
check('parse_mode HTML в сообщении о заявке', tgm && tgm.parse_mode === 'HTML', tgm);
check('заголовок с номером жирным', /^<b>Заказ №270101-0001<\/b>\n/.test(tgm.text), tgm.text);
check('строка позиции: сумма и (кол-во x цена)',
  tgm.text.indexOf('1. ' + siteCat.model_name + ': 77000 (2 x 38500)') !== -1, tgm.text);
check('нулевая цена печатается как у Tilda',
  tgm.text.indexOf('2. Бесплатная вещь: 0 (1 x 0.00)') !== -1, tgm.text);
check('сумма — по строкам', /<b>Сумма: 77000 RUB<\/b>/.test(tgm.text), tgm.text);
check('блок покупателя для взрослого: ФИО, телефон, ник',
  /<b>Покупатель<\/b>\nТестов Тест Тестович\nТелефон: \+70000000000\nTelegram: @testov/.test(tgm.text), tgm.text);
check('даты со временем', /<b>Даты:<\/b> 2026-10-01 10:00 — 2026-10-05 18:00/.test(tgm.text), tgm.text);
check('проект отдельной строкой', /Проект: курсовая/.test(tgm.text), tgm.text);
check('ссылка на сайт из site_url, экранированная',
  tgm.text.indexOf('<a href="https://example.test/site?a=1&amp;b=2">Открыть заказ на сайте</a>') !== -1, tgm.text);

// Несовершеннолетний: представитель, затем сам арендатор.
so = call('/public/order', { raw_text: botOrderText('270101-0002', [
  '1. ' + siteCat.model_name + ': 100 (1 x 100)',
], ['Are_you_an_adult: Нет', 'Full_name_guardian: Опекунов Опекун Опекунович',
  'Phone_guardian: +70000000001', 'Full_name_minor: Юнов Юн Юнович',
  'Phone_minors: +70000000002', 'Telegram_Minors: @yunov']) });
tgm = siteTg();
check('блок покупателя для несовершеннолетнего',
  /<b>Покупатель<\/b>\nПредставитель: Опекунов Опекун Опекунович\nТелефон представителя: \+70000000001\nНесовершеннолетний: Юнов Юн Юнович\nТелефон: \+70000000002\nTelegram: @yunov/.test(tgm.text), tgm.text);

// Всё, что пришло с формы, экранируется.
so = call('/public/order', { raw_text: botOrderText('270101-0003', [
  '1. Кран <i>&Ко: 5 (1 x 5)',
], ['Are_you_an_adult: Да', 'Full_name_minor: Иван <b>&', 'Phone_minors: +70000000000']) });
tgm = siteTg();
check('«<b>&» в имени экранирован', tgm.text.indexOf('Иван &lt;b&gt;&amp;') !== -1 &&
  tgm.text.indexOf('Иван <b>&') === -1, tgm.text);
check('и в названии позиции', tgm.text.indexOf('Кран &lt;i&gt;&amp;Ко') !== -1, tgm.text);

// Без site_url строки со ссылкой нет.
metaSet('setting_site_url', '');
so = call('/public/order', { raw_text: botOrderText('270101-0004', [
  '1. ' + siteCat.model_name + ': 100 (1 x 100)',
], adultBuyer) });
tgm = siteTg();
check('без site_url ссылки нет', !/<a href|Открыть заказ/.test(tgm.text), tgm.text);

// Длинная заявка: режется список позиций, а итог, покупатель и ссылка остаются.
metaSet('setting_site_url', 'https://example.test/');
so = call('/public/order', { raw_text: botOrderText('270101-0005',
  Array.from({ length: 30 }, (_, i) => (i + 1) + '. ' + '&'.repeat(60) + ': 100 (1 x 100)'),
  adultBuyer) });
check('длинная заявка принята', so.ok === true, so);
tgm = siteTg();
check('сообщение укладывается в предел Telegram', tgm.text.length <= 4096, tgm.text.length);
check('список урезан пометкой «… и ещё N поз.»', /… и ещё \d+ поз\./.test(tgm.text), tgm.text.slice(0, 200));
check('сумма по всем позициям сохранена', /<b>Сумма: 3000 RUB<\/b>/.test(tgm.text), tgm.text.slice(-400));
check('покупатель и ссылка уцелели',
  /Тестов Тест Тестович/.test(tgm.text) && /<a href="https:\/\/example\.test\/">/.test(tgm.text), tgm.text.slice(-400));
metaSet('setting_site_url', '');

// Дефект в чат не идёт: владелец решил, что чат — только заявки и акты.
const bdItem = call('/item/create', { name: 'Штатив <тест>', category: 'LGT' }, siteAdmin).data.item_id;
call('/transaction/checkout', { item_id: bdItem, client_id: clientId }, siteAdmin);
sent.length = 0;
const bdIn = call('/transaction/checkin',
  { item_id: bdItem, has_defect: true, defect_description: 'Сломано <b>&', defect_severity: 'Minor' }, siteAdmin);
check('приём с дефектом прошёл', bdIn.ok === true, bdIn);
check('о дефекте в Telegram не написано ничего',
  sent.filter((x) => /api\.telegram\.org/.test(x.url)).length === 0, sent.map((x) => x.url));

check('ручки просрочек в Telegram больше нет',
  /неизвестн|не найден|Unknown/i.test(String(call('/notify/overdue', {}, siteAdmin).error)),
  call('/notify/overdue', {}, siteAdmin));

console.log('\n== предел на заявки с сайта ==');
call('/settings/set', { settings: { public_orders_per_hour: 2 } }, siteAdmin);
__cacheStore.clear();
check('первая в пределах', call('/public/order', { raw_text: siteText('260102-0001') }).ok === true);
check('вторая в пределах', call('/public/order', { raw_text: siteText('260102-0002') }).ok === true);
const over = call('/public/order', { raw_text: siteText('260102-0003') });
check('третья отклонена по частоте', over.ok === false && over.status === 429, over);
check('отклонённая в таблицу не попала',
  call('/orders/list', {}, siteAdmin).data.every((o) => o.order_no !== '260102-0003'));
// Отказ по частоте не должен съедать квоту на разборе мусора: считаем только
// то, что дошло до записи.
__cacheStore.clear();
check('после сброса счётчика снова принимает',
  call('/public/order', { raw_text: siteText('260102-0004') }).ok === true);
call('/settings/set', { settings: { public_orders: 0 } }, siteAdmin);

// Хранение PIN. Блок стоит последним: вход перезаписывает session_token, и
// добытые выше токены после него стали бы недействительны.
console.log('\n== PIN в таблице ==');
const pinCol = SCHEMA.Staff.indexOf('pin_hash');
const pinAdmin = call('/auth/login', { login: 'Matvey', pin: '4321' }).data.token;

// Одинаковый PIN у двух человек не должен давать одинаковую строку: иначе по
// таблице видно, у кого код совпадает, и один перебор вскрывает обоих.
call('/staff/create', { full_name: 'Первый', login: 'pin_a', pin: '5150', role: 'Warehouse Staff' }, pinAdmin);
call('/staff/create', { full_name: 'Второй', login: 'pin_b', pin: '5150', role: 'Warehouse Staff' }, pinAdmin);
const pinRows = dumpSheet('Staff');
const loginCol = SCHEMA.Staff.indexOf('login');
const rowA = pinRows.filter((x) => x[loginCol] === 'pin_a')[0];
const rowB = pinRows.filter((x) => x[loginCol] === 'pin_b')[0];
check('одинаковый PIN — разные строки в таблице',
  rowA && rowB && rowA[pinCol] !== rowB[pinCol], [rowA && rowA[pinCol], rowB && rowB[pinCol]]);
check('оба входят со своим PIN',
  call('/auth/login', { login: 'pin_a', pin: '5150' }).ok === true &&
  call('/auth/login', { login: 'pin_b', pin: '5150' }).ok === true);

// В живой таблице PIN лежат в прежнем виде. После выкладки вход по ним обязан
// работать и обязан тут же переписать запись по-новому.
console.log('\n== старый формат PIN переезжает сам ==');
const legacyRow = dumpSheet('Staff').filter((x) => x[loginCol] === 'pin_a')[0];
legacyRow[pinCol] = crypto.createHash('sha256').update('5150').digest('hex');
const legacyIn = call('/auth/login', { login: 'pin_a', pin: '5150' });
check('вход по старому формату прошёл', legacyIn.ok === true, legacyIn);
check('запись переписана на новый формат', /^v2\$/.test(legacyRow[pinCol]), legacyRow[pinCol]);
check('тот же PIN по-прежнему пускает',
  call('/auth/login', { login: 'pin_a', pin: '5150' }).ok === true);
check('чужой PIN не пускает',
  call('/auth/login', { login: 'pin_a', pin: '5151' }).status === 401);

console.log('\n== выдача по заявке без скана ==');
const issAdmin = call('/auth/login', { login: 'Matvey', pin: '4321' }).data.token;
// Свой заказ, чтобы не тревожить те, на которых висят прежние проверки.
const issModel = call('/models/list', {}, issAdmin).data
  .filter((m) => !categoryByQty(m.category))[0];
const issItem = call('/item/create',
  { name: issModel.model_name, category: issModel.category, model_code: issModel.model_code },
  issAdmin);
check('предмет для выдачи заведён', issItem.ok === true, issItem);

let iss = call('/order/create', {
  order_no: 'ISSUE-1', student_name: 'Без Скана Иванович', student_phone: '+79990000001',
  issue_date: '01.10.2026', return_date: '03.10.2026',
  items: [{ line_no: 1, raw_name: issModel.model_name, category: issModel.category,
            model_code: issModel.model_code, qty: 1 }],
}, issAdmin);
check('заказ для выдачи создан', iss.ok === true, iss);
const issOrder = iss.data.order_id;

let out = call('/order/issue', { order_id: issOrder, line_no: 1 }, issAdmin);
check('выдали без сканирования', out.ok === true && out.data.issued.length === 1, out);
let issCard = call('/order/card', { order_id: issOrder }, issAdmin);
check('выдача записана в журнал', issCard.data.transactions.length === 1,
  issCard.data.transactions);
check('строка заказа отмечена выданной', issCard.data.items[0].issued_qty === 1,
  issCard.data.items[0]);
check('в примечании видно, что без скана',
  /без сканирования/.test(issCard.data.transactions[0].notes || ''),
  issCard.data.transactions[0].notes);
check('повторная выдача по той же строке отклонена',
  call('/order/issue', { order_id: issOrder, line_no: 1 }, issAdmin).status === 409);
check('несопоставленную строку выдать нельзя',
  call('/order/issue', { order_id: 1, line_no: 1 }, issAdmin).status === 409);
check('несуществующую строку тоже',
  call('/order/issue', { order_id: issOrder, line_no: 99 }, issAdmin).status === 404);

console.log('\n== выдача количеством в счёт заказа ==');
// «Выдано N из M» у позиции количеством: 10 мешков — это 10 в строке, а не 1.
check('категория GEL учитывается количеством', categoryByQty('GEL') === true);
const qtyItem = call('/item/create', { name: 'Скотч по заказу', category: 'GEL', qty: 30 }, issAdmin);
check('позиция количеством заведена', qtyItem.ok === true, qtyItem);
const qtyRow = readRows(getSheet(SHEETS.EQUIPMENT)).filter((e) => String(e.item_id) === String(qtyItem.data.item_id))[0];
const qtyOrder = call('/order/create', {
  order_no: 'QTY-1', student_name: 'Количеством Петрович', student_phone: '+79990000002',
  issue_date: '01.10.2026', return_date: '03.10.2026',
  items: [{ line_no: 1, raw_name: 'Скотч', category: 'GEL', model_code: qtyRow.model_code, qty: 12 }],
}, issAdmin).data.order_id;
const qtyLine = () => call('/order/card', { order_id: qtyOrder }, issAdmin).data.items[0].issued_qty;
r = call('/transaction/checkout', { item_id: qtyItem.data.item_id, order_id: qtyOrder, qty: 10 }, issAdmin);
check('выдали 10 из 12 — строка в составе', r.ok && r.data.order_line === '1', r);
check('в строке «выдано 10 из 12»', qtyLine() === 10, qtyLine());
r = call('/transaction/checkout', { item_id: qtyItem.data.item_id, order_id: qtyOrder, qty: 5 }, issAdmin);
check('сверх строки — остаток помечен вне заказа', r.ok && r.data.order_line === 'off-order', r);
check('строка заполнена до конца, не больше', qtyLine() === 12, qtyLine());
const qtyTx = readRows(getSheet(SHEETS.TRANSACTIONS)).filter((t) => String(t.order_id) === String(qtyOrder));
check('выдача разложена по записям: 10, 2 по строке и 3 вне заказа',
  qtyTx.map((t) => String(t.order_line) + ':' + t.qty).join(',') === '1:10,1:2,off-order:3',
  qtyTx.map((t) => String(t.order_line) + ':' + t.qty));
r = call('/transaction/checkin', { item_id: qtyItem.data.item_id, qty: 4 }, issAdmin);
check('приняли 4 — строка освободилась на 4', r.ok && qtyLine() === 8, qtyLine());
r = call('/transaction/checkin', { item_id: qtyItem.data.item_id, qty: 11 }, issAdmin);
check('приняли всё — строка пуста', r.ok && qtyLine() === 0, qtyLine());
check('заказ закрылся, когда вернули всё',
  call('/order/card', { order_id: qtyOrder }, issAdmin).data.order.status === 'Returned');
// Поштучная выдача по-прежнему +1 — выше, в «выдаче по заявке без скана».
check('поштучная выдача по-прежнему +1', issCard.data.items[0].issued_qty === 1, issCard.data.items[0]);

console.log('\n== архив заказа ==');
check('заказ с вещью на руках в архив не уходит',
  call('/order/archive', { order_id: issOrder }, issAdmin).status === 409,
  call('/order/archive', { order_id: issOrder }, issAdmin));

let empty = call('/order/create', {
  order_no: 'ARCHIVE-ME', student_name: 'Проверка Связи', student_phone: '+79000000000',
  items: [{ line_no: 1, raw_name: 'Что-то', qty: 1 }],
}, issAdmin);
const emptyId = empty.data.order_id;
const beforeArc = call('/orders/list', {}, issAdmin).data.length;
let arc = call('/order/archive', { order_id: emptyId }, issAdmin);
check('заказ без выдач убран в архив', arc.ok === true && !!arc.data.archived_at, arc);
check('из обычного списка пропал',
  call('/orders/list', {}, issAdmin).data.length === beforeArc - 1);
check('но в архиве он есть',
  call('/orders/list', { archived: true }, issAdmin).data
    .some((o) => String(o.order_id) === String(emptyId)));
// Самое важное: ничего не потеряно.
const arcCard = call('/order/card', { order_id: emptyId }, issAdmin);
check('карточка открывается, состав цел',
  arcCard.ok === true && arcCard.data.items.length === 1, arcCard.ok && arcCard.data.items);
check('видно, что заказ в архиве', !!arcCard.data.order.archived_at,
  arcCard.data.order.archived_at);

let back = call('/order/archive', { order_id: emptyId, back: true }, issAdmin);
check('из архива возвращается', back.ok === true && back.data.archived_at === '', back);
check('и снова в обычном списке',
  call('/orders/list', {}, issAdmin).data.length === beforeArc);

call('/staff/create', { full_name: 'Складмен Архива', login: 'arccheck',
                        pin: '5566', role: 'Warehouse Staff' }, issAdmin);
const arcStaff = call('/auth/login', { login: 'arccheck', pin: '5566' });
check('сотруднику склада архив запрещён',
  call('/order/archive', { order_id: emptyId }, arcStaff.data.token).status === 403);
check('а выдавать без скана он может',
  call('/order/issue', { order_id: issOrder, line_no: 1 }, arcStaff.data.token).status === 409);

console.log('\n== акт: сумма прописью ==');
check('ноль словами', numberInWords(0) === 'ноль');
check('одна тысяча, а не один тысяча', numberInWords(1000) === 'одна тысяча');
check('двадцать одна тысяча', numberInWords(21000) === 'двадцать одна тысяча');
check('сумма из старого акта',
  numberInWords(476718) === 'четыреста семьдесят шесть тысяч семьсот восемнадцать',
  numberInWords(476718));
check('рубль согласован', moneyInWords(1) === 'Один рубль 00 копеек', moneyInWords(1));
check('рубля согласовано', moneyInWords(2) === 'Два рубля 00 копеек', moneyInWords(2));
check('копейки на месте',
  moneyInWords(1500.5) === 'Одна тысяча пятьсот рублей 50 копеек', moneyInWords(1500.5));
check('разряды пробелами', moneyDigits(476718) === '476 718', moneyDigits(476718));
check('дата как в старом акте', humanRuDate('2026-10-01') === '01-10-2026г.');
check('фамилия сокращается', shortName('Гриднев Егор Олегович') === 'Гриднев Е.О.');

console.log('\n== чат склада находится сам ==');
// В Telegram на телефоне id чата не показывают, а открывать getUpdates в
// браузере — значит носить токен по адресной строке. Спрашивает бэкенд.
const chatAdmin = call('/auth/login', { login: 'Matvey', pin: '4321' }).data.token;
scriptProps.TELEGRAM_BOT_TOKEN = '';
check('без токена бота сказано, куда его класть',
  /TELEGRAM_BOT_TOKEN/.test(call('/notify/chats', {}, chatAdmin).error || ''),
  call('/notify/chats', {}, chatAdmin));
scriptProps.TELEGRAM_BOT_TOKEN = '123:ABC';

__telegramUpdates = [
  { message: { date: 1759100000, chat: { id: -1001234567890, title: 'Склад', type: 'supergroup' } } },
  { message: { date: 1759100100, chat: { id: -1001234567890, title: 'Склад', type: 'supergroup' } } },
  { message: { date: 1759100200, chat: { id: 482913756, first_name: 'Матвей', type: 'private' } } },
];
let found = call('/notify/chats', {}, chatAdmin);
check('чаты нашлись', found.ok === true && found.data.chats.length === 2, found);
check('повторы одного чата не плодятся',
  found.data.chats.filter((c) => c.chat_id === '-1001234567890').length === 1,
  found.data.chats);
check('свежий чат сверху',
  found.data.chats[0].chat_id === '482913756', found.data.chats.map((c) => c.chat_id));
check('минус у группы на месте',
  found.data.chats.some((c) => c.chat_id === '-1001234567890'), found.data.chats);
check('название группы взято из Telegram',
  found.data.chats.some((c) => c.title === 'Склад'), found.data.chats);
check('у личной переписки вместо названия имя',
  found.data.chats.some((c) => c.title === 'Матвей'), found.data.chats);

// Имя бота спрашиваем у Telegram: человеку незачем идти за ним в BotFather,
// чтобы подставить в команду.
check('имя бота пришло из Telegram',
  found.data.bot.username === 'mifs_rent_bot', found.data.bot);
check('команда собрана с этим именем',
  found.data.command === '/id@mifs_rent_bot', found.data.command);

__telegramUpdates = [];
found = call('/notify/chats', {}, chatAdmin);
check('пустой ответ объясняет, что делать',
  found.data.chats.length === 0 && /\/id@/.test(found.data.hint), found.data);
check('и называет бота по имени, а не «имя_бота»',
  /@mifs_rent_bot/.test(found.data.hint) && !/имя_бота/.test(found.data.hint),
  found.data.hint);

// Неверный токен — отдельная причина, и путать её с «бот не в группе» нельзя:
// пустой список сказал бы человеку не то.
__telegramMe = { ok: false, description: 'Unauthorized' };
const badToken = call('/notify/chats', {}, chatAdmin);
check('неверный токен назван неверным токеном',
  badToken.ok === false && /не признал токен/.test(badToken.error || '') &&
  /TELEGRAM_BOT_TOKEN/.test(badToken.error || ''), badToken);
__telegramMe = { ok: true, result: { username: 'mifs_rent_bot', first_name: 'Mifs Rent' } };
check('без входа чат не ищется',
  call('/notify/chats', {}, '').ok === false, call('/notify/chats', {}, ''));

console.log('\n== бот здоровается ==');
// Пока бот молчит, непонятно, есть ли он вообще: писать он начинает только
// когда на складе что-то случилось. Приветствие — первое, что он говорит.
const tgLast = () => {
  const msgs = sent.filter((r) => /sendMessage/.test(r.url));
  return msgs.length ? JSON.parse(msgs[msgs.length - 1].opts.payload) : null;
};

metaSet('setting_notify_chat_id', '-100777');
metaSet('setting_app_link', '');
let hi = call('/notify/hello', { chat_id: '-100555' }, chatAdmin);
check('приветствие отправлено', hi.ok === true, hi);
check('ушло в указанный чат, а не в чат из настроек',
  tgLast().chat_id === '-100555', tgLast());
check('бот представился',
  /^Здравствуйте! Я бот склада Mifs Rent\./.test(tgLast().text), tgLast().text);
check('перечислил, о чём будет писать',
  /заявки с сайта/.test(tgLast().text) && !/просрочки/.test(tgLast().text) &&
  !/дефект/.test(tgLast().text) && !/не собрал/.test(tgLast().text) &&
  /акт/.test(tgLast().text), tgLast().text);
check('приветствие уходит как HTML', tgLast().parse_mode === 'HTML', tgLast());
check('назвал чат, чтобы было видно — тот самый',
  /Этот чат: -100555/.test(tgLast().text), tgLast().text);
check('про склад молчит, пока ссылки нет',
  !/Склад:/.test(tgLast().text), tgLast().text);

metaSet('setting_app_link', 'https://t.me/mifs_rent_bot/app');
call('/notify/hello', {}, chatAdmin);
check('без chat_id берётся чат из настроек', tgLast().chat_id === '-100777', tgLast());
check('и ссылка на склад появляется, когда задана',
  /Склад: https:\/\/t\.me\/mifs_rent_bot\/app/.test(tgLast().text), tgLast().text);

scriptProps.TELEGRAM_BOT_TOKEN = '';
const noTok = call('/notify/hello', { chat_id: '-100555' }, chatAdmin);
check('без токена сказано, куда его положить',
  noTok.ok === false && /TELEGRAM_BOT_TOKEN/.test(noTok.error || ''), noTok);
scriptProps.TELEGRAM_BOT_TOKEN = '123:ABC';

metaSet('setting_notify_chat_id', '');
const noChat = call('/notify/hello', {}, chatAdmin);
check('без чата сказано, где его выбрать',
  noChat.ok === false && /Найти чат склада/.test(noChat.error || ''), noChat);
metaSet('setting_notify_chat_id', '-1001234567890');

check('складскому сотруднику здороваться нельзя',
  call('/notify/hello', {}, '').ok === false, call('/notify/hello', {}, ''));

console.log('\n== постоянная связь с Telegram ==');
// Опрос getUpdates отдаёт события один раз и не дольше суток: любой второй
// опрос забирает их себе, и список чатов выглядит пустым при живом боте.
// Вебхук снимает оба ограничения — и должен ставиться одним нажатием, без
// токена в адресной строке и без копирования секретов между Cloudflare и Google.
let hook = call('/notify/webhook', {}, chatAdmin);
check('состояние спрашивается без включения',
  hook.ok === true && hook.data.on === false, hook);

hook = call('/notify/webhook', { mode: 'on' }, chatAdmin);
check('связь включается', hook.ok === true && hook.data.on === true, hook);
check('адрес указывает на наш Worker',
  /^https:\/\/mifs-rent-api\.[^/]+\/tg\/[0-9a-f]{32}$/.test(hook.data.url), hook.data.url);
// Секрет не хранится нигде: он считается из токена бота, который есть у обеих
// сторон. Поэтому его нечего копировать и нечего потерять.
const expected = crypto.createHash('sha256').update('123:ABC', 'utf8')
  .digest('hex').slice(0, 32);
check('путь — отпечаток токена, а не отдельный секрет',
  hook.data.url.endsWith('/tg/' + expected), { url: hook.data.url, expected });
check('тот же отпечаток ушёл заголовком',
  __telegramWebhook.secret_token === expected, __telegramWebhook);
check('о включении сказано словами',
  /Постоянная связь включена/.test(hook.data.message), hook.data.message);

// Главное свойство: пока связь стоит, поиск чата не ломается. Telegram
// отвечает на опрос отказом 409, и это не поломка — чаты подставит Worker.
const chatsHooked = call('/notify/chats', {}, chatAdmin);
check('поиск чата при включённой связи не падает',
  chatsHooked.ok === true, chatsHooked);
check('и сообщает, что связь постоянная',
  chatsHooked.data.webhook === true, chatsHooked.data.webhook);
check('подсказка говорит про «/id», а не про опрос',
  /бот ответит сам/.test(chatsHooked.data.hint), chatsHooked.data.hint);

hook = call('/notify/webhook', { mode: 'off' }, chatAdmin);
check('связь выключается', hook.ok === true && hook.data.on === false, hook);
check('и сказано, что вернулись к опросу',
  /опрос/.test(hook.data.message), hook.data.message);
check('после выключения опрос снова работает',
  call('/notify/chats', {}, chatAdmin).data.webhook === false);

__telegramSetReply = { ok: false, description: 'Bad Request: bad webhook: HTTPS url must be provided' };
hook = call('/notify/webhook', { mode: 'on' }, chatAdmin);
check('отказ Telegram объяснён, а не проглочен',
  hook.ok === false && /Telegram не принял адрес/.test(hook.error || ''), hook);
__telegramSetReply = { ok: true, result: true };

// Адрес Worker настраивать не приходится: пустая настройка подменяется
// значением по умолчанию. Спрашивать его у человека было бы лишней работой —
// он и так знает его хуже, чем система.
metaSet('setting_api_url', '');
hook = call('/notify/webhook', { mode: 'on' }, chatAdmin);
check('без настройки берётся адрес по умолчанию',
  hook.ok === true && /^https:\/\/mifs-rent-api\./.test(hook.data.url), hook.data.url);
metaSet('setting_api_url', 'https://mifs-rent-api.example.workers.dev');
hook = call('/notify/webhook', { mode: 'on' }, chatAdmin);
check('заданный адрес побеждает значение по умолчанию',
  hook.data.url.indexOf('https://mifs-rent-api.example.workers.dev/tg/') === 0, hook.data.url);

scriptProps.TELEGRAM_BOT_TOKEN = '';
hook = call('/notify/webhook', { mode: 'on' }, chatAdmin);
check('без токена сказано, куда его положить',
  hook.ok === false && /TELEGRAM_BOT_TOKEN/.test(hook.error || ''), hook);
scriptProps.TELEGRAM_BOT_TOKEN = '123:ABC';

check('складскому сотруднику связь не переключить',
  call('/notify/webhook', { mode: 'on' }, '').ok === false);

console.log('\n== акт: шаблон ==');
const actAdmin = call('/auth/login', { login: 'Matvey', pin: '4321' }).data.token;
let act = call('/act/build', { order_id: 1 }, actAdmin);
check('без шаблона сборка отказывает понятно',
  act.ok === false && act.status === 409 && /Шаблон акта не создан/.test(act.error), act);

const helper = call('/staff/create', {
  full_name: 'Складмен Актов', login: 'actstaff', pin: '7788', role: 'Warehouse Staff',
}, actAdmin);
const helperToken = call('/auth/login', { login: 'actstaff', pin: '7788' }).data.token;
check('сотруднику склада шаблон создавать нельзя',
  call('/act/template', {}, helperToken).status === 403, helper.ok);

let tpl = call('/act/template', {}, actAdmin);
check('шаблон создан', tpl.ok === true && !!tpl.data.template_id, tpl);
check('и запомнен в настройках',
  call('/settings/get', {}, actAdmin).data.settings.act_template_id === tpl.data.template_id);
check('повторное создание без подтверждения отклонено',
  call('/act/template', {}, actAdmin).status === 409);
const tplText = __docs.get(tpl.data.template_id).body.getText();
check('в шаблоне нет ничьих персональных данных',
  !/Куприянова|Мария|977 677/.test(tplText));
// Шаблон — присланный колледжем акт, а не нарисованный заново: проверяем, что
// в нём осталась их формулировка и их реквизиты.
check('текст договора — колледжа',
  /О ПОЛНОЙ МАТЕРИАЛЬНОЙ ОТВЕТСТВЕННОСТИ/.test(tplText) &&
  /Шаболовка/.test(tplText) && /Приложение № 1/.test(tplText),
  tplText.slice(0, 120));
check('все подстановки на месте',
  ['{{НОМЕР}}', '{{ДАТА}}', '{{ФИО}}', '{{ТЕЛЕФОН}}', '{{ПРОЕКТ}}', '{{С}}', '{{ПО}}',
   '{{СУММА}}', '{{СУММА_СЛОВАМИ}}', '{{МАСТЕР}}', '{{МАСТЕР_КРАТКО}}', '{{ДИРЕКТОР}}',
   '{{ПОЗИЦИИ}}'].every((k) => tplText.includes(k)),
  (tplText.match(/\{\{[^}]+\}\}/g) || []).join(' '));
const tplTable = __docs.get(tpl.data.template_id).body.getTables()
  .filter((t) => t.grid[0][0] === '№')[0];
check('в таблице позиций шапка и одна строка-образец',
  tplTable && tplTable.grid.length === 2, tplTable && tplTable.grid.length);
check('столбец «КОЛ-ВО» вместо пустой «МОДЕЛЬ»',
  tplTable && tplTable.grid[0].join('|') === '№|НАИМЕНОВАНИЕ|КОЛ-ВО|ЗАВОДСКОЙ №|СТОИМОСТЬ (руб.)',
  tplTable && tplTable.grid[0]);
check('пятнадцати пустых строк из присланного акта не осталось',
  tplTable && !tplTable.grid.some((r) => r[0] === '5'), tplTable && tplTable.grid.map((r) => r[0]));

console.log('\n== акт: каждая позиция в свою ячейку ==');
act = call('/act/build', { order_id: 1 }, actAdmin);
check('акт собран', act.ok === true && !!act.data.url, act);
const built = __docs.get(act.data.document_id);
const itemsTable = built.body.getTables().filter((t) => t.grid[0][0] === '№')[0];
check('таблица позиций найдена', !!itemsTable);
check('строк по числу позиций (плюс заголовок)',
  itemsTable && itemsTable.grid.length === act.data.lines + 1,
  itemsTable && itemsTable.grid.length);
check('строки-образца не осталось',
  itemsTable && !itemsTable.getText().includes('{{'), itemsTable && itemsTable.getText());
check('в первой ячейке одно наименование, а не все подряд',
  itemsTable && itemsTable.grid[1][1].indexOf(';') === -1 &&
  itemsTable.grid[1][1].split(' - ').length === 1, itemsTable && itemsTable.grid[1][1]);
check('номера строк по порядку',
  itemsTable && itemsTable.grid.slice(1).every((r, i) => r[0] === String(i + 1)),
  itemsTable && itemsTable.grid.slice(1).map((r) => r[0]));
check('количество в своём столбце',
  itemsTable && itemsTable.grid.slice(1).every((r) => /^\d+$/.test(r[2])),
  itemsTable && itemsTable.grid.slice(1).map((r) => r[2]));
check('подстановок в документе не осталось',
  !built.body.getText().includes('{{'),
  (built.body.getText().match(/\{\{[^}]+\}\}/g) || []).slice(0, 4));
check('ФИО арендатора подставлено',
  built.body.getText().includes('Ильина-Ноктина Полина Ильинична'));
check('имя файла — дата и ФИО',
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /.test(built.name), built.name);

console.log('\n== акт: цены и заводские номера ==');
// В этом заказе часть позиций с ценой из заявки (Tilda), часть без.
check('у позиции без цены прочерк, а не ноль',
  itemsTable && itemsTable.grid.slice(1).some((r) => r[4] === '—'),
  itemsTable && itemsTable.grid.slice(1).map((r) => r[4]));
check('сумма посчитана по тем, у которых цена есть',
  act.data.total > 0, act.data.total);
check('непроставленные цены посчитаны и названы',
  act.data.unpriced > 0, act.data.unpriced);
check('сумма прописью попала в документ',
  /рубл/.test(built.body.getText()));

// Предметы в этом наборе заводились без заводских номеров, поэтому сначала
// проставим номер выданной единице — и только потом проверим, что он доехал
// до акта. Иначе проверка ничего не значит.
const issuedTx = call('/order/card', { order_id: 1 }, actAdmin).data.transactions
  .filter((t) => /^\d+$/.test(String(t.order_line)))[0];
check('в заказе есть выданная единица', !!issuedTx, issuedTx);
call('/item/numbers', { item_id: issuedTx.item_id, serial_number: 'SN-АКТ-001' }, actAdmin);

const act2 = call('/act/build', { order_id: 1 }, actAdmin);
const built2 = __docs.get(act2.data.document_id);
const table2 = built2.body.getTables().filter((t) => t.grid[0][0] === '№')[0];
check('заводской номер доехал до акта',
  table2.grid.slice(1).some((r) => r[3] === 'SN-АКТ-001'),
  table2.grid.slice(1).map((r) => r[3]));
check('у невыданных позиций столбец пуст, а не с чужим номером',
  table2.grid.slice(1).filter((r) => r[3] === 'SN-АКТ-001').length === 1,
  table2.grid.slice(1).map((r) => r[3]));

check('заказа без позиций акт не делает',
  call('/act/build', { order_id: 999 }, actAdmin).status === 404);

console.log('\n== акт собирается сам ==');
// Кнопки «собрать акт» нет: акт нужен всегда, а значит его незачем просить.
// Проверяем, что он появляется вместе с заказом и ссылка ложится в строку.
const madeOrder = call('/order/create', {
  order_no: '260930-7777',
  student_name: 'Соколов Роман Игоревич',
  student_phone: '+79990007777',
  project: 'курсовая',
  issue_date: '30-09-2026',
  return_date: '02-10-2026',
  items: [{ line_no: 1, raw_name: 'Видеоштатив', qty: 1 }],
}, actAdmin);
check('заказ записан', madeOrder.ok === true, madeOrder);
check('акт собрался сам, без отдельной просьбы',
  /docs.google.com/.test(String(madeOrder.data.act_url)), madeOrder.data);
const actCard = call('/order/card', { order_id: madeOrder.data.order_id }, actAdmin);
check('ссылка на акт лежит в заказе',
  actCard.data.order.act_url === madeOrder.data.act_url, actCard.data.order.act_url);
const tgTexts = () => sent
  .filter((r) => /sendMessage/.test(r.url))
  .map((r) => JSON.parse(r.opts.payload).text);
check('в чат ушло сообщение об акте со ссылкой <a href>',
  tgTexts().some((m) => /^<b>АКТ от \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/b> .*\n<a href="https:\/\/docs\.google\.com[^"]*">Открыть акт<\/a>$/.test(m)),
  tgTexts().slice(-3));

// Шаблон сломали — заказ всё равно должен записаться: это договорённость со
// студентом, а не документ.
const broke = call('/settings/set',
  { settings: { act_template_id: 'AAAAAAAAAAAAAAAAAAAAAA' } }, actAdmin);
check('настройку шаблона удалось подменить', broke.ok === true, broke);
const actSentBefore = sent.length;
const stillOrder = call('/order/create', {
  order_no: '260930-7778',
  student_name: 'Петрова Анна Сергеевна',
  student_phone: '+79990007778',
  items: [{ line_no: 1, raw_name: 'Видеоштатив', qty: 1 }],
}, actAdmin);
check('со сломанным шаблоном заказ всё равно записан', stillOrder.ok === true, stillOrder);
check('ссылки на акт при этом нет', !stillOrder.data.act_url, stillOrder.data.act_url);
check('о неудаче в чат не сказано ничего',
  sent.length === actSentBefore, sent.slice(actSentBefore).map((x) => x.url));
const actLog = logRows().filter((l) => l.kind === 'act');
check('неудача акта записана в журнал Logs',
  actLog.length === 1 && actLog[0].endpoint === 'autoAct' && actLog[0].reason === 'build-failed' &&
  actLog[0].message !== '' && String(JSON.parse(actLog[0].context).order_id) === String(stillOrder.data.order_id),
  actLog);

console.log('\n== акт: выдано сверх заявки ==');
// Складмен отсканировал по заказу то, чего в заявке нет. Выдача проходит
// (claimOrderLine → «off-order»), а акт пересобирается в том же документе:
// ссылка в теме «АКТЫ» остаётся рабочей, второго сообщения нет.
metaSet('setting_act_template_id', tpl.data.template_id);
const exA = call('/item/create', { name: 'Прожектор Сверхзаказ', category: 'LGT' }, actAdmin).data.item_id;
const exB = call('/item/create', { name: 'Прожектор Сверхзаказ', category: 'LGT' }, actAdmin).data.item_id;
const exC = call('/item/create', { name: 'Отражатель Сверхзаказ', category: 'LGT' }, actAdmin).data.item_id;
const exD = call('/item/create', { name: 'Отражатель Сверхзаказ', category: 'LGT' }, actAdmin).data.item_id;
call('/item/numbers', { item_id: exA, serial_number: 'SN-EX-1' }, actAdmin);
call('/item/numbers', { item_id: exB, serial_number: 'SN-EX-2' }, actAdmin);
const exModel = readRows(getSheet(SHEETS.EQUIPMENT)).filter((e) => String(e.item_id) === String(exA))[0];
check('у лишней позиции есть модель',
  exModel && exModel.model_code !== '' && exModel.model_code !== undefined, exModel);
call('/models/price', { category: 'LGT', model_code: exModel.model_code, price: 1500 }, actAdmin);

const exOrder = call('/order/create', {
  order_no: '260930-8888', student_name: 'Сверхов Иван Петрович', student_phone: '+79990008888',
  issue_date: '30-09-2026', return_date: '02-10-2026',
  items: [{ line_no: 1, raw_name: 'Видеоштатив', qty: 1 }],
}, actAdmin);
check('заказ с актом записан', exOrder.ok === true && /docs.google.com/.test(String(exOrder.data.act_url)), exOrder);
const exUrl = exOrder.data.act_url;
const exDoc = __docs.get((exUrl.match(/\/document\/d\/([^/]+)/) || [])[1]);
const exTable = () => exDoc.body.getTables().filter((t) => t.grid[0][0] === '№')[0];
const legendCount = () => exDoc.body.items
  .filter((i) => i.kind === 'p' && i.text === '* — выдано сверх заявки').length;
check('только заявленное — звёздочек нет',
  exTable().grid.slice(1).every((r) => !/\*$/.test(r[1])), exTable().grid);
check('только заявленное — расшифровки звёздочки нет', legendCount() === 0);

const docsBefore = __docs.size;
const actMsgsBefore = tgTexts().filter((m) => /^<b>АКТ от/.test(m)).length;
const stampBefore = exDoc.name.slice(0, 19);
const exR1 = call('/transaction/checkout', { item_id: exA, order_id: exOrder.data.order_id }, actAdmin);
const exR2 = call('/transaction/checkout', { item_id: exB, order_id: exOrder.data.order_id }, actAdmin);
check('лишнее выдаётся вне заказа',
  exR1.ok && exR2.ok && exR1.data.order_line === 'off-order' && exR2.data.order_line === 'off-order',
  [exR1, exR2]);
check('ответ выдачи прежний, без служебных полей',
  exR1.data.order_id === undefined && exR1.data.transaction_id > 0, exR1.data);
let exRows = exTable().grid.slice(1);
check('сначала заявленное, потом сверх заявки',
  exRows.length === 2 && exRows[0][1] === 'Видеоштатив' && exRows[1][0] === '2', exRows);
check('лишнее — одной строкой на модель, со звёздочкой',
  exRows[1][1] === 'Прожектор Сверхзаказ *' && exRows[1][2] === '2', exRows[1]);
check('заводские номера лишнего перечислены',
  exRows[1][3] === 'SN-EX-1, SN-EX-2', exRows[1][3]);
check('цена лишнего — по модели, за штуку на количество',
  exRows[1][4] === moneyDigits(3000), exRows[1][4]);
check('под таблицей одна строка «* — выдано сверх заявки»', legendCount() === 1);
check('расшифровка стоит сразу под таблицей',
  exDoc.body.items[exDoc.body.items.indexOf(exTable()) + 1].text === '* — выдано сверх заявки');
check('подстановок после пересборки не осталось', !exDoc.body.getText().includes('{{'));
check('сумма пересчитана с лишним', exDoc.body.getText().includes(moneyDigits(3000)));
check('пересобран тот же документ — новых нет', __docs.size === docsBefore, __docs.size - docsBefore);
check('ссылка в заказе та же',
  call('/order/card', { order_id: exOrder.data.order_id }, actAdmin).data.order.act_url === exUrl);
check('второго сообщения об акте в чат нет',
  tgTexts().filter((m) => /^<b>АКТ от/.test(m)).length === actMsgsBefore);
check('дата акта прежняя', exDoc.body.getText().includes(stampBefore), stampBefore);

// Вернули — всё равно выдавали: акт о переданном, как и у заявленных строк.
call('/transaction/checkin', { item_id: exA }, actAdmin);
call('/transaction/checkout', { item_id: exC, order_id: exOrder.data.order_id }, actAdmin);
exRows = exTable().grid.slice(1);
check('возвращённое лишнее из акта не пропало',
  exRows.some((r) => r[1] === 'Прожектор Сверхзаказ *' && r[3] === 'SN-EX-1, SN-EX-2'), exRows);
check('другая модель — своя строка, без цены прочерк',
  exRows.some((r) => r[1] === 'Отражатель Сверхзаказ *' && r[2] === '1' && r[4] === '—'), exRows);
check('расшифровка всё так же одна', legendCount() === 1);

// Пересборка сломалась — выдача всё равно прошла, причина в журнале.
metaSet('setting_act_template_id', 'AAAAAAAAAAAAAAAAAAAAAA');
const rebuildLogBefore = logRows().filter((l) => l.kind === 'act' && l.endpoint === 'rebuild').length;
const exR4 = call('/transaction/checkout', { item_id: exD, order_id: exOrder.data.order_id }, actAdmin);
check('со сломанным шаблоном выдача сверх заявки прошла',
  exR4.ok === true && exR4.data.order_line === 'off-order', exR4);
const rebuildLog = logRows().filter((l) => l.kind === 'act' && l.endpoint === 'rebuild');
check('неудача пересборки записана в Logs',
  rebuildLog.length === rebuildLogBefore + 1 && rebuildLog[rebuildLog.length - 1].reason === 'rebuild-failed' &&
  String(JSON.parse(rebuildLog[rebuildLog.length - 1].context).order_id) === String(exOrder.data.order_id),
  rebuildLog);
check('выданное со сломанным шаблоном на руках',
  readRows(getSheet(SHEETS.EQUIPMENT)).filter((e) => String(e.item_id) === String(exD))[0].status === 'Rented');
metaSet('setting_act_template_id', tpl.data.template_id);

console.log('\n== заявка с сайта: строки сопоставлены с каталогом ==');
// Сайт пишет в заявку model_name из /public/catalog. Без сопоставления строка
// ложилась без модели, и каждый скан по заявке уходил «вне заказа».
call('/settings/set', { settings: { public_orders: 1, public_orders_per_hour: 50 } }, actAdmin);
__cacheStore.clear();
const scA = call('/item/create', { name: 'Софтбокс Сайтовый', category: 'LGT' }, actAdmin).data.item_id;
const scB = call('/item/create', { name: 'Софтбокс Сайтовый', category: 'LGT' }, actAdmin).data.item_id;
const scX = call('/item/create', { name: 'Флаг Внезаказный', category: 'LGT' }, actAdmin).data.item_id;
const scModel = call('/public/catalog', {}).data.models
  .filter((m) => m.model_name === 'Софтбокс Сайтовый')[0];
check('модель есть в каталоге сайта', !!scModel, scModel);
// Строку собираем так же, как site/cart.js (orderText): имя из каталога.
const scText = botOrderText('270301-0001', [
  '1. ' + scModel.model_name + ': 0 (2 x 0)',
  '2. Неизвестная штуковина: 0 (1 x 0)',
], adultBuyer);
const scOrder = call('/public/order', { raw_text: scText });
check('заявка с сайта принята', scOrder.ok === true, scOrder);
let scCard = call('/order/card', { order_id: scOrder.data.order_id }, actAdmin).data;
check('строка из каталога получила модель и категорию',
  scCard.items[0].model_code === scModel.model_code && scCard.items[0].category === 'LGT',
  scCard.items[0]);
check('неизвестная строка осталась без модели',
  scCard.items[1].model_code === '' && scCard.items[1].raw_name === 'Неизвестная штуковина',
  scCard.items[1]);
check('повтор той же заявки по-прежнему узнаётся',
  call('/public/order', { raw_text: scText }).data.repeat === true);
check('регистр и лишние пробелы не мешают сопоставлению',
  matchOrderLine('  софтбокс   САЙТОВЫЙ ', readRows(getSheet(SHEETS.MODELS))).model_code === scModel.model_code);

const scR1 = call('/transaction/checkout', { item_id: scA, order_id: scOrder.data.order_id }, actAdmin);
check('скан по заявке с сайта — не «вне заказа»',
  scR1.ok === true && scR1.data.order_line === '1', scR1);
scCard = call('/order/card', { order_id: scOrder.data.order_id }, actAdmin).data;
check('«Выдано» по строке растёт', scCard.items[0].issued_qty === 1, scCard.items[0]);
call('/transaction/checkout', { item_id: scB, order_id: scOrder.data.order_id }, actAdmin);
check('вторая единица — та же строка, 2 из 2',
  call('/order/card', { order_id: scOrder.data.order_id }, actAdmin).data.items[0].issued_qty === 2);

const scDoc = __docs.get((String(scCard.order.act_url).match(/\/document\/d\/([^/]+)/) || [])[1]);
const scTable = () => scDoc.body.getTables().filter((t) => t.grid[0][0] === '№')[0];
check('в акте у сопоставленной строки звёздочки нет',
  !!scDoc && scTable().grid.slice(1).every((r) => !/\*$/.test(r[1])), scDoc && scTable().grid);

const scR3 = call('/transaction/checkout', { item_id: scX, order_id: scOrder.data.order_id }, actAdmin);
check('чужая вещь при несопоставленной строке — «вне заказа»',
  scR3.ok === true && scR3.data.order_line === 'off-order', scR3);
check('и только она в акте со звёздочкой',
  scTable().grid.slice(1).filter((r) => /\*$/.test(r[1])).map((r) => r[1]).join('|') === 'Флаг Внезаказный *',
  scTable().grid);
call('/settings/set', { settings: { public_orders: 0 } }, actAdmin);

console.log('\n== темы форума: заявки и акты ==');
// Группа склада — форум: заявки идут в тему «ЗАЯВКИ», акты — в «АКТЫ». Пустая
// настройка — General, как было до тем.
const tgMsgs = () => sent.filter((r) => /sendMessage/.test(r.url)).map((r) => JSON.parse(r.opts.payload));
const orderMsgs = () => tgMsgs().filter((m) => /^<b>Заказ №/.test(m.text));
check('номер темы: пусто принимается',
  call('/settings/set', { settings: { notify_thread_orders: '', notify_thread_acts: '' } }, actAdmin).ok === true);
check('номер темы: число принимается',
  call('/settings/set', { settings: { notify_thread_orders: '123' } }, actAdmin).ok === true);
check('номер темы: буквы отклонены',
  call('/settings/set', { settings: { notify_thread_orders: 'abc' } }, actAdmin).status === 400);
check('номер темы: минус отклонён',
  call('/settings/set', { settings: { notify_thread_acts: '-5' } }, actAdmin).status === 400);
check('отклонённое не сохранилось',
  call('/settings/get', {}, actAdmin).data.settings.notify_thread_orders === '123');
call('/settings/set', { settings: { public_orders: 1, public_orders_per_hour: 50,
  notify_thread_acts: '456' } }, actAdmin);
// Шаблон выше нарочно сломали; возвращаем настоящий, иначе акт не соберётся.
metaSet('setting_act_template_id', tpl.data.template_id);
metaSet('setting_notify_chat_id', '-1001234567890');

sent.length = 0;
let thr = call('/public/order', { raw_text: siteText('260201-0001') });
check('заявка принята', thr.ok === true, thr);
check('заявка ушла в тему «ЗАЯВКИ»',
  orderMsgs().length === 1 && orderMsgs()[0].message_thread_id === 123, tgMsgs());

sent.length = 0;
const thrOrder = call('/order/create', {
  order_no: '260201-0002', student_name: 'Темов Тема Темович', student_phone: '+79990002002',
  items: [{ line_no: 1, raw_name: 'Видеоштатив', qty: 1 }],
}, actAdmin);
check('заказ с актом записан', thrOrder.ok === true, thrOrder);
const actMsgs = tgMsgs().filter((m) => /^<b>АКТ от /.test(m.text));
check('акт ушёл в тему «АКТЫ»',
  actMsgs.length === 1 && actMsgs[0].message_thread_id === 456, tgMsgs());

sent.length = 0;
call('/notify/hello', {}, actAdmin);
call('/notify/hello', { chat_id: '-100555' }, actAdmin);
call('/notify/test', {}, actAdmin);
check('приветствие и проверка связи — без темы, в General',
  tgMsgs().length >= 2 && tgMsgs().every((m) => !('message_thread_id' in m)), tgMsgs());

call('/settings/set', { settings: { notify_thread_orders: '' } }, actAdmin);
sent.length = 0;
call('/public/order', { raw_text: siteText('260201-0003') });
check('пустая тема — заявка в General, поля нет',
  orderMsgs().length === 1 && !('message_thread_id' in orderMsgs()[0]), tgMsgs());

// Тему удалили или закрыли: Telegram отказывает, а заявка всё равно должна
// дойти — одним повтором без темы.
call('/settings/set', { settings: { notify_thread_orders: '999' } }, actAdmin);
__telegramSendReply = (m) => ('message_thread_id' in m)
  ? { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }
  : { ok: true, result: {} };
sent.length = 0;
thr = call('/public/order', { raw_text: siteText('260201-0004') });
check('заявка принята и при отказе темы', thr.ok === true, thr);
check('ровно один повтор, и он без темы',
  orderMsgs().length === 2 && orderMsgs()[0].message_thread_id === 999 &&
  !('message_thread_id' in orderMsgs()[1]), tgMsgs());
check('повтор помечен fallback',
  JSON.stringify(tgSend('проба', '', 'orders')) === JSON.stringify({ ok: true, fallback: true }));
__telegramSendReply = () => ({ ok: false, description: 'Forbidden' });
sent.length = 0;
const bothFail = tgSend('проба', '', 'orders');
check('отказ и без темы — ошибка повтора, повтор один',
  bothFail.ok === false && bothFail.fallback === true && bothFail.error === 'Forbidden' &&
  tgMsgs().length === 2, [bothFail, tgMsgs()]);
__telegramSendReply = null;
call('/settings/set', { settings: { public_orders: 0, notify_thread_orders: '', notify_thread_acts: '' } }, actAdmin);

console.log('\n== журнал Logs: служебное — в таблицу, не в чат ==');
// Владелец решил: в чат склада — только заявки и акты. Ошибки сервера, отказы
// Telegram и откат из темы в General пишутся в лист Logs.
scriptProps.TELEGRAM_BOT_TOKEN = '123:ABC';
metaSet('setting_notify_chat_id', '-1001234567890');
const logLogin = call('/auth/login', { login: 'matvey', pin: '4321' });
const logToken = logLogin.ok ? logLogin.data.token : null;
check('вход перед проверкой журнала', !!logToken, logLogin);

// Внутренняя ошибка: ответ по-прежнему 500, а в журнале — строка без токена и
// без тела запроса.
check('ошибка с отказом ручки (ApiError) в журнал не идёт',
  (() => { const n = logRows().length; call('/inventory/list', {}, 'чужой-токен'); return logRows().length === n; })());
const realInventoryList = handleInventoryList;
globalThis.handleInventoryList = () => { throw new Error('внезапно сломалось'); };
let logBefore = logRows().length;
let boom = call('/inventory/list', { phone: '+79990001122' }, logToken);
check('внутренняя ошибка — по-прежнему 500 с текстом',
  boom.ok === false && boom.status === 500 && /внезапно сломалось/.test(String(boom.error)), boom);
let errLog = logRows().slice(logBefore);
check('внутренняя ошибка записана в журнал',
  errLog.length === 1 && errLog[0].kind === 'error' && errLog[0].endpoint === '/inventory/list' &&
  errLog[0].message === 'внезапно сломалось' && /stack/.test(errLog[0].context), errLog);
check('в журнале нет ни токена сессии, ни данных запроса',
  JSON.stringify(errLog).indexOf(logToken) === -1 && JSON.stringify(errLog).indexOf('+79990001122') === -1,
  errLog);

// Отказ Telegram по заявке — строка в журнале, в чат ничего сверх попытки.
__telegramSendReply = () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked' });
logBefore = logRows().length;
let failed = tgSend('<b>Заказ №1</b>', '', 'orders');
let tgLog = logRows().slice(logBefore);
check('неудачная заявка в чат — строка в журнале',
  failed.ok === false && tgLog.length === 1 && tgLog[0].kind === 'telegram' &&
  tgLog[0].reason === 'telegram' && /kicked/.test(tgLog[0].message) &&
  JSON.parse(tgLog[0].context).kind === 'orders', tgLog);

// Откат из темы в General — тоже в журнал: заявка дошла, но тему пора чинить.
metaSet('setting_notify_thread_orders', '999');
__telegramSendReply = (m) => ('message_thread_id' in m)
  ? { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }
  : { ok: true, result: {} };
logBefore = logRows().length;
const fb = tgSend('<b>Заказ №2</b>', '', 'orders');
tgLog = logRows().slice(logBefore);
check('откат в General записан в журнал',
  fb.ok === true && fb.fallback === true && tgLog.length === 1 && tgLog[0].reason === 'fallback' &&
  JSON.parse(tgLog[0].context).thread === '999', tgLog);
metaSet('setting_notify_thread_orders', '');
__telegramSendReply = null;

// Нет чата: заявка — в журнал; кнопка приветствия — нет, она и так отвечает
// человеку через notifyRefusal.
metaSet('setting_notify_chat_id', '');
logBefore = logRows().length;
tgSend('<b>Заказ №3</b>', '', 'orders');
check('заявка без чата — строка no-chat в журнале',
  logRows().slice(logBefore).map((l) => l.reason).join() === 'no-chat', logRows().slice(logBefore));
logBefore = logRows().length;
const noChatHello = call('/notify/hello', {}, logToken);
check('приветствие без чата отвечает человеку', noChatHello.ok === false && noChatHello.status === 400,
  noChatHello);
check('и в журнал не пишет', logRows().length === logBefore, logRows().slice(logBefore));
metaSet('setting_notify_chat_id', '-1001234567890');

// Сетевая ошибка цитирует адрес с токеном бота — в журнал он не попадает.
__telegramSendReply = () => { throw new Error('Request failed for https://api.telegram.org/bot123:ABC/sendMessage'); };
logBefore = logRows().length;
tgSend('<b>Заказ №4</b>', '', 'orders');
tgLog = logRows().slice(logBefore);
check('сетевая ошибка в журнале, токен вырезан',
  tgLog.length === 1 && tgLog[0].reason === 'network' &&
  JSON.stringify(tgLog).indexOf('123:ABC') === -1 && /bot<token>/.test(tgLog[0].message), tgLog);
__telegramSendReply = null;

// Длинный контекст обрезается.
logBefore = logRows().length;
logEvent('error', '/x', 'test', 'длинно', { big: 'я'.repeat(5000) });
check('контекст журнала обрезан до ~2000 знаков',
  logRows().slice(logBefore)[0].context.length <= 2001, logRows().slice(logBefore)[0].context.length);

// Листа Logs нет (после выкладки не запускали setupSheets) — журнал молчит,
// запрос отвечает как обычно.
const logsSheet = spreadsheet.getSheetByName('Logs');
spreadsheet.deleteSheet(logsSheet);
let noLogThrew = false;
try { logEvent('error', '/x', 'test', 'без листа', {}); } catch (e) { noLogThrew = true; }
check('logEvent без листа Logs не бросает', noLogThrew === false);
check('без листа Logs сводка склада даёт logs_24h = 0',
  warehouseSummary().logs_24h === 0, warehouseSummary().logs_24h);
boom = call('/inventory/list', {}, logToken);
check('без листа Logs внутренняя ошибка — всё тот же 500',
  boom.ok === false && boom.status === 500 && /внезапно сломалось/.test(String(boom.error)), boom);
__telegramSendReply = () => ({ ok: false, description: 'Forbidden' });
check('без листа Logs неудачный tgSend просто возвращает отказ',
  tgSend('проба', '', 'orders').ok === false);
__telegramSendReply = null;
spreadsheet.sheets.push(logsSheet);
globalThis.handleInventoryList = realInventoryList;
check('ручка после проверки снова работает', call('/inventory/list', {}, logToken).ok === true);

console.log('\n== ночное обслуживание: копия таблицы ==');
// 15 копий уже лежат в папке, по дню разницы; шестнадцатая делается сейчас.
fakeFolder(BACKUP_FOLDER_NAME);
const backupFiles = drive.folders[BACKUP_FOLDER_NAME].files;
for (let d = 15; d >= 1; d--) {
  backupFiles.push({ name: 'Mifs Rent old-' + d, id: 'old-' + d,
                     created: new Date(Date.now() - d * 86400000), trashed: false });
}
r = dailyBackup();
const alive = backupFiles.filter(f => !f.trashed);
check('копия сделана с датой в имени', backupFiles.some(f => /^Mifs Rent \d{4}-\d{2}-\d{2}$/.test(f.name) && !f.trashed), r);
check('из 16 копий осталось 14', alive.length === 14, alive.length);
check('в корзину ушли две самые старые',
  backupFiles.filter(f => f.trashed).map(f => f.id).sort().join() === 'old-14,old-15',
  backupFiles.filter(f => f.trashed).map(f => f.id));

logBefore = logRows().length;
global.__driveFail = 'Drive недоступен';
let backupThrew = false;
try { dailyMaintenance(); } catch (e) { backupThrew = true; }
global.__driveFail = null;
const backupLog = logRows().slice(logBefore).filter(l => l.kind === 'backup');
check('ошибка Диска не роняет триггер', backupThrew === false);
check('ошибка Диска записана в Logs',
  backupLog.length === 1 && /Drive недоступен/.test(backupLog[0].message), backupLog);
check('после неудачи копий по-прежнему 14', backupFiles.filter(f => !f.trashed).length === 14);

console.log('\n== ночное обслуживание: триггеры ==');
ScriptApp.newTrigger('dailyOverdueDigest').timeBased().everyDays(1).atHour(9).create();
ScriptApp.newTrigger('doSomethingElse').timeBased().everyDays(1).atHour(9).create();
const trig1 = setupTriggers();
const trig2 = setupTriggers();
const byHandler = (h) => triggers.filter(t => t.handler === h);
check('после двух запусков ровно один dailyMaintenance', byHandler('dailyMaintenance').length === 1, triggers.map(t => t.handler));
check('dailyMaintenance ежедневно в 3 часа',
  byHandler('dailyMaintenance')[0].days === 1 && byHandler('dailyMaintenance')[0].hour === 3);
check('старый dailyOverdueDigest снят', byHandler('dailyOverdueDigest').length === 0);
check('чужой триггер не тронут', byHandler('doSomethingElse').length === 1);
check('сводка говорит, сколько снято', /снято старых 1/.test(trig1) && /снято старых 1/.test(trig2), [trig1, trig2]);

console.log('\n== ночное обслуживание: подрезка Logs ==');
const logSheet = getSheet(SHEETS.LOGS);
appendRow(logSheet, { timestamp: new Date(Date.now() - 91 * 86400000).toISOString(), kind: 'test', message: 'старая' });
appendRow(logSheet, { timestamp: new Date(Date.now() - 89 * 86400000).toISOString(), kind: 'test', message: 'свежая' });
const logsBeforeTrim = logRows().length;
const trimmed = trimLogs();
const testLogs = logRows().filter(l => l.kind === 'test');
check('удалена одна строка старше 90 дней', trimmed === 1 && logRows().length === logsBeforeTrim - 1, trimmed);
check('свежая строка осталась, старая ушла',
  testLogs.length === 1 && testLogs[0].message === 'свежая', testLogs);
check('сегодняшние строки на месте', logRows().some(l => l.kind === 'backup'));

console.log('\n== сводка склада: записи журнала за сутки ==');
// logs_24h — строки Logs со временем не старше суток. Позавчерашняя и строка
// с нечитаемой датой не считаются.
const logs24Before = warehouseSummary().logs_24h;
check('сегодняшние записи посчитаны', logs24Before > 0 &&
  logs24Before === logRows().filter(l => Date.now() - new Date(l.timestamp).getTime() <= 86400000).length,
  logs24Before);
appendRow(logSheet, { timestamp: new Date(Date.now() - 25 * 3600000).toISOString(), kind: 'test', message: '25 ч' });
appendRow(logSheet, { timestamp: new Date(Date.now() - 23 * 3600000).toISOString(), kind: 'test', message: '23 ч' });
appendRow(logSheet, { timestamp: 'не дата', kind: 'test', message: 'мусор' });
check('logs_24h считает только последние сутки',
  warehouseSummary().logs_24h === logs24Before + 1, warehouseSummary().logs_24h);
check('logs_24h отдаётся вместе с настройками',
  call('/settings/get', {}, logToken).data.summary.logs_24h === logs24Before + 1);

console.log('\n== объявления склада ==');
// Складмен — роль Warehouse Staff, не Admin: писать объявления должен мочь он.
const annStaff = secStaffLogin.ok ? secStaffLogin.data.token : 'нет-токена';
const annDay = (shift) => new Date(Date.now() + shift * 86400000).toISOString().substring(0, 10);

check('без объявлений публичный ответ пуст',
  call('/public/announcements', {}).ok === true &&
  call('/public/announcements', {}).data.items.length === 0, call('/public/announcements', {}));

const annNew = call('/announcement/save', {
  title: 'График на лето', text: 'Склад закрыт 12 июня.\n\nВыдача остановлена с 28 июня.',
  until: annDay(10),
}, annStaff);
check('складмен создаёт объявление', annNew.ok === true && !!annNew.data.announcement_id, annNew);
check('без входа создать нельзя',
  call('/announcement/save', { title: 'x', text: 'y' }, '').ok === false &&
  call('/announcement/save', { title: 'x', text: 'y' }, '').status === 401);
check('без заголовка отказ', call('/announcement/save', { title: ' ', text: 'y' }, annStaff).status === 400);
check('без текста отказ', call('/announcement/save', { title: 'x', text: ' \n ' }, annStaff).status === 400);
check('слишком длинный заголовок отказ',
  call('/announcement/save', { title: 'я'.repeat(121), text: 'y' }, annStaff).status === 400);
check('слишком длинный текст отказ',
  call('/announcement/save', { title: 'x', text: 'я'.repeat(2001) }, annStaff).status === 400);
check('больше десяти абзацев отказ',
  call('/announcement/save', { title: 'x', text: Array(11).fill('строка').join('\n') }, annStaff).status === 400);
check('плохая дата отказ',
  call('/announcement/save', { title: 'x', text: 'y', until: 'завтра' }, annStaff).status === 400);
check('несуществующий день отказ',
  call('/announcement/save', { title: 'x', text: 'y', until: '2026-02-31' }, annStaff).status === 400);

let annPub = call('/public/announcements', {});
check('публичный ответ отдаёт действующее', annPub.ok === true && annPub.data.items.length === 1, annPub);
const annItem = annPub.ok ? annPub.data.items[0] : {};
check('абзацы разобраны, пустые строки убраны',
  JSON.stringify(annItem.lines) === JSON.stringify(['Склад закрыт 12 июня.', 'Выдача остановлена с 28 июня.']), annItem);
check('срок отдан как есть', annItem.until === annDay(10), annItem);
check('кто завёл — наружу не уходит',
  Object.keys(annItem).sort().join() === 'id,lines,title,until', Object.keys(annItem));
check('публичное чтение не требует входа', call('/public/announcements', {}, '').ok === true);

// Правка и список для приложения.
check('правка по номеру', call('/announcement/save', {
  announcement_id: annNew.data.announcement_id, title: 'График на лето (новый)',
  text: 'Склад закрыт.', until: '',
}, annStaff).ok === true);
annPub = call('/public/announcements', {});
check('правка видна на сайте, срок снят',
  annPub.data.items[0].title === 'График на лето (новый)' && !('until' in annPub.data.items[0]), annPub);
check('правка чужого номера отказ', call('/announcement/save', {
  announcement_id: '999', title: 'x', text: 'y' }, annStaff).status === 404);
const annList = call('/announcements/list', {}, annStaff);
check('приложению отдаётся список с автором и текстом целиком',
  annList.ok === true && annList.data.items.length === 1 &&
  annList.data.items[0].created_by_name === 'Складмен Разделов' &&
  annList.data.items[0].text === 'Склад закрыт.', annList);
check('список без входа закрыт', call('/announcements/list', {}, '').status === 401);

// Просроченное: недавнее остаётся (решает браузер), давнее уходит из ответа.
call('/announcement/save', { title: 'Вчерашнее', text: 't', until: annDay(-1) }, annStaff);
call('/announcement/save', { title: 'Давнее', text: 't', until: annDay(-30) }, annStaff);
const annTitles = call('/public/announcements', {}).data.items.map(i => i.title);
check('вчерашнее срок ещё отдан (запас на часовые пояса)', annTitles.includes('Вчерашнее'), annTitles);
check('месячной давности не отдаётся', !annTitles.includes('Давнее'), annTitles);
check('в списке приложения просроченное помечено',
  call('/announcements/list', {}, annStaff).data.items.some(i => i.title === 'Давнее' && i.expired === true));

// Лимит действующих: просроченные не считаются.
let annLimit = null;
for (let i = 0; i < 12 && !annLimit; i++) {
  const r = call('/announcement/save', { title: 'Нагрузка ' + i, text: 't' }, annStaff);
  if (!r.ok) annLimit = r;
}
check('больше десяти действующих отказ', annLimit && annLimit.status === 409, annLimit);

// Снятие.
const annGone = call('/announcement/remove', { announcement_id: annNew.data.announcement_id }, annStaff);
check('складмен снимает объявление', annGone.ok === true && annGone.data.changed === true, annGone);
check('снятое пропало с сайта',
  !call('/public/announcements', {}).data.items.some(i => i.title.startsWith('График на лето')));
check('снятое пропало из списка приложения',
  !call('/announcements/list', {}, annStaff).data.items.some(i => i.announcement_id === annNew.data.announcement_id));
check('но строка в таблице осталась, с меткой',
  readRows(getSheet(SHEETS.ANNOUNCEMENTS)).some(r => String(r.announcement_id) === annNew.data.announcement_id && !!r.removed_at));
check('повторное снятие безвредно',
  call('/announcement/remove', { announcement_id: annNew.data.announcement_id }, annStaff).data.changed === false);
check('снять несуществующее отказ', call('/announcement/remove', { announcement_id: '999' }, annStaff).status === 404);
check('снять без входа нельзя', call('/announcement/remove', { announcement_id: '1' }, '').status === 401);

// Нет вкладки — сайту не падать.
spreadsheet.deleteSheet(spreadsheet.getSheetByName('Announcements'));
check('нет вкладки — публичный ответ пуст, а не ошибка',
  call('/public/announcements', {}).ok === true && call('/public/announcements', {}).data.items.length === 0,
  call('/public/announcements', {}));

console.log('\n' + (failures ? '❌ ПРОВАЛОВ: ' + failures : '✅ Все проверки пройдены'));
process.exit(failures ? 1 : 0);
