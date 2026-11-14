export const emptyScriptHistories = ["last beat", "two last beats", "removal and typing", "removal and split", "only scene"] as const;

export function emptyScriptDocument(rows: readonly Record<string, unknown>[] = []) {
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows, comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 };
}

export function emptyScriptRecovery(name: typeof emptyScriptHistories[number]) {
  const first = { kind: "removed-beat", row: { id: "R1", status: "todo", visualText: "", audioText: "ab", imageRef: null, updatedAt: "", updatedBy: null },
    members: ["R1"], removal: { ids: ["structure_1_0063007500740041_removal_0"], by: "Alice", edited: [] } };
  if (name === "last beat") return [first];
  if (name === "two last beats" || name === "only scene") return [first,
    { kind: "removed-beat", row: { id: "R2", status: "todo", visualText: "", audioText: "cd", imageRef: null, updatedAt: "", updatedBy: null }, members: ["R2"],
      removal: { ids: [name === "two last beats" ? "structure_2_0063007500740042_removal_0" : "structure_1_00630075007400410032_removal_0"], by: name === "two last beats" ? "Bob" : "Alice", edited: [] } },
    ...name === "only scene" ? [{ kind: "scene-with-no-beats", heading: { id: "H1", name: "Scene" }, beforeRowId: null }] : []];
  if (name === "removal and typing") return [{ kind: "removed-beat", row: { id: "R1", status: "todo", visualText: "", audioText: "aXb", imageRef: null, updatedAt: "", updatedBy: null },
    members: ["R1"], removal: { ids: ["structure_1_0063007500740041_removal_0"], by: "Alice", edited: [{ client: 2, clock: 0 }] } }];
  return [{ kind: "removed-beat", row: { id: "R1", status: "todo", visualText: "", audioText: "a", imageRef: null, updatedAt: "", updatedBy: null },
    members: ["R1"], removal: { ids: ["structure_1_0063007500740041_removal_0"], by: "Alice", edited: [] } },
  { kind: "removed-beat", row: { id: "structure_2_00730070006c006900740042_beat_0", status: "todo", visualText: "", audioText: "b", imageRef: null },
    members: ["structure_2_00730070006c006900740042_beat_0"], removal: { ids: ["structure_1_0063007500740041_removal_0"], by: "Alice", edited: [] }, splitBy: "Bob" }];
}

export const firstEmptyScriptBeat = "structure_1_00770031005f0031_beat_0";
export const secondEmptyScriptBeat = "structure_2_00770032005f0031_beat_0";

export function emptyScriptRow(id: string, audioText: string, by = "Alice") {
  return { id, status: "todo", visualText: "", audioText, imageRef: null, updatedAt: "2026-11-12T10:00:00.000Z", updatedBy: by };
}
