import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollOperation } from '../src/operationPolling.ts';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('polls sequentially and stops on completion', async () => {
  let active = 0, count = 0, maximum = 0;
  const stop = pollOperation(async () => {
    maximum = Math.max(maximum, ++active);
    await delay(20); active--; return ++count;
  }, async value => value === 3, assert.fail, 2, 100);
  try {
    await delay(150);
    assert.equal(maximum, 1); assert.equal(count, 3);
  } finally { stop(); }
});

test('transient bridge failures retry instead of leaving Play stuck', async () => {
  let count = 0, errors = 0, received = 0;
  const stop = pollOperation(async () => {
    if (++count === 1) throw new Error('temporary');
    return 'done';
  }, async () => { received++; return true; }, () => errors++, 2, 100);
  try { await delay(50); assert.equal(errors, 1); assert.equal(received, 1); }
  finally { stop(); }
});

test('hung bridge request times out and ignores its late response', async () => {
  let resolveOld, count = 0, errors = 0;
  const values = [];
  const stop = pollOperation(() => ++count === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve('done'),
    async value => { values.push(value); return true; }, () => errors++, 2, 15);
  try {
    await delay(60); resolveOld('stale'); await delay(10);
    assert.equal(errors, 1); assert.deepEqual(values, ['done']);
  } finally { stop(); }
});

test('stopping an old poll discards pending replies', async () => {
  let resolve, received = 0;
  const stop = pollOperation(() => new Promise(done => { resolve = done; }), async () => { received++; return true; }, assert.fail, 2, 100);
  stop(); resolve('old operation'); await delay(20);
  assert.equal(received, 0);
});
