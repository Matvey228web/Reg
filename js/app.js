// Точка входа приложения: инициализация Telegram WebApp SDK, регистрация экранов,
// выбор стартового экрана в зависимости от наличия действующей сессии.

(function bootstrap() {
  TG.init();

  Router.register("home", {
    onShow() {
      const session = Auth.getSession();
      // Имя крупно, роль строкой ниже: это заголовок экрана, а не подпись.
      document.getElementById("home-user").innerHTML = session
        ? `${escapeHtml(session.full_name)}<span>${session.role === "Admin" ? "Администратор" : "Сотрудник склада"}</span>`
        : "";
      const isAdmin = !!session && session.role === "Admin";
      // Пустая строка, а не "block": раскладку карточки задаёт стиль, а inline
      // display её перебивал — стрелка уезжала под название.
      document.getElementById("home-staff-card").style.display = isAdmin ? "" : "none";
      document.getElementById("home-settings-card").style.display = isAdmin ? "" : "none";
    },
  });

  document.querySelectorAll("#screen-home [data-nav]").forEach((el) => {
    el.addEventListener("click", () => Router.navigate(el.dataset.nav));
  });
  document.getElementById("pin-change-btn").addEventListener("click", () => Router.navigate("pin"));
  document.getElementById("logout-btn").addEventListener("click", () => Auth.logout());

  Router.init();
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

  const session = Auth.requireAuth();
  if (session) Router.reset("home");
})();
