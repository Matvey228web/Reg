// Тема и сезон. Подключается в <head> каждой страницы сразу после style.css, до
// отрисовки: иначе страница мигала бы обычным видом перед праздничным или
// тёмным перед светлым. Один файл вместо копий скрипта в трёх html.
//
// 1. Светлая/тёмная тема: data-theme на <html>, выбор в localStorage `mifs_theme`
//    (по умолчанию тёмная). Кнопку-переключатель ставит common.js.
// 2. Сезонная тема по календарю: data-season на <html> и файл themes/<id>.css,
//    подгружаемый только пока тема активна, — вес обычной страницы не растёт.
//
// Календарь — здесь, в одном месте. Первая подошедшая запись выигрывает, поэтому
// порядок = приоритет (День кино лежит внутри новогоднего окна и стоит выше).
// Даты — «месяц-день», без года; период может переходить через Новый год.
// Время берётся с часов посетителя. Изменили календарь или файл темы — поднимите
// ?v= у этого скрипта в трёх html.
(function () {
  var VERSION = "20261001j";

  var CALENDAR = [
    { id: "cinema", label: "День кино", from: "12-29", to: "12-29", color: "#120a0a",
      hero: { title: "С Днём кино!", sub: "Свет, камера, мотор 🎬" } },
    { id: "graduation", label: "Выпускной", from: "06-15", to: "06-30", color: "#0b1226",
      hero: { title: "Поздравляем выпускников!", sub: "Первый большой проект позади 🎓" } },
    { id: "halloween", label: "Хэллоуин", from: "10-25", to: "11-01", color: "#0f0a16",
      hero: { title: "Страшно красивое кино!", sub: "Техника для ваших хорроров 🎃" } },
    { id: "xmas", label: "Новый год", from: "12-15", to: "01-15", color: "#07140f",
      hero: { title: "С Новым годом, киноделы!", sub: "Пусть дубли будут первыми 🎄" } },
  ];

  var root = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  var COLORS = { light: "#f4f3f0", dark: "#0d0d0f" };

  // --- светлая/тёмная ---
  var theme = null;
  try {
    var t = localStorage.getItem("mifs_theme");
    if (t === "light" || t === "dark") theme = t;
  } catch (e) { /* хранилище закрыто — остаётся тёмная */ }
  if (theme) root.setAttribute("data-theme", theme);

  // --- сезон ---
  function inRange(c, md) {
    return c.from <= c.to ? md >= c.from && md <= c.to : md >= c.from || md <= c.to;
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  var season = null;
  try {
    var now = new Date();
    var md = pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    // ?season=<id> показывает тему, ?season=off гасит; ничего не сохраняется:
    // ссылка с параметром — для проверки, а не для постоянной подмены.
    var asked = new URLSearchParams(location.search).get("season");
    if (asked === "off") {
      season = null;
    } else if (asked) {
      CALENDAR.forEach(function (c) { if (c.id === asked) season = c; });
    } else {
      for (var i = 0; i < CALENDAR.length && !season; i++) {
        if (inRange(CALENDAR[i], md)) season = CALENDAR[i];
      }
    }
  } catch (e) { season = null; }

  if (season) {
    root.setAttribute("data-season", season.id);
    // document.write: ссылка встаёт сразу после style.css и блокирует отрисовку,
    // так что страница не мигает, а правила темы идут по каскаду после основных.
    document.write('<link rel="stylesheet" href="themes/' + season.id + '.css?v=' + VERSION + '" />');
  }

  // Для common.js: что за сезон идёт и какое у него приветствие.
  window.MifsSeason = season;

  if (meta) {
    var dark = (season && season.color) || COLORS.dark;
    meta.setAttribute("content", theme === "light" ? COLORS.light : dark);
  }
  window.MifsThemeColors = { light: COLORS.light, dark: (season && season.color) || COLORS.dark };
})();
