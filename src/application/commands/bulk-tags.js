let tagging;

export function bindBulkTagRows(ports) {
  tagging = ports;
}

export function bulkTagRows(rows, phrase, cat, name, matchCase, countOnly) {
  const total = { hits: 0, inTags: 0, skipped: 0 };
  (rows || []).forEach(function (row) {
    const res = tagging.cell(row.visualText, phrase, cat, name, matchCase, countOnly);
    total.hits += res.hits;
    total.inTags += res.inTags;
    total.skipped += res.skipped;
    if (!countOnly && res.hits && res.html !== row.visualText) {
      row.visualText = res.html;
      tagging.stamp(row);
    }
  });
  return total;
}
