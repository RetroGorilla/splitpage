export function armDeleteButton(btn: Element): void {
  btn.classList.add("armed");
  const label = btn.querySelector(".row-menu-label");
  if (label) label.textContent = "Click again to delete";
}

export function disarmDeleteButton(btn: Element): void {
  btn.classList.remove("armed");
  const label = btn.querySelector(".row-menu-label");
  if (label) label.textContent = "Delete";
}