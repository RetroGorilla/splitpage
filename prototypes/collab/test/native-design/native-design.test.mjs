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

test('stale base: painted b and c mapped through relative positions delete the surviving d once b is gone', t => {
  const { a, b, sync } = pair(t, doc => { doc.getText('beat').insert(0, 'abcd'); });
  const text = a.getText('beat');
  const painted = [...text.toString()].map((_, index) => Y.createRelativePositionFromTypeIndex(text, index, 0));
  b.getText('beat').delete(1, 1);
  sync();
  const at = [1, 2].map(index => Y.createAbsolutePositionFromRelativePosition(painted[index], a).index);
  assert.deepEqual(at, [1, 1]);
  a.transact(() => { for (const index of [...at].sort((x, y) => y - x)) text.delete(index, 1); });
  sync();
  assert.equal(text.toString(), 'a');
});

function composing(text) {
  const units = [...Array(text.length).keys()].map(index => ({ painted: index, live: true }));
  const observer = (event, transaction) => {
    if (transaction.origin !== 'remote') return;
    let at = 0;
    const advance = count => {
      while (count > 0) { if (units[at].live) count--; at++; }
    };
    const skipDead = () => { while (at < units.length && !units[at].live) at++; };
    for (const step of event.delta) {
      if (step.retain) advance(step.retain);
      else if (step.delete) {
        let count = step.delete;
        while (count > 0) { skipDead(); units[at].live = false; at++; count--; }
      } else if (step.insert !== undefined) {
        const length = typeof step.insert === 'string' ? step.insert.length : 1;
        units.splice(at, 0, ...Array.from({ length }, () => ({ painted: null, live: true })));
        at += length;
      }
    }
  };
  text.observe(observer);
  return {
    commit(from, to, insert) {
      text.unobserve(observer);
      const liveBefore = position => units.slice(0, position).filter(unit => unit.live).length;
      const left = units.findLastIndex(unit => unit.painted !== null && unit.painted < from);
      const gap = liveBefore(left + 1);
      const doomed = units.flatMap((unit, position) => unit.live && unit.painted !== null && unit.painted >= from && unit.painted < to ? [liveBefore(position)] : []);
      text.doc.transact(() => {
        if (insert) text.insert(gap, insert);
        for (const index of doomed.sort((x, y) => y - x)) text.delete(index + (insert && index >= gap ? insert.length : 0), 1);
      });
    }
  };
}

for (const [name, remote, from, to, insert, expected] of [
  ['remote deleted b; local deletes bc', text => text.delete(1, 1), 1, 3, '', 'ad'],
  ['remote deleted bc; local deletes bc', text => text.delete(1, 2), 1, 3, '', 'ad'],
  ['remote typed X between b and c; local deletes bc', text => text.insert(2, 'X'), 1, 3, '', 'aXd'],
  ['remote deleted b; local replaces bc with Y', text => text.delete(1, 1), 1, 3, 'Y', 'aYd'],
  ['remote deleted a; local types Y after a', text => text.delete(0, 1), 1, 1, 'Y', 'Ybcd'],
  ['remote put an embed between b and c; local deletes bc', text => text.insertEmbed(2, { k: 'shot' }), 1, 3, '', 'a\u0000d']
]) {
  test(`composition reconciled against the remote delta: ${name}`, t => {
    const { a, b, sync } = pair(t, doc => { doc.getText('beat').insert(0, 'abcd'); });
    const text = a.getText('beat');
    const edit = composing(text);
    remote(b.getText('beat'));
    sync();
    edit.commit(from, to, insert);
    sync();
    const shown = doc => doc.getText('beat').toDelta().map(step => typeof step.insert === 'string' ? step.insert : '\u0000').join('');
    assert.equal(shown(a), expected);
    assert.equal(shown(b), expected);
  });
}

test('stale base: the same deletion by painted offsets removes X and keeps c', t => {
  const { a, b, sync } = pair(t, doc => { doc.getText('beat').insert(0, 'abcd'); });
  b.getText('beat').insert(2, 'X');
  sync();
  a.getText('beat').delete(1, 2);
  sync();
  assert.equal(a.getText('beat').toString(), 'acd');
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

test('a delete filter that keeps a created record still holding a field: undo removes the name, keeps the colour', t => {
  const { a, b, sync } = pair(t);
  const origin = { local: true };
  const people = a.getMap('people');
  const deleteFilter = item => !(item.content instanceof Y.ContentType && item.parent === people && item.content.type.size > 0);
  const undo = new Y.UndoManager(people, { trackedOrigins: new Set([origin]), deleteFilter });
  a.transact(() => { const person = new Y.Map(); people.set('p1', person); person.set('name', 'Ada'); }, origin);
  sync();
  b.getMap('people').get('p1').set('colour', 'teal');
  sync();
  assert.notEqual(undo.undo(), null);
  sync();
  for (const doc of [a, b]) assert.deepEqual(doc.getMap('people').get('p1').toJSON(), { colour: 'teal' });
});

test('the same filter lets undo delete a created record nobody else changed', t => {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  const people = doc.getMap('people');
  const origin = { local: true };
  const deleteFilter = item => !(item.content instanceof Y.ContentType && item.parent === people && item.content.type.size > 0);
  const undo = new Y.UndoManager(people, { trackedOrigins: new Set([origin]), deleteFilter });
  doc.transact(() => { const person = new Y.Map(); people.set('p1', person); person.set('name', 'Ada'); }, origin);
  assert.notEqual(undo.undo(), null);
  assert.equal(people.has('p1'), false);
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

test('resolve and reopen as two time fields: the later choice shows on both copies', t => {
  const { a, b, sync } = pair(t, doc => { doc.getMap('comments').set('c1', new Y.Map()); });
  a.getMap('comments').get('c1').set('resolvedAt', 2000);
  b.getMap('comments').get('c1').set('reopenedAt', 1000);
  sync();
  for (const doc of [a, b]) {
    const comment = doc.getMap('comments').get('c1');
    assert.equal((comment.get('resolvedAt') ?? 0) > (comment.get('reopenedAt') ?? 0), true);
  }
});
