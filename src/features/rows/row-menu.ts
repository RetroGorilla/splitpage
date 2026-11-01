export function closeRowMenus(except?: Element | null) {
  document.querySelectorAll<HTMLElement>("#rows .row-menu:not([hidden])").forEach(function (menu) {
    if (menu === except) return;
    menu.hidden = true;
    const btn = (menu.parentNode as ParentNode).querySelector<HTMLElement>(".row-more");
    if (btn) btn.setAttribute("aria-expanded", "false");
    const row = menu.closest(".row");
    if (row) row.classList.remove("has-menu-open");
  });
}

export function toggleRowMenu(btn: Element, focusFirst?: boolean) {
  const menu = (btn.parentNode as ParentNode).querySelector<HTMLElement>(".row-menu");
  if (!menu) return;
  const opening = menu.hidden;
  closeRowMenus(opening ? menu : null);
  menu.hidden = !opening;
  btn.setAttribute("aria-expanded", opening ? "true" : "false");
  const row = btn.closest(".row");
  if (row) row.classList.toggle("has-menu-open", opening as boolean);
  if (!opening) return;
  menu.classList.remove("opens-up");
  const r = menu.getBoundingClientRect();
  const phoneBar = document.getElementById("phone-bar");
  const floor = window.innerHeight - 8 - (phoneBar ? phoneBar.offsetHeight : 0);
  if (r.bottom > floor && r.top - r.height - (btn as HTMLElement).offsetHeight > 8) menu.classList.add("opens-up");
  if (focusFirst) {
    const first = menu.querySelector<HTMLElement>(".row-menu-item");
    if (first) first.focus();
  }
}

export function rowMenuKeydown(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest) return false;
  if (t.classList.contains("row-more") && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const m = (t.parentNode as ParentNode).querySelector<HTMLElement>(".row-menu");
    if (m && m.hidden) toggleRowMenu(t, true);
    return true;
  }
  const menu = t.closest<HTMLElement>(".row-menu");
  if (!menu || menu.hidden) return false;
  const items = Array.prototype.slice.call(menu.querySelectorAll(".row-menu-item")) as HTMLElement[];
  const i = items.indexOf(t);
  const btn = (menu.parentNode as ParentNode).querySelector<HTMLElement>(".row-more");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    (items[(i + step + items.length) % items.length] as HTMLElement).focus();
    return true;
  }
  if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    (items[e.key === "Home" ? 0 : items.length - 1] as HTMLElement).focus();
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeRowMenus();
    if (btn) btn.focus();
    return true;
  }
  if (e.key === "Tab") {
    closeRowMenus();
    return false;
  }
  return false;
}
