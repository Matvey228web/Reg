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
          // Как в Sheets: значение формулы — её результат, а не текст. Формулы
          // в тестах дают пусто (IMAGE от пустой ссылки), текст отдаёт getFormulas.
          for (let j = 0; j < numCols; j++) {
            const v = r[col - 1 + j];
            line.push(v === undefined || (typeof v === 'string' && v.charAt(0) === '=') ? '' : v);
          }
          out.push(line);
        }
        return out;
      },
      getFormulas() {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const r = sheet.data[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < numCols; j++) {
            const v = r[col - 1 + j];
            line.push(typeof v === 'string' && v.charAt(0) === '=' ? v : '');
          }
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
// Замок считает вложенность: на повторный вход у настоящего замка Apps Script
// опираться нельзя — внутренний releaseLock отпустил бы и внешний. Вложенных
// захватов быть не должно, это проверяется в конце.
const lockState = { depth: 0, nested: 0 };
global.LockService = {
  getScriptLock: () => {
    let held = false;
    return {
      waitLock() { if (lockState.depth > 0) lockState.nested++; lockState.depth++; held = true; },
      releaseLock() { if (held) { held = false; lockState.depth--; } },
    };
  },
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
        insertTableRow(i) {
          const cells = [];
          grid.splice(i, 0, cells);
          const row = {
            appendTableCell: (v) => { cells.push(String(v)); return row; },
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
  AuthMode: { FULL: 'FULL' },
  requireAllScopes() {},
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
  sleep() {},
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
    // Бот «Моё в аренду»: файл фото, карточка на модерацию, правка подписи.
    if (/\/getFile$/.test(url)) {
      return { getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: true, result: { file_path: 'photos/p1.jpg' } }) };
    }
    if (/\/file\/bot[^/]+\/photos\//.test(url)) {
      const bytes = [0xFF, 0xD8, 0xFF, 0xE0].concat(new Array(40).fill(7)).map(b => (b > 127 ? b - 256 : b));
      return { getResponseCode: () => 200, getContent: () => bytes, getContentText: () => '' };
    }
    if (/\/sendPhoto$/.test(url)) {
      const asked = JSON.parse(opts.payload);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true,
        result: { message_id: 500 + sent.length, chat: { id: Number(asked.chat_id) } } }) };
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
          return { getName: () => f.name, getId: () => f.id, isTrashed: () => !!f.trashed,
                   getDateCreated: () => f.created || new Date(0),
                   setTrashed(v) { f.trashed = v; } };
        },
      };
    },
    createFile(fileName, content) {
      // Фото модели: createFile(blob) — один аргумент, имя берётся из блоба.
      const blob = typeof fileName === 'object' ? fileName : null;
      const file = { name: blob ? blob._name : fileName, content: blob || content,
                     id: 'file-' + (folder.files.length + 1), trashed: false };
      folder.files.push(file);
      return { getId: () => file.id, getName: () => file.name,
               setSharing(a, p) { file.sharing = [a, p]; },
               setTrashed(v) { file.trashed = v; } };
    },
  };
}
global.DriveApp = {
  Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
  Permission: { VIEW: 'VIEW' },
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
check('создано 17 вкладок (с журналом Logs, объявлениями и MyRent)', spreadsheet.getSheets().length === 17 && !!spreadsheet.getSheetByName('Logs'), spreadsheet.getSheets().map(s => s.name));
check('Sheet1 удалён', !spreadsheet.getSheetByName('Sheet1'));
check('заголовки Equipment верны',
  JSON.stringify(dumpSheet('Equipment')[0]) === JSON.stringify(SCHEMA.Equipment), dumpSheet('Equipment')[0]);
check('заголовки Meta верны',
  JSON.stringify(dumpSheet('Meta')[0]) === JSON.stringify(SCHEMA.Meta));

console.log('\n== setupSheets повторно (идемпотентность) ==');
spreadsheet.getSheetByName('Clients').appendRow([1, 'Тест Клиент', 'Проект', '', '', '']);
setupSheets();
check('вкладок по-прежнему 17', spreadsheet.getSheets().length === 17);
check('данные Clients не затёрты', dumpSheet('Clients').length === 2, dumpSheet('Clients'));
check('заголовки Clients на месте', dumpSheet('Clients')[0][0] === 'client_id');

console.log('\n== bootstrap первого администратора ==');
// PIN короче шести цифр не принимается и при самозагрузке — и попытка не
// должна «израсходовать» её: отметка bootstrap_done ставится только при успехе.
let r = call('/staff/create', { full_name: 'Матвей', login: 'Matvey', pin: '4321' });
check('bootstrap с 4-значным PIN отклонён', r.status === 400, r);
check('...и самозагрузка не израсходована', !metaGet('bootstrap_done') && dumpSheet('Staff').length === 1);
r = call('/staff/create', { full_name: 'Матвей', login: 'Matvey', pin: '432143' });
check('создан без токена', r.ok === true, r);
check('staff_id = 1', r.data && r.data.staff_id === 1, r.data);
const staffRow = dumpSheet('Staff')[1];
check('роль принудительно Admin', staffRow[SCHEMA.Staff.indexOf('role')] === 'Admin', staffRow);
const storedPin = staffRow[SCHEMA.Staff.indexOf('pin_hash')];
check('PIN сохранён не в открытом виде', storedPin !== '432143' && !/432143/.test(storedPin), storedPin);
// Голый SHA-256 от четырёх цифр подбирается перебором десяти тысяч вариантов
// за секунды, поэтому в таблице его быть не должно.
check('PIN не голый SHA-256',
  storedPin !== crypto.createHash('sha256').update('432143').digest('hex'), storedPin);
check('у PIN есть соль и число повторов',
  /^v2\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(storedPin), storedPin);

console.log('\n== bootstrap закрывается после первой записи ==');
r = call('/staff/create', { full_name: 'Чужой', login: 'hacker', pin: '000000' });
check('второй bootstrap без токена отклонён', r.ok === false && r.status === 403, r);

console.log('\n== вход ==');
r = call('/auth/login', { login: 'matvey', pin: '432143' });   // намеренно строчными
check('логин регистронезависимый', r.ok === true, r);
const token = r.ok ? r.data.token : null;
check('вернулась роль Admin', r.ok && r.data.role === 'Admin');
r = call('/auth/login', { login: 'Matvey', pin: '999999' });
check('неверный PIN отклонён', r.ok === false && r.status === 401, r);

console.log('\n== добавление сотрудника администратором ==');
r = call('/staff/create', { full_name: 'Иван', login: 'ivan', pin: '111111', role: 'Warehouse Staff' }, token);
check('сотрудник создан', r.ok === true && r.data.staff_id === 2, r);
r = call('/staff/create', { full_name: 'Дубль', login: 'IVAN', pin: '222222' }, token);
check('дубль логина отклонён (409)', r.ok === false && r.status === 409, r);
r = call('/staff/list', {}, token);
check('в списке 2 сотрудника', r.ok && r.data.length === 2, r.data);
check('pin_hash не утекает в /staff/list', r.ok && r.data.every(s => s.pin_hash === undefined));

console.log('\n== не-админ не может управлять сотрудниками ==');
const ivanLogin = call('/auth/login', { login: 'ivan', pin: '111111' });
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
r = call('/auth/login', { login: 'ivan', pin: '111111' });
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
r = call('/staff/create', { full_name: 'Новый', login: 'newbie', pin: '333333' }, token);
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
  { full_name: 'Пётр', login: 'petr', pin: '123412', role: 'Warehouse Staff' }, token).data.staff_id;
let petrToken = call('/auth/login', { login: 'petr', pin: '123412' }).data.token;
check('слишком короткий PIN отклонён',
  call('/staff/set-pin', { pin: '12', current_pin: '123412' }, petrToken).status === 400);
check('5-значный новый PIN отклонён',
  call('/staff/set-pin', { pin: '12345', current_pin: '123412' }, petrToken).status === 400);
check('7-значный новый PIN отклонён',
  call('/staff/set-pin', { pin: '1234567', current_pin: '123412' }, petrToken).status === 400);
check('администратор тоже не сбросит на 5 цифр',
  call('/staff/set-pin', { staff_id: petrId, pin: '12345' }, token).status === 400);
check('заводить сотрудника с 4-значным PIN нельзя',
  call('/staff/create', { full_name: 'Короткий', login: 'shortpin', pin: '1234' }, token).status === 400);
check('...и строка не появилась',
  !readRows(getSheet(SHEETS.STAFF)).some((x) => x.login === 'shortpin'));
// 403, а не 401: сессия цела, ошибся человек — иначе клиент выбросил бы его на вход
check('неверный текущий PIN отклонён, но сессия не рушится',
  call('/staff/set-pin', { pin: '555555', current_pin: '000000' }, petrToken).status === 403);
check('...и токен после этого ещё живой', call('/equipment/list', {}, petrToken).ok === true);
r = call('/staff/set-pin', { pin: '555555', current_pin: '123412' }, petrToken);
check('свой PIN сменён', r.ok === true, r);
check('взамен выдан новый токен, человек не вылетает из приложения', r.ok && !!r.data.token, r.data);
check('старый токен больше не действует', call('/equipment/list', {}, petrToken).status === 401);
check('старый PIN не пускает', call('/auth/login', { login: 'petr', pin: '123412' }).status === 401);
petrToken = call('/auth/login', { login: 'petr', pin: '555555' }).data.token;
check('новый PIN пускает', !!petrToken);

r = call('/staff/set-pin', { staff_id: petrId, pin: '777777' }, token);
check('администратор сбрасывает PIN сотруднику без текущего PIN', r.ok === true, r);
check('сессия сотрудника при сбросе обнуляется', call('/equipment/list', {}, petrToken).status === 401);
petrToken = call('/auth/login', { login: 'petr', pin: '777777' }).data.token;
check('сотрудник склада не может менять PIN другому',
  call('/staff/set-pin', { staff_id: 1, pin: '999999' }, petrToken).status === 403);

console.log('\n== защита от перебора PIN ==');
for (let i = 0; i < 5; i++) call('/auth/login', { login: 'petr', pin: '000000' });
r = call('/auth/login', { login: 'petr', pin: '777777' });
check('после 5 промахов не пускает даже верный PIN', r.ok === false && r.status === 429, r);
const petrRow = () => readRows(getSheet(SHEETS.STAFF)).filter(x => x.login === 'petr')[0];
updateRow(getSheet(SHEETS.STAFF), petrRow().__row,
  { locked_until: new Date(Date.now() - 1000).toISOString() });
r = call('/auth/login', { login: 'petr', pin: '777777' });
check('когда блокировка истекла, вход снова работает', r.ok === true, r);
check('счётчик промахов обнулён удачным входом', Number(petrRow().failed_attempts || 0) === 0,
  petrRow().failed_attempts);

console.log('\n== справочник категорий живёт в таблице ==');
const catSheet = getSheet(SHEETS.CATEGORIES);
check('лист категорий засеян умолчаниями', readRows(catSheet).length === 15,
  readRows(catSheet).map(c => c.code));
check('CBL и TRN засеяны: кабели количеством, транспортировка поштучно',
  categoryNum('CBL') === '15' && categoryNum('TRN') === '16' &&
  categoryByQty('CBL') === true && categoryByQty('TRN') === false,
  readRows(catSheet).filter(c => c.code === 'CBL' || c.code === 'TRN'));
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
check('категории приходят вместе с настройками', cfg.data.categories.length === 15);
// Кнопка «Создать недостающие вкладки»: видна, только пока таблица отстаёт
// от схемы в коде.
check('после setupSheets таблица не отстаёт — кнопку не показываем',
  cfg.data.maintenance.schema_outdated === false, cfg.data.maintenance);
metaSet('schema_sig', '');
check('отметки нет (таблица заведена до неё) — кнопку показываем',
  call('/settings/get', {}, token).data.maintenance.schema_outdated === true);
SCHEMA.__probe = ['x'];
metaSet('schema_sig', schemaSignature());
delete SCHEMA.__probe;
check('в схеме появилась вкладка или колонка — кнопку показываем',
  call('/settings/get', {}, token).data.maintenance.schema_outdated === true);
check('/maintenance setup ставит отметку — кнопка уходит',
  call('/maintenance', { action: 'setup' }, token).ok === true &&
  call('/settings/get', {}, token).data.maintenance.schema_outdated === false);
// Отдельная учётка: повторный вход аннулирует прежний токен, и войди мы здесь
// под администратором — сломали бы сессию, которой пользуются проверки ниже.
call('/staff/create', { full_name: 'Проба', login: 'probe', pin: '987698', role: 'Warehouse Staff' }, token);
const probeLogin = call('/auth/login', { login: 'probe', pin: '987698' });
check('настройки и категории приезжают уже при входе',
  !!probeLogin.data.settings && !!probeLogin.data.categories, probeLogin.data);
const probeToken = probeLogin.data.token;
check('повторный вход выкидывает прежнюю сессию',
  !!call('/auth/login', { login: 'probe', pin: '987698' }).data.token &&
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
check('номер выдан следующий свободный (17)', r.ok && r.data.num === '17', r.data);
check('дубль кода отклонён',
  call('/category/create', { code: 'BAT', label: 'Ещё раз' }, token).status === 409);
check('кривой код отклонён',
  call('/category/create', { code: 'X', label: 'Короткий' }, token).status === 400);
r = call('/category/create', { code: 'GEL', label: 'Гели и скотч', by_qty: true }, token);
check('новую категорию можно сразу завести количеством', r.ok === true && r.data.by_qty === true, r.data);
r = call('/category/update', { code: 'BAT', label: 'Аккумуляторы и зарядки' }, token);
check('название меняется свободно', r.ok === true, r);
r = call('/category/update', { code: 'BAT', num: 19 }, token);
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
  { full_name: 'Игорь Уволенный', login: 'igor', pin: '121212', role: 'Warehouse Staff' }, token).data;
const victimToken = call('/auth/login', { login: 'igor', pin: '121212' }).data.token;
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
check('войти под удалённым нельзя', call('/auth/login', { login: 'igor', pin: '121212' }).status === 401);
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
r = call('/maintenance', { action: 'setup' }, token);
check('создание недостающих вкладок через эндпоинт безопасно при повторе',
  r.ok === true && /Готово/.test(r.data.message) && spreadsheet.getSheets().length === 17, r);
check('сотрудник склада вкладки не заводит',
  call('/maintenance', { action: 'setup' }, ivanToken).status === 401);
r = call('/maintenance', { action: 'archive' }, token);
check('выгрузка через эндпоинт работает', r.ok === true && /выгружен|пуст/.test(r.data.message), r);
// Проверки выше со складским токеном получают 401 — его сессия к этому месту
// уже недействительна. Здесь — живая сессия без прав администратора.
call('/staff/create', { full_name: 'Склад Обслуживание', login: 'maint', pin: '246824', role: 'Warehouse Staff' }, token);
const maintToken = call('/auth/login', { login: 'maint', pin: '246824' }).data.token;
check('живая сессия склада: обслуживание — 403',
  call('/maintenance', { action: 'archive' }, maintToken).status === 403);
check('живая сессия склада: неизвестное действие — тоже 403, права проверяются первыми',
  call('/maintenance', { action: 'drop-everything' }, maintToken).status === 403);
check('администратор: пустое действие — 400',
  call('/maintenance', {}, token).status === 400);

console.log('\n== номера: счётчик, дубли, отчёт ==');
{
  const eqSheet = getSheet(SHEETS.EQUIPMENT);
  const metaOf = (key) => readRows(getSheet(SHEETS.META)).filter(m => String(m.key) === key)[0];
  // Чистая таблица: отчёт пуст (дальше портим её по одному виду за раз).
  r = call('/maintenance', { action: 'ids' }, token);
  check('отчёт по номерам: чистые данные — пустой список',
    r.ok === true && r.data.total === 0 && r.data.problems.length === 0, r);

  const n1 = call('/item/create', { category: 'CAM', model_name: 'Номера Тест', serial_number: 'NUM-A' }, token).data.item_id;
  const n2 = call('/item/create', { category: 'CAM', model_name: 'Номера Тест', serial_number: 'NUM-B' }, token).data.item_id;
  const nPrefix = n1.slice(0, 4);
  check('номера идут подряд', Number(n2.slice(4)) === Number(n1.slice(4)) + 1, [n1, n2]);

  // Счётчик потерялся (стёрт вручную): новый номер не должен совпасть с занятым.
  updateRow(getSheet(SHEETS.META), metaOf('unit_' + nPrefix).__row, { value: 0 });
  r = call('/maintenance', { action: 'ids' }, token);
  check('отчёт: счётчик ниже существующего номера',
    r.data.counts.counter_behind === 1 && r.data.problems[0].kind === 'counter_behind', r.data);
  const n3 = call('/item/create', { category: 'CAM', model_name: 'Номера Тест' }, token).data.item_id;
  check('счётчик отстал — новый номер пропускает занятые',
    Number(n3.slice(4)) === Number(n2.slice(4)) + 1 && n3 !== n1 && n3 !== n2, [n1, n2, n3]);
  check('счётчик догнан', Number(metaOf('unit_' + nPrefix).value) === Number(n3.slice(4)));

  // Серийник: повтор — 409, номер при отказе не сжигается.
  const counterBefore = Number(metaOf('unit_' + nPrefix).value);
  r = call('/item/create', { category: 'CAM', model_name: 'Номера Тест', serial_number: ' num-a ' }, token);
  check('создание с чужим серийником — 409', r.status === 409 && /заводской/.test(r.error), r);
  check('при отказе по серийнику счётчик не сдвинулся',
    Number(metaOf('unit_' + nPrefix).value) === counterBefore);

  // Занятый номер: подсовываем счётчик, который выдал бы n1, — запись отклонена.
  const realNext = global.nextUnitNumber;
  global.nextUnitNumber = () => Number(n1.slice(4));
  const rowsBefore = eqSheet.getLastRow();
  r = call('/item/create', { category: 'CAM', model_name: 'Номера Тест' }, token);
  global.nextUnitNumber = realNext;
  check('создание с уже занятым item_id — 409', r.status === 409 && /занят/.test(r.error), r);
  check('занятый номер не записан', eqSheet.getLastRow() === rowsBefore);

  r = call('/maintenance', { action: 'ids' }, token);
  check('после правок отчёт снова чист', r.data.total === 0, r.data);

  // Испорченные данные: по одному каждого вида.
  const hdr = sheetHeaders(eqSheet);
  const col = (name) => hdr.indexOf(name) + 1;
  const rowOf = (id) => readRows(eqSheet).filter(x => itemIdDigits(x.item_id) === id)[0].__row;
  const rA = rowOf(n1), rB = rowOf(n2);
  // 1. дубль номера: у второй вещи номер первой
  eqSheet.getRange(rB, col('item_id'), 1, 1).setValues([[n1]]);
  // 2. дубль серийника у третьей вещи
  eqSheet.getRange(rowOf(n3), col('serial_number'), 1, 1).setValues([['NUM-A']]);
  r = call('/maintenance', { action: 'ids' }, token);
  const kinds = r.data.problems.map(p => p.kind).sort();
  check('отчёт: дубль номера находит обе строки',
    r.data.problems.some(p => p.kind === 'duplicate_id' && p.item_id === n1 &&
      p.rows.length === 2 && p.rows.indexOf(rA) >= 0 && p.rows.indexOf(rB) >= 0 &&
      p.detail.indexOf('Дубль номера ' + n1 + ': строки ') === 0), r.data);
  check('отчёт: дубль серийника', r.data.counts.duplicate_serial === 1, r.data);
  eqSheet.getRange(rB, col('item_id'), 1, 1).setValues([[n2]]);
  eqSheet.getRange(rowOf(n3), col('serial_number'), 1, 1).setValues([['']]);

  // 3. потерянный ведущий ноль: число вместо строки
  eqSheet.getRange(rB, col('item_id'), 1, 1).setValues([[Number(n2)]]);
  r = call('/maintenance', { action: 'ids' }, token);
  check('отчёт: номер числом (потерян ноль)',
    r.data.problems.some(p => p.kind === 'bad_id' && p.row === rB && /ведущий ноль/.test(p.detail)), r.data);
  check('отчёт: число — это тот же номер, дублем и расхождением префикса не считается',
    !r.data.counts.duplicate_id && !r.data.counts.prefix_mismatch, r.data);
  // 4. не шесть цифр
  eqSheet.getRange(rB, col('item_id'), 1, 1).setValues([['AB12']]);
  r = call('/maintenance', { action: 'ids' }, token);
  check('отчёт: номер не из шести цифр',
    r.data.problems.some(p => p.kind === 'bad_id' && p.row === rB && /не шесть цифр/.test(p.detail)), r.data);
  // 5. префикс не по категории и модели
  eqSheet.getRange(rB, col('item_id'), 1, 1).setValues([['990101']]);
  r = call('/maintenance', { action: 'ids' }, token);
  check('отчёт: префикс не совпадает с категорией и моделью',
    r.data.problems.some(p => p.kind === 'prefix_mismatch' && p.item_id === '990101' && p.row === rB), r.data);
  eqSheet.getRange(rB, col('item_id'), 1, 1).setValues([[n2]]);

  r = call('/maintenance', { action: 'ids' }, token);
  check('исправили руками — отчёт чист', r.data.total === 0, r.data);

  // Ночной прогон молчит, пока всё в порядке, и пишет одну строку, когда нет.
  // Копию и подрезку глушим: этот прогон проверяет только сверку номеров.
  const realSteps = [global.dailyBackup, global.trimArchive, global.trimLogs];
  global.dailyBackup = () => ''; global.trimArchive = () => ''; global.trimLogs = () => '';
  dailyMaintenance();
  check('ночью при чистых номерах в Logs ничего не пишется',
    readRows(getSheet(SHEETS.LOGS)).filter(l => l.endpoint === 'itemNumbers').length === 0);
  eqSheet.getRange(rB, col('item_id'), 1, 1).setValues([[n1]]);
  dailyMaintenance();
  const nightLogs = readRows(getSheet(SHEETS.LOGS)).filter(l => l.endpoint === 'itemNumbers');
  check('ночью при дубле в Logs одна сводная строка', nightLogs.length === 1, nightLogs);
  eqSheet.getRange(rB, col('item_id'), 1, 1).setValues([[n2]]);
  [global.dailyBackup, global.trimArchive, global.trimLogs] = realSteps;

  check('сотрудник склада номера не сверяет — 401',
    call('/maintenance', { action: 'ids' }, ivanToken).status === 401);
  check('живая сессия склада: сверка номеров — 403',
    call('/maintenance', { action: 'ids' }, maintToken).status === 403);
}

console.log('\n== настройки: память в пределах запроса ==');
{
  const realReadRows = global.readRows, realGetSettings = global.getSettings;
  let metaReads = 0;
  global.readRows = function (sheet) {
    if (sheet && sheet.getName && sheet.getName() === SHEETS.META) metaReads++;
    return realReadRows.apply(this, arguments);
  };
  call('/students/list', {}, token);
  check('проверка сессии читает Meta один раз, а не по разу на настройку', metaReads === 1, metaReads);
  metaReads = 0;
  call('/settings/get', {}, token);
  const settingsGetReads = metaReads;
  metaReads = 0;
  global.getSettings = ((real) => function () { real(); return real.apply(this, arguments); })(getSettings);
  call('/settings/get', {}, token);
  check('повторный getSettings в том же запросе берёт из памяти', metaReads === settingsGetReads, [metaReads, settingsGetReads]);
  global.readRows = realReadRows;
  global.getSettings = realGetSettings;
}
const ttlBefore = getSettings().session_ttl_hours;
metaSet('setting_session_ttl_hours', ttlBefore + 1);
check('metaSet сбрасывает память и вне doPost', getSettings().session_ttl_hours === ttlBefore + 1);
r = call('/settings/set', { settings: { session_ttl_hours: ttlBefore + 2 } }, token);
check('/settings/set возвращает новое значение', r.ok && r.data.settings.session_ttl_hours === ttlBefore + 2, r);
check('следующий /settings/get в том же процессе видит новое значение',
  call('/settings/get', {}, token).data.settings.session_ttl_hours === ttlBefore + 2);
const ttlRow = readRows(getSheet(SHEETS.META)).filter((m) => m.key === 'setting_session_ttl_hours')[0];
updateRow(getSheet(SHEETS.META), ttlRow.__row, { value: ttlBefore + 3 });
check('правка Meta руками между запросами видна следующему запросу',
  call('/settings/get', {}, token).data.settings.session_ttl_hours === ttlBefore + 3);
call('/settings/set', { settings: { session_ttl_hours: ttlBefore } }, token);
check('getSettings отдаёт копию — правка результата память не портит',
  (() => { const s = getSettings(); s.session_ttl_hours = -1; return getSettings().session_ttl_hours === ttlBefore; })());


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
const ownerLogin = call('/auth/login', { login: 'matvey', pin: '432143' }).data;
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
call('/staff/create', { full_name: 'Первый', login: 'one', pin: '111111' }, ownerToken);
call('/staff/create', { full_name: 'Второй', login: 'two', pin: '222222' }, ownerToken);
call('/staff/create', { full_name: 'Третий', login: 'three', pin: '333333' }, ownerToken);
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
const oneToken = call('/auth/login', { login: 'one', pin: '111111' }).data.token;
check('обычный админ сотрудников не заводит',
  call('/staff/create', { full_name: 'Никто', login: 'nobody', pin: '555555' }, oneToken).status === 403);
check('обычный админ сотрудников не удаляет',
  call('/staff/delete', { staff_id: 3 }, oneToken).status === 403);
check('обычный админ не сбрасывает PIN главному',
  call('/staff/set-pin', { staff_id: 1, pin: '999999' }, oneToken).status === 409);
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
  call('/staff/create', { full_name: 'Никто', login: 'nobody', pin: '555555' }, ownerToken).status === 403);
const threeToken = call('/auth/login', { login: 'three', pin: '333333' }).data.token;
check('новый главный сотрудников заводит',
  call('/staff/create', { full_name: 'Новичок', login: 'rookie', pin: '666666' }, threeToken).ok === true);
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
check('в ответе все категории справочника, и пустые тоже, без лишних полей',
  pub.ok && Array.isArray(pub.data.categories) && pub.data.categories.length === categories().length &&
  categories().every(c => pub.data.categories.some(x => x.code === c.code && x.label === c.label)) &&
  pub.data.categories.every(c => Object.keys(c).sort().join() === 'code,label') &&
  pub.data.categories.some(c => !pub.data.models.some(m => m.category === c.code)),
  pub.ok && pub.data.categories);
check('категории отсортированы по названию',
  pub.ok && pub.data.categories.every((c, i, a) => !i || String(a[i - 1].label).localeCompare(String(c.label), 'ru') <= 0));
// Звук только в «Кино» (решение владельца 7 октября 2026): и неразмеченный, и
// ошибочно отмеченный «Фото».
{
  const mSheet = getSheet(SHEETS.MODELS);
  const audRows = readRows(mSheet).filter(r => r.category === 'AUD');
  const audKeys = audRows.map(r => 'AUD-' + pad2(Number(r.model_code)));
  if (audRows.length) updateRow(mSheet, audRows[0].__row, { section: 'PHOTO' });
  const audPub = call('/public/catalog', { from: '2026-03-04', to: '2026-03-05' }).data.models.filter(m => m.category === 'AUD');
  check('звук на сайте только в «Кино», отметка модели не важна',
    audPub.length > 0 && audPub.every(m => m.section === 'CINE'), { audKeys, audPub });
  if (audRows.length) updateRow(mSheet, audRows[0].__row, { section: audRows[0].section || '' });
}
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
spreadsheet.getSheetByName('ImportRules').appendRow(['GRP', 'name', 'гойда', 'тест']);
IMPORT_CONFIG = null;
check('добавленное в таблицу правило работает сразу',
      importCategory('', '', 'Ковёр гойда') === 'GRP', importCategory('', '', 'Ковёр гойда'));
spreadsheet.getSheetByName('ImportRules').deleteRow(spreadsheet.getSheetByName('ImportRules').getLastRow());
IMPORT_CONFIG = null;

console.log('\n== самозагрузка первого администратора закрыта навсегда ==');
// Раньше защита держалась на «в Staff есть строки»: почистив лист, кто угодно
// снова стал бы администратором без пароля.
const staffSheet = getSheet(SHEETS.STAFF);
staffSheet.getRange(2, 1, staffSheet.getLastRow() - 1, staffSheet.getLastColumn()).clearContent();
check('лист Staff пуст', readRows(staffSheet).length === 0, readRows(staffSheet).length);
r = call('/staff/create', { full_name: 'Чужой', login: 'intruder', pin: '000000' });
check('на пустом Staff администратора без токена не создать', r.ok === false && r.status === 403, r);
check('в отказе сказано, как владелец таблицы вернёт доступ',
  /bootstrap_done/.test(String(r.error)), r.error);

const flagRow = readRows(getSheet(SHEETS.META)).filter(m => m.key === 'bootstrap_done')[0];
check('отметка bootstrap_done стоит в Meta', !!flagRow, flagRow);
updateRow(getSheet(SHEETS.META), flagRow.__row, { key: '', value: '' });
r = call('/staff/create', { full_name: 'Матвей', login: 'matvey', pin: '432143' });
check('после удаления отметки вручную самозагрузка снова доступна', r.ok === true, r);

console.log('\n== перенос модели в другую категорию ==');
// Номер вещи начинается с номера категории, поэтому переносим с перенумерацией.
// Главное, что здесь проверяется: у вещи не отвязывается история — на номер
// ссылаются журнал выдач, дефекты и сверки.
const mvLogin = call('/auth/login', { login: 'matvey', pin: '432143' });
const mvToken = mvLogin.ok ? mvLogin.data.token : null;
check('вход перед переносом', mvLogin.ok === true, mvLogin);

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
  full_name: 'Складмен Переноса', login: 'movecheck', pin: '555555', role: 'Warehouse Staff',
}, mvToken);
check('сотрудник склада для проверки прав заведён', mvStaffNew.ok === true, mvStaffNew);
const mvStaffLogin = call('/auth/login', { login: 'movecheck', pin: '555555' });
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

console.log('-- строки заказов идут за моделью --');
// Состав заказа ссылается на модель кодом: без переписи строка заказа после
// переноса указала бы на пустое место (или на чужую модель с тем же кодом).
mv = call('/item/create', { category: 'CAM', model_name: 'Строка Тест', serial_number: 'L1' }, mvToken);
const mvLineCode = mv.ok ? mv.data.item_id.slice(2, 4) : null;
appendRow(getSheet(SHEETS.ORDER_ITEMS), { order_id: 900901, line_no: 1, raw_name: 'Строка Тест',
                                          model_code: mvLineCode, category: 'CAM', qty: 1 });
mv = call('/model/move', { category: 'CAM', model_code: mvLineCode, to_category: 'LEN' }, mvToken);
const mvLine = readRows(getSheet(SHEETS.ORDER_ITEMS)).filter(l => String(l.order_id) === '900901')[0];
check('перенос переписал строку заказа на новую категорию и код',
  mv.ok === true && mv.data.order_lines === 1 && mvLine.category === 'LEN' &&
  String(mvLine.model_code) === mv.data.model_code, [mv.data, mvLine]);

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
const labelLogin = call('/auth/login', { login: 'matvey', pin: '432143' });
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
const numLogin = call('/auth/login', { login: 'matvey', pin: '432143' });
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
  full_name: 'Складмен Номеров', login: 'numcheck', pin: '777777', role: 'Warehouse Staff',
}, numToken);
check('сотрудник склада для проверки прав заведён', numStaff.ok === true, numStaff);
const numStaffLogin = call('/auth/login', { login: 'numcheck', pin: '777777' });
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
// Решение владельца 10 октября 2026: название принадлежит модели, поэтому правка
// названия одной вещи идёт на всю модель и без галочки.
check('без галочки название всё равно уходит на соседнюю вещь модели',
  readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => String(r.item_id) === numOther)[0].name === 'Номерная Тест (Б)');
check('без галочки справочник моделей переименован вместе с вещью',
  readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'CAM' && r.model_name === 'Номерная Тест (Б)') &&
  !readRows(getSheet(SHEETS.MODELS)).some(r => r.category === 'CAM' && r.model_name === 'Номерная Тест'));

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
  full_name: 'Админ Правки', login: 'updadmin', pin: '888888', role: 'Admin',
}, numToken);
check('обычный администратор заведён', updAdmin.ok === true, updAdmin);
const updOne = call('/auth/login', { login: 'updadmin', pin: '888888' });
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
const secLogin = call('/auth/login', { login: 'matvey', pin: '432143' });
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
  models: [{ category: 'CAM', model_code: secCode, section: '#кино #Фото' }],
}, secToken);
check('хэштеги #кино #фото понимаются как CINE,PHOTO', sec.ok === true &&
  call('/models/list', { category: 'CAM' }, secToken).data
    .filter(m => m.model_code === secCode)[0].section === 'CINE,PHOTO', sec);
check('хэштег в таблице руками читается так же', normalizeSection('#фото') === 'PHOTO' &&
  normalizeSection('кино; #ФОТО') === 'CINE,PHOTO');
call('/models/sections', { models: [{ category: 'CAM', model_code: secCode, section: 'PHOTO' }] }, secToken);

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
  full_name: 'Складмен Разделов', login: 'seccheck', pin: '888888', role: 'Warehouse Staff',
}, secToken);
check('сотрудник склада заведён', secStaff.ok === true, secStaff);
const secStaffLogin = call('/auth/login', { login: 'seccheck', pin: '888888' });
sec = call('/models/sections', { models: [{ category: 'CAM', model_code: secCode, section: 'CINE' }] },
           secStaffLogin.ok ? secStaffLogin.data.token : 'нет-токена');
check('сотруднику склада разметка запрещена', sec.ok === false && sec.status === 403, sec);

// Публичный каталог отдаёт раздел — из него он попадает в снимок сайта.
const secPublic = call('/public/catalog', {});
check('публичный каталог отдаёт раздел',
  secPublic.ok === true && secPublic.data.models.every(m => 'section' in m),
  secPublic.ok ? secPublic.data.models[0] : secPublic);

console.log('\n== фото модели: колонка photo и превью ==');
const phSheet = getSheet(SHEETS.MODELS);
const phRow = readRows(phSheet).filter(r => pad2(Number(r.model_code)) === secCode && r.category === 'CAM')[0];
const phCol = () => sheetHeaders(phSheet).indexOf('photo') + 1;
check('photo есть в схеме Models', SCHEMA.Models.indexOf('photo') !== -1);
phSheet.getRange(phRow.__row, phCol(), 1, 1).setValues([['  https://example.com/a.jpg  ']]);
const phModel = () => call('/public/catalog', {}).data.models
  .filter(m => m.category === 'CAM' && m.model_code === secCode)[0];
check('публичный каталог отдаёт photo обрезанным', phModel() && phModel().photo === 'https://example.com/a.jpg', phModel());
check('у модели без ссылки photo пустой', call('/public/catalog', {}).data.models.every(m => typeof m.photo === 'string'));
check('/models/list отдаёт photo',
  call('/models/list', { category: 'CAM' }, secToken).data.filter(m => m.model_code === secCode)[0].photo === 'https://example.com/a.jpg');
['http://example.com/a.jpg', 'ftp://x/a.jpg', 'javascript:alert(1)', 'просто текст', 'https://a b/c.jpg'].forEach((bad) => {
  phSheet.getRange(phRow.__row, phCol(), 1, 1).setValues([[bad]]);
  check('не-https отброшено: ' + bad, phModel().photo === '', phModel());
});
phSheet.getRange(phRow.__row, phCol(), 1, 1).setValues([['https://example.com/a.jpg']]);

// Старый лист: колонки photo нет вовсе.
{
  const ph = phCol() - 1;
  phSheet.data.forEach(r => r.splice(ph, 1));
  check('старый лист без photo читается', phModel().photo === '', phModel());
  const msg = setupPhotoPreview();
  check('photo создана на старом листе', phCol() > 0 && sheetHeaders(phSheet).indexOf('photo_preview') > 0, sheetHeaders(phSheet));
  check('отчёт по-русски', /Превью фото/.test(msg), msg);
  phSheet.getRange(phRow.__row, phCol(), 1, 1).setValues([['https://example.com/a.jpg']]);
}
const phSnap = () => JSON.stringify(phSheet.data.map(r => r.filter((c, i) => sheetHeaders(phSheet)[i] !== 'photo_preview')));
setupPhotoPreview();
const phPrevCol = sheetHeaders(phSheet).indexOf('photo_preview') + 1;
const phFormula = () => phSheet.getRange(phRow.__row, phPrevCol, 1, 1).getFormulas()[0][0];
const phLetter = columnLetter(phCol());
check('формула превью в строке модели',
  phFormula() === '=IF(' + phLetter + phRow.__row + '="","",IMAGE(' + phLetter + phRow.__row + ',1))', phFormula());
const phBefore = JSON.stringify(phSheet.data), phOther = phSnap();
const phMsg = setupPhotoPreview();
check('setupPhotoPreview идемпотентна', JSON.stringify(phSheet.data) === phBefore && /формул записано 0/.test(phMsg), phMsg);
check('остальные колонки не тронуты', phSnap() === phOther);
check('photo_preview не попадает в ответы',
  call('/models/list', { category: 'CAM' }, secToken).data.every(m => !('photo_preview' in m)) &&
  call('/public/catalog', {}).data.models.every(m => !('photo_preview' in m)));
// Записи в Models с лишними колонками работают, формула переживает updateRow.
check('разметка при колонках превью', call('/models/sections', { models: [{ category: 'CAM', model_code: secCode, section: 'CINE' }] }, secToken).data.changed === 1);
check('цена при колонках превью', call('/models/price', { category: 'CAM', model_code: secCode, price: 1234 }, secToken).ok === true);
check('формула превью пережила updateRow', phFormula().indexOf('IMAGE(') > 0, phFormula());
check('photo пережила updateRow', phModel().photo === 'https://example.com/a.jpg', phModel());
const phNew = call('/item/create', { category: 'CAM', model_name: 'Фото Новая Модель' }, secToken);
check('новая модель создаётся при колонках превью', phNew.ok === true, phNew);
check('у новой строки превью пусто до повторного запуска',
  phSheet.getRange(phSheet.getLastRow(), phPrevCol, 1, 1).getFormulas()[0][0] === '');
setupPhotoPreview();
check('повторный запуск добавляет превью новой строке',
  phSheet.getRange(phSheet.getLastRow(), phPrevCol, 1, 1).getFormulas()[0][0].indexOf('IMAGE(') > 0);
phSheet.getRange(phRow.__row, phCol(), 1, 1).setValues([['']]);

console.log('\n== админская правка модели: название и фото ==');
{
  const adm = secToken;
  call('/staff/create', { full_name: 'Склад Правка', login: 'modeledit', pin: '246802', role: 'Warehouse Staff' }, adm);
  const staff = call('/auth/login', { login: 'modeledit', pin: '246802' }).data.token;
  const mk = (n) => call('/item/create', { category: 'CAM', model_name: n }, adm).data.item_id.slice(2, 4);
  const cA = mk('Редакт Альфа'), cB = mk('Редакт Бета');
  const eqNames = (c) => readRows(getSheet(SHEETS.EQUIPMENT))
    .filter(r => r.category === 'CAM' && pad2(Number(r.model_code)) === c).map(r => r.name);
  const mrow = (c) => readRows(getSheet(SHEETS.MODELS)).filter(r => r.category === 'CAM' && pad2(Number(r.model_code)) === c)[0];

  check('переименование: сотруднику 403',
    call('/models/rename', { category: 'CAM', model_code: cA, model_name: 'Икс' }, staff).status === 403);
  check('/model/create: сотруднику 403',
    call('/model/create', { category: 'CAM', model_name: 'Модель Складмена' }, staff).status === 403);
  check('/model/create: администратору можно',
    call('/model/create', { category: 'CAM', model_name: 'Модель Админа' }, adm).ok === true);
  check('фото: сотруднику 403',
    call('/models/photo', { category: 'CAM', model_code: cA, image: '' }, staff).status === 403);
  let rn = call('/models/rename', { category: 'CAM', model_code: cA, model_name: '  Zenit   60mm ' }, adm);
  check('имя хранится как набрано', rn.ok && rn.data.model_name === 'Zenit 60mm' && mrow(cA).model_name === 'Zenit 60mm', rn);
  check('вещи модели переименованы', eqNames(cA).every(n => n === 'Zenit 60mm') && rn.data.renamed_units >= 1, eqNames(cA));
  check('синоним даёт warning', /Zenit 60mm F2.8/.test(rn.data.warning || ''), rn.data);
  rn = call('/models/rename', { category: 'CAM', model_code: cA, model_name: 'Редакт Альфа 2' }, adm);
  check('обычное имя без warning', rn.ok && rn.data.warning === undefined, rn);
  rn = call('/models/rename', { category: 'CAM', model_code: cA, model_name: 'редакт-бета' }, adm);
  check('занятое имя — 409 с именем соседа', rn.ok === false && rn.status === 409 && /Редакт Бета/.test(rn.error), rn);
  check('при 409 ничего не записано', mrow(cA).model_name === 'Редакт Альфа 2');
  check('двоеточие отклонено', call('/models/rename', { category: 'CAM', model_code: cA, model_name: 'A: B' }, adm).status === 400);
  check('перенос строки отклонён', call('/models/rename', { category: 'CAM', model_code: cA, model_name: 'A\nB' }, adm).status === 400);
  check('пустое имя отклонено', call('/models/rename', { category: 'CAM', model_code: cA, model_name: '   ' }, adm).status === 400);
  check('длинное имя отклонено', call('/models/rename', { category: 'CAM', model_code: cA, model_name: 'x'.repeat(121) }, adm).status === 400);
  check('неизвестная модель — 404', call('/models/rename', { category: 'CAM', model_code: '98', model_name: 'Нет' }, adm).status === 404);
  rn = call('/models/rename', { category: 'CAM', model_code: cA, model_name: 'Альфа · Kit' }, adm);
  check('разделитель « · » разрешён', rn.ok === true, rn);

  const b64 = (arr) => 'data:image/jpeg;base64,' + Buffer.from(arr).toString('base64');
  const jpg = (n) => b64([0xFF, 0xD8, 0xFF, 0xE0].concat(new Array(n || 40).fill(7)));
  const folder = () => drive.folders['Mifs Rent — фото'];
  const live = () => folder().files.filter(f => !f.trashed);
  let ph = call('/models/photo', { category: 'CAM', model_code: cA, image: jpg() }, adm);
  check('фото сохранено', ph.ok && /^https:\/\/drive\.google\.com\/thumbnail\?id=file-\d+&sz=w800$/.test(ph.data.photo), ph);
  check('файл открыт по ссылке', live().length === 1 && live()[0].sharing[0] === 'ANYONE_WITH_LINK' && live()[0].sharing[1] === 'VIEW');
  check('имя файла CAT-код-метка', /^CAM-\d\d-.+\.jpg$/.test(live()[0].name), live()[0].name);
  check('ссылка в Models.photo', mrow(cA).photo === ph.data.photo);
  const pubM = () => call('/public/catalog', {}).data.models.filter(m => m.category === 'CAM' && m.model_code === cA)[0];
  check('/public/catalog: новое имя и фото', pubM() && pubM().model_name === 'Альфа · Kit' && pubM().photo === ph.data.photo, pubM());
  check('/models/list отдаёт фото', call('/models/list', { category: 'CAM' }, adm).data.filter(m => m.model_code === cA)[0].photo === ph.data.photo);

  const firstId = photoIdFromUrl(ph.data.photo);
  ph = call('/models/photo', { category: 'CAM', model_code: cA, image: jpg(60) }, adm);
  check('замена: старый файл в корзине, новый жив',
    ph.ok && folder().files.filter(f => f.id === firstId)[0].trashed === true && live().length === 1, ph);

  check('не картинка отклонена',
    call('/models/photo', { category: 'CAM', model_code: cA, image: b64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) }, adm).status === 400);
  check('не data URL отклонён', call('/models/photo', { category: 'CAM', model_code: cA, image: 'https://x.y/a.jpg' }, adm).status === 400);
  check('слишком большое отклонено',
    call('/models/photo', { category: 'CAM', model_code: cA, image: jpg(701 * 1024) }, adm).status === 413);
  check('неизвестная модель — 404, файл не создан',
    call('/models/photo', { category: 'CAM', model_code: '98', image: jpg() }, adm).status === 404 && live().length === 1);
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0]).toString('base64');
  check('PNG принят', call('/models/photo', { category: 'CAM', model_code: cB, image: png }, adm).ok === true);

  // Чужой файл: ссылка в ячейке на то, чего нет в папке фото.
  const outsider = { name: 'чужой', id: 'file-outside', trashed: false };
  drive.folders['Чужая папка'] = { name: 'Чужая папка', files: [outsider] };
  getSheet(SHEETS.MODELS).getRange(mrow(cA).__row, sheetHeaders(getSheet(SHEETS.MODELS)).indexOf('photo') + 1, 1, 1)
    .setValues([['https://drive.google.com/thumbnail?id=file-outside&sz=w800']]);
  ph = call('/models/photo', { category: 'CAM', model_code: cA, image: jpg(70) }, adm);
  check('чужой файл не тронут', ph.ok && outsider.trashed === false, ph);
  const lastId = photoIdFromUrl(ph.data.photo);

  ph = call('/models/photo', { category: 'CAM', model_code: cA, image: '' }, adm);
  check('убрать: колонка пуста, файл в корзине', ph.ok && ph.data.photo === '' && mrow(cA).photo === '' &&
    folder().files.filter(f => f.id === lastId)[0].trashed === true, ph);
  check('/public/catalog без фото', pubM().photo === '');
  const fcol = sheetHeaders(phSheet).indexOf('photo_preview') + 1;
  call('/models/photo', { category: phRow.category, model_code: pad2(Number(phRow.model_code)), image: jpg() }, adm);
  check('формула превью пережила запись фото',
    fcol > 0 && phSheet.getRange(phRow.__row, fcol, 1, 1).getFormulas()[0][0].indexOf('IMAGE(') > 0);
  call('/models/photo', { category: phRow.category, model_code: pad2(Number(phRow.model_code)), image: '' }, adm);
}

// Решение владельца 10 октября 2026: названия и разделы в приложении и на сайте
// совпадают, Models.model_name — единственный источник. После любой правки
// проверяем всё сразу, по всем моделям публичного каталога.
console.log('\n== одни названия и разделы в приложении и на сайте ==');
{
  const adm = secToken;
  const parity = (label) => {
    const pub = call('/public/catalog', {}).data.models;
    const eq = call('/equipment/list', {}, adm).data;
    const ml = call('/models/list', {}, adm).data;
    const bad = [];
    pub.forEach(m => {
      const units = eq.filter(e => e.category === m.category && e.model_code === m.model_code);
      units.forEach(u => { if (u.name !== m.model_name) bad.push(['name', m.category, m.model_code, u.name, m.model_name]); });
      const row = ml.filter(x => x.category === m.category && x.model_code === m.model_code)[0];
      if (!row) bad.push(['no /models/list', m.category, m.model_code]);
      else {
        if (row.section !== m.section) bad.push(['section', m.category, m.model_code, row.section, m.section]);
        if (row.model_name !== m.model_name) bad.push(['model_name', m.category, m.model_code, row.model_name, m.model_name]);
      }
    });
    check('совпадение имён и разделов: ' + label, pub.length > 0 && bad.length === 0, bad.slice(0, 5));
  };
  const mk = (cat, n) => call('/item/create', { category: cat, model_name: n }, adm).data;
  const unitNames = (cat, c) => readRows(getSheet(SHEETS.EQUIPMENT))
    .filter(r => r.category === cat && pad2(Number(r.model_code)) === c).map(r => r.name);
  const modelName = (cat, c) => readRows(getSheet(SHEETS.MODELS))
    .filter(r => r.category === cat && pad2(Number(r.model_code)) === c)[0].model_name;

  const p1 = mk('CAM', 'Паритет Один');
  const pc = p1.item_id.slice(2, 4);
  const second = mk('CAM', 'Паритет Один');
  parity('после создания');

  // Двойные пробелы в Models, записанные до правила, наружу не уходят.
  const mrowP = readRows(getSheet(SHEETS.MODELS)).filter(r => r.category === 'CAM' && pad2(Number(r.model_code)) === pc)[0];
  updateRow(getSheet(SHEETS.MODELS), mrowP.__row, { model_name: 'Паритет   Один' });
  check('пробелы схлопнуты в /public/catalog и /models/list',
    call('/public/catalog', {}).data.models.some(m => m.category === 'CAM' && m.model_code === pc && m.model_name === 'Паритет Один') &&
    call('/models/list', { category: 'CAM' }, adm).data.some(m => m.model_code === pc && m.model_name === 'Паритет Один'));
  updateRow(getSheet(SHEETS.MODELS), mrowP.__row, { model_name: 'Паритет Один' });

  call('/models/rename', { category: 'CAM', model_code: pc, model_name: 'Паритет Два' }, adm);
  parity('после переименования модели');

  // Правка названия одной вещи без галочки: Models и обе вещи остаются равными.
  const one = call('/item/update', { item_id: p1.item_id, name: 'Паритет Три' }, adm);
  check('имя одной вещи ушло на всю модель', one.ok && modelName('CAM', pc) === 'Паритет Три' &&
    unitNames('CAM', pc).every(n => n === 'Паритет Три') && one.data.renamed >= 1, one);
  parity('после правки имени одной вещи');

  // Рассинхрон, оставшийся от прежних версий, лечится при правке.
  const secondRow = readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => r.item_id === second.item_id)[0];
  updateRow(getSheet(SHEETS.EQUIPMENT), secondRow.__row, { name: 'Старое имя' });
  check('/equipment/list берёт имя из Models, а не из вещи',
    call('/equipment/list', {}, adm).data.filter(e => e.item_id === second.item_id)[0].name === 'Паритет Три');
  call('/item/update', { item_id: p1.item_id, name: 'Паритет Три' }, adm);
  check('повторная правка выравнивает вещи', unitNames('CAM', pc).every(n => n === 'Паритет Три'), unitNames('CAM', pc));

  // Перенос одной вещи: имя новой модели берётся из строки Models.
  const mvd = call('/item/update', { item_id: p1.item_id, category: 'LEN' }, adm);
  check('перенос одной вещи', mvd.ok && mvd.data.item.name === 'Паритет Три' &&
    mvd.data.item.category === 'LEN', mvd);
  parity('после переноса вещи');
  const mvdUnit = readRows(getSheet(SHEETS.EQUIPMENT)).filter(r => r.item_id === mvd.data.item_id)[0];
  check('имя перенесённой вещи равно имени новой модели',
    mvdUnit.name === modelName('LEN', pad2(Number(mvdUnit.model_code))), mvdUnit);

  // Раздел: звук в обоих списках «Кино».
  const aud = mk('AUD', 'Паритет Звук');
  const audC = aud.item_id.slice(2, 4);
  call('/models/sections', { models: [{ category: 'AUD', model_code: audC, section: 'PHOTO' }] }, adm);
  const audList = call('/models/list', { category: 'AUD' }, adm).data.filter(m => m.model_code === audC)[0];
  check('/models/list: звук в «Кино» при отметке «Фото»', audList && audList.section === 'CINE', audList);
  parity('после смены раздела');

  check('/models/list отдаёт список без служебных полей',
    call('/models/list', {}, adm).data.every(m => !('category_label' in m)));
}

console.log('\n== заявка с сайта ==');
const siteAdmin = call('/auth/login', { login: 'Matvey', pin: '432143' }).data.token;
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
check('заголовок с номером, через строку состав', /^<b>📦 Заказ №270101-0001<\/b>\n\n1\. /.test(tgm.text), tgm.text);
check('строка позиции: сумма и (кол-во x цена)',
  tgm.text.indexOf('1. ' + siteCat.model_name + ': 77000 (2 x 38500)') !== -1, tgm.text);
check('нулевая цена печатается как у Tilda',
  tgm.text.indexOf('2. Бесплатная вещь: 0 (1 x 0.00)') !== -1, tgm.text);
check('сумма — по строкам, жирным', /\n<b>Сумма: 77000 RUB<\/b>\n/.test(tgm.text), tgm.text);
check('блок покупателя для взрослого: ФИО, телефон, ник',
  /<b>👤 Покупатель<\/b>\nТестов Тест Тестович\nТелефон: \+70000000000\nTelegram: @testov/.test(tgm.text), tgm.text);
check('приём и сдача со временем', /\n\n<b>📅 Сроки<\/b>\nПрием: 2026-10-01 10:00\nСдача: 2026-10-05 18:00\n\n<b>🎬 Съёмка<\/b>\n/.test(tgm.text), tgm.text);
check('проект отдельной строкой', /Проект: курсовая/.test(tgm.text), tgm.text);
check('без Input строк мастерской, комментария и адреса нет',
  !/Мастерская:|Комментарий:|Адрес:/.test(tgm.text), tgm.text);

// Input с сайта: мастерская, комментарий и адрес — каждый своей строкой, по
// образцу владельца. Точка внутри комментария строку не рвёт.
so = call('/public/order', { raw_text: botOrderText('270101-0011', [
  '1. ' + siteCat.model_name + ': 100 (1 x 100)',
], adultBuyer.concat(['Input: Мастерская: оператор. Комментарий: Доп. алекса и прочие понты. Адрес: Москва, ул. Примерная 1'])) });
tgm = siteTg();
check('мастерская, комментарий и адрес — по строке, в порядке образца',
  /<b>🎬 Съёмка<\/b>\nПроект: курсовая\nМастерская: оператор\nКомментарий: Доп\. алекса и прочие понты\nАдрес: Москва, ул\. Примерная 1\n/.test(tgm.text), tgm.text);
check('Input без меток — комментарием', splitExtraInput('просто текст')['Комментарий'] === 'просто текст');
check('старый Input «Мастерская: …» без адреса',
  JSON.stringify(splitExtraInput('Мастерская: звук, 2 курс')) === JSON.stringify({ 'Мастерская': 'звук, 2 курс' }));
check('ссылка на сайт из site_url, экранированная',
  tgm.text.indexOf('\n\n<a href="https://example.test/site?a=1&amp;b=2">Сделать заказ</a>') !== -1, tgm.text);

// Несовершеннолетний: представитель, затем сам арендатор.
so = call('/public/order', { raw_text: botOrderText('270101-0002', [
  '1. ' + siteCat.model_name + ': 100 (1 x 100)',
], ['Are_you_an_adult: Нет', 'Full_name_guardian: Опекунов Опекун Опекунович',
  'Phone_guardian: +70000000001', 'Full_name_minor: Юнов Юн Юнович',
  'Phone_minors: +70000000002', 'Telegram_Minors: @yunov']) });
tgm = siteTg();
check('блок покупателя для несовершеннолетнего',
  /<b>👤 Покупатель<\/b>\nПредставитель: Опекунов Опекун Опекунович\nТелефон представителя: \+70000000001\nНесовершеннолетний: Юнов Юн Юнович\nТелефон: \+70000000002\nTelegram: @yunov/.test(tgm.text), tgm.text);

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
check('без site_url ссылки нет', !/<a href|Сделать заказ/.test(tgm.text), tgm.text);

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
const pinAdmin = call('/auth/login', { login: 'Matvey', pin: '432143' }).data.token;

// Одинаковый PIN у двух человек не должен давать одинаковую строку: иначе по
// таблице видно, у кого код совпадает, и один перебор вскрывает обоих.
call('/staff/create', { full_name: 'Первый', login: 'pin_a', pin: '515051', role: 'Warehouse Staff' }, pinAdmin);
call('/staff/create', { full_name: 'Второй', login: 'pin_b', pin: '515051', role: 'Warehouse Staff' }, pinAdmin);
const pinRows = dumpSheet('Staff');
const loginCol = SCHEMA.Staff.indexOf('login');
const rowA = pinRows.filter((x) => x[loginCol] === 'pin_a')[0];
const rowB = pinRows.filter((x) => x[loginCol] === 'pin_b')[0];
check('одинаковый PIN — разные строки в таблице',
  rowA && rowB && rowA[pinCol] !== rowB[pinCol], [rowA && rowA[pinCol], rowB && rowB[pinCol]]);
check('оба входят со своим PIN',
  call('/auth/login', { login: 'pin_a', pin: '515051' }).ok === true &&
  call('/auth/login', { login: 'pin_b', pin: '515051' }).ok === true);

// В живой таблице PIN лежат в прежнем виде — и часто из четырёх цифр: правило
// «ровно 6» действует только для нового PIN. Вход по старому обязан работать
// и обязан тут же переписать запись по-новому.
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
const legacyToken = call('/auth/login', { login: 'pin_a', pin: '5150' }).data.token;
check('старый 4-значный PIN годится как текущий при смене на 6 цифр',
  call('/staff/set-pin', { pin: '515099', current_pin: '5150' }, legacyToken).ok === true);
check('после смены пускает новый 6-значный',
  call('/auth/login', { login: 'pin_a', pin: '515099' }).ok === true);

console.log('\n== выдача по заявке без скана ==');
const issAdmin = call('/auth/login', { login: 'Matvey', pin: '432143' }).data.token;
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

console.log('\n== выдача строки целиком: один вход и один замок ==');
// Строка на несколько предметов идёт одним проходом под одним замком, как
// приём пачкой (/transaction/checkin-batch): вход, замок и выбор свободных —
// один раз на запрос, а не на каждый предмет.
const mFree = () => readRows(getSheet(SHEETS.EQUIPMENT)).filter((e) =>
  String(e.category) === String(issModel.category) &&
  String(e.model_code) !== '' && Number(e.model_code) === Number(issModel.model_code) &&
  e.status === 'Available').map((e) => String(e.item_id));
while (mFree().length < 3) {
  call('/item/create', { name: issModel.model_name, category: issModel.category,
    model_code: issModel.model_code }, issAdmin);
}
const mOrderOf = (no, qty) => call('/order/create', {
  order_no: no, student_name: 'Строкой Выдаев', student_phone: '+79990000004',
  issue_date: '01.10.2026', return_date: '03.10.2026',
  items: [{ line_no: 1, raw_name: issModel.model_name, category: issModel.category,
            model_code: issModel.model_code, qty: qty }],
}, issAdmin).data.order_id;
// Счётчики: сколько раз вход, замок и пересборка акта случились за запрос.
const spy = { auth: 0, lock: 0, rebuild: 0, onLock: null };
const realCheckAuth = global.checkAuth, realRebuild = global.rebuildAct;
const realLock = global.LockService.getScriptLock;
global.checkAuth = function () { spy.auth++; return realCheckAuth.apply(this, arguments); };
global.rebuildAct = function () { spy.rebuild++; return { skipped: 'spy' }; };
global.LockService.getScriptLock = () => ({
  waitLock() { spy.lock++; if (spy.onLock) { const f = spy.onLock; spy.onLock = null; f(); } },
  releaseLock() {},
});
const spyReset = () => { spy.auth = 0; spy.lock = 0; spy.rebuild = 0; };
const mTx = (id) => readRows(getSheet(SHEETS.TRANSACTIONS)).filter((t) => String(t.order_id) === String(id));
const mCard = (id) => call('/order/card', { order_id: id }, issAdmin).data;

const want3 = mFree().slice(0, 3).sort();
const mOrder = mOrderOf('LINE-3', 3);
spyReset();
r = call('/order/issue', { order_id: mOrder, line_no: 1 }, issAdmin);
check('строка на три предмета выдана целиком', r.ok === true && r.data.issued.length === 3 && r.data.left === 0, r);
check('ответ прежнего вида: issued [{item_id, qty}], left, order_id, line_no',
  r.data.issued.every((i) => typeof i.item_id !== 'undefined' && i.qty === 1) &&
  r.data.order_id === Number(mOrder) && r.data.line_no === 1, r.data);
check('взяты свободные по порядку номеров',
  r.data.issued.map((i) => String(i.item_id)).join(',') === want3.join(','), [r.data.issued, want3]);
check('вход — один раз на запрос', spy.auth === 1, spy.auth);
check('замок — один раз на запрос', spy.lock === 1, spy.lock);
check('акт не пересобирался: всё легло в состав', spy.rebuild === 0, spy.rebuild);
check('три записи журнала по строке 1, все с пометкой «без сканирования»',
  mTx(mOrder).length === 3 && mTx(mOrder).every((t) => String(t.order_line) === '1' &&
    /без сканирования/.test(t.notes) && t.status === 'Open'), mTx(mOrder));
check('в строке «выдано 3 из 3», заказ выдан',
  mCard(mOrder).items[0].issued_qty === 3 && mCard(mOrder).order.status === 'Issued', mCard(mOrder));
check('предметы ушли со склада', want3.every((id) => !mFree().includes(id)));

spyReset();
r = call('/order/issue', { order_id: mOrder, line_no: 1 }, issAdmin);
check('второе нажатие — 409, а не вторая выдача', r.ok === false && r.status === 409, r);
check('второе нажатие ничего не записало', mTx(mOrder).length === 3 && mCard(mOrder).items[0].issued_qty === 3);

// Свободных меньше, чем в строке: выдаём что есть, остаток — в left.
while (mFree().length < 2) {
  call('/item/create', { name: issModel.model_name, category: issModel.category,
    model_code: issModel.model_code }, issAdmin);
}
const freeNow = mFree().length;
const pOrder = mOrderOf('LINE-PART', freeNow + 2);
r = call('/order/issue', { order_id: pOrder, line_no: 1 }, issAdmin);
check('частичная выдача: выдано сколько свободно', r.ok === true && r.data.issued.length === freeNow, r);
check('частичная выдача: остаток по строке в left', r.data.left === 2, r.data);
check('частичная выдача: в строке «выдано N из N+2»',
  mCard(pOrder).items[0].issued_qty === freeNow, mCard(pOrder).items[0]);
r = call('/order/issue', { order_id: pOrder, line_no: 1 }, issAdmin);
check('по остатку свободных нет — 409, лишнего не выдано',
  r.ok === false && r.status === 409 && mTx(pOrder).length === freeNow, r);
r = call('/order/issue', { order_id: pOrder, line_no: 1, qty: 3 }, issAdmin);
check('просят больше остатка по строке — 409', r.ok === false && r.status === 409, r);

// Выбор свободных — под замком. Пока запрос ждал замок, другой телефон забрал
// один из предметов: запрос должен увидеть это и взять следующий свободный,
// а не упасть на середине и не выдать чужое.
for (let k = 0; k < 2; k++) {
  call('/item/create', { name: issModel.model_name, category: issModel.category,
    model_code: issModel.model_code }, issAdmin);
}
const raceFree = mFree().sort();
const raceOrder = mOrderOf('LINE-RACE', 1);
const otherOrder = mOrderOf('LINE-OTHER', 1);
spy.onLock = () => {
  // «Второй телефон» успел раньше: первый свободный уже на руках.
  realCheckout(raceFree[0], otherOrder);
};
function realCheckout(itemId, orderId) {
  checkoutUnderLock({ item_id: itemId, order_id: orderId, notes: 'другой телефон' },
    { staff_id: 1, full_name: 'Другой' });
}
r = call('/order/issue', { order_id: raceOrder, line_no: 1 }, issAdmin);
check('забранный другим предмет не выдан повторно',
  r.ok === true && r.data.issued.length === 1 && String(r.data.issued[0].item_id) === raceFree[1], [r, raceFree]);
check('у забранного предмета одна открытая выдача',
  readRows(getSheet(SHEETS.TRANSACTIONS)).filter((t) => String(t.item_id) === raceFree[0] && t.status === 'Open').length === 1);

// Вне состава выдача по строке лечь не должна, но если легла — акт
// пересобирается один раз на запрос, а не на каждый предмет.
while (mFree().length < 3) {
  call('/item/create', { name: issModel.model_name, category: issModel.category,
    model_code: issModel.model_code }, issAdmin);
}
const offOrder = mOrderOf('LINE-OFF', 3);
const realClaim = global.claimOrderLine;
global.claimOrderLine = (oid, item, qty) => [{ line: 'off-order', qty: qty }];
spyReset();
r = call('/order/issue', { order_id: offOrder, line_no: 1 }, issAdmin);
global.claimOrderLine = realClaim;
check('выдача трёх вне состава прошла', r.ok === true && r.data.issued.length === 3, r);
check('акт пересобран один раз на три предмета', spy.rebuild === 1, spy.rebuild);
check('замок один и при пересборке', spy.lock === 1, spy.lock);

// Одиночная выдача после выноса тела в checkoutUnderLock — по-прежнему
// замок и вход на запрос и пересборка акта вне состава.
const soloItem = call('/item/create', { name: issModel.model_name, category: issModel.category,
  model_code: issModel.model_code }, issAdmin).data.item_id;
const soloOrder = mOrderOf('LINE-SOLO', 1);
global.claimOrderLine = (oid, item, qty) => [{ line: 'off-order', qty: qty }];
spyReset();
r = call('/transaction/checkout', { item_id: soloItem, order_id: soloOrder }, issAdmin);
global.claimOrderLine = realClaim;
check('одиночная выдача вне состава: ответ прежний', r.ok === true && r.data.order_line === 'off-order' &&
  r.data.order_id === undefined && r.data.transaction_id, r);
check('одиночная выдача: вход, замок и пересборка — по одному',
  spy.auth === 1 && spy.lock === 1 && spy.rebuild === 1, spy);
check('одиночная выдача по заказу ставит заказу «Issued»', mCard(soloOrder).order.status === 'Issued');

global.checkAuth = realCheckAuth;
global.rebuildAct = realRebuild;
global.LockService.getScriptLock = realLock;

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

console.log('\n== приём всего заказа одним запросом ==');
// «Принять всё» на карточке заказа — один вызов вместо запроса на позицию.
// Сделано как одиночный приём выше: те же записи журнала и строки состава.
const bModel = issModel;
const bItem = () => call('/item/create',
  { name: bModel.model_name, category: bModel.category, model_code: bModel.model_code }, issAdmin).data.item_id;
const bA = bItem(), bB = bItem(), bC = bItem(), bD = bItem();
const bGel = call('/item/create', { name: 'Скотч пачкой', category: 'GEL', qty: 20 }, issAdmin).data.item_id;
const bGelRow = readRows(getSheet(SHEETS.EQUIPMENT)).filter((e) => String(e.item_id) === String(bGel))[0];
const bOrder = call('/order/create', {
  order_no: 'BATCH-1', student_name: 'Пачкой Принимаев', student_phone: '+79990000003',
  issue_date: '01.10.2026', return_date: '03.10.2026',
  items: [
    { line_no: 1, raw_name: bModel.model_name, category: bModel.category, model_code: bModel.model_code, qty: 3 },
    { line_no: 2, raw_name: 'Скотч', category: 'GEL', model_code: bGelRow.model_code, qty: 5 },
  ],
}, issAdmin).data.order_id;
call('/transaction/checkout', { item_id: bA, order_id: bOrder }, issAdmin);
call('/transaction/checkout', { item_id: bB, order_id: bOrder }, issAdmin);
call('/transaction/checkout', { item_id: bD, order_id: bOrder }, issAdmin);
call('/transaction/checkout', { item_id: bGel, order_id: bOrder, qty: 5 }, issAdmin);
const bCard = () => call('/order/card', { order_id: bOrder }, issAdmin).data;
check('до приёма заказ выдан, строки заняты',
  bCard().order.status === 'Issued' && bCard().items.map((i) => i.issued_qty).join(',') === '3,5',
  bCard().items.map((i) => i.issued_qty));

r = call('/transaction/checkin-batch', { order_id: bOrder, items: [] }, issAdmin);
check('пустой список — 400', r.ok === false && r.status === 400, r);
r = call('/transaction/checkin-batch', { order_id: bOrder,
  items: Array.from({ length: 41 }, () => ({ item_id: bA })) }, issAdmin);
check('больше сорока позиций — 400', r.ok === false && r.status === 400, r);
r = call('/transaction/checkin-batch', { order_id: bOrder, items: [{ item_id: bA }] }, 'не-токен');
check('чужой токен — отказ целиком', r.ok === false && r.status === 401, r);
check('после отказа ничего не принято', bCard().order.status === 'Issued' &&
  readRows(getSheet(SHEETS.EQUIPMENT)).filter((e) => String(e.item_id) === String(bA))[0].status === 'Rented');

// Две позиции не принять: bC не выдавался, скотча на руках 5, а не 99.
// Остальные проходят — сбой одной не отменяет других.
const logsBefore = logRows().length;
r = call('/transaction/checkin-batch', { order_id: bOrder, items: [
  { item_id: bA }, { item_id: bC }, { item_id: bGel, qty: 99 },
] }, issAdmin);
check('пачка с ошибками отвечает ok и по каждой позиции', r.ok === true && r.data.results.length === 3, r);
check('годная позиция принята', r.data.results[0].ok === true && r.data.results[0].transaction_id, r.data.results[0]);
check('невыданная — отказ 409', r.data.results[1].ok === false && r.data.results[1].status === 409
  && r.data.results[1].item_id === String(bC), r.data.results[1]);
check('лишнее количество — отказ 409 с причиной', r.data.results[2].ok === false
  && r.data.results[2].status === 409 && /На руках 5/.test(r.data.results[2].error), r.data.results[2]);
check('счётчики: принято 1, не принято 2', r.data.done === 1 && r.data.failed === 2, r.data);
const bLogs = logRows().slice(logsBefore).filter((l) => l.kind === 'checkin' && l.endpoint === 'batch');
check('в Logs одна строка об отказах пачки', bLogs.length === 1 && bLogs[0].context.includes(String(bC))
  && /На руках/.test(bLogs[0].context), bLogs);
check('заказ ещё выдан — на руках остались вещи', bCard().order.status === 'Issued');

// Остаток заказа одним вызовом: две штучные (одна с дефектом) и количество.
r = call('/transaction/checkin-batch', { order_id: bOrder, items: [
  { item_id: bB, has_defect: true, defect_description: 'Трещина', defect_severity: 'Major' },
  { item_id: bD },
  { item_id: bGel, qty: 5 },
] }, issAdmin);
check('остаток принят целиком', r.ok === true && r.data.done === 3 && r.data.failed === 0, r);
check('позиция количеством вернула остаток на складе', r.data.results[2].qty === 5 && r.data.results[2].qty_out === 0,
  r.data.results[2]);
check('по дефекту заведена заявка', !!r.data.results[0].defect_id, r.data.results[0]);
const bEq = (id) => readRows(getSheet(SHEETS.EQUIPMENT)).filter((e) => String(e.item_id) === String(id))[0];
check('серьёзный дефект увёл предмет в ремонт', bEq(bB).status === 'In Repair', bEq(bB).status);
check('без дефекта — снова доступны', bEq(bA).status === 'Available' && bEq(bD).status === 'Available',
  [bEq(bA).status, bEq(bD).status]);
check('заказ закрылся, когда вернули всё', bCard().order.status === 'Returned' && String(bCard().order.closed_at) !== '',
  bCard().order);
check('строки состава свободны', bCard().items.map((i) => i.issued_qty).join(',') === '0,0',
  bCard().items.map((i) => i.issued_qty));
check('все записи журнала по заказу закрыты',
  readRows(getSheet(SHEETS.TRANSACTIONS)).filter((t) => String(t.order_id) === String(bOrder))
    .every((t) => t.status === 'Closed'));
check('полный успех в Logs не пишется',
  logRows().filter((l) => l.kind === 'checkin' && l.endpoint === 'batch').length === 1);

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
                        pin: '556655', role: 'Warehouse Staff' }, issAdmin);
const arcStaff = call('/auth/login', { login: 'arccheck', pin: '556655' });
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

console.log('\n== чат склада находится сам ==');
// В Telegram на телефоне id чата не показывают, а открывать getUpdates в
// браузере — значит носить токен по адресной строке. Спрашивает бэкенд.
const chatAdmin = call('/auth/login', { login: 'Matvey', pin: '432143' }).data.token;
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
const actAdmin = call('/auth/login', { login: 'Matvey', pin: '432143' }).data.token;
let act = call('/act/build', { order_id: 1 }, actAdmin);
check('без шаблона сборка отказывает понятно',
  act.ok === false && act.status === 409 && /Шаблон акта не создан/.test(act.error), act);

const helper = call('/staff/create', {
  full_name: 'Складмен Актов', login: 'actstaff', pin: '778877', role: 'Warehouse Staff',
}, actAdmin);
const helperToken = call('/auth/login', { login: 'actstaff', pin: '778877' }).data.token;
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
// Шаблон — бланк колледжа, а не нарисованный заново: проверяем, что в нём
// осталась их формулировка и их реквизиты.
check('текст акта — колледжа',
  /Акт приема-передачи/.test(tplText) && /материальных ценностей № \{\{НОМЕР\}\}-МТО/.test(tplText) &&
  /Шаболовка/.test(tplText) && /Приказа № 104\.25-о/.test(tplText) &&
  !/ПОЛНОЙ МАТЕРИАЛЬНОЙ ОТВЕТСТВЕННОСТИ|Приложение № 1/.test(tplText),
  tplText.slice(0, 120));
check('пункты пронумерованы текстом, как в бланке',
  ['1.4. ', '1.10. ', '2.6.3. ', '3.6.4. ', '3.13. ', '4.3. ', '9. Реквизиты Сторон']
    .every((k) => tplText.includes(k)));
check('все подстановки на месте',
  ACT_PLACEHOLDERS.every((k) => tplText.includes(k)) &&
  (tplText.match(/\{\{[^}]+\}\}/g) || []).every((k) => ACT_PLACEHOLDERS.includes(k)),
  (tplText.match(/\{\{[^}]+\}\}/g) || []).join(' '));
const tplTable = __docs.get(tpl.data.template_id).body.getTables()
  .filter((t) => t.grid[0][0] === '№')[0];
check('в таблице позиций шапка, одна строка-образец и «Итого»',
  tplTable && tplTable.grid.length === 3 && tplTable.grid[2][1] === 'Итого',
  tplTable && tplTable.grid);
check('столбцы в порядке бланка: заводской номер перед количеством',
  tplTable && tplTable.grid[0].join('|') ===
    '№|Наименование материальных ценностей|Зав. номер|Кол-во|Стоимость, рублей',
  tplTable && tplTable.grid[0]);
check('двадцати пяти пустых строк из бланка не осталось',
  tplTable && !tplTable.grid.some((r) => r[0] === '5'), tplTable && tplTable.grid.map((r) => r[0]));

console.log('\n== акт: каждая позиция в свою ячейку ==');
act = call('/act/build', { order_id: 1 }, actAdmin);
check('акт собран', act.ok === true && !!act.data.url, act);
const built = __docs.get(act.data.document_id);
const itemsTable = built.body.getTables().filter((t) => t.grid[0][0] === '№')[0];
check('таблица позиций найдена', !!itemsTable);
check('строк по числу позиций (плюс заголовок и «Итого»)',
  itemsTable && itemsTable.grid.length === act.data.lines + 2,
  itemsTable && itemsTable.grid.length);
check('строки-образца не осталось',
  itemsTable && !itemsTable.getText().includes('{{'), itemsTable && itemsTable.getText());
check('в первой ячейке одно наименование, а не все подряд',
  itemsTable && itemsTable.grid[1][1].indexOf(';') === -1 &&
  itemsTable.grid[1][1].split(' - ').length === 1, itemsTable && itemsTable.grid[1][1]);
check('номера строк по порядку',
  itemsTable && itemsTable.grid.slice(1, -1).every((r, i) => r[0] === String(i + 1)),
  itemsTable && itemsTable.grid.slice(1, -1).map((r) => r[0]));
check('количество в своём столбце',
  itemsTable && itemsTable.grid.slice(1, -1).every((r) => /^\d+$/.test(r[3])),
  itemsTable && itemsTable.grid.slice(1, -1).map((r) => r[3]));
check('подстановок в документе не осталось',
  !built.body.getText().includes('{{'),
  (built.body.getText().match(/\{\{[^}]+\}\}/g) || []).slice(0, 4));
check('ФИО арендатора подставлено',
  built.body.getText().includes('Ильина-Ноктина Полина Ильинична'));
const builtPara = (doc, start) => (doc.body.items
  .filter((i) => i.kind === 'p' && i.text.startsWith(start))[0] || {}).text;
check('адреса в заявке нет — в п. 4.3 линия от руки',
  builtPara(built, '4.3.') === '4.3. Адрес использования оборудования: ' + ACT_BLANK + ACT_BLANK,
  builtPara(built, '4.3.'));
check('имя файла — дата и ФИО',
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /.test(built.name), built.name);

console.log('\n== акт: цены и заводские номера ==');
// В этом заказе часть позиций с ценой из заявки (Tilda), часть без.
check('у позиции без цены прочерк, а не ноль',
  itemsTable && itemsTable.grid.slice(1, -1).some((r) => r[4] === '—'),
  itemsTable && itemsTable.grid.slice(1, -1).map((r) => r[4]));
check('сумма посчитана по тем, у которых цена есть',
  act.data.total > 0, act.data.total);
check('непроставленные цены посчитаны и названы',
  act.data.unpriced > 0, act.data.unpriced);
check('сумма прописью попала в документ',
  /рубл/.test(built.body.getText()));
check('позиции встали над строкой «Итого», в ней сумма',
  itemsTable && itemsTable.grid[itemsTable.grid.length - 1][1] === 'Итого' &&
  itemsTable.grid[itemsTable.grid.length - 1][4] === moneyDigits(act.data.total),
  itemsTable && itemsTable.grid[itemsTable.grid.length - 1]);

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
  table2.grid.slice(1, -1).some((r) => r[2] === 'SN-АКТ-001'),
  table2.grid.slice(1, -1).map((r) => r[2]));
check('у невыданных позиций столбец пуст, а не с чужим номером',
  table2.grid.slice(1, -1).filter((r) => r[2] === 'SN-АКТ-001').length === 1,
  table2.grid.slice(1, -1).map((r) => r[2]));

check('заказа без позиций акт не делает',
  call('/act/build', { order_id: 999 }, actAdmin).status === 404);

console.log('\n== акт: кто подписывает за колледж ==');
// Подписанта и директора владелец вписывает в сам шаблон-документ: настроек
// для них больше нет, а в бланке на их месте — линии.
const signText = __docs.get(act.data.document_id).body.getText();
const handover = __docs.get(act.data.document_id).body.getTables()
  .filter((t) => /СДАЛ/.test(t.getText()))[0];
check('в блоке выдачи за колледж — пустая линия, за арендатора — его ФИО',
  handover && handover.grid[1][0] === '' && handover.grid[1][4] === 'Ильина-Ноктина Полина Ильинична',
  handover && handover.grid[1]);
check('«в лице» — линия от руки',
  /в лице _{20,}, действующего на основании Приказа/.test(signText));
check('настроек подписанта больше нет',
  !('act_signer' in call('/settings/get', {}, actAdmin).data.settings) &&
  !('act_master' in call('/settings/get', {}, actAdmin).data.settings) &&
  !('act_director' in call('/settings/get', {}, actAdmin).data.settings));

// Шаблон, созданный до нынешнего бланка, ещё может стоять в настройках: его
// подстановки подписанта не должны остаться в акте сырыми «{{…}}».
const oldTpl = DocumentApp.create('старый шаблон');
oldTpl.body.appendParagraph('в лице {{ДИРЕКТОР}}, {{ПОДПИСАНТ}} {{МАСТЕР}} / {{МАСТЕР_КРАТКО}}');
oldTpl.body.appendTable([['№', 'НАИМЕНОВАНИЕ', 'КОЛ-ВО', 'ЗАВОДСКОЙ №', 'СТОИМОСТЬ'],
  ['1', '{{ПОЗИЦИИ}}', '', '', ''], ['', 'Итого', '', '', '{{СУММА}}']]);
fillAct(oldTpl, findRowByValue(getSheet(SHEETS.ORDERS), 'order_id', '1'), '1', actLines('1'),
  '2026-10-02 10:00:00');
check('старый шаблон: вместо подписанта и директора — линии',
  oldTpl.body.items[0].text === 'в лице ' + ACT_BLANK + ', ' + [ACT_BLANK, ACT_BLANK, '/', ACT_BLANK].join(' '),
  oldTpl.body.items[0].text);

console.log('\n== акт: адрес из заявки ==');
// Адрес приходит с сайта частью extra_input («… Адрес: …»), отдельной колонки
// у него нет — в акт он попадает через splitExtraInput.
const adrOrder = call('/order/create', {
  order_no: '261002-7777', student_name: 'Адресова Ольга Ивановна', student_phone: '+79990007777',
  issue_date: '03-10-2026', return_date: '06-10-2026', project: 'Курсовой фильм',
  extra_input: 'Мастерская: Режиссура. Комментарий: к 10 утра. Адрес: Москва, ул. Шаболовка, д. 44, павильон 2',
  items: [{ line_no: 1, raw_name: 'Видеоштатив', qty: 1 }],
}, actAdmin);
const adrDoc = adrOrder.ok && __docs.get((String(adrOrder.data.act_url).match(/\/document\/d\/([^/]+)/) || [])[1]);
check('адрес из заявки — в п. 4.3, без мастерской и комментария',
  !!adrDoc && builtPara(adrDoc, '4.3.') ===
    '4.3. Адрес использования оборудования: Москва, ул. Шаболовка, д. 44, павильон 2',
  adrDoc ? builtPara(adrDoc, '4.3.') : adrOrder);
check('проект — в п. 4.2',
  !!adrDoc && builtPara(adrDoc, '4.2.') === '4.2. Указанные материальные ценности предназначены для: Курсовой фильм',
  adrDoc && builtPara(adrDoc, '4.2.'));

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
  tgTexts().some((m) => /^<b><a href="https:\/\/docs\.google\.com[^"]*">АКТ от \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/a><\/b>\n.+$/.test(m)),
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
  exTable().grid.slice(1, -1).every((r) => !/\*$/.test(r[1])), exTable().grid);
check('только заявленное — расшифровки звёздочки нет', legendCount() === 0);

const docsBefore = __docs.size;
const actMsgsBefore = tgTexts().filter((m) => /АКТ от/.test(m)).length;
const stampBefore = exDoc.name.slice(0, 19);
const exR1 = call('/transaction/checkout', { item_id: exA, order_id: exOrder.data.order_id }, actAdmin);
const exR2 = call('/transaction/checkout', { item_id: exB, order_id: exOrder.data.order_id }, actAdmin);
check('лишнее выдаётся вне заказа',
  exR1.ok && exR2.ok && exR1.data.order_line === 'off-order' && exR2.data.order_line === 'off-order',
  [exR1, exR2]);
check('ответ выдачи прежний, без служебных полей',
  exR1.data.order_id === undefined && exR1.data.transaction_id > 0, exR1.data);
let exRows = exTable().grid.slice(1, -1);
check('сначала заявленное, потом сверх заявки',
  exRows.length === 2 && exRows[0][1] === 'Видеоштатив' && exRows[1][0] === '2', exRows);
check('лишнее — одной строкой на модель, со звёздочкой',
  exRows[1][1] === 'Прожектор Сверхзаказ *' && exRows[1][3] === '2', exRows[1]);
check('заводские номера лишнего перечислены',
  exRows[1][2] === 'SN-EX-1, SN-EX-2', exRows[1][2]);
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
  tgTexts().filter((m) => /АКТ от/.test(m)).length === actMsgsBefore);
check('дата акта прежняя', exDoc.body.getText().includes(stampBefore), stampBefore);

// Вернули — всё равно выдавали: акт о переданном, как и у заявленных строк.
call('/transaction/checkin', { item_id: exA }, actAdmin);
call('/transaction/checkout', { item_id: exC, order_id: exOrder.data.order_id }, actAdmin);
exRows = exTable().grid.slice(1, -1);
check('возвращённое лишнее из акта не пропало',
  exRows.some((r) => r[1] === 'Прожектор Сверхзаказ *' && r[2] === 'SN-EX-1, SN-EX-2'), exRows);
check('другая модель — своя строка, без цены прочерк',
  exRows.some((r) => r[1] === 'Отражатель Сверхзаказ *' && r[3] === '1' && r[4] === '—'), exRows);
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
  !!scDoc && scTable().grid.slice(1, -1).every((r) => !/\*$/.test(r[1])), scDoc && scTable().grid);

const scR3 = call('/transaction/checkout', { item_id: scX, order_id: scOrder.data.order_id }, actAdmin);
check('чужая вещь при несопоставленной строке — «вне заказа»',
  scR3.ok === true && scR3.data.order_line === 'off-order', scR3);
check('и только она в акте со звёздочкой',
  scTable().grid.slice(1, -1).filter((r) => /\*$/.test(r[1])).map((r) => r[1]).join('|') === 'Флаг Внезаказный *',
  scTable().grid);
call('/settings/set', { settings: { public_orders: 0 } }, actAdmin);

console.log('\n== темы форума: заявки и акты ==');
// Группа склада — форум: заявки идут в тему «ЗАЯВКИ», акты — в «АКТЫ». Пустая
// настройка — General, как было до тем.
const tgMsgs = () => sent.filter((r) => /sendMessage/.test(r.url)).map((r) => JSON.parse(r.opts.payload));
const orderMsgs = () => tgMsgs().filter((m) => /Заказ №/.test(m.text));
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
const actMsgs = tgMsgs().filter((m) => /АКТ от /.test(m.text));
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
const logLogin = call('/auth/login', { login: 'matvey', pin: '432143' });
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

// Отказы, которые стоит видеть потом: неверный вход, блокировка, 5xx.
logBefore = logRows().length;
call('/auth/login', { login: 'matvey', pin: '999888' });
errLog = logRows().slice(logBefore);
check('неверный вход — строка refusal 401 в журнале',
  errLog.length === 1 && errLog[0].kind === 'refusal' && errLog[0].endpoint === '/auth/login' &&
  errLog[0].reason === '401', errLog);
check('в строке о неверном входе нет ни логина, ни PIN',
  JSON.stringify(errLog).indexOf('matvey') === -1 && JSON.stringify(errLog).indexOf('999888') === -1, errLog);
call('/staff/create', { full_name: 'Перебор', login: 'brute', pin: '135791' }, logToken);
for (let i = 0; i < getSettings().max_login_attempts; i++) call('/auth/login', { login: 'brute', pin: '000000' });
logBefore = logRows().length;
r = call('/auth/login', { login: 'brute', pin: '135791' });
errLog = logRows().slice(logBefore);
check('блокировка входа (429) — в журнале',
  r.status === 429 && errLog.length === 1 && errLog[0].reason === '429', [r, errLog]);
logBefore = logRows().length;
call('/staff/list', {}, 'чужой-токен');
check('401 вне входа (протухшая сессия) в журнал не идёт', logRows().length === logBefore);
__telegramSendReply = () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked' });
logBefore = logRows().length;
r = call('/notify/hello', { chat_id: '-100555' }, logToken);
errLog = logRows().slice(logBefore);
check('отказ Telegram (502) — одна строка, без дубля от doPost',
  r.status === 502 && errLog.length === 1 && errLog[0].kind === 'telegram', [r, errLog]);
__telegramSendReply = null;
const realNotifyChats = handleNotifyChats;
globalThis.handleNotifyChats = () => { throw apiError(502, 'Диск не ответил'); };
logBefore = logRows().length;
call('/notify/chats', {}, logToken);
errLog = logRows().slice(logBefore);
check('прочий 5xx от ручки — строка refusal в журнале',
  errLog.length === 1 && errLog[0].kind === 'refusal' && errLog[0].reason === '502' &&
  errLog[0].message === 'Диск не ответил', errLog);
globalThis.handleNotifyChats = realNotifyChats;

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

console.log('\n== уборка тестовых строк ==');
// Свои строки с номерами 9xxx — рядом с тем, что накопили проверки выше.
const sh = (n) => getSheet(n);
const rowsOf = (n) => readRows(sh(n));
const hasRow = (n, col, v) => rowsOf(n).some(r => String(r[col]) === String(v));
appendRow(sh('Students'), { student_id: 9001, full_name: 'Тест Ученик', created_at: '2026-09-01' });
appendRow(sh('Students'), { student_id: 9002, full_name: 'Тестова Анна', created_at: '2026-09-01' });
appendRow(sh('Students'), { student_id: 9003, full_name: 'Тест Смешанный', created_at: '2026-09-01' });
appendRow(sh('Orders'), { order_id: 9101, order_no: '9101', student_id: 9001, student_name: 'Тест Ученик',
                          created_at: '2026-09-02', act_url: 'https://docs.google.com/document/d/act9101' });
appendRow(sh('Orders'), { order_id: 9102, order_no: '9102', student_id: 9002, student_name: 'Тестова Анна', created_at: '2026-09-02' });
appendRow(sh('Orders'), { order_id: 9103, order_no: '9103', student_id: 9002, student_name: '[тест] на руках', created_at: '2026-09-02' });
appendRow(sh('Orders'), { order_id: 9104, order_no: 'TEST-1', student_id: 9003, student_name: 'Смешанный', created_at: '2026-09-02' });
appendRow(sh('Orders'), { order_id: 9105, order_no: '9105', student_id: 9003, student_name: 'Смешанный', created_at: '2026-09-02' });
[[9101, 1], [9101, 2], [9102, 1], [9103, 1], [9104, 1]].forEach(([o, l]) =>
  appendRow(sh('OrderItems'), { order_id: o, line_no: l, raw_name: 'Позиция ' + o + '/' + l, qty: 1 }));
appendRow(sh('Transactions'), { transaction_id: 9201, item_id: '010101', order_id: 9101, status: 'Closed', checked_out_at: '2026-09-03' });
appendRow(sh('Transactions'), { transaction_id: 9202, item_id: '010101', order_id: 9102, status: 'Closed', checked_out_at: '2026-09-03' });
appendRow(sh('Transactions'), { transaction_id: 9203, item_id: '010102', order_id: 9103, status: 'Open', checked_out_at: '2026-09-03' });
appendRow(sh('Defects'), { defect_id: 9301, item_id: '010101', related_transaction_id: 9201, status: 'Resolved', description: 'тест' });
appendRow(sh('Defects'), { defect_id: 9302, item_id: '010101', related_transaction_id: 9202, status: 'Open', description: 'настоящий' });
const owner = findRowByValue(sh('Staff'), 'staff_id', ownerId());
const ownerName = owner.full_name;
updateRow(sh('Staff'), owner.__row, { full_name: 'Тест Владелец' });
appendRow(sh('Staff'), { staff_id: 9401, full_name: 'Сотрудник Проба', login: 'test1', role: 'Staff', active: true });
appendRow(sh('Staff'), { staff_id: 9402, full_name: 'Тест Админ', login: 'tadm', role: 'Admin', active: true });
appendRow(sh('Staff'), { staff_id: 9403, full_name: 'Тестеров Иван', login: 'tester', role: 'Staff', active: true });

check('isTestName: слово «Тест», пометка, но не фамилия',
  isTestName(' тест ') && isTestName('Test-1') && isTestName('Иванов [TEST]') &&
  !isTestName('Тестова Анна') && !isTestName('Testov') && !isTestName(''));

const equipBefore = JSON.stringify(dumpSheet('Equipment'));
const sizes = () => ['Orders', 'OrderItems', 'Transactions', 'Defects', 'Students', 'Staff']
  .map(n => rowsOf(n).length).join();
const sizesBefore = sizes();

const preview = cleanupTestDataPreview();
const plan = cleanupTestPlan();
const planIds = (list, col) => list.map(r => String(r[col]));
check('просмотр ничего не удаляет', sizes() === sizesBefore, [sizes(), sizesBefore]);
check('просмотр: тестовый заказ и заказ TEST-1 в списке, настоящий нет',
  planIds(plan.orders, 'order_id').includes('9101') && planIds(plan.orders, 'order_id').includes('9104') &&
  !planIds(plan.orders, 'order_id').includes('9102'), planIds(plan.orders, 'order_id'));
check('просмотр: заказ с техникой на руках отказан с причиной',
  plan.refused.some(x => x.order_id === '9103' && /010102/.test(x.reason)) && /на руках/.test(preview), plan.refused);
check('просмотр: в отчёте ссылка на акт и счётчики',
  /act9101/.test(preview) && /Orders — \d+/.test(preview) && /Тест Ученик/.test(preview), preview);
check('просмотр: ученик с настоящим заказом оставлен',
  plan.keptStudents.some(x => String(x.row.student_id) === '9003'));
check('просмотр: главный администратор оставлен',
  plan.keptStaff.some(x => String(x.row.staff_id) === String(owner.staff_id) && /главный/.test(x.reason)));

// Последний действующий администратор: гасим всех остальных — тестовый
// администратор остаётся. Лист Staff потом возвращаем как был.
const staffSnapshot = sh('Staff').data.map(r => r.slice());
rowsOf('Staff').forEach(r => {
  if (r.role === 'Admin' && String(r.staff_id) !== '9402') updateRow(sh('Staff'), r.__row, { active: false });
});
const lonely = cleanupTestPlan();
check('последний действующий администратор не удаляется',
  lonely.keptStaff.some(x => String(x.row.staff_id) === '9402' && /последний/.test(x.reason)) &&
  !planIds(lonely.staff, 'staff_id').includes('9402'), lonely.keptStaff.map(x => x.row.staff_id));
sh('Staff').data = staffSnapshot;

// Копия не получилась — не удаляется ничего.
logBefore = logRows().length;
global.__driveFail = 'Диск недоступен';
r = cleanupTestData();
global.__driveFail = null;
check('без копии уборка отменена', /отменена/.test(r) && sizes() === sizesBefore, r);
check('отказ уборки записан в Logs',
  logRows().slice(logBefore).some(l => l.kind === 'cleanup' && l.reason === 'backup_failed'));

const copiesBefore = backupFiles.length;
logBefore = logRows().length;
r = cleanupTestData();
const cleanupLogs = logRows().slice(logBefore).filter(l => l.kind === 'cleanup');
check('перед уборкой сделана копия таблицы', backupFiles.length === copiesBefore + 1, r);
check('удалены тестовый заказ, его позиции, выдача и дефект',
  !hasRow('Orders', 'order_id', 9101) && !hasRow('Orders', 'order_id', 9104) &&
  !hasRow('OrderItems', 'order_id', 9101) && !hasRow('OrderItems', 'order_id', 9104) &&
  !hasRow('Transactions', 'transaction_id', 9201) && !hasRow('Defects', 'defect_id', 9301));
check('удалён тестовый ученик', !hasRow('Students', 'student_id', 9001));
check('настоящий заказ, его состав, выдача, дефект и ученица на месте',
  hasRow('Orders', 'order_id', 9102) && hasRow('OrderItems', 'order_id', 9102) &&
  hasRow('Transactions', 'transaction_id', 9202) && hasRow('Defects', 'defect_id', 9302) &&
  hasRow('Students', 'student_id', 9002));
check('ученик с настоящим заказом оставлен', hasRow('Students', 'student_id', 9003) && hasRow('Orders', 'order_id', 9105));
check('заказ с техникой на руках не тронут',
  hasRow('Orders', 'order_id', 9103) && hasRow('OrderItems', 'order_id', 9103) && hasRow('Transactions', 'transaction_id', 9203));
check('Equipment не тронут', JSON.stringify(dumpSheet('Equipment')) === equipBefore);
check('тестовые сотрудники удалены, «Тестеров» и главный на месте',
  !hasRow('Staff', 'staff_id', 9401) && !hasRow('Staff', 'staff_id', 9402) &&
  hasRow('Staff', 'staff_id', 9403) && hasRow('Staff', 'staff_id', owner.staff_id));
check('в Logs одна строка уборки со счётчиками',
  cleanupLogs.length === 1 && /заказов \d+/.test(cleanupLogs[0].message) && /act9101/.test(cleanupLogs[0].context),
  cleanupLogs);

const sizesAfter = sizes();
const again = cleanupTestPlan();
r = cleanupTestData();
check('повторный запуск ничего не удаляет',
  sizes() === sizesAfter && again.orders.length === 0 && again.items.length === 0 &&
  again.transactions.length === 0 && again.students.length === 0 && again.staff.length === 0, r);
updateRow(sh('Staff'), findRowByValue(sh('Staff'), 'staff_id', owner.staff_id).__row, { full_name: ownerName });

console.log('\n== уборка архива заказов ==');
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
appendRow(sh('Orders'), { order_id: 9501, order_no: '9501', student_id: 9002, student_name: 'Архив Старый',
                          created_at: '2026-09-01', archived_at: ago(3) });
appendRow(sh('Orders'), { order_id: 9502, order_no: '9502', student_id: 9002, student_name: 'Архив Свежий',
                          created_at: '2026-09-01', archived_at: ago(1) });
appendRow(sh('Orders'), { order_id: 9503, order_no: '9503', student_id: 9002, student_name: 'Не в архиве',
                          created_at: '2026-09-01' });
appendRow(sh('Orders'), { order_id: 9504, order_no: '9504', student_id: 9002, student_name: 'Архив На руках',
                          created_at: '2026-09-01', archived_at: ago(5) });
appendRow(sh('OrderItems'), { order_id: 9501, line_no: 1, raw_name: 'Позиция 9501', qty: 1 });
appendRow(sh('Transactions'), { transaction_id: 9601, item_id: '010101', order_id: 9501, status: 'Closed', checked_out_at: '2026-09-03' });
appendRow(sh('Transactions'), { transaction_id: 9602, item_id: '010102', order_id: 9504, status: 'Open', checked_out_at: '2026-09-03' });

check('срок архива по умолчанию — 2 дня', getSettings().archive_keep_days === 2, getSettings().archive_keep_days);
const archPreview = cleanupArchivePreview();
check('просмотр архива: весь архив, без неархивных, заказ на руках отказан',
  /9501/.test(archPreview) && /9502/.test(archPreview) && !/9503/.test(archPreview) &&
  archivedPlan(0).refused.some(x => x.order_id === '9504'), archPreview);

const archStudents = rowsOf('Students').length;
r = trimArchive();
check('ночная уборка: удалён заказ старше 2 дней с позициями и выдачей',
  !hasRow('Orders', 'order_id', 9501) && !hasRow('OrderItems', 'order_id', 9501) &&
  !hasRow('Transactions', 'transaction_id', 9601), r);
check('ночная уборка: свежий архив, неархивный и заказ на руках на месте',
  hasRow('Orders', 'order_id', 9502) && hasRow('Orders', 'order_id', 9503) && hasRow('Orders', 'order_id', 9504));
check('уборка архива не трогает учеников', rowsOf('Students').length === archStudents);

call('/settings/set', { settings: { archive_keep_days: 0 } }, logToken);
logBefore = logRows().length;
check('срок 0 — ночью архив не трогается', trimArchive() === '' && hasRow('Orders', 'order_id', 9502) &&
  logRows().length === logBefore);
check('срок вне пределов отклонён',
  call('/settings/set', { settings: { archive_keep_days: -1 } }, logToken).ok === false);

r = cleanupArchive();
check('ручная уборка удаляет весь архив, кроме заказа на руках',
  !hasRow('Orders', 'order_id', 9502) && hasRow('Orders', 'order_id', 9504) && hasRow('Orders', 'order_id', 9503), r);
call('/settings/set', { settings: { archive_keep_days: 2 } }, logToken);

console.log('\n== разовая правка каталога ==');
// Маленький план на своих моделях «КФ …», а не весь CATALOG_FIX: проверяется
// ход (слияния, удаления, названия, цены, разделы, повтор), а не данные.
const kfModel = (cat, name, n, extra) => {
  const m = findOrCreateModel(cat, name);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = buildItemId(cat, m.model_code, nextUnitNumber(cat, m.model_code));
    appendRow(sh('Equipment'), Object.assign({ item_id: id, name: name, category: cat,
      model_code: pad2(m.model_code), status: 'Available', qty: 1, qty_out: 0 }, extra || {}));
    ids.push(id);
  }
  return { key: catalogFixKey(cat, m.model_code), code: pad2(m.model_code), ids: ids };
};
const kfA = kfModel('CAM', 'КФ Камера А', 2);
const kfB = kfModel('CAM', 'КФ Камера Б', 1);
const kfSide = kfModel('CAM', 'КФ Сосед', 1);
const kfMon = kfModel('OTH', 'КФ Монитор', 2);
const kfMonPro = kfModel('MON', 'КФ Монитор Про', 1);
const kfBag = kfModel('GRP', 'КФ Мешок', 1, { qty: 5 });
const kfBagBig = kfModel('GRP', 'КФ Мешок большой', 1, { qty: 3 });
const kfDel = kfModel('LEN', 'КФ Удаляемая', 2);
const kfOut = kfModel('CAM', 'КФ Выданная', 1, { status: 'Rented', current_transaction_id: 9901 });

appendRow(sh('Transactions'), { transaction_id: 9902, item_id: kfA.ids[0], status: 'Closed', checked_out_at: '2026-09-03' });
appendRow(sh('Defects'), { defect_id: 9903, item_id: kfA.ids[0], status: 'Resolved', description: 'КФ царапина' });
appendRow(sh('Inventory'), { inventory_id: 9904, kind: 'missing', item_id: kfA.ids[0] });
appendRow(sh('Transactions'), { transaction_id: 9905, item_id: kfDel.ids[0], status: 'Closed', checked_out_at: '2026-09-03' });
appendRow(sh('Inventory'), { inventory_id: 9906, kind: 'missing', item_id: kfDel.ids[1] });
appendRow(sh('Transactions'), { transaction_id: 9901, item_id: kfOut.ids[0], status: 'Open', checked_out_at: '2026-09-03' });
appendRow(sh('OrderItems'), { order_id: 9907, line_no: 1, raw_name: 'КФ Камера А', model_code: kfA.code, category: 'CAM', qty: 1 });
appendRow(sh('OrderItems'), { order_id: 9907, line_no: 2, raw_name: 'КФ Удаляемая', model_code: kfDel.code, category: 'LEN', qty: 1 });

const kfCatMax = Math.max.apply(null, categories().map(c => Number(c.num)));
const kfPlan = {
  categories: [
    { action: 'relabel', code: 'MED', label: 'Карты КФ' },
    { action: 'create', code: 'KFA', label: 'КФ поштучно', by_qty: false },
    { action: 'create', code: 'KFB', label: 'КФ количеством', by_qty: true },
    { action: 'relabel', code: 'KFZ', label: 'нет такой' },
  ],
  delete_models: [kfDel.key, 'LEN-98'],
  merges: [{ from: kfA.key, into: kfB.key }, { from: kfMon.key, into: kfMonPro.key },
           { from: kfBag.key, into: kfBagBig.key }],
  // Ключи — до слияний: цена и раздел, названные по kfA, уходят kfB.
  renames: [{ key: kfB.key, to: 'КФ Камера Бета' }],
  prices: [{ key: kfA.key, price: 1500 }, { key: kfMonPro.key, price: 700 }],
  sections: [{ key: kfA.key, section: 'photo' }, { key: 'CAM-97', section: 'CINE' }],
};
const kfEquip = () => JSON.stringify(dumpSheet('Equipment'));
const kfModels = () => JSON.stringify(dumpSheet('Models'));

console.log('-- отказы: ничего не записано --');
let kfEquipBefore = kfEquip(), kfModelsBefore = kfModels();
r = catalogFixPlan(Object.assign({}, kfPlan, { merges: kfPlan.merges.concat([{ from: kfOut.key, into: kfSide.key }]) }), 'копия есть');
check('выданная вещь у сливаемой модели — отказ всего запуска',
  r.ok === false && /КФ Выданная/.test(r.message) && /На руках 1 вещь/.test(r.message), r.message);
check('после отказа каталог и справочник не тронуты',
  kfEquip() === kfEquipBefore && kfModels() === kfModelsBefore && !categories().some(c => c.code === 'KFA'));
r = catalogFixPlan(Object.assign({}, kfPlan, { delete_models: [kfOut.key] }), 'копия есть');
check('удаление модели с вещью на руках — отказ',
  r.ok === false && /на руках/.test(r.message) && kfEquip() === kfEquipBefore, r.message);
r = catalogFixPlan(Object.assign({}, kfPlan, { renames: [{ key: kfB.key, to: 'КФ Сосед' }] }), 'копия есть');
check('переименование в соседнюю модель — отказ', r.ok === false && /КФ Сосед/.test(r.message) &&
  kfModels() === kfModelsBefore, r.message);
check('отказ записан в Logs',
  logRows().slice(-1).some(l => l.kind === 'catalog_fix' && l.reason === 'refused'));
r = catalogFixPlan(Object.assign({}, kfPlan, { delete_units: { item_ids: [kfOut.ids[0]] } }), 'копия есть');
check('вещь на руках не удалить и поштучно', r.ok === false && /на руках/i.test(r.message), r.message);

logBefore = logRows().length;
global.__driveFail = 'Диск недоступен';
r = catalogFixPlan(kfPlan);
global.__driveFail = null;
check('без копии правка отменена', r.ok === false && /отменена/.test(r.message) &&
  kfEquip() === kfEquipBefore && kfModels() === kfModelsBefore, r.message);
check('отказ без копии записан в Logs',
  logRows().slice(logBefore).some(l => l.kind === 'catalog_fix' && l.reason === 'backup_failed'));

console.log('-- просмотр --');
const kfTodo = catalogFixTodo(kfPlan);
check('просмотр ничего не меняет и не находит отказов',
  kfTodo.errors.length === 0 && kfEquip() === kfEquipBefore && kfModels() === kfModelsBefore, kfTodo.errors);
check('просмотр называет пропущенные ключи',
  ['LEN-98', 'CAM-97', 'KFZ'].every(k => kfTodo.missing.some(m => m.indexOf(k) !== -1)), kfTodo.missing);

console.log('-- запуск --');
const kfCopies = backupFiles.length;
logBefore = logRows().length;
r = catalogFixPlan(kfPlan);
check('правка прошла и перед ней сделана копия', r.ok === true && backupFiles.length === kfCopies + 1, r.message);
const kfEq = () => rowsOf('Equipment');
const kfOf = (key) => kfEq().filter(u => catalogFixKey(u.category, u.model_code) === key);
const kfModelRow = (key) => rowsOf('Models').filter(m => catalogFixKey(m.category, m.model_code) === key)[0];

const kfCats = categories();
const kfA2 = kfCats.filter(c => c.code === 'KFA')[0], kfB2 = kfCats.filter(c => c.code === 'KFB')[0];
check('категории заведены со следующими свободными номерами и способом учёта',
  kfA2 && kfB2 && Number(kfA2.num) === kfCatMax + 1 && Number(kfB2.num) === kfCatMax + 2 &&
  !kfA2.by_qty && kfB2.by_qty, [kfA2, kfB2, kfCatMax]);
check('категория MED переименована', kfCats.filter(c => c.code === 'MED')[0].label === 'Карты КФ');

check('слияние в категории: вещи под номерами целевой модели, исходной модели нет',
  kfOf(kfB.key).length === 3 && !kfOf(kfA.key).length && !kfModelRow(kfA.key) &&
  kfOf(kfB.key).every(u => String(u.item_id).slice(0, 4) === kfB.ids[0].slice(0, 4)), kfOf(kfB.key).map(u => u.item_id));
check('слияние между категориями: вещи в MON с номерами MON',
  kfOf(kfMonPro.key).length === 3 && !kfOf(kfMon.key).length && !kfModelRow(kfMon.key) &&
  kfOf(kfMonPro.key).every(u => u.category === 'MON' && String(u.item_id).slice(0, 2) === categoryNum('MON')));
const kfShelf = kfOf(kfBagBig.key);
check('полка: количество сложено в одну строку, исходной строки нет',
  kfShelf.length === 1 && Number(kfShelf[0].qty) === 8 && !kfOf(kfBag.key).length && !kfModelRow(kfBag.key), kfShelf);
check('карта номеров: полка указывает на целевую строку',
  r.items[kfBag.ids[0]] === String(kfShelf[0].item_id), r.items);

const kfNewA = r.items[kfA.ids[0]];
check('журналы переписаны на новый номер',
  kfNewA && rowsOf('Transactions').some(t => String(t.transaction_id) === '9902' && String(t.item_id) === kfNewA) &&
  rowsOf('Defects').some(d => String(d.defect_id) === '9903' && String(d.item_id) === kfNewA) &&
  rowsOf('Inventory').some(i => String(i.inventory_id) === '9904' && String(i.item_id) === kfNewA), kfNewA);
const kfLine = (n) => rowsOf('OrderItems').filter(l => String(l.order_id) === '9907' && Number(l.line_no) === n)[0];
check('строка заказа переписана на выжившую модель',
  kfLine(1).category === 'CAM' && pad2(Number(kfLine(1).model_code)) === kfB.code, kfLine(1));

check('удаление: модели и вещей нет, закрытые записи журналов удалены',
  !kfModelRow(kfDel.key) && !kfOf(kfDel.key).length &&
  !rowsOf('Transactions').some(t => String(t.transaction_id) === '9905') &&
  !rowsOf('Inventory').some(i => String(i.inventory_id) === '9906'));
check('строка заказа удалённой модели осталась без кода', kfLine(2) && kfLine(2).model_code === '', kfLine(2));
check('/public/catalog удалённую модель не показывает',
  !call('/public/catalog', {}).data.models.some(m => m.model_name === 'КФ Удаляемая'));

check('переименование: модель и все её вещи, включая слитые',
  kfModelRow(kfB.key).model_name === 'КФ Камера Бета' && kfOf(kfB.key).every(u => u.name === 'КФ Камера Бета'));
check('цены записаны (по ключу до слияния — выжившей модели)',
  Number(kfModelRow(kfB.key).price) === 1500 && Number(kfModelRow(kfMonPro.key).price) === 700);
check('раздел записан приведённым', kfModelRow(kfB.key).section === 'PHOTO', kfModelRow(kfB.key).section);
check('карта ключей — по слияниям',
  r.keys[kfA.key] === kfB.key && r.keys[kfMon.key] === kfMonPro.key && r.keys[kfBag.key] === kfBagBig.key, r.keys);
const kfLog = logRows().slice(logBefore).filter(l => l.kind === 'catalog_fix');
check('в Logs одна строка со счётчиками и картой ключей',
  kfLog.length === 1 && kfLog[0].reason === 'done' && kfLog[0].context.indexOf(kfA.key) !== -1, kfLog);

console.log('-- повтор --');
kfEquipBefore = kfEquip(); kfModelsBefore = kfModels();
const kfAgain = catalogFixPlan(kfPlan, 'копия есть');
check('повторный запуск ничего не меняет и сообщает нули',
  kfAgain.ok === true && Object.keys(kfAgain.counts).every(k => kfAgain.counts[k] === 0) &&
  kfEquip() === kfEquipBefore && kfModels() === kfModelsBefore, kfAgain.counts);
check('повтор отдаёт ту же карту ключей', JSON.stringify(kfAgain.keys) === JSON.stringify(r.keys), kfAgain.keys);

console.log('-- имена вещей по модели (sync_unit_names) --');
{
  const sy = kfModel('CAM', 'КФ Синк', 4);
  const syRow = (id) => rowsOf('Equipment').filter(u => String(u.item_id) === id)[0];
  const syPatch = (id, patch) => updateRow(sh('Equipment'), syRow(id).__row, patch);
  syPatch(sy.ids[0], { name: 'КФ Синк 8k', serial_number: 'SN-SY-0', condition_notes: 'царапина' });
  // Номер модели числом, категория строчными с пробелом: так вещь могла попасть в таблицу руками.
  syPatch(sy.ids[1], { name: 'КФ Старое', model_code: Number(sy.code) });
  syPatch(sy.ids[2], { name: 'КФ Ещё старое', category: ' cam ' });
  appendRow(sh('Equipment'), { item_id: 'CAM97-99', name: 'КФ Сирота', category: 'CAM', model_code: 97, status: 'Available', qty: 1, qty_out: 0 });
  appendRow(sh('OrderItems'), { order_id: 9951, line_no: 1, raw_name: 'КФ Синк 8k', model_code: sy.code, category: 'CAM', qty: 1 });
  const syPlan = { sync_unit_names: true };
  const syEquip = () => JSON.stringify(dumpSheet('Equipment'));
  const syModels = () => JSON.stringify(dumpSheet('Models'));
  const syLines = () => JSON.stringify(dumpSheet('OrderItems'));
  const syWithout = (col) => JSON.stringify(rowsOf('Equipment').map(u => Object.assign({}, u, { [col]: '' })));

  const before = syEquip(), modelsBefore = syModels(), linesBefore = syLines(), withoutBefore = syWithout('name');
  global.__driveFail = 'Диск недоступен';
  r = catalogFixPlan(syPlan);
  global.__driveFail = null;
  check('sync: без копии отмена и ничего не записано', r.ok === false && syEquip() === before, r.message);

  const syTodo = catalogFixTodo(syPlan);
  check('sync: просмотр ничего не меняет и называет вещи с именем не по модели',
    syEquip() === before && syTodo.errors.length === 0 &&
    [sy.ids[0], sy.ids[1], sy.ids[2]].every(id => syTodo.syncs.some(s => s.item_id === id)) &&
    syTodo.syncModels.some(g => g.key === sy.key && g.units === 3), syTodo.syncs);
  check('sync: вещь без модели названа в отчёте, но не тронута',
    syTodo.missing.some(m => m.indexOf('CAM97-99') !== -1) && !syTodo.syncs.some(s => s.item_id === 'CAM97-99'), syTodo.missing);
  check('sync: в отчёте «было → стало»', catalogFixReport(syTodo, syTodo.counts, 'Просмотр').indexOf(sy.ids[0] + ': КФ Синк 8k → КФ Синк') !== -1);

  r = catalogFixPlan(syPlan, 'копия есть');
  check('sync: запуск прошёл', r.ok === true && r.counts.synced_units >= 3, r.message);
  check('sync: имена вещей — имя модели, включая число в model_code и « cam » в категории',
    [sy.ids[0], sy.ids[1], sy.ids[2]].every(id => syRow(id).name === 'КФ Синк'), rowsOf('Equipment').filter(u => /КФ Синк|КФ Старое|КФ Ещё/.test(u.name)).map(u => u.name));
  check('sync: вещь без модели осталась как была', syRow('CAM97-99').name === 'КФ Сирота');
  check('sync: другие колонки, Models и OrderItems.raw_name не тронуты',
    syWithout('name') === withoutBefore && syModels() === modelsBefore && syLines() === linesBefore);
  check('sync: заводской номер и заметка на месте',
    syRow(sy.ids[0]).serial_number === 'SN-SY-0' && syRow(sy.ids[0]).condition_notes === 'царапина');

  const afterRun = syEquip();
  r = catalogFixPlan(syPlan, 'копия есть');
  check('sync: повторный запуск — нули', r.ok === true && Object.keys(r.counts).every(k => r.counts[k] === 0) && syEquip() === afterRun, r.counts);

  // Переименование модели обязано дойти до вещей с кривой категорией — та же причина, что у sync.
  const adm = logToken;
  syPatch(sy.ids[3], { name: 'КФ Старое', category: ' cam ' });
  const rn = call('/models/rename', { category: 'CAM', model_code: sy.code, model_name: 'КФ Синк Новый' }, adm);
  check('/models/rename: вещи с « cam » и числом в model_code переименованы тоже',
    rn.ok && sy.ids.every(id => syRow(id).name === 'КФ Синк Новый'), sy.ids.map(id => syRow(id).name));
  syPatch(sy.ids[2], { name: 'КФ Старое', category: ' cam ' });
  const up = call('/item/update', { item_id: sy.ids[0], all_model: true, name: 'КФ Синк Третий' }, adm);
  check('/item/update all_model: так же',
    up.ok && sy.ids.every(id => syRow(id).name === 'КФ Синк Третий'), up.ok ? sy.ids.map(id => syRow(id).name) : up);
}

console.log('-- дубли с повторной вкладки КИНО --');
// Свои вещи с меткой КИНО; метки КИНО у вещей из импорта выше на время
// проверки снимаем — среди них есть выданная, и она дала бы отказ. Лист
// Equipment потом возвращаем как был.
const kfEqSnapshot = sh('Equipment').data.map(r => r.slice());
rowsOf('Equipment').forEach(u => {
  if (/Импорт:\s*КИНО#/.test(String(u.condition_notes || ''))) updateRow(sh('Equipment'), u.__row, { condition_notes: '' });
});
const kfKino = (name, serial, tab) => {
  const m = kfModel('LEN', name, 1);
  updateRow(sh('Equipment'), findRowByValue(sh('Equipment'), 'item_id', m.ids[0]).__row,
    { serial_number: serial, condition_notes: 'Комплект: крышки / Импорт: ' + tab + '#' + (7 + m.ids.length) });
  return m.ids[0];
};
const kinoEmpty = kfKino('КФ Кино Пусто', '', 'КИНО');
const kinoDup = kfKino('КФ Кино Дубль', 'SN-77001', 'КИНО');
const kinoTwin = kfKino('КФ Кино Дубль', 'SN-77001', 'КАМЕРЫ');
const kinoOwn = kfKino('КФ Кино Свой', 'SN-77002', 'КИНО');
const kinoCopy = kfKino('КФ Кино Копия', '', 'КИНО (копия)');
appendRow(sh('Transactions'), { transaction_id: 9908, item_id: kinoDup, status: 'Closed', checked_out_at: '2026-09-03' });
r = catalogFixPlan({ delete_units: { import_tab: 'КИНО' } }, 'копия есть');
const kinoHas = (id) => rowsOf('Equipment').some(u => String(u.item_id) === id);
check('вещь КИНО без заводского номера удалена', r.ok === true && !kinoHas(kinoEmpty), r.message);
check('вещь КИНО с номером, который есть на другой вкладке, удалена, а та — нет',
  !kinoHas(kinoDup) && kinoHas(kinoTwin));
check('закрытая выдача удалённой вещи удалена',
  !rowsOf('Transactions').some(t => String(t.transaction_id) === '9908'));
check('вещь КИНО со своим номером оставлена и названа «проверить на складе»',
  kinoHas(kinoOwn) && /проверить на складе/.test(r.message) && r.message.indexOf(kinoOwn) !== -1, r.message);
check('«КИНО (копия)» не тронута', kinoHas(kinoCopy));
check('отчёт считает по моделям', r.counts.deleted_units === 2 && /по моделям: LEN-\d\d — 1/.test(r.message), r.message);
r = catalogFixPlan({ delete_units: { import_tab: 'КИНО' } }, 'копия есть');
check('повтор: удалять больше нечего', r.ok === true && r.counts.deleted_units === 0 && kinoHas(kinoOwn), r.counts);
sh('Equipment').data = kfEqSnapshot;

console.log('\n== правка каталога: перенос в другую категорию ==');
const mvTripod = kfModel('GRP', 'МВ Штатив', 1, { qty: 4 });
const mvMon = kfModel('OTH', 'МВ Монитор', 2);
const mvOut = kfModel('OTH', 'МВ Выданный', 1, { status: 'Rented', current_transaction_id: 9921 });
appendRow(sh('Transactions'), { transaction_id: 9921, item_id: mvOut.ids[0], status: 'Open', checked_out_at: '2026-09-03' });
appendRow(sh('Transactions'), { transaction_id: 9922, item_id: mvMon.ids[0], status: 'Closed', checked_out_at: '2026-09-03' });
appendRow(sh('OrderItems'), { order_id: 9923, line_no: 1, raw_name: 'МВ Монитор', model_code: mvMon.code, category: 'OTH', qty: 1 });
const mvPlan = {
  categories: [{ action: 'create', code: 'MVS', label: 'МВ Стабилизация', by_qty: true }],
  moves: [{ from: mvTripod.key, to: 'MVS' }, { from: mvMon.key, to: 'MON' }],
};
r = catalogFixPlan(Object.assign({}, mvPlan, { moves: mvPlan.moves.concat([{ from: mvMon.key, to: 'MVS' }]) }), 'копия есть');
check('перенос между «количеством» и поштучной — отказ, ничего не меняется',
  r.ok === false && /способ учёта/.test(r.message) && !categories().some(c => c.code === 'MVS'), r.message);
r = catalogFixPlan(Object.assign({}, mvPlan, { moves: [{ from: mvOut.key, to: 'MON' }] }), 'копия есть');
check('перенос модели с вещью на руках — отказ', r.ok === false && /на руках/i.test(r.message), r.message);
r = catalogFixPlan(mvPlan, 'копия есть');
const mvTripodKey = r.keys && r.keys[mvTripod.key];
const mvMonKey = r.keys && r.keys[mvMon.key];
check('новая категория создана, штатив переехал в неё', r.ok === true && categories().some(c => c.code === 'MVS') &&
  /^MVS-\d\d$/.test(mvTripodKey || '') && rowsOf('Models').some(m => catalogFixKey(m.category, m.model_code) === mvTripodKey), r.message);
const mvMonCode = (mvMonKey || '').split('-')[1];
check('монитор переехал в MON, старой модели нет', /^MON-\d\d$/.test(mvMonKey || '') &&
  !rowsOf('Models').some(m => catalogFixKey(m.category, m.model_code) === mvMon.key), r.keys);
check('вещи монитора перенумерованы под MON', rowsOf('Equipment').filter(u => u.category === 'MON' && pad2(u.model_code) === mvMonCode).length === 2);
check('выдача и строка заказа переписаны на новые номера', !rowsOf('Transactions').some(t => t.item_id === mvMon.ids[0]) &&
  rowsOf('OrderItems').some(l => String(l.order_id) === '9923' && l.category === 'MON' && pad2(l.model_code) === mvMonCode));
r = catalogFixPlan(mvPlan, 'копия есть');
check('повторный перенос ничего не делает', r.ok === true && r.counts.moves === 0 && r.counts.categories === 0, r.message);
appendRow(sh('Transactions'), { transaction_id: 9924, item_id: mvOut.ids[0], status: 'Closed' });
updateRow(sh('Transactions'), findRowByValue(sh('Transactions'), 'transaction_id', 9921).__row, { status: 'Closed' });

console.log('-- удаление категории после переноса --');
createCategory('DLA', 'ДЛ Старая', false);
createCategory('DLB', 'ДЛ Новая', false);
createCategory('DLC', 'ДЛ Занятая', false);
const dlX = kfModel('DLA', 'ДЛ Модель', 2);
const dlY = kfModel('DLC', 'ДЛ Остаток', 1);
const dlNum = categories().filter(c => c.code === 'DLA')[0].num;
appendRow(sh('ImportRules'), { category: 'DLA', match: 'name', keywords: 'дл-модель' });
updateRow(sh('Equipment'), findRowByValue(sh('Equipment'), 'item_id', dlX.ids[0]).__row, { name: 'ДЛ Старое имя' });
const dlCounters = () => rowsOf('Meta').filter(m => String(m.key).indexOf('unit_' + dlNum) === 0).length;
const dlPlan = { sync_unit_names: true, moves: [{ from: dlX.key, to: 'DLB' }], delete_categories: ['DLA'] };

check('категория со вещами: просмотр называет её, счётчик и правило', (() => {
  const t = catalogFixTodo(dlPlan);
  return t.errors.length === 0 && t.counts.deleted_categories === 1 && t.counts.deleted_counters === 1 &&
    t.counts.deleted_rules === 1 && t.counts.moves === 1;
})(), catalogFixTodo(dlPlan).errors);
const dlBefore = JSON.stringify(dumpSheet('Categories')) + JSON.stringify(dumpSheet('Models'));
r = catalogFixPlan({ delete_categories: ['DLA', 'DLC'] }, 'копия есть');
check('непустая категория — отказ всего плана, ничего не тронуто',
  r.ok === false && /DLC/.test(r.message) && /DLA/.test(r.message) && /не пуста/.test(r.message) &&
  dlBefore === JSON.stringify(dumpSheet('Categories')) + JSON.stringify(dumpSheet('Models')), r.message);

r = catalogFixPlan(dlPlan, 'копия есть');
check('категория, опустевшая переносом в том же плане, удалена',
  r.ok === true && r.counts.deleted_categories === 1 && !categories().some(c => c.code === 'DLA') &&
  categories().some(c => c.code === 'DLB' || c.code === 'DLC'), r.message);
check('счётчики Meta и правило импорта этой категории убраны',
  dlCounters() === 0 && !rowsOf('ImportRules').some(x => x.category === 'DLA') && r.counts.deleted_rules === 1, r.counts);
check('вещи переехали в DLB и получили имя модели после переноса (sync после moves)',
  rowsOf('Equipment').filter(u => u.category === 'DLB').length === 2 &&
  rowsOf('Equipment').filter(u => u.category === 'DLB').every(u => u.name === 'ДЛ Модель'), r.message);
check('чужая категория DLC и её модель на месте', categories().some(c => c.code === 'DLC') &&
  rowsOf('Models').some(m => catalogFixKey(m.category, m.model_code) === dlY.key));
r = catalogFixPlan(dlPlan, 'копия есть');
check('повтор: категория названа «нет в таблице», не отказ, всё по нулям',
  r.ok === true && Object.keys(r.counts).every(k => r.counts[k] === 0) && /категория DLA \(удалить\)/.test(r.message), r.message);

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

console.log('\n== праздничные темы сайта: тумблер главного администратора ==');
const seasonOwner = call('/auth/login', { login: 'Matvey', pin: '432143' }).data.token;
const seasonAdmin = call('/auth/login', { login: 'updadmin', pin: '888888' }).data.token;
check('по умолчанию темы включены', call('/public/announcements', {}).data.seasons === true);
check('главный администратор выключает',
  call('/settings/set', { settings: { site_seasons: 0 } }, seasonOwner).ok === true &&
  call('/public/announcements', {}).data.seasons === false);
{
  const adminNotOwner = call('/settings/set', { settings: { site_seasons: 1 } }, seasonAdmin);
  check('обычный администратор — отказ', adminNotOwner.status === 400 &&
    /главный администратор/.test(adminNotOwner.error), adminNotOwner);
}
{
  const sumAdmin = call('/settings/get', {}, seasonOwner).data.summary;
  check('администратору — последние записи журнала, свежие первыми',
    Array.isArray(sumAdmin.logs_recent) && sumAdmin.logs_recent.length <= 5 &&
    sumAdmin.logs_recent.length === Math.min(5, sumAdmin.logs_24h) &&
    (sumAdmin.logs_recent.length < 2 || sumAdmin.logs_recent[0].at >= sumAdmin.logs_recent[1].at), sumAdmin.logs_recent);
}
check('и включает обратно',
  call('/settings/set', { settings: { site_seasons: 1 } }, seasonOwner).ok === true &&
  call('/public/announcements', {}).data.seasons === true);

console.log('\n== свежая копия документа недоступна в первую секунду ==');
{
  const realOpen = DocumentApp.openById;
  let calls = 0;
  DocumentApp.openById = (id) => {
    calls += 1;
    if (calls < 3) throw new Error('Auf das Dokument kann nicht zugegriffen werden. Bitte versuchen Sie es später noch einmal.');
    return { id };
  };
  check('openDoc повторяет и дожидается документа', openDoc('d1').id === 'd1' && calls === 3, calls);
  calls = -10;
  let thrown = null;
  try { openDoc('d2'); } catch (e) { thrown = e; }
  check('после всех попыток — та же ошибка наружу', thrown && /nicht zugegriffen/.test(thrown.message), calls);
  DocumentApp.openById = () => { calls = 100; throw new Error('Exception: not found'); };
  thrown = null;
  try { openDoc('d3'); } catch (e) { thrown = e; }
  check('другая ошибка — без повторов', thrown && calls === 100);
  DocumentApp.openById = realOpen;
}

console.log('\n== нет разрешения Google: понятная фраза вместо страницы на языке аккаунта ==');
check('немецкий отказ DocumentApp → что нажать',
  /setupTriggers/.test(missingScopeHint(new Error('Sie haben nicht die erforderliche Berechtigung, DocumentApp.openById anzurufen.'))));
check('английский отказ DriveApp → тоже',
  /DriveApp/.test(missingScopeHint(new Error('You do not have permission to call DriveApp.getFileById. Required permissions: …'))));
check('обычная ошибка не подменяется', missingScopeHint(new Error('Cannot read properties of undefined')) === '');

console.log('\n== My rent: объявления студентов через бота ==');
{
  const botKey = webhookSecret('123:ABC');
  const WH = -1001234567890;
  scriptProps.TELEGRAM_BOT_TOKEN = '123:ABC';
  metaSet('setting_notify_chat_id', String(WH));
  metaSet('setting_notify_thread_orders', '');
  metaSet('setting_site_url', 'https://example.test/');
  const base = { bot_key: botKey, tg_id: 777, tg_username: '@student_a', tg_name: 'Аня',
    category: 'CAM', title: 'Sony A7 <Kit>', description: 'Как новая', price: 3000, photo_file_id: 'FILE-1' };
  const mySheet = () => readRows(getSheet(SHEETS.MYRENT));
  const calls = (m) => sent.filter((x) => new RegExp('/' + m + '$').test(x.url)).map((x) => JSON.parse(x.opts.payload));

  check('вкладка MyRent создана', !!spreadsheet.getSheetByName('MyRent'));
  check('submit без bot_key — 403', call('/myrent/submit', Object.assign({}, base, { bot_key: '' })).status === 403);
  check('submit с чужим bot_key — 403', call('/myrent/submit', Object.assign({}, base, { bot_key: 'x'.repeat(32) })).status === 403);
  check('decide с чужим bot_key — 403', call('/myrent/decide', { bot_key: 'bad', id: 'S-0001', decision: 'approve', chat_id: WH }).status === 403);
  scriptProps.TELEGRAM_BOT_TOKEN = '';
  check('без токена бота ключ не проходит — 403', call('/myrent/submit', Object.assign({}, base, { bot_key: '' })).status === 403);
  scriptProps.TELEGRAM_BOT_TOKEN = '123:ABC';
  check('пустая таблица /public/my', JSON.stringify(call('/public/my').data.items) === '[]');
  // Категории My rent — каталог склада плюс «Разгрузка» и «Студийное» (решение
  // владельца 7 октября 2026), по алфавиту подписей.
  const myCats = call('/public/my').data.categories;
  check('/public/my: категории каталога плюс UNL и STD',
    myCats.length === categories().length + 2 && myCats.some((c) => c.code === 'UNL' && c.label === 'Разгрузка') &&
    myCats.some((c) => c.code === 'STD') && myCats.some((c) => c.code === 'CAM'), myCats);
  check('/public/my: категории по алфавиту',
    myCats.every((c, i) => i === 0 || myCats[i - 1].label.localeCompare(c.label, 'ru') <= 0), myCats.map((c) => c.label));

  check('чужая категория — 400', call('/myrent/submit', Object.assign({}, base, { category: 'XXX' })).status === 400);
  check('пустое название — 400', call('/myrent/submit', Object.assign({}, base, { title: ' ' })).status === 400);
  check('цена дробная — 400', call('/myrent/submit', Object.assign({}, base, { price: 10.5 })).status === 400);
  check('нет фото — 400', call('/myrent/submit', Object.assign({}, base, { photo_file_id: '' })).status === 400);
  check('нет username — 400', call('/myrent/submit', Object.assign({}, base, { tg_username: '' })).status === 400);
  check('ничего не записано после отказов', mySheet().length === 0);

  sent.length = 0;
  let sub = call('/myrent/submit', base);
  check('submit — S-0001 сразу approved', sub.ok && sub.data.id === 'S-0001' && sub.data.status === 'approved', sub);
  let row = mySheet()[0];
  check('строка approved, approved_at записан, username без @',
    row && row.status === 'approved' && !!row.approved_at && row.removed_by === '' && row.tg_username === 'student_a', row);
  check('фото в Диске, открыто по ссылке',
    /^https:\/\/drive\.google\.com\/thumbnail\?id=file-\d+&sz=w800$/.test(row.photo) &&
    drive.folders['Mifs Rent — фото'].files.some((f) => /^S-0001-.+\.jpg$/.test(f.name) && f.sharing && f.sharing[0] === 'ANYONE_WITH_LINK'));
  const mod = calls('sendPhoto');
  check('информационная карточка в чат склада одним sendPhoto', mod.length === 1 && String(mod[0].chat_id) === String(WH) && mod[0].photo === 'FILE-1', mod);
  check('одна кнопка «🗑 Снять» myr:x:S-0001',
    mod[0].reply_markup.inline_keyboard.length === 1 && mod[0].reply_markup.inline_keyboard[0].length === 1 &&
    mod[0].reply_markup.inline_keyboard[0][0].callback_data === 'myr:x:S-0001' && /Снять/.test(mod[0].reply_markup.inline_keyboard[0][0].text),
    mod[0].reply_markup);
  check('подпись «My rent · новое», экранирование, цена, @username',
    /My rent · новое/.test(mod[0].caption) && !/модерац/.test(mod[0].caption) &&
    /Sony A7 &lt;Kit&gt;/.test(mod[0].caption) && /3 000 ₽\/сутки/.test(mod[0].caption) && /@student_a/.test(mod[0].caption), mod[0].caption);
  check('mod_chat_id и mod_message_id записаны', String(row.mod_chat_id) === String(WH) && String(row.mod_message_id) !== '', row);

  const pub = call('/public/my').data;
  check('submit → сразу видно в /public/my в форме my.json',
    pub.items.length === 1 && pub.items[0].key === 'S-0001' && pub.items[0].name === 'Sony A7 <Kit>' &&
    pub.items[0].offers[0].tg === 'student_a' && pub.items[0].offers[0].price === 3000 &&
    pub.items[0].offers[0].qty === 1 && pub.items[0].photo === false && /thumbnail/.test(pub.items[0].photo_url), pub.items);
  check('tg_id наружу не уходит', JSON.stringify(call('/public/my')).indexOf('777') === -1);

  sent.length = 0;
  sub = call('/myrent/submit', base);
  check('повторный submit — тот же id, строка одна, чат молчит',
    sub.ok && sub.data.id === 'S-0001' && mySheet().length === 1 && calls('sendPhoto').length === 0 && calls('getFile').length === 0, sub);

  const second = call('/myrent/submit', Object.assign({}, base, { title: 'Штатив', price: null, photo_file_id: 'FILE-2', category: 'GRP' }));
  check('второе объявление — S-0002 approved', second.ok && second.data.id === 'S-0002' && second.data.status === 'approved', second);
  check('цена пустая → «Договорная»', mySheet()[1].price === '' && mySheet()[1].price_text === 'Договорная');
  check('в подписи «Договорная»', /Цена: Договорная/.test(calls('sendPhoto').pop().caption));
  const third = call('/myrent/submit', Object.assign({}, base, { title: 'Третий', photo_file_id: 'FILE-3' }));
  check('новые сверху', call('/public/my').data.items.map((i) => i.key).join() === 'S-0003,S-0002,S-0001');

  console.log('\n-- My rent: «Снять» из чата склада --');
  const tk = (extra) => Object.assign({ bot_key: botKey, id: 'S-0001', chat_id: WH, by: '@owner' }, extra);
  const byId = (id) => mySheet().filter((r) => r.id === id)[0];
  const pubKeys = () => call('/public/my').data.items.map((i) => i.key).join();
  check('takedown с чужим bot_key — 403', call('/myrent/takedown', tk({ bot_key: 'bad' })).status === 403);
  check('takedown из чужого чата — 403', call('/myrent/takedown', tk({ chat_id: -555 })).status === 403);
  check('takedown без chat_id — 403', call('/myrent/takedown', tk({ chat_id: undefined })).status === 403);
  check('takedown неизвестного id — 404', call('/myrent/takedown', tk({ id: 'S-9999' })).status === 404);
  check('после отказов объявление на месте', byId('S-0001').status === 'approved' && pubKeys() === 'S-0003,S-0002,S-0001');

  sent.length = 0;
  let td = call('/myrent/takedown', tk());
  check('takedown — removed, repeat false', td.ok && td.data.status === 'removed' && td.data.repeat === false, td);
  row = byId('S-0001');
  check('removed_by admin, removed_at и решивший записаны',
    row.status === 'removed' && row.removed_by === 'admin' && !!row.removed_at && row.decided_by === '@owner', row);
  check('скрыто с сайта', pubKeys() === 'S-0003,S-0002');
  const ed = calls('editMessageCaption');
  check('подпись «Снято — @owner», кнопки сняты',
    ed.length === 1 && /🗑 Снято — @owner/.test(ed[0].caption) && ed[0].reply_markup.inline_keyboard.length === 0 &&
    Number(ed[0].message_id) === Number(row.mod_message_id), ed);
  const toStudent = calls('sendMessage').filter((m) => String(m.chat_id) === '777');
  check('студенту — «снято администратором»',
    toStudent.length === 1 && /Ваше объявление «Sony A7 &lt;Kit&gt;» снято администратором/.test(toStudent[0].text), toStudent);

  sent.length = 0;
  td = call('/myrent/takedown', tk({ by: '@other' }));
  check('повторный takedown — repeat:true, ничего не отправлено',
    td.ok && td.data.repeat === true && td.data.status === 'removed' && sent.length === 0 && byId('S-0001').decided_by === '@owner', td);

  console.log('\n-- My rent: студент и снятое админом --');
  const stu = (extra) => Object.assign({ bot_key: botKey, tg_id: 777 }, extra);
  sent.length = 0;
  let rs = call('/myrent/restore', stu({ id: 'S-0001' }));
  check('студент возвращает снятое админом — 403 с текстом',
    rs.status === 403 && /снято администратором/.test(rs.error), rs);
  const up403 = call('/myrent/update', stu({ id: 'S-0001', changes: { title: 'Ещё' } }));
  check('студент правит снятое админом — 403', up403.status === 403 && /снято администратором/.test(up403.error), up403);
  const rm403 = call('/myrent/remove', stu({ id: 'S-0001' }));
  check('студент «снимает» снятое админом — repeat, removed_by остаётся admin',
    rm403.ok && rm403.data.repeat === true && byId('S-0001').removed_by === 'admin', rm403);
  check('после отказов скрыто и чат молчит', byId('S-0001').status === 'removed' && pubKeys() === 'S-0003,S-0002' && sent.length === 0);

  console.log('\n-- My rent: старые карточки «Одобрить/Отклонить» --');
  // Строки, созданные до отмены модерации: pending с живой карточкой.
  updateRow(getSheet(SHEETS.MYRENT), byId('S-0003').__row, { status: 'pending', mod_chat_id: String(WH), mod_message_id: '900' });
  check('pending не виден на сайте (как раньше)', pubKeys() === 'S-0002');
  check('decide с чужим bot_key — 403', call('/myrent/decide', { bot_key: 'bad', id: 'S-0003', decision: 'approve', chat_id: WH }).status === 403);
  check('decide из чужого чата — 403', call('/myrent/decide', { bot_key: botKey, id: 'S-0003', decision: 'reject', chat_id: -555, by: '@x' }).status === 403);
  check('decide без chat_id — 403', call('/myrent/decide', { bot_key: botKey, id: 'S-0003', decision: 'approve' }).status === 403);
  check('decide неизвестного id — 404', call('/myrent/decide', { bot_key: botKey, id: 'S-9999', decision: 'approve', chat_id: WH }).status === 404);
  sent.length = 0;
  let dec = call('/myrent/decide', { bot_key: botKey, id: 'S-0003', decision: 'approve', chat_id: WH, by: '@owner' });
  check('старое «Одобрить» публикует поданное до отмены модерации',
    dec.ok && dec.data.repeat === false && dec.data.status === 'approved' && byId('S-0003').status === 'approved' &&
    calls('editMessageCaption').length === 1 && /Опубликовано/.test(calls('editMessageCaption')[0].caption), dec);
  dec = call('/myrent/decide', { bot_key: botKey, id: 'S-0003', decision: 'approve', chat_id: WH, by: '@owner' });
  check('повторное «Одобрить» — repeat', dec.ok && dec.data.repeat === true && dec.data.status === 'approved', dec);
  sent.length = 0;
  dec = call('/myrent/decide', { bot_key: botKey, id: 'S-0003', decision: 'reject', chat_id: WH, by: '@owner' });
  check('старое «Отклонить» — снятие админом', dec.ok && dec.data.status === 'removed' && dec.data.repeat === false &&
    byId('S-0003').removed_by === 'admin', dec);
  check('карточка закрыта, студенту про снятие',
    calls('editMessageCaption').length === 1 && Number(calls('editMessageCaption')[0].message_id) === 900 &&
    calls('sendMessage').filter((m) => String(m.chat_id) === '777' && /снято администратором/.test(m.text)).length === 1);
  dec = call('/myrent/decide', { bot_key: botKey, id: 'S-0003', decision: 'reject', chat_id: WH, by: '@owner' });
  check('повторное «Отклонить» — repeat', dec.ok && dec.data.repeat === true && dec.data.status === 'removed', dec);

  console.log('\n-- My rent: свои объявления, правка, снятие --');
  // Дальше: S-0001 и S-0003 снято админом, S-0002 опубликовано; все студента 777.
  check('mine с чужим bot_key — 403', call('/myrent/mine', { bot_key: 'bad', tg_id: 777 }).status === 403);
  check('mine без tg_id — 400', call('/myrent/mine', { bot_key: botKey }).status === 400);
  let mine = call('/myrent/mine', stu());
  check('mine: свои, новые сверху', mine.ok && mine.data.items.map((i) => i.id).join() === 'S-0003,S-0002,S-0001', mine);
  check('mine: форма записи', (() => {
    const i = mine.data.items[2];
    return i.status === 'removed' && i.category === 'CAM' && i.category_label === categories().filter((c) => c.code === 'CAM')[0].label && i.title === 'Sony A7 <Kit>' &&
      i.price === 3000 && i.photo_file_id === 'FILE-1' && !!i.created_at && !!i.updated_at && !('tg_id' in i);
  })(), mine.data.items[2]);
  check('mine: removed_by — admin у снятого, пусто у опубликованного',
    mine.data.items[2].removed_by === 'admin' && mine.data.items[0].removed_by === 'admin' && mine.data.items[1].removed_by === '' &&
    mine.data.items[1].status === 'approved', mine.data.items.map((i) => [i.id, i.removed_by]));
  check('mine: у второй цена null и «Договорная»', mine.data.items[1].price === null && mine.data.items[1].price_text === 'Договорная');
  check('mine чужого студента — пусто', JSON.stringify(call('/myrent/mine', stu({ tg_id: 888 })).data.items) === '[]');

  // чужой tg_id — 404 на любой ручке, ничего не меняется
  const snapshot = JSON.stringify(mySheet());
  sent.length = 0;
  check('update чужого — 404', call('/myrent/update', stu({ tg_id: 888, id: 'S-0002', changes: { title: 'Взлом' } })).status === 404);
  check('remove чужого — 404', call('/myrent/remove', stu({ tg_id: 888, id: 'S-0002' })).status === 404);
  check('restore чужого — 404', call('/myrent/restore', stu({ tg_id: 888, id: 'S-0002' })).status === 404);
  check('update несуществующего — 404', call('/myrent/update', stu({ id: 'S-9999', changes: { title: 'x' } })).status === 404);
  check('после 404 таблица и чат не тронуты', JSON.stringify(mySheet()) === snapshot && sent.length === 0);

  // проверка полей правки
  check('правка: чужая категория — 400', call('/myrent/update', stu({ id: 'S-0002', changes: { category: 'XXX' } })).status === 400);
  check('правка: пустое название — 400', call('/myrent/update', stu({ id: 'S-0002', changes: { title: ' ' } })).status === 400);
  check('правка: дробная цена — 400', call('/myrent/update', stu({ id: 'S-0002', changes: { price: 1.5 } })).status === 400);
  check('правка: без changes — 400', call('/myrent/update', stu({ id: 'S-0002' })).status === 400);
  check('после отказов правки статус прежний', byId('S-0002').status === 'approved' && sent.length === 0);

  // правка применяется сразу
  const oldMsg = Number(byId('S-0002').mod_message_id);
  sent.length = 0;
  let up = call('/myrent/update', stu({ id: 'S-0002', tg_username: '@student_new', changes: { title: 'Штатив Pro', price: 4000 } }));
  check('update — approved сразу, repeat false', up.ok && up.data.status === 'approved' && up.data.repeat === false, up);
  row = byId('S-0002');
  check('правка записана, username обновлён',
    row.status === 'approved' && row.title === 'Штатив Pro' && row.price === 4000 && row.price_text === '' &&
    !!row.approved_at && !!row.updated_at && row.tg_username === 'student_new', row);
  check('правка сразу на сайте', call('/public/my').data.items.filter((i) => i.key === 'S-0002')[0].name === 'Штатив Pro' && pubKeys() === 'S-0002');
  let cards = calls('sendPhoto');
  check('новая карточка «правка» с кнопкой «Снять»',
    cards.length === 1 && /My rent · правка/.test(cards[0].caption) && /Штатив Pro/.test(cards[0].caption) &&
    cards[0].reply_markup.inline_keyboard[0][0].callback_data === 'myr:x:S-0002' && cards[0].photo === 'FILE-2', cards);
  const closed = calls('editMessageCaption');
  check('кнопка прежней карточки снята, «заменено правкой»',
    closed.length === 1 && Number(closed[0].message_id) === oldMsg && closed[0].reply_markup.inline_keyboard.length === 0 &&
    /Заменено правкой/.test(closed[0].caption), closed);
  check('mod_message_id указывает на новую карточку', Number(byId('S-0002').mod_message_id) !== oldMsg && String(byId('S-0002').mod_message_id) !== '');

  // правка без изменений
  sent.length = 0;
  up = call('/myrent/update', stu({ id: 'S-0002', changes: { title: 'Штатив Pro', price: 4000, category: 'grp' } }));
  check('правка без изменений — repeat, карточки нет',
    up.ok && up.data.repeat === true && up.data.status === 'approved' && calls('sendPhoto').length === 0 && calls('getFile').length === 0, up);

  // смена фото: скачано заново, старый свой файл в корзине
  const photoFiles = () => drive.folders['Mifs Rent — фото'].files;
  const oldPhotoId = photoIdFromUrl(byId('S-0002').photo);
  sent.length = 0;
  up = call('/myrent/update', stu({ id: 'S-0002', changes: { photo_file_id: 'FILE-9' } }));
  row = byId('S-0002');
  check('смена фото — новый file_id и файл в Диске, остаётся на сайте',
    up.ok && row.status === 'approved' && row.photo_file_id === 'FILE-9' && calls('getFile').length === 1 &&
    photoIdFromUrl(row.photo) !== oldPhotoId && photoFiles().some((f) => f.id === photoIdFromUrl(row.photo) && !f.trashed) &&
    pubKeys() === 'S-0002', row);
  check('старое фото в корзине', photoFiles().filter((f) => f.id === oldPhotoId)[0].trashed === true);
  check('карточка ушла с новым file_id', calls('sendPhoto').length === 1 && calls('sendPhoto')[0].photo === 'FILE-9');

  // старая отклонённая строка после правки автора становится опубликованной
  updateRow(getSheet(SHEETS.MYRENT), byId('S-0002').__row, { status: 'rejected' });
  check('rejected не виден на сайте', pubKeys() === '');
  up = call('/myrent/update', stu({ id: 'S-0002', changes: { description: 'Новое описание' } }));
  check('правка старого rejected — approved и на сайте', up.ok && up.data.status === 'approved' && byId('S-0002').status === 'approved' && pubKeys() === 'S-0002', up);

  // снять автором и выставить снова — сразу
  sent.length = 0;
  let rm = call('/myrent/remove', stu({ id: 'S-0002' }));
  check('remove — removed, repeat false', rm.ok && rm.data.status === 'removed' && rm.data.repeat === false, rm);
  check('снятое скрыто, removed_by author', pubKeys() === '' && !!byId('S-0002').removed_at && byId('S-0002').removed_by === 'author');
  const gone = calls('editMessageCaption');
  check('карточка в чате: «снято автором», кнопки сняты',
    gone.length === 1 && /Снято автором/.test(gone[0].caption) && gone[0].reply_markup.inline_keyboard.length === 0, gone);
  rm = call('/myrent/remove', stu({ id: 'S-0002' }));
  check('повторное remove — repeat', rm.ok && rm.data.repeat === true && rm.data.status === 'removed', rm);
  check('update на снятом автором — 409', call('/myrent/update', stu({ id: 'S-0002', changes: { title: 'Ещё' } })).status === 409);
  sent.length = 0;
  rs = call('/myrent/restore', stu({ id: 'S-0002' }));
  check('restore снятого автором — сразу approved и на сайте',
    rs.ok && rs.data.status === 'approved' && rs.data.repeat === false && pubKeys() === 'S-0002', rs);
  check('removed_at и removed_by очищены', byId('S-0002').removed_at === '' && byId('S-0002').removed_by === '');
  cards = calls('sendPhoto');
  check('при возврате — новая карточка со «Снять»', cards.length === 1 && cards[0].reply_markup.inline_keyboard[0][0].callback_data === 'myr:x:S-0002', cards);
  rs = call('/myrent/restore', stu({ id: 'S-0002' }));
  check('restore не снятого — repeat, статус прежний', rs.ok && rs.data.repeat === true && rs.data.status === 'approved', rs);

  console.log('\n-- My rent: администратор в приложении --');
  const adm = call('/auth/login', { login: 'matvey', pin: '432143' }).data.token;
  const staffTok = call('/auth/login', { login: 'modeledit', pin: '246802' }).data.token;
  const ids = ['/myrent/admin/list', '/myrent/admin/save', '/myrent/admin/photo', '/myrent/admin/remove', '/myrent/admin/restore'];
  ids.forEach((ep) => {
    check(ep + ': без токена — 401', call(ep, { id: 'S-0002' }).status === 401);
    check(ep + ': сотруднику — 403', call(ep, { id: 'S-0002', changes: {}, image: '' }, staffTok).status === 403);
  });

  const al = call('/myrent/admin/list', {}, adm);
  check('admin/list: все строки, новые сверху, категории как у /public/my',
    al.ok && al.data.items.map((i) => i.id).join() === 'S-0003,S-0002,S-0001' && al.data.categories.length === categories().length + 2, al);
  check('admin/list: форма записи, tg_id не выходит', (() => {
    const i = al.data.items[2];
    return i.status === 'removed' && i.removed_by === 'admin' && i.category_label === categories().filter((c) => c.code === 'CAM')[0].label && i.price === 3000 &&
      /thumbnail/.test(i.photo) && i.tg_username === 'student_a' && i.tg_name === 'Аня' && !!i.created_at && !!i.updated_at;
  })() && JSON.stringify(al).indexOf('777') === -1, al.data.items[2]);

  sent.length = 0;
  const preStatus = byId('S-0002').status;
  let sv = call('/myrent/admin/save', { id: 'S-0002', changes: { title: '  Штатив Админ ', category: 'cam', description: 'Правка админа', price: null } }, adm);
  row = byId('S-0002');
  check('admin/save: применено сразу, статус не тронут',
    sv.ok && sv.data.id === 'S-0002' && sv.data.status === preStatus && row.title === 'Штатив Админ' && row.category === 'CAM' &&
    row.description === 'Правка админа' && row.price === '' && row.price_text === 'Договорная' && row.status === preStatus, row);
  check('admin/save: студент не получает сообщений, карточки нет', sent.length === 0);
  check('admin/save: сразу в /public/my', call('/public/my').data.items.filter((i) => i.key === 'S-0002')[0].name === 'Штатив Админ');
  check('admin/save: чужая категория — 400', call('/myrent/admin/save', { id: 'S-0002', changes: { category: 'XXX' } }, adm).status === 400);
  check('admin/save: пустое название — 400', call('/myrent/admin/save', { id: 'S-0002', changes: { title: ' ' } }, adm).status === 400);
  check('admin/save: дробная цена — 400', call('/myrent/admin/save', { id: 'S-0002', changes: { price: 1.5 } }, adm).status === 400);
  check('admin/save: без changes — 400', call('/myrent/admin/save', { id: 'S-0002' }, adm).status === 400);
  check('admin/save: неизвестный id — 404', call('/myrent/admin/save', { id: 'S-9999', changes: { title: 'x' } }, adm).status === 404);
  sv = call('/myrent/admin/save', { id: 'S-0001', changes: { title: 'Снятое, но правится' } }, adm);
  check('admin/save: снятое правится, остаётся снятым', sv.ok && sv.data.status === 'removed' && byId('S-0001').status === 'removed', sv);

  const b64 = (arr) => 'data:image/jpeg;base64,' + Buffer.from(arr).toString('base64');
  const jpg = (n) => b64([0xFF, 0xD8, 0xFF, 0xE0].concat(new Array(n || 40).fill(7)));
  const oldAdm = photoIdFromUrl(byId('S-0002').photo);
  const oldFileId = byId('S-0002').photo_file_id;
  let ph = call('/myrent/admin/photo', { id: 'S-0002', image: jpg() }, adm);
  check('admin/photo: фото сохранено, ссылка в строке',
    ph.ok && /^https:\/\/drive\.google\.com\/thumbnail\?id=file-\d+&sz=w800$/.test(ph.data.photo) && byId('S-0002').photo === ph.data.photo, ph);
  check('admin/photo: файл открыт по ссылке, старый в корзине, photo_file_id прежний',
    photoFiles().some((f) => f.id === photoIdFromUrl(ph.data.photo) && !f.trashed && f.sharing[0] === 'ANYONE_WITH_LINK') &&
    photoFiles().filter((f) => f.id === oldAdm)[0].trashed === true && byId('S-0002').photo_file_id === oldFileId);
  check('admin/photo: сразу в /public/my', call('/public/my').data.items.filter((i) => i.key === 'S-0002')[0].photo_url === ph.data.photo);
  check('admin/photo: не data URL — 400', call('/myrent/admin/photo', { id: 'S-0002', image: 'https://x.y/a.jpg' }, adm).status === 400);
  check('admin/photo: пусто — 400', call('/myrent/admin/photo', { id: 'S-0002', image: '' }, adm).status === 400);
  check('admin/photo: не картинка — 400',
    call('/myrent/admin/photo', { id: 'S-0002', image: b64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) }, adm).status === 400);
  check('admin/photo: больше 700 КБ — 413', call('/myrent/admin/photo', { id: 'S-0002', image: jpg(701 * 1024) }, adm).status === 413);
  const filesBefore = photoFiles().length;
  check('admin/photo: неизвестный id — 404, файл не создан',
    call('/myrent/admin/photo', { id: 'S-9999', image: jpg() }, adm).status === 404 && photoFiles().length === filesBefore);

  sent.length = 0;
  let ar = call('/myrent/admin/remove', { id: 'S-0002' }, adm);
  check('admin/remove — removed, removed_by admin', ar.ok && ar.data.status === 'removed' && ar.data.repeat === false &&
    byId('S-0002').removed_by === 'admin' && pubKeys() === '', ar);
  check('admin/remove: карточка закрыта, студенту про снятие',
    calls('editMessageCaption').length === 1 && /Снято/.test(calls('editMessageCaption')[0].caption) &&
    calls('sendMessage').filter((m) => String(m.chat_id) === '777' && /снято администратором/.test(m.text)).length === 1);
  check('admin/remove: студент вернуть не может', call('/myrent/restore', stu({ id: 'S-0002' })).status === 403);
  ar = call('/myrent/admin/remove', { id: 'S-0002' }, adm);
  check('admin/remove повторно — repeat', ar.ok && ar.data.repeat === true, ar);
  check('admin/remove: неизвестный id — 404', call('/myrent/admin/remove', { id: 'S-9999' }, adm).status === 404);

  sent.length = 0;
  ar = call('/myrent/admin/restore', { id: 'S-0002' }, adm);
  check('admin/restore — approved, на сайте, removed_by очищен',
    ar.ok && ar.data.status === 'approved' && byId('S-0002').removed_by === '' && pubKeys() === 'S-0002', ar);
  check('admin/restore: новая карточка в чате', calls('sendPhoto').length === 1 &&
    calls('sendPhoto')[0].reply_markup.inline_keyboard[0][0].callback_data === 'myr:x:S-0002');
  ar = call('/myrent/admin/restore', { id: 'S-0001' }, adm);
  check('admin/restore снятого админом S-0001 — approved', ar.ok && ar.data.status === 'approved' && pubKeys() === 'S-0002,S-0001', ar);
  check('admin/restore: неизвестный id — 404', call('/myrent/admin/restore', { id: 'S-9999' }, adm).status === 404);
  check('admin/restore не снятого — repeat', call('/myrent/admin/restore', { id: 'S-0002' }, adm).data.repeat === true);

  metaSet('setting_site_url', '');
}

console.log('\n== замок ==');
check('вложенных захватов замка не было', lockState.nested === 0, lockState);
check('все замки отпущены', lockState.depth === 0, lockState);

console.log('\n' + (failures ? '❌ ПРОВАЛОВ: ' + failures : '✅ Все проверки пройдены'));
process.exit(failures ? 1 : 0);
