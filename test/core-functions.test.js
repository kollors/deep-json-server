import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalNode } from '../dist/src/core/model.js';
import { capitalize, errorMessage, hasOnlyKeys, isPortNumber, toPascalCase } from '../dist/src/core/utils.js';

test('shared value helpers preserve input and handle empty values and own keys', () => {
  const inherited = Object.create({ unexpected: true });
  inherited.name = 'Анна';
  assert.equal(hasOnlyKeys(inherited, ['name']), true);
  assert.equal(hasOnlyKeys(Object.freeze({ name: 'Анна', extra: 1 }), ['name']), false);
  assert.equal(hasOnlyKeys({}, []), true);
  assert.equal(hasOnlyKeys(JSON.parse('{"__proto__":1}'), ['name']), false);
  assert.equal(capitalize(''), '');
  assert.equal(capitalize('helloWorld'), 'HelloWorld');
  assert.equal(capitalize('анна'), 'Анна');
  assert.equal(toPascalCase('user--profile'), 'UserProfile');
  assert.equal(errorMessage(new Error('missing')), 'missing');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage(404), '404');
  for (const port of [0, 80, 65535]) assert.equal(isPortNumber(port), true);
  for (const port of [-1, 65536, 1.2, NaN, Infinity, '80', null]) assert.equal(isPortNumber(port), false);
});

test('canonical nodes preserve identity and follow relation roots without modifying inputs', () => {
  const root = Object.freeze({ children: {} });
  const target = Object.freeze({ name: 'Book', root });
  const source = Object.freeze({ name: 'Author', root: {} });
  const relation = Object.freeze({ relation: target });
  assert.deepEqual(canonicalNode(source, relation), [target, root]);
  assert.equal(canonicalNode(source, relation)[1], root);
  const ordinary = Object.freeze({ children: {} });
  assert.deepEqual(canonicalNode(source, ordinary), [source, ordinary]);
  assert.equal(canonicalNode(source, ordinary)[1], ordinary);
});
