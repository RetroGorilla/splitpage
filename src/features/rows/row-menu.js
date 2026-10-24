export function closeRowMenus(except) {
  document.querySelectorAll("#rows .row-menu:not([hidden])").forEach(function (menu) {
    if (menu === except) return;
    menu.hidden = true;
    var btn = menu.parentNode.querySelector(".row-more");
    if (btn) btn.setAttribute("aria-expanded", "false");
    var row = menu.closest(".row");
    if (row) row.classList.remove("has-menu-open");
  });
}

export function toggleRowMenu(btn, focusFirst) {
  var menu = btn.parentNode.querySelector(".row-menu");
  if (!menu) return;
  var opening = menu.hidden;
  closeRowMenus(opening ? menu : null);
  menu.hidden = !opening;
  btn.setAttribute("aria-expanded", opening ? "true" : "false");
  var row = btn.closest(".row");
  if (row) row.classList.toggle("has-menu-open", opening);
  if (!opening) return;
  menu.classList.remove("opens-up");
  var r = menu.getBoundingClientRect();
  var phoneBar = document.getElementById("phone-bar");
  var floor = window.innerHeight - 8 - (phoneBar ? phoneBar.offsetHeight : 0);
  if (r.bottom > floor && r.top - r.height - btn.offsetHeight > 8) menu.classList.add("opens-up");
  if (focusFirst) {
    var first = menu.querySelector(".row-menu-item");
    if (first) first.focus();
  }
}

export function rowMenuKeydown(e) {
  var t = e.target;
  if (!t || !t.closest) return false;
  if (t.classList.contains("row-more") && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    var m = t.parentNode.querySelector(".row-menu");
    if (m && m.hidden) toggleRowMenu(t, true);
    return true;
  }
  var menu = t.closest(".row-menu");
  if (!menu || menu.hidden) return false;
  var items = Array.prototype.slice.call(menu.querySelectorAll(".row-menu-item"));
  var i = items.indexOf(t);
  var btn = menu.parentNode.querySelector(".row-more");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    var step = e.key === "ArrowDown" ? 1 : -1;
    items[(i + step + items.length) % items.length].focus();
    return true;
  }
  if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    items[e.key === "Home" ? 0 : items.length - 1].focus();
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
