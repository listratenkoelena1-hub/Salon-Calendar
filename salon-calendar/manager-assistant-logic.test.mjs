import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./manager-assistant-logic.js', import.meta.url), 'utf8');
const logic = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function questionFor(service) {
  return logic.getManagerServiceQuestion(logic.analyzeManagerService(service));
}

test('paraffin alone is ignored completely', () => {
  const analysis = logic.analyzeManagerService('paraffin');
  assert.equal(analysis.hasRecognizedService, false);
  assert.equal(questionFor('paraffin'), null);
});

test('paraffin is removed but leaves an ambiguous pedicure question', () => {
  for (const service of ['pedi paraffin', 'pedicure + paraffin', 'педикюр парафин']) {
    assert.equal(questionFor(service)?.key, 'pedi-type');
  }
});

test('standalone P and pedi ask which pedicure', () => {
  for (const service of ['P', 'pedi', 'pedicure', 'педикюр']) {
    assert.equal(questionFor(service)?.key, 'pedi-type');
  }
});

test('unambiguous pedicure variants do not ask the main question', () => {
  for (const service of [
    'pedi gel',
    'gel pedi',
    'shellac pedi',
    'pedi no color',
    'pedi no polish',
    'cleaning only pedi',
    'no washing',
    'toes',
    'toe color change',
    'pedi color change',
    'deluxe pedi'
  ]) {
    assert.notEqual(questionFor(service)?.key, 'pedi-type', service);
  }
});

test('pedicure duration categories follow configured service keys', () => {
  assert.deepEqual(logic.analyzeManagerService('pedi regular polish').durationKeys, ['pedicureNoColor']);
  assert.deepEqual(logic.analyzeManagerService('pedi no color').durationKeys, ['pedicureNoColor']);
  assert.deepEqual(logic.analyzeManagerService('deluxe pedi').durationKeys, ['pedicureGelPolish']);
  assert.deepEqual(logic.analyzeManagerService('toes').durationKeys, ['pedicureChangeColor']);
});

test('generic manicure spellings ask which nail service', () => {
  for (const service of ['M', 'mani', 'manicure', 'маникюр', 'nails']) {
    assert.equal(questionFor(service)?.key, 'mani-type');
  }
});

test('hard gel and acrylic ask set type only when it is missing', () => {
  assert.equal(questionFor('hard gel')?.key, 'mani-set-type');
  assert.equal(questionFor('acrylic')?.key, 'mani-set-type');
  assert.equal(questionFor('hard gel refill')?.key, 'mani-design');
  assert.equal(questionFor('acrylic new set')?.key, 'mani-design');
});

test('regular polish and no color never ask about design', () => {
  assert.equal(questionFor('mani regular polish'), null);
  assert.equal(questionFor('mani no color'), null);
});

test('design on an eligible nail service adds one 15-minute slot', () => {
  const withDesign = logic.analyzeManagerService('mani gel polish design');
  assert.equal(withDesign.designSlots, 1);
  assert.equal(questionFor('mani gel polish')?.key, 'mani-design');
});

test('PM choices are inserted into their own Pedi and Mani sections', () => {
  let value = 'PM';
  let analysis = logic.analyzeManagerService(value);
  assert.equal(questionFor(value)?.key, 'pedi-type');
  value = logic.applyManagerServiceChoice(value, 'pedi-gel', analysis);
  assert.match(value, /Pedi:\s*gel polish/i);
  assert.match(value, /Mani\s*;/i);
  assert.equal(questionFor(value)?.key, 'mani-type');

  analysis = logic.analyzeManagerService(value);
  value = logic.applyManagerServiceChoice(value, 'mani-hard-gel', analysis);
  assert.match(value, /Mani:\s*hard gel/i);
  assert.equal(questionFor(value)?.key, 'mani-set-type');

  analysis = logic.analyzeManagerService(value);
  value = logic.applyManagerServiceChoice(value, 'mani-refill', analysis);
  assert.equal(questionFor(value)?.key, 'mani-design');
});
