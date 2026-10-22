import "../src/test/_dom.mjs";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { S } from "../src/js/_state.js";
import { __init as initSceneStatus } from "../src/js/01-scene-status.js";
import { rowSeconds } from "../src/core/production/timing.ts";
import { productionReaders } from "../src/legacy/document-ports.ts";
import { migrateRows } from "../src/js/02-state.js";
import { __init as initTags } from "../src/js/07-production-tags.js";
import { brollEntries } from "../src/js/08c-broll.js";

initSceneStatus();
initTags();

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TITLE = "I Fixed a $40 Film Camera (and Shot a Roll With It)";

const SCENES = [
  { s: "shot",
    v: "Cold open, macro: a dusty [p:Pentax K1000] on the [l:workbench]. A finger wipes a line through the dust.\n[s:shutter click] as the lever is wound.",
    a: "Forty dollars. That's what this cost me at a flea market. The meter's dead, the seals are gone, and the shutter sticks. Let's fix it." },
  { s: "shot",
    v: "[v:Title card] over a fast montage of the camera coming apart.\n[s:intro sting] under it.",
    a: "((music up))" , len: 6 },
  { s: "shot",
    v: "Medium shot, [c:Sam] at the [l:workbench], [g:lav mic] hidden under the collar. Camera held up to the lens.",
    a: "Hi, I'm Sam. On this channel I take old cameras that everyone gave up on and try to get one roll of film through them. Some of them make it. <<c1:Some of them really, really don't.>> This one I have a good feeling about. The Pentax K1000 was made for more than twenty years, it has almost no electronics in it, and there are millions of them still out there, sitting in drawers and lofts. Which means parts are cheap, advice is everywhere, and if I break it, well, I can buy another one. Here's the plan: seals, shutter, meter, film, and then we go and shoot a whole roll and see what comes back from the lab." },
  { s: "shot",
    v: "Close-up: the back door open, crumbling foam in the channels.\n[v:Lower third]: “Problem 1 — light seals”\nB-roll*: fingertip pushing on the sticky old foam",
    a: "First problem. These little foam strips keep light from leaking in round the back door. After forty years they turn into black goo. If you shoot with them like this, every frame gets a red stripe down one side. And you won't find out until the film comes back from the lab, weeks later, which is a very specific kind of heartbreak. There's a second strip up by the hinge, and a thin one under the mirror that stops it slapping the top of the chamber. Those three are the whole job." },
  { s: "shot",
    v: "Top-down from the [g:overhead rig]: the [p:light seal kit] laid out beside a [p:toothpick] and a bottle of [p:naphtha].",
    a: "Replacement seals are about eight dollars. You'll also want a toothpick, a bit of lighter fluid to dissolve the old stuff, and a lot of patience." },
  { s: "shot",
    v: "Timelapse from the [g:overhead rig]: the old seals scraped out of the channel.\n[s:lo-fi bed] throughout.\nB-roll*: the toothpick lifting a long strand of goo",
    a: "This part takes about forty minutes and it is genuinely the worst forty minutes in camera repair. Go slowly. If you scratch the channel, the new seal won't sit flat. Soak a cotton bud, let it sit for a minute, and the old foam lifts out in long sticky strings. Keep a paper towel under the camera, because it drips, and keep the naphtha well away from the lens and the mirror. When the channel is clean, it should be bare shiny metal from end to end." },
  { s: "shot",
    v: "Macro: new foam strip pressed into place with the [p:toothpick].",
    a: "New seals in. Press them down with the flat end, not your fingers, and don't stretch them." },
  { s: "shot",
    v: "[c:Sam] closes the back. Beat.",
    a: "Door shuts. That's one." },
  { s: "shot",
    v: "Medium shot at the [l:workbench]. [c:Sam] fires the shutter; it hangs open.\n[v:Lower third]: “Problem 2 — sticky shutter”",
    a: "Problem two. Listen to this. ((fires the shutter)) That should be a crisp click. Instead it hangs, and then it sort of sighs closed. At slow speeds that's a disaster. <<c2:Old oil has gone gummy in the escapement.>>" },
  { s: "ready",
    v: "Macro through the lens mount: the shutter curtain.\n[v:Arrow callout] pointing at the escapement.\nB-roll: slow-motion shutter firing at one second",
    a: "The fix everyone suggests is to exercise it. Fire it at every speed, fifty times each, and a lot of the time the old oil loosens up on its own. It's boring, but it's free, and it doesn't involve opening anything. Start at the fastest speed, a thousandth of a second, and work your way down. The fast speeds barely touch the mechanism that's sticking, but they get everything moving. By the time you reach the slow speeds, where the gears actually do the timing, the old oil has warmed up and started to spread." },
  { s: "ready",
    v: "[v:Counter] ticking up in the corner as [c:Sam] fires the shutter again and again.\n[s:shutter click] layered and speeding up.",
    a: "So that's what I did. For a whole episode of a podcast." },
  { s: "ready",
    v: "Same framing. One clean fire.\n[v:Split screen]: before and after, the same one-second exposure.",
    a: "And there it is. ((beat)) One second actually lasts one second now. If exercising it doesn't work for you, the next step is a proper clean, and that's a video of its own." },
  { s: "todo",
    v: "[l:Kitchen table], window light. [c:Sam] with a [p:button cell battery] between two fingers.\n[v:Lower third]: “Problem 3 — the light meter”",
    a: "Problem three is the light meter. The K1000 was built for a mercury battery that you can't buy any more. The easy swap is a silver oxide cell, which runs at a slightly higher voltage, so the meter will read a touch hot. For colour negative film, that honestly doesn't matter. Negative film has loads of room on the bright side, so a meter that reads a little hot just makes your pictures a touch denser, and the scanner sorts that out. If you're going to shoot slide film, which has almost no room at all, you'd want a proper adapter that drops the voltage. I'm not going to do that today." },
  { s: "todo",
    v: "Insert: the battery cover unscrewed with a coin.\nB-roll: battery dropping into the base plate",
    a: "Battery in. And the needle moves." },
  { s: "todo",
    v: "Over the shoulder, through the viewfinder: the needle swinging as the camera pans across the [l:kitchen table].\n[v:Viewfinder overlay] on the needle.",
    a: "To check it, I compared it to the meter app on my phone at a few different scenes. It was within about a third of a stop everywhere, which is better than I expected, and more than good enough. I tried a bright window, a dark hallway, and the fridge light, which is the least scientific test in the world, but it told me the needle moves in the right direction by the right amount. If yours doesn't move at all, check the battery contact first. It's usually a bit of green corrosion, and a pencil eraser takes it right off." },
  { s: "shot",
    v: "[l:Camera shop] exterior, handheld on the [g:gimbal].\nB-roll*: shop sign and window display",
    a: "Next stop: film." },
  { s: "shot",
    v: "Inside the [l:camera shop]. [c:Rita] behind the counter with a fridge full of film.\n[s:shop door bell] as they come in.",
    a: "This is Rita. She has run this shop for twenty-two years and she has opinions about every film stock ever made. I asked her what she'd put in a camera with a brand new meter she didn't trust yet. She also told me that about half the cameras people bring in with a problem just need a battery, and the other half need new seals, which made me feel very clever for about ten seconds." },
  { s: "shot",
    v: "Two-shot, [c:Rita] holding up a box of [p:Portra 400].\n[v:Lower third]: “Rita — owner, Frame & Grain”",
    a: "((Rita, off camera)) Portra 400. It forgives you. Overexpose it two stops and it still looks lovely. Underexpose it and, well, you get what you deserve. <<c3:Buy two.>>" },
  { s: "shot",
    v: "Close-up: cash going over the counter.\n[s:cash register ding]\n[v:Price counter]: $40 + $8 + $4 + $18",
    a: "Running total: sixty-eight dollars. Still less than a nice dinner." },
  { s: "ready",
    v: "Back at the [l:workbench]. Loading the film, the leader threaded onto the take-up spool.\nB-roll: sprocket holes catching on the teeth",
    a: "Loading a manual camera for the first time is the moment everyone gets nervous. Pull the leader across, hook it into the slot, and wind on until both sets of sprocket holes are caught. Then, and this is the important bit, watch the rewind knob turn as you advance. If it doesn't turn, the film isn't moving. You'll shoot thirty-six frames onto the same patch of film, or onto nothing at all, and you'll only find out when you try to rewind and there's no tension. Ask me how I know. Close the back, fire two blank frames to get past the part you fogged while loading, and the counter should sit on one." },
  { s: "ready",
    v: "Tight on the rewind knob turning.",
    a: "It turns. We're good." },
  { s: "todo",
    v: "[l:Riverside park], golden hour. Wide: [c:Sam] walking in with the camera on a strap.\n[s:lo-fi bed] returns.\nB-roll: feet on the gravel path, low angle",
    a: "Then I took it for a walk. The whole point of a camera like this is that it slows you down. There's no screen to check. You look at the needle, you turn the rings, and you commit. I set the camera for the light at the start of the walk, and then only changed it when the needle told me to. That meant I spent most of the hour just looking at things, which, honestly, I don't do enough of with a phone in my pocket. By the time I reached the river, I'd only taken four pictures, and I was fine with that." },
  { s: "todo",
    v: "Series of handheld shots round the [l:Riverside park], [c:Sam] metering and shooting: a bench, a heron, a bike leaning on a rail.\nEach frame freezes for a beat with a [s:shutter click].\nB-roll: the heron taking off",
    a: "I shot all thirty-six frames in about an hour. Some of them I thought about for a long time. Some of them I just took, because the light was doing something and I didn't want to miss it. The heron stood in the shallows for nearly ten minutes while I crept closer, and then took off the moment I lifted the camera, which I'm told is what herons are for. The bike on the rail was the last frame. I stood there a long time deciding whether it was worth it, and then took it anyway, because it was frame thirty-six." },
  { s: "todo",
    v: "Medium, [c:Sam] on a bench in the [l:Riverside park], winding back the film.",
    a: "Rewinding is the most stressful thirty seconds in photography. <<c4:If the film tears now, there's nothing left to show you.>>" },
  { s: "todo",
    v: "Montage: the canister going into an envelope, the envelope into a post box.\n[s:lo-fi bed] swells.",
    a: "((music only))", len: 12 },
  { s: "todo",
    v: "[l:Kitchen table], a week later. [c:Sam] opens an email on a laptop.\n[v:Screen recording] of the lab's download page.",
    a: "A week later, the scans came back." },
  { s: "todo",
    v: "Full screen, one by one: the scans.\n[v:Ken Burns] slow push on each.\nB-roll: prints laid out on the table, overhead",
    a: "And I'm really happy with them. The meter held up. There's no light leak anywhere, not even on the first frame. Two frames are soft because I missed focus, and that's entirely on me. The heron is out of focus too. The heron was always going to be out of focus. The colours are what got me. Portra does this warm, soft thing with late light that I've spent years trying to get out of a phone with filters, and here it is, straight out of the scanner, no editing at all. Rita was right. It forgave me for everything." },
  { s: "ready",
    v: "Medium at the [l:workbench], the [p:Pentax K1000] on the bench beside the prints.",
    a: "So was it worth it? Forty dollars for the camera, eight for the seals, four for a battery, eighteen for film and another fifteen to get it developed and scanned. Eighty-five dollars all in, for a camera that will outlive my phone, and a roll of pictures I actually like. **Yes.** It was worth it." },
  { s: "ready",
    v: "[c:Sam] to camera. [v:End screen] for the last twenty seconds.\n[s:outro sting]",
    a: "If you want to try this, the full parts list is in the description. Next time, we're going somewhere much scarier: a rangefinder with a cloth shutter and a big hole in it." },
  { s: "todo",
    v: "Post-credits: [c:Sam] fires the shutter one more time. It hangs.",
    a: "((long pause)) Oh no." }
];

const PEOPLE = [
  { id: "p_ld_sam", name: "Sam" },
  { id: "p_ld_jo", name: "Jo (editor)" }
];
const TAG_STATE = {
  "prop/Pentax K1000": ["have", "p_ld_sam", "The $40 flea-market body. Keep the lens cap on between setups."],
  "prop/light seal kit": ["have", "p_ld_sam", ""],
  "prop/toothpick": ["have", "", ""],
  "prop/naphtha": ["have", "", "Zippo fluid is fine."],
  "prop/button cell battery": ["sourcing", "p_ld_sam", "SR44 silver oxide."],
  "prop/Portra 400": ["have", "", "Two rolls, from Rita."],
  "location/workbench": ["have", "", ""],
  "location/Kitchen table": ["have", "", ""],
  "location/Camera shop": ["have", "p_ld_sam", "Frame & Grain, weekday mornings only."],
  "location/Riverside park": ["needed", "", "Golden hour, check the forecast."],
  "cast/Sam": ["have", "", ""],
  "cast/Rita": ["have", "p_ld_sam", "Release form signed."],
  "gear/lav mic": ["have", "", ""],
  "gear/overhead rig": ["have", "", ""],
  "gear/gimbal": ["returned", "", "Borrowed for the shop day."],
  "vfx/Title card": ["have", "p_ld_jo", ""],
  "vfx/Lower third": ["sourcing", "p_ld_jo", "One template for all of them."],
  "vfx/Split screen": ["needed", "p_ld_jo", ""],
  "vfx/Price counter": ["needed", "p_ld_jo", ""],
  "vfx/End screen": ["needed", "p_ld_jo", ""],
  "sound/intro sting": ["have", "p_ld_jo", ""],
  "sound/lo-fi bed": ["sourcing", "p_ld_jo", "Licensed track, not the free one."],
  "sound/shutter click": ["have", "", "Record the real one, close up."]
};

const COMMENTS = [
  { id: "c1", scene: 3, field: "audioText", author: "Jo (editor)",
    body: "Love this. Could we hold on your face for a beat after it?",
    at: "2026-09-20T10:12:00.000Z",
    replies: [{ id: "c1r1", author: "Sam", body: "Yes — I'll leave a second of room in the take.", at: "2026-09-20T11:40:00.000Z" }] },
  { id: "c2", scene: 9, field: "audioText", author: "Jo (editor)",
    body: "Is “escapement” right for a focal-plane shutter? Worth checking.",
    at: "2026-09-20T10:20:00.000Z",
    resolved: { by: "Sam", at: "2026-09-21T09:05:00.000Z" } },
  { id: "c3", scene: 18, field: "audioText", author: "Sam",
    body: "Rita's line — keep it exactly as she said it.",
    at: "2026-09-21T14:30:00.000Z", assignee: "Jo (editor)" },
  { id: "c4", scene: 24, field: "audioText", author: "Jo (editor)",
    body: "Tension here could use a sting. Something short and low?",
    at: "2026-09-22T08:15:00.000Z" }
];

const LINKS = {
  2: [{ href: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", poster: true }],
  28: [{ href: "https://www.youtube.com/watch?v=eRsGyueVLvQ", poster: true }]
};

const CATS = { p: "prop", l: "location", c: "cast", v: "vfx", s: "sound", g: "gear" };

function esc(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(text) {
  let out = "";
  const re = /\[([plcvsg]):([^\]]+)\]|\(\(([^)]+)\)\)|<<(c\d+):([^>]+)>>|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    if (m[1]) {
      out += '<span class="tag-anchor" data-tag-cat="' + CATS[m[1]] + '" data-tag-name="' + esc(m[2]) +
        '" contenteditable="false">' + esc(m[2]) + "</span>";
    } else if (m[3]) {
      out += '<span class="stage-dir">' + esc(m[3]) + "</span>";
    } else if (m[4]) {
      out += '<span class="cmt-anchor" data-cmt="' + m[4] + '">' + esc(m[5]) + "</span>";
    } else {
      out += "<strong>" + esc(m[6]) + "</strong>";
    }
    last = re.lastIndex;
  }
  return out + esc(text.slice(last));
}

const shotBroll = [];
let brollN = 0;

function visual(text) {
  return text.split("\n").map((line) => {
    const m = /^B-roll(\*?):\s*(.*)$/.exec(line);
    if (!m) return inline(line);
    const id = "bs_ld_" + String(++brollN).padStart(2, "0");
    if (m[1]) shotBroll.push(id);
    return '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">B-roll:</span> ' + inline(m[2]);
  }).join("<br>");
}

const rows = SCENES.map((sc, i) => {
  const row = {
    id: "r" + (i + 1),
    status: sc.s,
    visualText: visual(sc.v),
    audioText: inline(sc.a),
    imageRef: null
  };
  if (sc.len != null) row.lengthSeconds = sc.len;
  if (LINKS[i + 1]) row.imageLinks = LINKS[i + 1];
  return row;
});

const productionTags = Object.keys(TAG_STATE).map((key, i) => {
  const [cat, name] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
  const [status, owner, notes] = TAG_STATE[key];
  return { id: "t_ld_" + String(i + 1).padStart(2, "0"), cat, name, status, owner, notes };
});

const comments = COMMENTS.map((c) => {
  const row = rows[c.scene - 1];
  const quoted = new RegExp('data-cmt="' + c.id + '">([^<]*)<').exec(row[c.field]);
  if (!quoted) throw new Error("comment " + c.id + " has no anchor in scene " + c.scene);
  return {
    id: c.id, rowId: row.id, field: c.field, anchorId: c.id, quotedText: quoted[1],
    author: c.author, body: esc(c.body),
    resolved: !!c.resolved,
    resolvedBy: c.resolved ? c.resolved.by : null,
    resolvedAt: c.resolved ? c.resolved.at : null,
    assignee: c.assignee || "",
    createdAt: c.at, updatedAt: c.at,
    replies: (c.replies || []).map((r) => ({ id: r.id, author: r.author, body: esc(r.body), createdAt: r.at }))
  };
});

S.state = migrateRows({
  schema: 2,
  title: TITLE,
  rows,
  comments,
  people: PEOPLE,
  productionTags,
  brollShots: [],
  wordsPerMinute: 150
});

brollEntries(false);
S.state.brollShots.forEach((r) => { if (shotBroll.includes(r.id)) r.status = "shot"; });
const flagged = S.state.brollShots.find((r) => r.id === "bs_ld_02");
if (flagged) { flagged.reshoot = true; flagged.notes = "Soft focus — grab it again on the macro day."; }

const total = S.state.rows.reduce((n, r) => n + rowSeconds(r, S.state, productionReaders), 0);
S.state.targetSeconds = Math.floor(total / 60) * 60;

const doc = migrateRows(JSON.parse(JSON.stringify(S.state)));
delete doc.docId;

writeFileSync(join(ROOT, "src", "starters", "long-demo.json"), JSON.stringify(doc, null, 2) + "\n");
console.log("long-demo.json: " + doc.rows.length + " scenes, " + Math.round(total) + "s read time, target " +
  doc.targetSeconds + "s, " + doc.brollShots.length + " b-roll shots, " + doc.productionTags.length + " breakdown entries");
