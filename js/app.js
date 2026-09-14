// Точка входа приложения: инициализация Telegram WebApp SDK, регистрация экранов,
// выбор стартового экрана в зависимости от наличия действующей сессии.

(function bootstrap() {
  TG.init();

  Router.register("home", {
    onShow() {
      const session = Auth.getSession();
      // Имя крупно, роль строкой ниже: это заголовок экрана, а не подпись.
      document.getElementById("home-user").innerHTML = session
        ? `${escapeHtml(session.full_name)}<span>${escapeHtml(roleLabel(session))}</span>`
        : "";
      const isAdmin = !!session && session.role === "Admin";
      // Пустая строка, а не "block": раскладку плитки задаёт стиль, а inline
      // display её перебивал — иконка уезжала от названия.
      document.getElementById("home-staff-card").style.display = isAdmin ? "" : "none";
      // Адрес сайта приходит в сессии вместе с настройками — отдельный запрос
      // ради одной строки стоил бы 5–8 секунд на каждом открытии главной.
      const site = ((session && session.settings) || {}).site_url || "";
      const siteCard = document.getElementById("home-site-card");
      siteCard.style.display = site ? "" : "none";
      siteCard.dataset.url = site;
    },
  });

  document.querySelectorAll("#screen-home [data-nav]").forEach((el) => {
    el.addEventListener("click", () => Router.navigate(el.dataset.nav));
  });
  // Сайт открываем встроенным браузером Telegram: он ложится поверх склада и
  // закрывается свайпом — приложение остаётся под ним, а не перезапускается.
  document.getElementById("home-site-card").addEventListener("click", (e) => {
    const url = e.currentTarget.dataset.url;
    if (url) TG.openLink(url);
  });
  // Настройки — кнопкой в шапке, а не карточкой на главной, и открыты любому
  // вошедшему: смена своего PIN и выход лежат там же, и складскому сотруднику
  // они нужны не реже, чем администратору настройки категорий.
  document.getElementById("appbar-settings")
    .addEventListener("click", () => Router.navigate("settings"));

  Router.init();
  Suggest.init();
  Auth.init();
  CatalogScreen.init();
  ScanScreen.init();
  ItemScreen.init();
  OrderScreen.init();
  RepairScreen.init();
  OrdersScreen.init();
  StaffScreen.init();
  PinScreen.init();
  SettingsScreen.init();
  LabelsScreen.init();
  InventoryScreen.init();

  const session = Auth.requireAuth();
  if (session) Router.reset("home");
})();
