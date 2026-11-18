import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as Y from 'yjs';

const require = createRequire(import.meta.url);

function pair(t, setup = () => {}) {
  assert.equal(require('yjs/package.json').version, '13.6.33');
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.clientID = 1;
  b.clientID = 2;
  t.after(() => { a.destroy(); b.destroy(); });
  setup(a);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
  const sync = () => {
    const au = Y.encodeStateAsUpdate(a);
    const bu = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, bu, 'remote');
    Y.applyUpdate(b, au, 'remote');
  };
  return { a, b, sync };
}

function convert(doc, text) {
  doc.transact(() => {
    const segment = new Y.Text();
    doc.getMap('segments').set('b:1', segment);
    doc.getArray('order').push(['b:1']);
    segment.insert(0, text);
  }, 'birth');
}

test('two conversions of one file: the order lists the beat twice and one copy\'s typing is gone', t => {
  const { a, b, sync } = pair(t);
  convert(a, 'hello');
  convert(b, 'hello');
  a.getMap('segments').get('b:1').insert(5, ' from A');
  sync();
  assert.deepEqual(a.getArray('order').toArray(), ['b:1', 'b:1']);
  assert.equal(a.getMap('segments').get('b:1').toString(), 'hello');
  assert.equal(b.getMap('segments').get('b:1').toString(), 'hello');
});

test('two conversions under one fixed client id with different text: the copies disagree', t => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  t.after(() => { a.destroy(); b.destroy(); });
  a.clientID = 0;
  b.clientID = 0;
  convert(a, 'hello');
  convert(b, 'hullo');
  const au = Y.encodeStateAsUpdate(a);
  const bu = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, bu, 'remote');
  Y.applyUpdate(b, au, 'remote');
  assert.notEqual(a.getMap('segments').get('b:1').toString(), b.getMap('segments').get('b:1').toString());
});

test('a join that copies the second visual cell and deletes it loses what another copy typed there', t => {
  const { a, b, sync } = pair(t, doc => {
    const visuals = doc.getMap('visuals');
    visuals.set('b1', new Y.Text('one'));
    visuals.set('b2', new Y.Text('two'));
  });
  a.transact(() => {
    const visuals = a.getMap('visuals');
    visuals.get('b1').insert(3, ' ' + visuals.get('b2').toString());
    visuals.delete('b2');
  });
  b.getMap('visuals').get('b2').insert(3, ' X');
  sync();
  assert.equal(a.getMap('visuals').get('b1').toString(), 'one two');
  assert.equal(a.getMap('visuals').has('b2'), false);
  assert.equal(b.getMap('visuals').get('b1').toString(), 'one two');
});

test('a join as a flag keeps what another copy typed in the second visual cell', t => {
  const { a, b, sync } = pair(t, doc => {
    const visuals = doc.getMap('visuals');
    visuals.set('b1', new Y.Text('one'));
    visuals.set('b2', new Y.Text('two'));
    const beat = new Y.Map();
    doc.getMap('beats').set('b2', beat);
  });
  a.getMap('beats').get('b2').set('joined', { into: 'b1', glue: ' ' });
  b.getMap('visuals').get('b2').insert(3, ' X');
  sync();
  assert.deepEqual(a.getMap('beats').get('b2').get('joined'), { into: 'b1', glue: ' ' });
  assert.equal(a.getMap('visuals').get('b2').toString(), 'two X');
});

test('a retried birth under the same creation id: one births entry, the order lists the segment twice, one copy\'s typing is gone', t => {
  const { a, b, sync } = pair(t);
  for (const doc of [a, b]) {
    doc.transact(() => doc.getMap('births').set('creation-1', { by: doc.clientID }), 'hydration');
    convert(doc, 'hello');
  }
  a.getMap('segments').get('b:1').insert(5, ' A');
  b.getMap('segments').get('b:1').insert(5, ' B');
  sync();
  assert.equal(a.getMap('births').size, 1);
  assert.deepEqual(a.getArray('order').toArray(), ['b:1', 'b:1']);
  assert.equal(a.getMap('segments').get('b:1').toString(), 'hello B');
});

test('a throw after the first write inside one transaction still commits and emits that write', t => {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const updates = [];
  doc.on('update', update => updates.push(update));
  assert.throws(() => doc.transact(() => { doc.getText('beat').insert(0, 'a'); throw new Error('second part refused'); }));
  assert.equal(doc.getText('beat').toString(), 'a');
  assert.equal(updates.length, 1);
});

test('setting a map key to its current value emits an update and wakes a remote observer', t => {
  const { a, b } = pair(t, doc => doc.getMap('beats').set('status', 'todo'));
  let updates = 0;
  let observed = 0;
  a.on('update', () => updates++);
  b.getMap('beats').observe(() => observed++);
  a.getMap('beats').set('status', 'todo');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'remote');
  assert.deepEqual([updates, observed], [1, 1]);
});

test('a replaced visual cell: a held relative position resolves to null and a write through the old cell is not shown', t => {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const visuals = doc.getMap('visuals');
  const cell = new Y.Text('abc');
  visuals.set('b2', cell);
  const position = Y.createRelativePositionFromTypeIndex(cell, 1);
  visuals.set('b2', new Y.Text('xyz'));
  cell.insert(0, 'Q');
  assert.equal(Y.createAbsolutePositionFromRelativePosition(position, doc), null);
  assert.equal(visuals.get('b2').toString(), 'xyz');
});

test('both copies delete the same b and undo before seeing the other\'s undo: both show abbc', t => {
  const { a, b, sync } = pair(t, doc => doc.getText('beat').insert(0, 'abc'));
  const origin = { local: true };
  const managers = [a, b].map(doc => new Y.UndoManager(doc.getText('beat'), { trackedOrigins: new Set([origin]) }));
  for (const doc of [a, b]) doc.transact(() => doc.getText('beat').delete(1, 1), origin);
  sync();
  for (const manager of managers) assert.notEqual(manager.undo(), null);
  sync();
  assert.deepEqual([a.getText('beat').toString(), b.getText('beat').toString()], ['abbc', 'abbc']);
});

test('a 1,000-character paste: encoded update bytes plain, with one identified key per character, with four', () => {
  const paste = attributes => {
    const doc = new Y.Doc();
    doc.clientID = 7;
    let bytes = 0;
    doc.on('update', update => { bytes += update.byteLength; });
    const text = doc.getText('beat');
    doc.transact(() => {
      if (!attributes) text.insert(0, 'x'.repeat(1000));
      else for (let index = 0; index < 1000; index++) text.insert(index, 'x', attributes(index));
    });
    doc.destroy();
    return bytes;
  };
  const keys = kinds => index => Object.fromEntries(kinds.map(kind => [`${kind}\u001f7.${index.toString(36)}`, true]));
  assert.deepEqual([paste(null), paste(keys(['b'])), paste(keys(['b', 'i', 'hl', 't:tag1']))], [1014, 37809, 145593]);
});

test('a new history rebuilt from the visible text and synced with the old one doubles the text', t => {
  const { a, b, sync } = pair(t);
  a.getText('beat').insert(0, 'seed');
  b.getText('beat').insert(0, a.getText('beat').toString());
  sync();
  assert.equal(a.getText('beat').toString(), 'seedseed');
});

test('plain undo: a group that deleted all it typed is passed over and the same press undoes the step before', t => {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const text = doc.getText('beat');
  const origin = { local: true };
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([origin]), captureTimeout: 60_000 });
  doc.transact(() => text.insert(0, 'x'), origin);
  undo.stopCapturing();
  doc.transact(() => text.insert(1, 'y'), origin);
  doc.transact(() => text.delete(1, 1), origin);
  assert.equal(undo.undoStack.length, 2);
  assert.notEqual(undo.undo(), null);
  assert.equal(text.toString(), '');
  assert.equal(undo.undoStack.length, 0);
});

test('plain undo of a record\'s creation deletes a field another copy set in it', t => {
  const { a, b, sync } = pair(t);
  const origin = { local: true };
  const undo = new Y.UndoManager(a.getMap('people'), { trackedOrigins: new Set([origin]) });
  a.transact(() => {
    const person = new Y.Map();
    a.getMap('people').set('p1', person);
    person.set('name', 'Ada');
  }, origin);
  sync();
  b.getMap('people').get('p1').set('colour', 'teal');
  sync();
  assert.notEqual(undo.undo(), null);
  sync();
  assert.equal(a.getMap('people').has('p1'), false);
  assert.equal(b.getMap('people').has('p1'), false);
});

test('undo inside an outer transaction whose origin is the manager undoes the text but leaves no redo', t => {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const text = doc.getText('beat');
  const origin = { local: true };
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) });
  doc.transact(() => text.insert(0, 'abc'), origin);
  doc.transact(() => undo.undo(), undo);
  assert.equal(text.toString(), '');
  assert.equal(undo.undoStack.length, 1);
  assert.equal(undo.redoStack.length, 0);
});

function identicalStatus(t) {
  const { a, b, sync } = pair(t, doc => { const beat = new Y.Map(); doc.getMap('beats').set('b1', beat); beat.set('status', 'todo'); });
  const origin = { local: true };
  const undo = new Y.UndoManager(b.getMap('beats'), { trackedOrigins: new Set([origin]) });
  a.getMap('beats').get('b1').set('status', 'shot');
  b.transact(() => b.getMap('beats').get('b1').set('status', 'shot'), origin);
  sync();
  return { a, b, sync, undo, beat: b.getMap('beats').get('b1') };
}

test('identical statuses: the winner\'s undo leaves the status absent on both copies; redo brings it back', t => {
  const { a, sync, undo, beat } = identicalStatus(t);
  assert.notEqual(undo.undo(), null);
  sync();
  assert.equal(beat.has('status'), false);
  assert.equal(a.getMap('beats').get('b1').has('status'), false);
  assert.notEqual(undo.redo(), null);
  sync();
  assert.equal(a.getMap('beats').get('b1').get('status'), 'shot');
});

test('identical statuses: a fallback value written after the undo makes the following redo do nothing', t => {
  const { a, sync, undo, beat } = identicalStatus(t);
  assert.notEqual(undo.undo(), null);
  beat.doc.transact(() => beat.set('status', 'todo'), 'fallback');
  sync();
  assert.equal(undo.redo(), null);
  sync();
  assert.equal(a.getMap('beats').get('b1').get('status'), 'todo');
});

test('deleted text kept by undo history stays in the encoded state after clear() until a fresh copy is made', t => {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const text = doc.getText('beat');
  const origin = { local: true };
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) });
  doc.transact(() => text.insert(0, 'x'.repeat(10_000)), origin);
  doc.transact(() => text.delete(0, 10_000), origin);
  undo.clear();
  const kept = Y.encodeStateAsUpdate(doc).byteLength;
  const fresh = new Y.Doc();
  t.after(() => fresh.destroy());
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  const rebuilt = Y.encodeStateAsUpdate(fresh).byteLength;
  assert.ok(kept > 10_000);
  assert.ok(rebuilt < 100);
});

test('formatting key per action: bolding growing prefixes leaves one live key per act on the first character', t => {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  doc.clientID = 1;
  const text = doc.getText('beat');
  const keys = [];
  for (let act = 1; act <= 100; act++) {
    text.insert(text.length, 'x', {});
    const key = `b\u001f1.${act.toString(36)}`;
    keys.push(key);
    text.format(0, act, { [key]: true });
  }
  assert.equal(Object.keys(text.toDelta()[0].attributes).length, 100);
  const formatted = Y.encodeStateAsUpdate(doc).byteLength;
  text.format(0, text.length, Object.fromEntries(keys.map(key => [key, null])));
  const fresh = new Y.Doc();
  t.after(() => fresh.destroy());
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  const unformatted = Y.encodeStateAsUpdate(fresh).byteLength;
  assert.deepEqual(text.toDelta(), [{ insert: 'x'.repeat(100) }]);
  const plain = new Y.Doc();
  t.after(() => plain.destroy());
  plain.clientID = 1;
  for (let act = 1; act <= 100; act++) plain.getText('beat').insert(act - 1, 'x');
  const baseline = Y.encodeStateAsUpdate(plain).byteLength;
  assert.deepEqual([formatted, unformatted, baseline], [3610, 1739, 113]);
});

test('a comment body as one whole string: two people adding to it at once keep only one addition', t => {
  const { a, b, sync } = pair(t, doc => {
    const comment = new Y.Map();
    doc.getMap('comments').set('c1', comment);
    comment.set('body', 'Note');
  });
  a.getMap('comments').get('c1').set('body', 'Note from A');
  b.getMap('comments').get('c1').set('body', 'Note from B');
  sync();
  const bodies = [a, b].map(doc => doc.getMap('comments').get('c1').get('body'));
  assert.equal(bodies[0], bodies[1]);
  assert.equal(['Note from A', 'Note from B'].includes(bodies[0]), true);
});

test('a comment body as Y.Text: both additions stay', t => {
  const { a, b, sync } = pair(t, doc => {
    const comment = new Y.Map();
    doc.getMap('comments').set('c1', comment);
    comment.set('body', new Y.Text('Note'));
  });
  a.getMap('comments').get('c1').get('body').insert(4, ' from A');
  b.getMap('comments').get('c1').get('body').insert(4, ' from B');
  sync();
  assert.equal(a.getMap('comments').get('c1').get('body').toString(), 'Note from A from B');
  assert.equal(b.getMap('comments').get('c1').get('body').toString(), 'Note from A from B');
});
