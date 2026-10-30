import "../../../src/test/_dom.mjs";
import "../../../src/test/_export-services-started.mjs";
import { loadTestDocument } from "../../../src/test/_document.mjs";
import { currentDocument } from "../../../src/bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { intern } from "../../../src/adapters/storage/02c-blobs.js";
import { htmlToPlainText } from "../../../src/bootstrap/plain-text.ts";
import { mountProductionTagsFeature as initTags } from "../../../src/bootstrap/wiring/production-tags.ts";

initTags();

export const TITLE = "Café “Ünïcödé” 😀 — round trip";
export const TAGS = {
  prop: "Pentax K1000",
  location: "Café Pier",
  cast: "Rita 😀",
  vfx: "Title card",
  sound: "Door slam",
  gear: "Tripod"
};
export const TAG_LABELS = { prop: "Prop", location: "Location", cast: "Cast", vfx: "VFX", sound: "Music/SFX", gear: "Gear" };
export const LONG_VISUAL = "Slow pan across the harbour, then hold. ".repeat(100).trim();
export const LONG_AUDIO = Array.from({ length: 3000 }, (_, i) => "word" + i).join(" ");
export const UNICODE_LINE = "Café “quoted” ‘single’ — naïve ﬁnale 😀 👩🏽‍🎤";

const jpegBytes = (w, h, salt) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt, 0xFF, 0xD9]);
const tagSpan = (cat) => `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${TAGS[cat]}" contenteditable="false">${TAGS[cat]}</span>`;
const cmtSpan = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;

export const PICTURES = {
  first: intern(jpegBytes(300, 200, 1)),
  second: intern(jpegBytes(160, 90, 2))
};

function fixtureState() {
  return {
    schema: 2, title: TITLE, wordsPerMinute: 150,
    rows: [
      { id: "r0", status: "shot", imageRef: PICTURES.first,
        visualText: "Wide on the " + Object.keys(TAGS).map(tagSpan).join(" · ") + "<br>second line of the shot",
        audioText: UNICODE_LINE + "<br>and " + cmtSpan("c0", "anchored words") + " follow." },
      { id: "r1", status: "todo", visualText: "", audioText: "" },
      { id: "r2", status: "todo", visualText: "", audioText: "Narration only: “curly” ‘quotes’ and naïve café 😀." },
      { id: "r3", status: "ready", imageRef: PICTURES.second, visualText: "", audioText: "" },
      { id: "r4", status: "todo", visualText: LONG_VISUAL, audioText: LONG_AUDIO },
      { id: "r5", status: "todo", visualText: "Opening<br><br>After a break", audioText: "Line one.<br><br>Line two.<br><br><br>Line three." },
      { id: "r6", status: "todo", visualText: "", audioText: "" },
      { id: "r7", status: "todo", visualText: "שלום עולם 你好 🎬", audioText: "Ünïcödé — ‘ﬁ’ ligature",
        imageRef: PICTURES.first },
      { id: "r8", status: "todo", visualText: "Last row", audioText: "The end." },
      { id: "r9", status: "todo", visualText: "", audioText: "" }
    ],
    comments: [
      { id: "c0", rowId: "r0", field: "audioText", author: "Zoë Ünal", createdAt: "2026-09-20T10:00:00Z", quotedText: "anchored words",
        body: "Café “check” 😀", assignee: "Bjørn",
        replies: [{ id: "rp0", author: "Sam", createdAt: "2026-09-20T11:00:00Z", body: "Done — ‘ok’." }] },
      { id: "c1", rowId: "r8", field: "visualText", author: "Ann", createdAt: "2026-09-21T10:00:00Z", quotedText: "",
        body: "Resolved note", resolved: true, resolvedBy: "Ann", replies: [] }
    ]
  };
}

export function loadFixture() {
  loadTestDocument(migrateRows(fixtureState()));
  return currentDocument();
}

export const plainOf = (row) => ({ visual: htmlToPlainText(row.visualText), audio: htmlToPlainText(row.audioText) });
export const isBlank = (row) => !row.visual && !row.audio;
