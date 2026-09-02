/*
 * Laeuft blockierend im <head>, bevor der erste Paint passiert — sonst blitzt
 * beim Laden das falsche Theme auf.
 *
 * Gespeichert wird die *Absicht* ("system" | "light" | "dark"), auf <html>
 * landet immer der aufgeloeste Wert. Damit braucht das CSS nur zwei Zustaende
 * und keinen dritten, per Media-Query duplizierten Block.
 */
(function () {
  var STORAGE_KEY = "iso-share-theme";

  var preference;
  try {
    preference = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    // localStorage kann durch Browser-Einstellungen blockiert sein
  }
  if (preference !== "light" && preference !== "dark") {
    preference = "system";
  }

  var resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : preference;

  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
})();
