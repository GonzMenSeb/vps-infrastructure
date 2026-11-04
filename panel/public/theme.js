(() => {
  const KEY = "vp-theme";
  const root = document.documentElement;
  try {
    const t = localStorage.getItem(KEY);
    if (t === "light" || t === "dark") root.dataset.theme = t;
  } catch {}
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest("[data-theme-toggle]")) return;
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try {
      localStorage.setItem(KEY, root.dataset.theme);
    } catch {}
  });
})();
