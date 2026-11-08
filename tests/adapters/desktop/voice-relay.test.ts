import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayRecognition, hasVoiceRelay, listRelayMicrophones, setVoiceRelay } from "../../../src/adapters/desktop/voice-relay.ts";
import { createMicrophoneDevices } from "../../../src/adapters/page/microphones.ts";

const TOKEN = "ab".repeat(32);
const MIC_ONE = "{0.0.1.00000000}.{11111111-1111-4111-8111-111111111111}";
const MIC_TWO = "{0.0.1.00000000}.{22222222-2222-4222-8222-222222222222}";

class FakeSource {
  static made: FakeSource[] = [];
  url: string;
  closed = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeSource.made.push(this); }
  close() { this.closed = true; }
  emit(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function withRelay(answer: (url: string) => Promise<Response>) {
  const saved = { fetch: globalThis.fetch, EventSource: (globalThis as { EventSource?: unknown }).EventSource, sessionStorage: (globalThis as { sessionStorage?: unknown }).sessionStorage };
  const stored = new Map<string, string>();
  const fetched: string[] = [];
  Object.assign(globalThis, {
    sessionStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } },
    EventSource: FakeSource,
    fetch: (url: string) => { fetched.push(String(url)); return answer(String(url)); }
  });
  FakeSource.made = [];
  setVoiceRelay("8771-" + TOKEN);
  return {
    fetched,
    restore() {
      setVoiceRelay("");
      Object.assign(globalThis, saved);
    }
  };
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

test("in the relay window the microphone list is the desktop app's, through the relay, and only its endpoint ids", async () => {
  const relay = withRelay(() => json({ microphones: [
    { id: MIC_ONE, name: "Microphone (Desk One)" },
    { id: "dev-browser", name: "Not a desktop id" },
    { id: MIC_TWO, name: "Microphone (Desk Two)" },
    { id: 7, name: "junk" }
  ] }));
  try {
    const devices = createMicrophoneDevices({ desktop: () => false });
    assert.equal(devices.support(), "yes", "the relay window offers the picker");
    const list = await devices.list();
    assert.deepEqual(relay.fetched, ["http://127.0.0.1:8771/prompter-voice/" + TOKEN + "/microphones"]);
    assert.deepEqual(list, { options: [{ id: MIC_ONE, label: "Microphone (Desk One)" }, { id: MIC_TWO, label: "Microphone (Desk Two)" }], named: true });
  } finally { relay.restore(); }
});

test("a relay list that fails is an empty list, not an error", async () => {
  for (const answer of [() => json({ error: "expired" }, 404), () => Promise.reject(new Error("offline")), () => json({ nothing: true })]) {
    const relay = withRelay(answer);
    try {
      assert.deepEqual(await listRelayMicrophones(), { options: [], named: false });
    } finally { relay.restore(); }
  }
});

test("the relay starts on the chosen desktop microphone by its id, and on the default with none", () => {
  const relay = withRelay(() => json({ microphones: [] }));
  try {
    const chosen = createRelayRecognition(MIC_TWO);
    chosen.start();
    assert.equal(FakeSource.made[0]?.url, "http://127.0.0.1:8771/prompter-voice/" + TOKEN + "?microphone=" + encodeURIComponent(MIC_TWO));
    chosen.stop();
    assert.equal(FakeSource.made[0]?.closed, true);
    const plain = createRelayRecognition("");
    plain.start();
    assert.equal(FakeSource.made[1]?.url, "http://127.0.0.1:8771/prompter-voice/" + TOKEN, "the default asks for no device, as before");
    plain.stop();
  } finally { relay.restore(); }
});

test("a stored value that is not a desktop microphone is never sent, and the default is said", () => {
  const relay = withRelay(() => json({ microphones: [] }));
  try {
    const rec = createRelayRecognition("dev-browser") as ReturnType<typeof createRelayRecognition> & { ondevice: ((e: unknown) => void) | null };
    const heard: unknown[] = [];
    rec.ondevice = (e) => { heard.push(e); };
    rec.start();
    assert.equal(FakeSource.made[0]?.url, "http://127.0.0.1:8771/prompter-voice/" + TOKEN);
    assert.deepEqual(heard, [{ fellBack: true }]);
    rec.stop();
  } finally { relay.restore(); }
});

test("the desktop's fallback line reaches the teleprompter as a fallback, and the device line as its name", () => {
  const relay = withRelay(() => json({ microphones: [] }));
  try {
    const rec = createRelayRecognition(MIC_ONE) as ReturnType<typeof createRelayRecognition> & { ondevice: ((e: unknown) => void) | null };
    const heard: unknown[] = [];
    rec.ondevice = (e) => { heard.push(e); };
    rec.start();
    const source = FakeSource.made[0] as FakeSource;
    source.emit({ type: "fallback", session: 1 });
    source.emit({ type: "device", session: 1, name: "Microphone (Default)" });
    assert.deepEqual(heard[0], { fellBack: true });
    assert.equal((heard[1] as { name?: unknown }).name, "Microphone (Default)");
    rec.stop();
    source.emit({ type: "fallback", session: 1 });
    assert.equal(heard.length, 2, "nothing reaches it after it stopped");
  } finally { relay.restore(); }
});

test("without a relay the browser keeps its own microphones", () => {
  assert.equal(hasVoiceRelay(), false);
  const devices = createMicrophoneDevices({ desktop: () => false });
  assert.equal(devices.support(), "browser", "Node has no speech recognizer, so the plain browser answer is unchanged");
});
