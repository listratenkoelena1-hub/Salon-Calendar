const STYLE_ID = 'managerAssistantStylesheet';
const ROOT_ID = 'managerAssistant';

const POSE_URLS = Object.freeze({
  smile: new URL('./assets/manager-assistant/buddha-smile.png', import.meta.url).href,
  peek: new URL('./assets/manager-assistant/buddha-peek.png', import.meta.url).href,
  walkA: new URL('./assets/manager-assistant/buddha-walk-a.png', import.meta.url).href,
  walkB: new URL('./assets/manager-assistant/buddha-walk-b.png?v=matched-color-slow-steps', import.meta.url).href,
  wave: new URL('./assets/manager-assistant/buddha-wave.png', import.meta.url).href,
  laugh: new URL('./assets/manager-assistant/buddha-laugh.png', import.meta.url).href,
  meditate: new URL('./assets/manager-assistant/buddha-meditate.png', import.meta.url).href
});

const STATE_POSES = Object.freeze({
  peeking: 'peek',
  walking: 'walkA',
  greeting: 'wave',
  sitting: 'smile',
  speaking: 'wave',
  laughing: 'laugh',
  meditating: 'meditate',
  leaving: 'walkA'
});

const STATE_CLASSES = Object.keys(STATE_POSES).map(state => `is-${state}`);

function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./manager-assistant.css', import.meta.url).href;
  document.head.appendChild(link);
}

function makeAvailabilityGroup(label, items, modifier = '') {
  if (!Array.isArray(items) || !items.length) return null;

  const group = document.createElement('div');
  group.className = `manager-assistant__availability-group${modifier ? ` ${modifier}` : ''}`;

  const labelEl = document.createElement('div');
  labelEl.className = 'manager-assistant__availability-label';
  labelEl.textContent = label;

  const list = document.createElement('div');
  list.className = 'manager-assistant__availability-list';

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'manager-assistant__availability-item';

    const dot = document.createElement('span');
    dot.className = 'manager-assistant__availability-dot';

    const text = document.createElement('span');
    text.textContent = String(item?.text || item || '');

    row.append(dot, text);
    list.appendChild(row);
  });

  group.append(labelEl, list);
  return group;
}

export function createManagerAssistant({ host = document.body, contained = false } = {}) {
  ensureStylesheet();

  document.getElementById(ROOT_ID)?.remove();

  const root = document.createElement('aside');
  root.id = ROOT_ID;
  root.className = `manager-assistant is-peeking${contained ? ' manager-assistant--contained' : ''}`;
  root.hidden = true;
  root.setAttribute('aria-label', 'Manager assistant');

  const characterButton = document.createElement('button');
  characterButton.className = 'manager-assistant__character-button';
  characterButton.type = 'button';
  characterButton.setAttribute('aria-label', 'Buddha assistant. Tap for a little laugh.');

  const characterImage = document.createElement('img');
  characterImage.className = 'manager-assistant__character-image';
  characterImage.alt = '';
  characterImage.decoding = 'async';
  characterImage.draggable = false;
  characterImage.setAttribute('aria-hidden', 'true');
  characterButton.appendChild(characterImage);

  const bubble = document.createElement('section');
  bubble.className = 'manager-assistant__bubble';
  bubble.setAttribute('aria-live', 'polite');
  bubble.setAttribute('aria-hidden', 'true');
  bubble.innerHTML = `
    <button class="manager-assistant__close" type="button" aria-label="Close assistant message">&times;</button>
    <p class="manager-assistant__eyebrow">Buddha assistant</p>
    <h3 class="manager-assistant__title"></h3>
    <p class="manager-assistant__intro"></p>
    <div class="manager-assistant__availability"></div>
    <p class="manager-assistant__empty" hidden></p>
  `;

  root.append(characterButton, bubble);
  host.appendChild(root);

  const title = bubble.querySelector('.manager-assistant__title');
  const intro = bubble.querySelector('.manager-assistant__intro');
  const availability = bubble.querySelector('.manager-assistant__availability');
  const empty = bubble.querySelector('.manager-assistant__empty');
  const closeButton = bubble.querySelector('.manager-assistant__close');
  const timers = new Set();
  const posePreloads = new Map();
  let activeContext = null;
  let visible = false;

  function later(callback, delay) {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  }

  function clearTimers() {
    timers.forEach(timer => window.clearTimeout(timer));
    timers.clear();
  }

  function preloadPose(pose) {
    if (posePreloads.has(pose) || !POSE_URLS[pose]) return;
    const image = new Image();
    image.decoding = 'async';
    image.src = POSE_URLS[pose];
    posePreloads.set(pose, image);
  }

  function preloadPoses(poses) {
    poses.forEach(preloadPose);
  }

  function setPose(pose) {
    const normalizedPose = POSE_URLS[pose] ? pose : 'smile';
    if (characterImage.dataset.pose === normalizedPose) return;
    characterImage.dataset.pose = normalizedPose;
    characterImage.src = POSE_URLS[normalizedPose];
  }

  function setState(state) {
    root.classList.remove(...STATE_CLASSES);
    root.classList.add(`is-${state}`);
    setPose(STATE_POSES[state] || 'smile');
  }

  function ensureVisible() {
    root.hidden = false;
    visible = true;
  }

  function setBubbleContext(context) {
    root.classList.toggle('is-greeting-bubble', context === 'welcome');
    root.classList.toggle('is-availability-bubble', context === 'availability');
  }

  function hideBubble() {
    root.classList.remove('is-bubble-visible');
    bubble.setAttribute('aria-hidden', 'true');
    setBubbleContext(null);
  }

  function renderMessage(payload = {}) {
    title.textContent = payload.title || 'A little schedule check';
    intro.textContent = payload.intro || '';
    intro.hidden = !intro.textContent;
    availability.replaceChildren();

    const nowGroup = makeAvailabilityGroup(payload.nowLabel || 'Free now', payload.availableNow || []);
    const soonGroup = makeAvailabilityGroup(
      payload.soonLabel || 'Free soon',
      payload.availableSoon || [],
      'manager-assistant__availability-group--soon'
    );

    if (nowGroup) availability.appendChild(nowGroup);
    if (soonGroup) availability.appendChild(soonGroup);

    const hasItems = Boolean(nowGroup || soonGroup);
    availability.hidden = !hasItems;
    const emptyText = String(payload.emptyText || '');
    empty.hidden = hasItems || !emptyText;
    empty.textContent = hasItems ? '' : emptyText;
  }

  function showBubble(payload, { context, autoHideMs = 0 } = {}) {
    activeContext = context || null;
    renderMessage(payload);
    setBubbleContext(activeContext);
    root.classList.add('is-bubble-visible');
    bubble.setAttribute('aria-hidden', 'false');

    if (autoHideMs > 0) {
      later(() => dismissTip(), autoHideMs);
    }
  }

  function smile() {
    clearTimers();
    ensureVisible();
    hideBubble();
    activeContext = null;
    setState('sitting');
  }

  function peek() {
    clearTimers();
    ensureVisible();
    hideBubble();
    activeContext = null;
    setState('peeking');
    later(() => setState('sitting'), 1900);
  }

  function playWelcome({ autoHideMs = 5000 } = {}) {
    clearTimers();
    ensureVisible();
    hideBubble();
    activeContext = null;
    preloadPoses(['walkA', 'walkB', 'wave', 'smile']);
    setState('peeking');

    later(() => setState('walking'), 680);
    for (let step = 0; step < 4; step += 1) {
      later(() => setPose(step % 2 === 0 ? 'walkA' : 'walkB'), 680 + step * 320);
    }

    later(() => setState('greeting'), 2100);
    later(() => {
      showBubble({
        title: 'Hi there!',
        intro: 'Bình an 🌿'
      }, {
        context: 'welcome',
        autoHideMs
      });
    }, 2300);
  }

  function playLaugh() {
    clearTimers();
    ensureVisible();
    hideBubble();
    activeContext = null;
    setState('laughing');
    later(() => setState('meditating'), 2200);
  }

  function playMeditate() {
    clearTimers();
    ensureVisible();
    hideBubble();
    activeContext = null;
    setState('meditating');
  }

  function dismissTip({ celebrate } = {}) {
    const shouldCelebrate = typeof celebrate === 'boolean'
      ? celebrate
      : activeContext === 'availability';

    clearTimers();
    hideBubble();
    activeContext = null;
    ensureVisible();

    if (!shouldCelebrate) {
      setState('sitting');
      return;
    }

    setState('sitting');
    later(() => setState('laughing'), 350);
    later(() => setState('meditating'), 2550);
  }

  function showAvailability(payload = {}, { autoHideMs = 9000 } = {}) {
    clearTimers();
    ensureVisible();
    preloadPoses(['wave', 'laugh', 'meditate']);
    setState('speaking');
    showBubble(payload, {
      context: 'availability',
      autoHideMs
    });
  }

  function hide({ immediate = false } = {}) {
    clearTimers();
    hideBubble();
    activeContext = null;

    if (immediate) {
      root.hidden = true;
      visible = false;
      setState('peeking');
      return;
    }

    ensureVisible();
    setState('leaving');
    later(() => setPose('walkB'), 170);
    later(() => setPose('walkA'), 340);
    later(() => {
      root.hidden = true;
      visible = false;
      setState('peeking');
    }, 680);
  }

  function destroy() {
    clearTimers();
    root.remove();
    visible = false;
  }

  characterButton.addEventListener('click', () => {
    if (root.classList.contains('is-bubble-visible')) {
      dismissTip();
      return;
    }
    playLaugh();
  });

  closeButton.addEventListener('click', () => dismissTip());

  return {
    showAvailability,
    playWelcome,
    dismissTip,
    peek,
    smile,
    playLaugh,
    playMeditate,
    hide,
    destroy,
    isVisible: () => visible
  };
}
