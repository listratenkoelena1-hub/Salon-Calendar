export {
  analyzeManagerService,
  applyManagerServiceChoice,
  getManagerServiceQuestion
} from './manager-assistant-logic.js?v=service-assistant-v2';

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
const KEYBOARD_MIN_HEIGHT_CHANGE = 110;
const MODAL_BUBBLE_EDGE_GAP = 6;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function isTextEntryElement(element) {
  if (!element) return false;
  if (element.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA'].includes(element.tagName);
}

function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./manager-assistant.css?v=service-assistant-v2', import.meta.url).href;
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
    <p class="manager-assistant__helper" hidden></p>
    <div class="manager-assistant__availability"></div>
    <p class="manager-assistant__empty" hidden></p>
    <div class="manager-assistant__actions" hidden></div>
    <div class="manager-assistant__links" hidden></div>
    <div class="manager-assistant__footer" hidden>
      <button class="manager-assistant__leave" type="button" data-assistant-action="leave-current">Leave current</button>
    </div>
  `;

  root.append(characterButton, bubble);
  host.appendChild(root);

  const title = bubble.querySelector('.manager-assistant__title');
  const intro = bubble.querySelector('.manager-assistant__intro');
  const helper = bubble.querySelector('.manager-assistant__helper');
  const availability = bubble.querySelector('.manager-assistant__availability');
  const empty = bubble.querySelector('.manager-assistant__empty');
  const actions = bubble.querySelector('.manager-assistant__actions');
  const links = bubble.querySelector('.manager-assistant__links');
  const footer = bubble.querySelector('.manager-assistant__footer');
  const closeButton = bubble.querySelector('.manager-assistant__close');
  const timers = new Set();
  const posePreloads = new Map();
  let activeContext = null;
  let visible = false;
  let modalMode = false;
  let modalTransitionTimer = 0;
  let pendingModalTip = null;
  let modalObserver = null;
  let bubbleResizeObserver = null;
  let bubblePositionFrame = 0;
  let keyboardBaselineHeight = Math.max(window.innerHeight || 0, window.visualViewport?.height || 0);
  let celebrateOnModalExit = false;
  let welcomeRequested = false;
  let welcomeShown = false;
  let welcomePending = false;
  let activeActionHandler = null;
  let activeDismissHandler = null;

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

  function clearModalBubblePosition() {
    if (bubblePositionFrame) {
      window.cancelAnimationFrame(bubblePositionFrame);
      bubblePositionFrame = 0;
    }
    root.classList.remove('has-dynamic-bubble', 'is-keyboard-visible');
    bubble.style.removeProperty('left');
    bubble.style.removeProperty('top');
    bubble.style.removeProperty('--ma-tail-top');
  }

  function getVisualViewportBounds() {
    const viewport = window.visualViewport;
    return {
      left: viewport?.offsetLeft || 0,
      top: viewport?.offsetTop || 0,
      width: viewport?.width || window.innerWidth || document.documentElement.clientWidth,
      height: viewport?.height || window.innerHeight || document.documentElement.clientHeight
    };
  }

  function updateModalBubblePosition() {
    bubblePositionFrame = 0;
    if (!modalMode || !root.classList.contains('is-bubble-visible')) {
      clearModalBubblePosition();
      return;
    }

    const bounds = getVisualViewportBounds();
    const viewportBottom = bounds.top + bounds.height;
    const activeIsTextEntry = isTextEntryElement(document.activeElement);
    if (!activeIsTextEntry) {
      keyboardBaselineHeight = Math.max(keyboardBaselineHeight, bounds.height, window.innerHeight || 0);
    }
    const keyboardVisible = activeIsTextEntry && (
      keyboardBaselineHeight - bounds.height >= KEYBOARD_MIN_HEIGHT_CHANGE ||
      (window.innerHeight || 0) - bounds.height >= KEYBOARD_MIN_HEIGHT_CHANGE
    );

    root.classList.add('has-dynamic-bubble');
    root.classList.toggle('is-keyboard-visible', keyboardVisible);

    const rootRect = root.getBoundingClientRect();
    const characterRect = characterImage.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const preferredLeft = characterRect.left + characterRect.width * 0.82;
    const maximumLeft = bounds.left + bounds.width - bubbleRect.width - MODAL_BUBBLE_EDGE_GAP;
    const left = clamp(preferredLeft, bounds.left + 68, Math.max(bounds.left + 68, maximumLeft));
    const preferredBottom = keyboardVisible
      ? viewportBottom - MODAL_BUBBLE_EDGE_GAP
      : Math.min(viewportBottom - MODAL_BUBBLE_EDGE_GAP, characterRect.bottom + 8);
    const top = Math.max(bounds.top + MODAL_BUBBLE_EDGE_GAP, preferredBottom - bubbleRect.height);
    const headY = characterRect.top + characterRect.height * 0.27;
    const tailTop = clamp(headY - top - 10, 12, Math.max(12, bubbleRect.height - 30));

    bubble.style.left = `${Math.round(left - rootRect.left)}px`;
    bubble.style.top = `${Math.round(top - rootRect.top)}px`;
    bubble.style.setProperty('--ma-tail-top', `${Math.round(tailTop)}px`);
  }

  function scheduleModalBubblePosition() {
    if (bubblePositionFrame) window.cancelAnimationFrame(bubblePositionFrame);
    bubblePositionFrame = window.requestAnimationFrame(updateModalBubblePosition);
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
    if (modalMode) scheduleModalBubblePosition();
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
    clearModalBubblePosition();
  }

  function makeActionButton(action, { link = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.assistantAction = String(action?.id || '');
    button.textContent = String(action?.label || '');
    button.className = link
      ? 'manager-assistant__link'
      : `manager-assistant__choice${action?.emphasis === 'secondary' ? ' manager-assistant__choice--secondary' : ''}`;
    if (action?.disabled === true) button.disabled = true;
    return button;
  }

  function appendActionRow(actionItems, modifier = '') {
    if (!actionItems.length) return;
    const row = document.createElement('div');
    row.className = `manager-assistant__action-row${modifier ? ` ${modifier}` : ''}`;
    actionItems.forEach(action => row.appendChild(makeActionButton(action)));
    actions.appendChild(row);
  }

  function renderMessage(payload = {}) {
    title.textContent = payload.title || 'A little schedule check';
    intro.textContent = payload.intro || '';
    intro.hidden = !intro.textContent;
    helper.textContent = payload.helper || '';
    helper.hidden = !helper.textContent;
    availability.replaceChildren();
    actions.replaceChildren();
    links.replaceChildren();

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

    const actionItems = Array.isArray(payload.actions) ? payload.actions : [];
    const actionLayout = payload.actionLayout || (actionItems.length <= 3 ? 'single-row' : 'compact-rows');
    actions.dataset.layout = actionLayout;
    if (actionLayout === 'mani-types') {
      appendActionRow(actionItems.slice(0, 3), 'manager-assistant__action-row--primary');
      appendActionRow(actionItems.slice(3), 'manager-assistant__action-row--secondary');
    } else if (actionLayout === 'single-row') {
      appendActionRow(actionItems);
    } else {
      for (let index = 0; index < actionItems.length; index += 3) {
        appendActionRow(actionItems.slice(index, index + 3));
      }
    }
    actions.hidden = !actionItems.length;

    const linkItems = Array.isArray(payload.links) ? payload.links : [];
    linkItems.forEach(action => links.appendChild(makeActionButton(action, { link: true })));
    links.hidden = !linkItems.length;

    footer.hidden = payload.leaveCurrent !== true;
  }

  function showBubble(payload, { context, autoHideMs = 0, onAction = null, onDismiss = null } = {}) {
    activeContext = context || null;
    activeActionHandler = typeof onAction === 'function' ? onAction : null;
    activeDismissHandler = typeof onDismiss === 'function' ? onDismiss : null;
    renderMessage(payload);
    setBubbleContext(activeContext);
    root.classList.add('is-bubble-visible');
    bubble.setAttribute('aria-hidden', 'false');
    scheduleModalBubblePosition();

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
      context: tip.context || 'availability',
      autoHideMs: tip.autoHideMs,
      onAction: tip.onAction,
      onDismiss: tip.onDismiss
    });
  }

  function playEntrance({ showGreeting = false, autoHideMs = 5000, celebrateOnArrival = false } = {}) {
    clearTimers();
    clearModalTransitionTimer();
    ensureVisible();
    hideBubble();
    activeContext = null;
    pendingModalTip = null;
    activeActionHandler = null;
    activeDismissHandler = null;
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

      if (!showGreeting) {
        if (celebrateOnArrival) {
          later(() => setState('laughing'), MOTION.frameMs);
          later(() => setState('meditating'), MOTION.frameMs + MOTION.laughDurationMs);
        }
        return;
      }
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
    const celebrateOnArrival = celebrateOnModalExit;
    celebrateOnModalExit = false;
    welcomePending = false;
    clearModalBubblePosition();
    playEntrance({ showGreeting: showDeferredGreeting, celebrateOnArrival });
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

  function celebrateAfterModalClose() {
    if (modalMode) {
      celebrateOnModalExit = true;
      return;
    }
    playLaugh();
  }

  function dismissTip({ celebrate } = {}) {
    const shouldCelebrate = typeof celebrate === 'boolean'
      ? celebrate
      : Boolean(activeContext);

    clearTimers();
    hideBubble();
    activeContext = null;
    ensureVisible();
    pendingModalTip = null;
    activeActionHandler = null;
    activeDismissHandler = null;

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
      pendingModalTip = { payload, autoHideMs, context: 'availability' };
      if (!modalTransitionTimer) showPendingModalTip();
      return;
    }

    setState('speaking');
    showBubble(payload, {
      context: 'availability',
      autoHideMs
    });
  }

  function showPrompt(payload = {}, { autoHideMs = 0, onAction = null, onDismiss = null, context = 'prompt' } = {}) {
    clearTimers();
    ensureVisible();
    preloadPoses(['wave', 'peekWave']);

    if (modalMode) {
      pendingModalTip = { payload, autoHideMs, onAction, onDismiss, context };
      if (!modalTransitionTimer) showPendingModalTip();
      return;
    }

    setState('speaking');
    showBubble(payload, { context, autoHideMs, onAction, onDismiss });
  }

  function hide({ immediate = false } = {}) {
    clearTimers();
    clearModalTransitionTimer();
    hideBubble();
    activeContext = null;
    pendingModalTip = null;
    activeActionHandler = null;
    activeDismissHandler = null;

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
    clearModalBubblePosition();
    modalObserver?.disconnect();
    modalObserver = null;
    bubbleResizeObserver?.disconnect();
    bubbleResizeObserver = null;
    window.visualViewport?.removeEventListener('resize', scheduleModalBubblePosition);
    window.visualViewport?.removeEventListener('scroll', scheduleModalBubblePosition);
    window.removeEventListener('resize', scheduleModalBubblePosition);
    document.removeEventListener('focusin', scheduleModalBubblePosition);
    document.removeEventListener('focusout', scheduleModalBubblePosition);
    root.remove();
    visible = false;
  }

  modalObserver = new MutationObserver(syncModalMode);
  modalObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });
  bubbleResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(scheduleModalBubblePosition)
    : null;
  bubbleResizeObserver?.observe(bubble);
  window.visualViewport?.addEventListener('resize', scheduleModalBubblePosition);
  window.visualViewport?.addEventListener('scroll', scheduleModalBubblePosition);
  window.addEventListener('resize', scheduleModalBubblePosition);
  document.addEventListener('focusin', scheduleModalBubblePosition);
  document.addEventListener('focusout', scheduleModalBubblePosition);
  syncModalMode();

  characterButton.addEventListener('click', () => {
    if (root.classList.contains('is-bubble-visible')) {
      activeDismissHandler?.();
      dismissTip();
      return;
    }
    playLaugh();
  });

  bubble.addEventListener('click', event => {
    const actionButton = event.target.closest('[data-assistant-action]');
    if (!actionButton || actionButton.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    activeActionHandler?.(actionButton.dataset.assistantAction, actionButton);
  });

  closeButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    activeDismissHandler?.();
    dismissTip();
  });

  return {
    showAvailability,
    showPrompt,
    playWelcome,
    dismissTip,
    peek,
    smile,
    playLaugh,
    playMeditate,
    celebrateAfterModalClose,
    hide,
    destroy,
    isVisible: () => visible,
    isWelcomeActive: () => welcomePending || (welcomeRequested && !welcomeShown) || activeContext === 'welcome'
  };
}
