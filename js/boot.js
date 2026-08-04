/* NutriDaily — CSP-safe early boot. Loaded synchronously in <head>. */
(function () {
  // Apply the saved theme before first paint. Invalid or unavailable storage
  // falls back to the app's light default.
  try {
    var settings = JSON.parse(localStorage.getItem("nd_settings_v1") || "{}");
    var theme = settings.theme || "light";
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }

  if (navigator.serviceWorker && typeof navigator.serviceWorker.register === "function" &&
      (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
