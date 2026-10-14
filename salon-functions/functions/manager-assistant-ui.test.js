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
  assert.match(html, /this is just the beginning — over time, I'll be able to help with even more/);
  assert.match(html, /Don't show this again/);
  assert.doesNotMatch(html, /close-introduction/);
  assert.match(assistant, /title: 'Bình an 🌿'/);
  assert.match(assistant, /manager-assistant__preference-input/);
});

test('focused Buddha integration includes only the requested scheduling helpers', () => {
  assert.match(html, /getManagerAssistantDurationResult/);
  assert.match(html, /getManagerAssistantAnyoneResult/);
  assert.match(html, /getPendingManagerAssistantOnlineRequests/);
  assert.match(html, /showManagerAssistantDashReminder/);
  assert.match(html, /buildManagerAssistantAppointmentResult\(\{ forSave = false \} = \{\}\)/);
  assert.match(html, /if \(!forSave \|\| !aNote\.value\.trim\(\)\) return null/);
  assert.match(html, /Assign this service to \$\{selected\.member\.name\}\?/);
  assert.doesNotMatch(html, /getManagerServiceQuestion/);
  assert.doesNotMatch(html, /applyManagerServiceChoice/);
  assert.doesNotMatch(html, /Any nail design\?/);
  assert.doesNotMatch(html, /new set or refill\?/i);
});

test('manager Update stays centered while other roles keep the existing placement', () => {
  assert.match(html, /#calendarUpdateBtn\s*\{[\s\S]*?left:\s*16px\s*!important/);
  assert.match(html, /body\.manager-user #calendarUpdateBtn\s*\{[\s\S]*?left:\s*50%\s*!important[\s\S]*?translateX\(-50%\)/);
  assert.match(html, /classList\.toggle\('manager-user', currentUserRole === 'manager'\)/);
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
