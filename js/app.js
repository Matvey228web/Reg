// Точка входа приложения: инициализация Telegram WebApp SDK, регистрация экранов,
// выбор стартового экрана в зависимости от наличия действующей сессии.

(function bootstrap() {
  TG.init();

  Router.register("home", {
    onShow() {
      const session = Auth.getSession();
      document.getElementById("home-user").textContent = session
        ? `${session.full_name} · ${session.role === "Admin" ? "Администратор" : "Сотрудник склада"}`
        : "";
      const isAdmin = !!session && session.role === "Admin";
      document.getElementById("home-staff-card").style.display = isAdmin ? "block" : "none";
      document.getElementById("home-settings-card").style.display = isAdmin ? "block" : "none";
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
  RepairScreen.init();
  ClientsScreen.init();
  StaffScreen.init();
  PinScreen.init();
  SettingsScreen.init();

  const session = Auth.requireAuth();
  if (session) Router.reset("home");
})();
