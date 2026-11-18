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

test('stale base: a deletion of painted b and c, mapped through relative positions, keeps an unpainted X', t => {
  const { a, b, sync } = pair(t, doc => { doc.getText('beat').insert(0, 'abcd'); });
  const text = a.getText('beat');
  const painted = [...text.toString()].map((_, index) => Y.createRelativePositionFromTypeIndex(text, index, 0));
  b.getText('beat').insert(2, 'X');
  sync();
  assert.equal(text.toString(), 'abXcd');
  a.transact(() => {
    const at = [1, 2].map(index => Y.createAbsolutePositionFromRelativePosition(painted[index], a).index).sort((x, y) => y - x);
    for (const index of at) text.delete(index, 1);
  });
  sync();
  assert.equal(text.toString(), 'aXd');
  assert.equal(b.getText('beat').toString(), 'aXd');
});

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
