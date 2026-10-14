const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const calendarDir = path.resolve(__dirname, '..', '..', 'salon-calendar');
const html = fs.readFileSync(path.join(calendarDir, 'index.html'), 'utf8');
const assistant = fs.readFileSync(path.join(calendarDir, 'manager-assistant.js'), 'utf8');

test('focused Buddha integration is manager-only and contains the approved introduction', () => {
  assert.match(html, /if \(currentUserRole !== 'manager'\) return null;/);
  assert.match(html, /Hello, I'm here to help\./);
  assert.match(html, /check appointment duration, assign Anyone bookings in order/);
  assert.match(html, /Don't show this again/);
  assert.match(assistant, /title: 'Bình an 🌿'/);
  assert.match(assistant, /manager-assistant__preference-input/);
});

test('focused Buddha integration includes only the requested scheduling helpers', () => {
  assert.match(html, /getManagerAssistantDurationResult/);
  assert.match(html, /getManagerAssistantAnyoneResult/);
  assert.match(html, /getPendingManagerAssistantOnlineRequests/);
  assert.match(html, /showManagerAssistantDashReminder/);
  assert.doesNotMatch(html, /getManagerServiceQuestion/);
  assert.doesNotMatch(html, /applyManagerServiceChoice/);
  assert.doesNotMatch(html, /Any nail design\?/);
  assert.doesNotMatch(html, /new set or refill\?/i);
});

test('Buddha artwork required by every animation state is packaged', () => {
  for (const file of [
    'buddha-smile.png',
    'buddha-peek.png',
    'buddha-peek-wave.png',
    'buddha-poof.png',
    'buddha-walk-a.png',
    'buddha-walk-b.png',
    'buddha-wave.png',
    'buddha-laugh.png',
    'buddha-meditate.png'
  ]) {
    assert.equal(fs.existsSync(path.join(calendarDir, 'assets', 'manager-assistant', file)), true, file);
  }
});
