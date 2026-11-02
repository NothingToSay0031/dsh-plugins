import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject } from '../index.js';

test('the plugin registers only the reply provenance projection', () => {
  const projections = [];
  const ctx = { sessionProjections: { register: projection => projections.push(projection) } };
  apply(ctx);
  assert.deepEqual(inject, ['sessionProjections']);
  assert.equal(projections.length, 1);
  assert.equal(projections[0].key, 'localModelReplyProvenance');
});

test('the plugin no longer touches provider configuration or model budgets', () => {
  assert.deepEqual(inject, ['sessionProjections']);
});
