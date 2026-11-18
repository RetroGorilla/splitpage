import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as Y from 'yjs';

const require = createRequire(import.meta.url);

function replicas(t, initial = 'abcd') {
  assert.equal(require('yjs/package.json').version, '13.6.33');
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.clientID = 1;
  b.clientID = 2;
  t.after(() => { a.destroy(); b.destroy(); });
  const at = a.getText('text');
  at.insert(0, initial);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const bt = b.getText('text');
  const sync = () => {
    const au = Y.encodeStateAsUpdate(a);
    const bu = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, bu, 'remote');
    Y.applyUpdate(b, au, 'remote');
    assert.deepEqual(at.toDelta(), bt.toDelta());
  };
  return { a, b, at, bt, sync };
}

test('M-inside: unseen italic then delete leaves concurrent interior X plain', t => {
  const { at, bt, sync } = replicas(t);
  at.format(1, 2, { italic: true });
  at.delete(1, 2);
  bt.insert(2, 'X');
  sync();
  assert.deepEqual(at.toDelta(), [{ insert: 'aXd' }]);
});

test('M-edge: concurrent X immediately before bold bc becomes bold', t => {
  const { at, bt, sync } = replicas(t);
  bt.insert(1, 'X');
  at.format(1, 2, { bold: true });
  sync();
  assert.deepEqual(at.toDelta(), [
    { insert: 'a' }, { insert: 'Xbc', attributes: { bold: true } }, { insert: 'd' },
  ]);
});

test('M-loss: formatting cleanup can remove italic from untouched d', t => {
  const { a, b, at, bt } = replicas(t);
  const queue = [];
  a.on('update', (update, origin) => { if (origin !== 'remote') queue.push([b, update]); });
  b.on('update', (update, origin) => { if (origin !== 'remote') queue.push([a, update]); });
  at.format(1, 2, { italic: true });
  at.format(3, 1, { italic: true });
  bt.format(2, 1, { italic: true });
  bt.delete(0, 3);
  while (queue.length) {
    const [doc, update] = queue.shift();
    Y.applyUpdate(doc, update, 'remote');
  }
  assert.deepEqual(at.toDelta(), [{ insert: 'd' }]);
  assert.deepEqual(bt.toDelta(), at.toDelta());
});

test('F-status: different concurrent statuses choose a value, not the prior status', t => {
  const { a, b, sync } = replicas(t);
  a.getMap('beat').set('status', 'todo');
  sync();
  a.getMap('beat').set('status', 'ready');
  b.getMap('beat').set('status', 'shot');
  sync();
  const status = a.getMap('beat').get('status');
  assert.ok(status === 'ready' || status === 'shot');
  assert.equal(b.getMap('beat').get('status'), status);
});

test('F-clock: native winner ignores time; retained stamped candidates allow time and causal override', t => {
  const { a, b, sync } = replicas(t);
  for (const field of ['resolution', 'stamp']) {
    a.getMap(field).set('value', { at: 100, by: 'Alice', value: 'A' });
    b.getMap(field).set('value', { at: 1, by: 'Bob', value: 'B' });
    a.getMap(`${field}-candidates`).set('A', { at: 100, by: 'Alice', value: 'A' });
    b.getMap(`${field}-candidates`).set('B', { at: 1, by: 'Bob', value: 'B' });
  }
  sync();
  for (const field of ['resolution', 'stamp']) {
    assert.equal(a.getMap(field).get('value').value, 'B');
    assert.deepEqual(b.getMap(field).get('value'), a.getMap(field).get('value'));
    for (const doc of [a, b]) {
      const values = [...doc.getMap(`${field}-candidates`).values()];
      assert.equal(values.length, 2);
      values.sort((x, y) => x.at - y.at || (x.by < y.by ? -1 : x.by > y.by ? 1 : 0));
      assert.equal(values.at(-1).value, 'A');
    }
    const candidates = b.getMap(`${field}-candidates`);
    b.transact(() => {
      for (const key of candidates.keys()) candidates.delete(key);
      candidates.set('C', { at: 0, by: 'Bob', value: 'C' });
    });
  }
  sync();
  for (const field of ['resolution', 'stamp']) {
    for (const doc of [a, b]) {
      assert.deepEqual([...doc.getMap(`${field}-candidates`).values()], [
        { at: 0, by: 'Bob', value: 'C' },
      ]);
    }
  }
});

test('U-identical: undo does not cancel an unseen identical remote format', t => {
  const { at, bt, sync } = replicas(t);
  const undo = new Y.UndoManager(at);
  t.after(() => undo.destroy());
  at.format(1, 2, { bold: true });
  bt.format(1, 2, { bold: true });
  undo.undo();
  sync();
  assert.deepEqual(at.toDelta(), [
    { insert: 'a' }, { insert: 'bc', attributes: { bold: true } }, { insert: 'd' },
  ]);
});

test('R-beat: keeping text beside a removal flag retains an unseen edit for a late copy', t => {
  const { a, b, at, bt, sync } = replicas(t);
  a.getMap('beat').set('removed', true);
  bt.insert(2, 'X');
  sync();
  assert.equal(at.toString(), 'abXcd');
  assert.equal(b.getMap('beat').get('removed'), true);
  const late = new Y.Doc();
  t.after(() => late.destroy());
  Y.applyUpdate(late, Y.encodeStateAsUpdate(a));
  assert.equal(late.getText('text').toString(), 'abXcd');
  assert.equal(late.getMap('beat').get('removed'), true);
  a.getMap('beat').set('removed', false);
  sync();
  assert.equal(b.getMap('beat').get('removed'), false);
  assert.equal(bt.toString(), 'abXcd');
});

test('T-delete: observed deletion keeps concurrent inserted text', t => {
  const { at, bt, sync } = replicas(t);
  at.delete(1, 2);
  bt.insert(2, 'X');
  sync();
  assert.equal(at.toString(), 'aXd');
});

test('U-own: local text undo keeps remote text', t => {
  const { at, bt, sync } = replicas(t);
  const undo = new Y.UndoManager(at);
  t.after(() => undo.destroy());
  at.insert(1, 'A');
  bt.insert(3, 'B');
  sync();
  undo.undo();
  sync();
  assert.equal(at.toString(), 'abcBd');
});
