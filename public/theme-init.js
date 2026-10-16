// Apply the saved theme before first paint so there is no flash of the wrong theme or logo.
(function () {
  var dark = false;
  try {
    var pref = localStorage.getItem("typewriter:theme");
    dark = pref === "dark" || (pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch (e) {
    dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
