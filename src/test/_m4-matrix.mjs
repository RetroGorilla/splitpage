import assert from "node:assert/strict";
import test from "node:test";

const declared = [];

function isAssertion(error) {
  return error instanceof assert.AssertionError;
}

const CASE_TIMEOUT = Number(process.env.SPLITPAGE_M4_CASE_TIMEOUT_MS) || 20000;

function messageOf(check) {
  try {
    check();
  } catch (error) {
    return error.message;
  }
  return "";
}

const DEFAULT_MESSAGES = [
  messageOf(() => assert.equal(1, 2)),
  messageOf(() => assert.notEqual(1, 1)),
  messageOf(() => assert.deepEqual([1], [])),
  messageOf(() => assert.deepEqual({ a: 1 }, { a: 2 })),
  messageOf(() => assert.notDeepEqual([1], [1])),
  messageOf(() => assert.ok(false)),
  messageOf(() => assert.match("a", /b/)),
  messageOf(() => assert.fail())
];

export function refusedExpectation(expects) {
  if (!(expects instanceof RegExp)) return "is declared wrongToday without the assertion message it expects to fail on";
  if (expects.global || expects.sticky) return "names an expected message with the g or y flag, which makes the match depend on how often it ran";
  if (DEFAULT_MESSAGES.some(function (m) { return expects.test(m); })) {
    return "names an expected message that node's default assertion messages also match; use an assert with a label";
  }
  return null;
}

export async function judge(id, today, run, expects) {
  if (today === "wrong") {
    const refused = refusedExpectation(expects);
    if (refused) throw new Error(id + " " + refused);
  }
  let failure = null;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  if (today === "right") {
    if (failure) throw failure;
    return "right";
  }
  if (today !== "wrong") throw new Error(id + " is declared " + String(today) + ", not right or wrong");
  if (!failure) {
    throw new Error(id + " is declared wrongToday and now passes: it is now right, so flip it to rightToday in the commit that fixed it");
  }
  if (!isAssertion(failure)) {
    throw new Error(id + " is declared wrongToday but failed with " + failure.name + ": " + failure.message + ", not with an assertion", { cause: failure });
  }
  if (!expects.test(failure.message)) {
    throw new Error(id + " is declared wrongToday to fail on " + String(expects) + " but failed a different assertion: " + failure.message, { cause: failure });
  }
  return "wrong";
}

function declare(id, today, title, run, expects) {
  declared.push({ id: id, today: today, title: title });
  const gated = today === "wrong" && process.env.SPLITPAGE_M4_GATE === "1";
  test(id + " " + title + " [" + today + "Today]", { timeout: CASE_TIMEOUT }, async (t) => {
    if (gated) assert.fail(id + " is still wrongToday at the gate");
    await judge(id, today, function () { return run(t); }, expects);
  });
}

export function rightToday(id, title, run) {
  declare(id, "right", title, run, null);
}

export function wrongToday(id, title, run, expects) {
  declare(id, "wrong", title, run, expects);
}

export function declaredCases() {
  return declared.map(function (c) { return { id: c.id, today: c.today, title: c.title }; });
}

export function createGates() {
  const channels = new Map();

  function channel(name) {
    let c = channels.get(name);
    if (!c) {
      c = { holds: [], parked: [], watchers: [] };
      channels.set(name, c);
    }
    return c;
  }

  function wake(c) {
    const watchers = c.watchers.splice(0);
    watchers.forEach(function (resolve) { resolve(); });
  }

  return {
    hold: function (name, options) {
      const o = options || {};
      channel(name).holds.push({ remaining: o.times === undefined ? 1 : o.times, when: o.when || null });
    },
    pass: function (name, info) {
      const c = channel(name);
      const hold = c.holds.find(function (h) { return h.remaining > 0 && (!h.when || h.when(info)); });
      if (!hold) return Promise.resolve();
      hold.remaining--;
      return new Promise(function (resolve) {
        c.parked.push({ resolve: resolve, info: info });
        wake(c);
      });
    },
    parked: function (name) {
      return channel(name).parked.map(function (p) { return p.info; });
    },
    arrived: async function (name, count) {
      const c = channel(name);
      const want = count === undefined ? 1 : count;
      for (let turn = 0; c.parked.length < want; turn++) {
        if (turn > 2000) throw new Error("nothing reached the " + name + " gate");
        await new Promise(function (resolve) { setImmediate(resolve); });
      }
    },
    release: function (name) {
      const c = channel(name);
      const next = c.parked.shift();
      if (!next) throw new Error("nothing is parked at the " + name + " gate");
      next.resolve();
    },
    releaseAll: function (name) {
      const c = channel(name);
      c.holds.forEach(function (h) { h.remaining = 0; });
      c.parked.splice(0).forEach(function (p) { p.resolve(); });
    }
  };
}

function bodyOf(raw) {
  if (typeof raw !== "string") return raw === undefined ? null : raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function createHeldFetch(ports) {
  const gates = ports.gates || createGates();
  const answer = ports.answer || function () { return { status: 200, body: {} }; };
  const connection = ports.connection || function () { return null; };
  const requests = [];

  async function held(url, init) {
    const options = init || {};
    const request = {
      n: requests.length + 1,
      url: String(url),
      method: options.method || "GET",
      headers: Object.assign({}, options.headers || {}),
      body: bodyOf(options.body),
      connection: connection(),
      released: false
    };
    requests.push(request);
    await gates.pass("fetch", request);
    request.released = true;
    const reply = await answer(request);
    if (reply.bytes !== undefined) {
      return new Response(bytesOf(reply.bytes), {
        status: reply.status === undefined ? 200 : reply.status,
        headers: Object.assign({ "content-type": "application/octet-stream" }, reply.headers || {})
      });
    }
    const body = reply.body === undefined ? null : reply.body;
    return new Response(body === null ? null : JSON.stringify(body), {
      status: reply.status === undefined ? 200 : reply.status,
      headers: Object.assign({ "content-type": "application/json" }, reply.headers || {})
    });
  }

  return {
    fetch: held,
    gates: gates,
    requests: requests,
    install: function (target) {
      const owner = target || globalThis;
      const before = owner.fetch;
      owner.fetch = held;
      return function () { owner.fetch = before; };
    },
    holdWhen: function (when, times) {
      gates.hold("fetch", { when: when, times: times });
    },
    matching: function (method, fragment) {
      return requests.filter(function (r) { return r.method === method && r.url.includes(fragment); });
    }
  };
}

function bytesOf(chunk) {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return chunk.slice();
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk.slice(0));
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
  return new TextEncoder().encode(String(chunk));
}

function joined(chunks) {
  let total = 0;
  chunks.forEach(function (c) { total += c.length; });
  const out = new Uint8Array(total);
  let at = 0;
  chunks.forEach(function (c) { out.set(c, at); at += c.length; });
  return out;
}

export function createHeldFileHandle(ports) {
  const gates = ports.gates || createGates();
  const name = ports.name || "held.md";
  const step = ports.step || 1000;
  let bytes = bytesOf(ports.text === undefined ? "" : ports.text);
  let lastModified = ports.lastModified === undefined ? 1000 : ports.lastModified;
  let permission = ports.permission || "granted";
  const failures = new Map();
  const calls = [];
  const commits = [];

  async function reach(op, detail) {
    calls.push(op);
    if (permission !== "granted" && (op === "getFile" || op === "createWritable")) {
      throw new DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError");
    }
    await gates.pass("file." + op, detail);
    const failure = failures.get(op);
    if (failure) {
      failures.delete(op);
      throw failure;
    }
  }

  const handle = {
    kind: "file",
    name: name,
    getFile: async function () {
      await reach("getFile");
      return new File([bytes.slice()], name, { lastModified: lastModified });
    },
    createWritable: async function () {
      await reach("createWritable");
      const chunks = [];
      return {
        write: async function (chunk) {
          await reach("write");
          chunks.push(bytesOf(chunk));
        },
        close: async function () {
          await reach("close");
          bytes = joined(chunks);
          lastModified += step;
          commits.push({ bytes: bytes.slice(), lastModified: lastModified });
        },
        abort: async function () {}
      };
    },
    queryPermission: async function () {
      calls.push("queryPermission");
      return permission;
    },
    requestPermission: async function () {
      calls.push("requestPermission");
      return permission;
    },
    isSameEntry: async function (other) { return other === handle; }
  };

  return {
    handle: handle,
    gates: gates,
    calls: calls,
    commits: commits,
    text: function () { return new TextDecoder().decode(bytes); },
    lastModified: function () { return lastModified; },
    setPermission: function (next) { permission = next; },
    failNext: function (op, error) { failures.set(op, error); },
    holdOp: function (op, times) { gates.hold("file." + op, { times: times }); },
    arrivedAt: function (op, count) { return gates.arrived("file." + op, count); },
    releaseOp: function (op) { gates.release("file." + op); }
  };
}

function wrapped(target, gates, prefix, log, names) {
  const out = Object.create(target);
  names.forEach(function (key) {
    const original = target[key];
    if (typeof original !== "function") return;
    out[key] = async function (...args) {
      log.push({ op: key, args: args });
      await gates.pass(prefix + key, args);
      return original.apply(target, args);
    };
  });
  return out;
}

export function createHeldDesktop(backend, ports) {
  const gates = (ports && ports.gates) || createGates();
  const calls = [];
  const names = ["saveFileDialog", "readFile", "writeFile", "statFile", "writeDraft", "discardDraft", "takeDraft", "historyCopy"];
  return {
    desktop: wrapped(backend, gates, "desktop.", calls, names),
    backend: backend,
    gates: gates,
    calls: calls,
    holdOp: function (op, times) { gates.hold("desktop." + op, { times: times }); },
    arrivedAt: function (op, count) { return gates.arrived("desktop." + op, count); },
    releaseOp: function (op) { gates.release("desktop." + op); }
  };
}

export function createHeldBlobBackend(inner, ports) {
  const gates = (ports && ports.gates) || createGates();
  const calls = [];
  const backend = { name: inner.name, persistent: inner.persistent };
  ["get", "put", "missing"].forEach(function (key) {
    backend[key] = async function (...args) {
      calls.push({ op: key, args: args });
      await gates.pass("blob." + key, args);
      return inner[key].apply(inner, args);
    };
  });
  return {
    backend: backend,
    inner: inner,
    gates: gates,
    calls: calls,
    holdOp: function (op, times) { gates.hold("blob." + op, { times: times }); },
    arrivedAt: function (op, count) { return gates.arrived("blob." + op, count); },
    releaseOp: function (op) { gates.release("blob." + op); }
  };
}

export function createHeldImageDecode(ports) {
  const gates = (ports && ports.gates) || createGates();
  const dataUrl = ports && ports.dataUrl;
  if (typeof dataUrl !== "string") throw new TypeError("createHeldImageDecode needs the data URL a decode answers with");
  const decoded = [];

  class HeldImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.width = 1;
      this.height = 1;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
    }

    set src(value) {
      decoded.push(String(value).length);
      const self = this;
      gates.pass("image.decode", { length: String(value).length }).then(function () {
        if (typeof self.onload === "function") self.onload();
      });
    }
  }

  return {
    gates: gates,
    decoded: decoded,
    holdDecode: function (times) { gates.hold("image.decode", { times: times }); },
    arrivedAtDecode: function (count) { return gates.arrived("image.decode", count); },
    releaseDecode: function () { gates.release("image.decode"); },
    holdEncode: function (times) { gates.hold("image.encode", { times: times }); },
    arrivedAtEncode: function (count) { return gates.arrived("image.encode", count); },
    releaseEncode: function () { gates.release("image.encode"); },
    install: function (target) {
      const win = target || globalThis.window;
      const canvas = win.HTMLCanvasElement.prototype;
      const realImage = [globalThis.Image, win.Image];
      const realContext = canvas.getContext;
      const realDataUrl = canvas.toDataURL;
      const realBlob = canvas.toBlob;
      globalThis.Image = HeldImage;
      win.Image = HeldImage;
      canvas.getContext = function () {
        return new Proxy({}, { get: function (t, k) { return k in t ? t[k] : function () {}; }, set: function (t, k, v) { t[k] = v; return true; } });
      };
      canvas.toDataURL = function () { return dataUrl; };
      const encoded = ports.encodedDataUrl === undefined ? dataUrl : ports.encodedDataUrl;
      canvas.toBlob = function (callback, type) {
        gates.pass("image.encode", { type: type }).then(function () {
          callback(new Blob([Buffer.from(encoded.slice(encoded.indexOf(",") + 1), "base64")], { type: type || "image/png" }));
        });
      };
      return function () {
        globalThis.Image = realImage[0];
        win.Image = realImage[1];
        canvas.getContext = realContext;
        canvas.toDataURL = realDataUrl;
        canvas.toBlob = realBlob;
      };
    }
  };
}

export function mockClock(t, startMs) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: startMs === undefined ? 1_700_000_000_000 : startMs });
  let live = true;
  t.after(function () { if (live) t.mock.timers.runAll(); });
  return {
    tick: function (ms) { t.mock.timers.tick(ms); },
    now: function () { return Date.now(); },
    reset: function () {
      live = false;
      t.mock.timers.reset();
    }
  };
}

export function traceFields(owner, fields, probe) {
  const events = [];
  const restore = [];
  fields.forEach(function (field) {
    const before = Object.getOwnPropertyDescriptor(owner, field);
    let value = owner[field];
    const read = before && before.get ? function () { return before.get.call(owner); } : function () { return value; };
    const write = before && before.set ? function (v) { before.set.call(owner, v); } : function (v) { value = v; };
    Object.defineProperty(owner, field, {
      configurable: true,
      enumerable: true,
      get: read,
      set: function (v) {
        write(v);
        events.push({
          field: field,
          value: v !== null && typeof v === "object" ? "object" : v,
          epoch: probe.epoch(),
          sessionHolds: probe.held() === owner.state
        });
      }
    });
    restore.push(function () {
      if (before && (before.get || before.set)) Object.defineProperty(owner, field, before);
      else Object.defineProperty(owner, field, { value: value, configurable: true, enumerable: true, writable: true });
    });
  });
  return {
    events: events,
    stop: function () { restore.splice(0).forEach(function (r) { r(); }); }
  };
}

export function firstWriteBeforeAdoption(events, documentField) {
  let assigned = false;
  for (const e of events) {
    if (e.field === documentField) {
      assigned = e.value !== null;
      continue;
    }
    if (assigned && !e.sessionHolds) return e;
  }
  return null;
}
