const STYLE_ID = 'managerAssistantStylesheet';
const ROOT_ID = 'managerAssistant';
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const MOTION = Object.freeze({
  poseTransitionMs: REDUCED_MOTION ? 1 : 400,
  peekHoldMs: REDUCED_MOTION ? 1 : 1600,
  frameMs: REDUCED_MOTION ? 1 : 400,
  walkDurationMs: REDUCED_MOTION ? 3 : 1200,
  greetingLeadMs: REDUCED_MOTION ? 1 : 200,
  waveCycleMs: REDUCED_MOTION ? 1 : 800,
  idleCycleMs: REDUCED_MOTION ? 1 : 3200,
  laughCycleMs: REDUCED_MOTION ? 1 : 400,
  laughDurationMs: REDUCED_MOTION ? 1 : 2000,
  meditateCycleMs: REDUCED_MOTION ? 1 : 2400,
  poofDurationMs: REDUCED_MOTION ? 1 : 1000
});

const POSE_URLS = Object.freeze({
  smile: new URL('./assets/manager-assistant/buddha-smile.png', import.meta.url).href,
  peek: new URL('./assets/manager-assistant/buddha-peek.png', import.meta.url).href,
  peekWave: new URL('./assets/manager-assistant/buddha-peek-wave.png?v=modal-poof-variant', import.meta.url).href,
  poof: new URL('./assets/manager-assistant/buddha-poof.png?v=modal-poof-variant', import.meta.url).href,
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
  poofing: 'poof',
  'modal-peeking': 'peek',
  'modal-speaking': 'peekWave',
  leaving: 'walkA'
});

const STATE_CLASSES = Object.keys(STATE_POSES).map(state => `is-${state}`);

function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./manager-assistant.css?v=final-motion-sequence', import.meta.url).href;
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
  root.style.setProperty('--ma-pose-transition-ms', `${MOTION.poseTransitionMs}ms`);
  root.style.setProperty('--ma-frame-ms', `${MOTION.frameMs}ms`);
  root.style.setProperty('--ma-walk-ms', `${MOTION.walkDurationMs}ms`);
  root.style.setProperty('--ma-wave-cycle-ms', `${MOTION.waveCycleMs}ms`);
  root.style.setProperty('--ma-idle-cycle-ms', `${MOTION.idleCycleMs}ms`);
  root.style.setProperty('--ma-laugh-cycle-ms', `${MOTION.laughCycleMs}ms`);
  root.style.setProperty('--ma-meditate-cycle-ms', `${MOTION.meditateCycleMs}ms`);
  root.style.setProperty('--ma-poof-ms', `${MOTION.poofDurationMs}ms`);

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
  let modalMode = false;
  let modalTransitionTimer = 0;
  let pendingModalTip = null;
  let modalObserver = null;
  let welcomeRequested = false;
  let welcomeShown = false;
  let welcomePending = false;

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

  function clearModalTransitionTimer() {
    if (!modalTransitionTimer) return;
    window.clearTimeout(modalTransitionTimer);
    modalTransitionTimer = 0;
  }

  function afterModalPoof(callback) {
    clearModalTransitionTimer();
    modalTransitionTimer = window.setTimeout(() => {
      modalTransitionTimer = 0;
      callback();
    }, MOTION.poofDurationMs);
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

  function showPendingModalTip() {
    if (!modalMode || !pendingModalTip) return;

    const tip = pendingModalTip;
    pendingModalTip = null;
    setState('modal-speaking');
    showBubble(tip.payload, {
      context: 'availability',
      autoHideMs: tip.autoHideMs
    });
  }

  function playEntrance({ showGreeting = false, autoHideMs = 5000 } = {}) {
    clearTimers();
    clearModalTransitionTimer();
    ensureVisible();
    hideBubble();
    activeContext = null;
    pendingModalTip = null;
    if (showGreeting) welcomePending = false;
    preloadPoses(['peek', 'walkA', 'walkB', 'wave', 'smile']);
    setState('peeking');

    const walkingAt = MOTION.peekHoldMs;
    const arrivalAt = walkingAt + MOTION.walkDurationMs;

    later(() => setState('walking'), walkingAt);
    later(() => setPose('walkB'), walkingAt + MOTION.frameMs);
    later(() => setPose('walkA'), walkingAt + MOTION.frameMs * 2);
    later(() => {
      if (modalMode) return;
      setState(showGreeting ? 'greeting' : 'sitting');

      if (!showGreeting) return;
      later(() => {
        if (modalMode) return;
        welcomeShown = true;
        welcomePending = false;
        showBubble({
          title: 'Hi there!',
          intro: 'Bình an 🌿'
        }, {
          context: 'welcome',
          autoHideMs
        });
      }, MOTION.greetingLeadMs);
    }, arrivalAt);
  }

  function enterModalMode() {
    modalMode = true;
    if (welcomeRequested && !welcomeShown) welcomePending = true;
    pendingModalTip = null;
    clearTimers();
    clearModalTransitionTimer();
    ensureVisible();
    hideBubble();
    activeContext = null;
    preloadPoses(['poof', 'peek', 'peekWave']);
    setState('poofing');

    afterModalPoof(() => {
      if (!modalMode) return;
      setState('modal-peeking');
      showPendingModalTip();
    });
  }

  function exitModalMode() {
    modalMode = false;
    const showDeferredGreeting = welcomePending && welcomeRequested && !welcomeShown;
    welcomePending = false;
    playEntrance({ showGreeting: showDeferredGreeting });
  }

  function syncModalMode() {
    const nextModalMode = document.body.classList.contains('modal-open');
    if (nextModalMode === modalMode) return;
    if (nextModalMode) {
      enterModalMode();
    } else {
      exitModalMode();
    }
  }

  function smile() {
    clearTimers();
    ensureVisible();
    hideBubble();
    activeContext = null;
    pendingModalTip = null;
    if (modalMode) {
      if (!modalTransitionTimer) setState('modal-peeking');
      return;
    }
    setState('sitting');
  }

  function peek() {
    clearTimers();
    ensureVisible();
    hideBubble();
    activeContext = null;
    pendingModalTip = null;
    if (modalMode) {
      if (!modalTransitionTimer) setState('modal-peeking');
      return;
    }
    setState('peeking');
    later(() => setState('sitting'), MOTION.peekHoldMs);
  }

  function playWelcome({ autoHideMs = 5000 } = {}) {
    welcomeRequested = true;
    welcomeShown = false;
    welcomePending = false;

    if (modalMode) {
      welcomePending = true;
      ensureVisible();
      if (!modalTransitionTimer && !root.classList.contains('is-bubble-visible')) {
        setState('modal-peeking');
      }
      return;
    }

    playEntrance({ showGreeting: true, autoHideMs });
  }

  function playLaugh() {
    clearTimers();
    ensureVisible();
    hideBubble();
    activeContext = null;
    pendingModalTip = null;
    if (modalMode) {
      if (!modalTransitionTimer) setState('modal-peeking');
      return;
    }
    setState('laughing');
    later(() => setState('meditating'), MOTION.laughDurationMs);
  }

  function playMeditate() {
    clearTimers();
    ensureVisible();
    hideBubble();
    activeContext = null;
    pendingModalTip = null;
    if (modalMode) {
      if (!modalTransitionTimer) setState('modal-peeking');
      return;
    }
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
    pendingModalTip = null;

    if (modalMode) {
      if (!modalTransitionTimer) setState('modal-peeking');
      return;
    }

    if (!shouldCelebrate) {
      setState('sitting');
      return;
    }

    setState('sitting');
    later(() => setState('laughing'), MOTION.frameMs);
    later(() => setState('meditating'), MOTION.frameMs + MOTION.laughDurationMs);
  }

  function showAvailability(payload = {}, { autoHideMs = 9000 } = {}) {
    clearTimers();
    ensureVisible();
    preloadPoses(['wave', 'laugh', 'meditate', 'peekWave']);

    if (modalMode) {
      pendingModalTip = { payload, autoHideMs };
      if (!modalTransitionTimer) showPendingModalTip();
      return;
    }

    setState('speaking');
    showBubble(payload, {
      context: 'availability',
      autoHideMs
    });
  }

  function hide({ immediate = false } = {}) {
    clearTimers();
    clearModalTransitionTimer();
    hideBubble();
    activeContext = null;
    pendingModalTip = null;

    if (immediate) {
      root.hidden = true;
      visible = false;
      setState('peeking');
      return;
    }

    ensureVisible();
    setState('leaving');
    later(() => setPose('walkB'), MOTION.frameMs);
    later(() => setPose('walkA'), MOTION.frameMs * 2);
    later(() => {
      root.hidden = true;
      visible = false;
      setState('peeking');
    }, MOTION.walkDurationMs);
  }

  function destroy() {
    clearTimers();
    clearModalTransitionTimer();
    modalObserver?.disconnect();
    modalObserver = null;
    root.remove();
    visible = false;
  }

  modalObserver = new MutationObserver(syncModalMode);
  modalObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });
  syncModalMode();

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
