export const PERCENTILE_RULE = "p50 is the median (the mean of the two middle values when the count is even); p95 is the nearest rank, the ceil(0.95 n)-th smallest value; max is the largest";

export const EARLIER_RECORDS = "Standalone figures in records committed before this rule used another percentile rule (p50 the upper middle value, p95 the largest of 20 samples) and are not comparable; the standalone baseline is rerun in the same session as the shared passes for every record run";

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function nearestRank(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function latencyFigures(latencies) {
  const tenth = (value) => +value.toFixed(1);
  return latencies.length
    ? { keys: latencies.length, p50: tenth(median(latencies)), p95: tenth(nearestRank(latencies, 0.95)), max: tenth(Math.max(...latencies)) }
    : { keys: 0, p50: null, p95: null, max: null };
}
