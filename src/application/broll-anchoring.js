let declined;

export function resetBrollAnchoring() {
  declined = Object.create(null);
}

export function declineBrollRows(rows) {
  (rows || []).forEach(function (row) { declined[row.id] = true; });
}

export function brollAnchoringDeclined(id) {
  return !!declined[id];
}
