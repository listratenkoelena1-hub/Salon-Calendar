const COMPOUND_SERVICE_PATTERN = /(?<![\p{L}\p{N}])(?:(?:p\s*[+\/&]\s*m|m\s*[+\/&]\s*p|pm|mp)|(?:pedi(?:cure)?|педи|педикюр)\s*(?:[+\/&]|and|и)?\s*(?:mani(?:cure)?|мани|маникюр)|(?:mani(?:cure)?|мани|маникюр)\s*(?:[+\/&]|and|и)?\s*(?:pedi(?:cure)?|педи|педикюр))(?![\p{L}\p{N}])/iu;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^\p{L}\p{N}+\/&:;\-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeIgnoredServiceWords(value) {
  return String(value || '')
    .replace(/(?<![\p{L}\p{N}])(?:paraffin|парафин)(?![\p{L}\p{N}])/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phrase(text, pattern) {
  return pattern.test(text);
}

function tokensFrom(text) {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function hasStandaloneToken(tokens, ...values) {
  const choices = new Set(values.map(value => String(value).toLowerCase()));
  return tokens.some(token => choices.has(token));
}

function detectGroup(text) {
  if (!text) return false;
  return (
    /\b(?:group|party|couple|family)\b/i.test(text) ||
    /\b(?:two|three|four|five|six|2|3|4|5|6)\s+(?:people|persons|clients|manicures?|pedicures?|manis?|pedis?)\b/i.test(text) ||
    /\b(?:x\s*[2-9]|[2-9]\s*x)\b/i.test(text) ||
    /\bwith\s+(?:husband|wife|mom|mother|daughter|son|friend)\b/i.test(text) ||
    /(?<![\p{L}\p{N}])(?:муж|мужем|жена|женой|мама|мамой|мать|матерью|дочь|дочерью|сын|сыном|подруга|подругой|группа)(?![\p{L}\p{N}])/iu.test(text)
  );
}

function getScopedText(normalized, label) {
  const match = normalized.match(new RegExp(`(?:^|;\\s*)${label}(?:\\s*:\\s*([^;]*))?(?=\\s*;|$)`, 'i'));
  return match ? String(match[1] || '').trim() : normalized;
}

function detectDesign(text) {
  if (/\b(?:no\s+design|without\s+design|без\s+дизайна)\b/iu.test(text)) return 'no';
  if (/\b(?:design|nail\s+art|дизайн)\b/iu.test(text)) return 'yes';
  return null;
}

function detectSpecialToeService(text) {
  const toe = '(?:toe|toes)';
  const advanced = '(?:f|r|fill|refill|ext|extension|extensions|new\\s+set|full\\s+set|acrylic|акрил|hard\\s+gel|strong\\s+gel|builder(?:\\s+gel)?)';
  return new RegExp(`(?:(?<![\\p{L}\\p{N}])${toe}(?![\\p{L}\\p{N}])[^;]*(?<![\\p{L}\\p{N}])${advanced}(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])${advanced}(?![\\p{L}\\p{N}])[^;]*(?<![\\p{L}\\p{N}])${toe}(?![\\p{L}\\p{N}]))`, 'iu').test(text);
}

function detectPedicure(normalized, tokens, compound) {
  const canonical = compound && /(?:^|;\s*)pedi(?:\s*:|\s*;)/i.test(normalized);
  const present = compound || canonical || /\bno\s+washing\b/i.test(normalized) || hasStandaloneToken(tokens, 'p', 'pedi', 'pedicure', 'педи', 'педикюр', 'toes', 'toe', 'paraffin', 'парафин', 'deluxe');
  if (!present) return { present: false };

  const scoped = canonical ? getScopedText(normalized, 'pedi') : normalized;
  const specialToeService = detectSpecialToeService(scoped);
  const paraffin = /\b(?:paraffin|парафин)\b/iu.test(scoped);
  const deluxe = /\bdeluxe\b/i.test(scoped);
  const colorChange = /\b(?:toes?|toe\s+color\s+change|pedi(?:cure)?\s+color\s+change|color\s+change\s+(?:on\s+)?toes?)\b/i.test(scoped);
  const noColor = /\b(?:no\s+color|no\s+polish|without\s+(?:color|polish)|cleaning\s+only|no\s+washing|pedicure\s+cleaning|pedi\s+cleaning)\b/i.test(scoped);
  const regular = /\b(?:regular\s+(?:polish|color)|classic\s+polish)\b/i.test(scoped);
  const gel = /\b(?:gel(?:\s+(?:polish|color|lacquer|lac))?|shellac)\b/i.test(scoped);
  const genericColor = /\bcolor\b/i.test(scoped) && !colorChange && !noColor && !regular && !gel;

  let type = null;
  if (specialToeService) type = 'specialToeService';
  else if (colorChange) type = 'changeColor';
  else if (deluxe) type = 'gelPolish';
  else if (noColor) type = 'noColor';
  else if (regular) type = 'regularPolish';
  else if (gel) type = 'gelPolish';

  return {
    present: true,
    type,
    paraffin,
    deluxe,
    specialToeService,
    genericColor,
    needsColorKind: genericColor && !specialToeService,
    needsType: !type && !genericColor && !specialToeService
  };
}

function detectManicure(normalized, tokens, compound) {
  const canonical = compound && /(?:^|;\s*)mani(?:\s*:|\s*;|$)/i.test(normalized);
  const explicitHandService = hasStandaloneToken(tokens, 'm', 'mani', 'manicure', 'мани', 'маникюр', 'nail', 'nails');
  const specialToeService = detectSpecialToeService(normalized) && !explicitHandService && !compound;
  const refillToken = !specialToeService && hasStandaloneToken(tokens, 'f', 'r', 'fill', 'refill', 'коррекция');
  const extensionToken = !specialToeService && (hasStandaloneToken(tokens, 'ext', 'extension', 'extensions', 'наращивание', 'наращ') || /\b(?:new\s+set|full\s+set)\b/i.test(normalized));
  const acrylicToken = !specialToeService && hasStandaloneToken(tokens, 'acrylic', 'акрил');
  const hardGelToken = !specialToeService && /\b(?:hard\s+gel|builder\s+gel|builder|strong\s+gel)\b/i.test(normalized);
  const hasPedicureContext = compound || hasStandaloneToken(tokens, 'p', 'pedi', 'pedicure', 'педи', 'педикюр', 'toe', 'toes', 'deluxe', 'paraffin', 'парафин');
  const genericHandService = !hasPedicureContext && /\b(?:change\s+color|color\s+change|gel\s+(?:polish|color|lacquer|lac)|shellac|regular\s+(?:polish|color))\b/i.test(normalized);
  const genericCleaningService = !hasPedicureContext && /^(?:no\s+color|no\s+polish|cleaning(?:\s+only)?)$/i.test(normalized);
  const present = compound || canonical || refillToken || extensionToken || acrylicToken || hardGelToken || genericHandService || genericCleaningService || explicitHandService;
  if (!present) return { present: false };

  const scoped = canonical ? getScopedText(normalized, 'mani') : normalized;
  const scopedTokens = tokensFrom(scoped);
  const refill = hasStandaloneToken(scopedTokens, 'f', 'r', 'fill', 'refill', 'коррекция');
  const extensions = hasStandaloneToken(scopedTokens, 'ext', 'extension', 'extensions', 'наращивание', 'наращ') || /\b(?:new\s+set|full\s+set)\b/i.test(scoped);
  const acrylic = hasStandaloneToken(scopedTokens, 'acrylic', 'акрил');
  const hardGel = /\b(?:hard\s+gel|builder\s+gel|builder|strong\s+gel)\b/i.test(scoped);
  const noColor = /\b(?:no\s+color|no\s+polish|without\s+(?:color|polish)|cleaning\s+only|manicure\s+cleaning|mani\s+cleaning)\b/i.test(scoped) || /^(?:cleaning)$/i.test(scoped);
  const regularPolish = /\b(?:regular\s+(?:polish|color)|classic\s+polish)\b/i.test(scoped);
  const colorChange = /\b(?:change\s+color|color\s+change)\b/i.test(scoped);
  const gel = /\b(?:gel(?:\s+(?:polish|color|lacquer|lac))?|shellac)\b/i.test(scoped) && !hardGel;
  const genericColorChange = colorChange && !gel && !regularPolish;
  const design = detectDesign(scoped);

  let type = null;
  if (refill) type = 'refill';
  else if (extensions) type = 'extensions';
  else if (acrylic) type = 'acrylic';
  else if (hardGel) type = 'hardGel';
  else if (noColor) type = 'noColor';
  else if (regularPolish) type = colorChange ? 'changeColorRegular' : 'regularPolish';
  else if (gel) type = colorChange ? 'changeColorGel' : 'gelPolish';

  const setType = refill ? 'refill' : extensions ? 'extensions' : null;
  const needsSetType = (type === 'hardGel' || type === 'acrylic') && !setType;
  const designEligible = ['refill', 'extensions', 'hardGel', 'acrylic', 'gelPolish', 'changeColorGel'].includes(type);

  return {
    present: true,
    type,
    setType,
    material: acrylic ? 'acrylic' : hardGel ? 'hardGel' : null,
    design,
    designEligible,
    genericColorChange,
    needsColorKind: genericColorChange,
    needsType: !type && !genericColorChange,
    needsSetType,
    needsDesign: designEligible && !design && !needsSetType
  };
}

function getDurationParts(pedicure, manicure) {
  const parts = [];
  const groups = new Set();
  let manual = false;

  if (pedicure?.present) {
    groups.add('pedicure');
    if (pedicure.type === 'gelPolish') parts.push('pedicureGelPolish');
    else if (pedicure.type === 'noColor' || pedicure.type === 'regularPolish') parts.push('pedicureNoColor');
    else if (pedicure.type === 'changeColor') parts.push('pedicureChangeColor');
    else manual = true;
  }

  if (manicure?.present) {
    if (['refill', 'extensions', 'hardGel', 'acrylic'].includes(manicure.type)) groups.add('acrylics');
    else groups.add('manicure');

    const setType = manicure.setType || (manicure.type === 'refill' ? 'refill' : manicure.type === 'extensions' ? 'extensions' : null);
    if (setType === 'refill') parts.push('refillNoDesign');
    else if (setType === 'extensions') parts.push('extensionsNoDesign');
    else if (manicure.type === 'gelPolish') parts.push('manicureGelPolish');
    else if (manicure.type === 'noColor' || manicure.type === 'regularPolish') parts.push('manicureNoColor');
    else if (manicure.type === 'changeColorGel' || manicure.type === 'changeColorRegular') parts.push('changeColor');
    else manual = true;
  }

  return {
    durationKeys: parts,
    requiredGroups: [...groups],
    durationResolvable: parts.length > 0 && !manual,
    designSlots: manicure?.design === 'yes' ? 1 : 0
  };
}

export function analyzeManagerService(value) {
  const normalized = removeIgnoredServiceWords(normalizeText(value));
  const tokens = tokensFrom(normalized);
  const hasCanonicalCompound = /(?:^|;\s*)pedi(?:\s*:|\s*;)/i.test(normalized) && /(?:^|;\s*)mani(?:\s*:|\s*;|$)/i.test(normalized);
  const compound = COMPOUND_SERVICE_PATTERN.test(normalized) || hasCanonicalCompound;
  const groupDetected = detectGroup(normalized);
  const pedicure = detectPedicure(normalized, tokens, compound);
  const manicure = detectManicure(normalized, tokens, compound);
  const duration = getDurationParts(pedicure, manicure);

  const signature = JSON.stringify({
    compound,
    groupDetected,
    pedi: pedicure.present ? [pedicure.type, pedicure.needsType, pedicure.needsColorKind, pedicure.paraffin] : null,
    mani: manicure.present ? [manicure.type, manicure.setType, manicure.needsType, manicure.needsColorKind, manicure.needsSetType, manicure.design] : null
  });

  return {
    raw: String(value || ''),
    normalized,
    compound,
    groupDetected,
    pedicure,
    manicure,
    ...duration,
    hasRecognizedService: pedicure.present || manicure.present,
    signature
  };
}

function ensureCompoundLabels(value) {
  const text = String(value || '');
  if (/\bPedi\s*:/i.test(text) && /\bMani\s*:/i.test(text)) return text;
  if (!COMPOUND_SERVICE_PATTERN.test(normalizeText(text))) return text;
  return text.replace(COMPOUND_SERVICE_PATTERN, 'Pedi; Mani;');
}

function addUniqueDetail(existing, detail) {
  const normalizedExisting = normalizeText(existing);
  const normalizedDetail = normalizeText(detail);
  if (!normalizedDetail || normalizedExisting.includes(normalizedDetail)) return existing.trim();
  return existing.trim() ? `${existing.trim()}, ${detail}` : detail;
}

function setScopedDetail(value, scope, detail) {
  let text = String(value || '').trim();
  const label = scope === 'pedicure' ? 'Pedi' : 'Mani';
  const otherLabel = scope === 'pedicure' ? 'Mani' : 'Pedi';
  const sectionPattern = new RegExp(`\\b${label}\\s*(?::\\s*([^;]*))?(?=\\s*;|$)`, 'i');
  const match = text.match(sectionPattern);

  if (match) {
    const current = match[1] || '';
    const next = `${label}: ${addUniqueDetail(current, detail)}`;
    return text.replace(sectionPattern, next);
  }

  const otherPattern = new RegExp(`\\b${otherLabel}\\s*(?::\\s*[^;]*)?`, 'i');
  if (otherPattern.test(text)) return `${text}; ${label}: ${detail}`;
  return addUniqueDetail(text, detail);
}

function replaceGenericPedicureColor(value, detail) {
  return String(value || '').replace(/\b((?:pedi(?:cure)?|педикюр)\s+)color\b/iu, `$1${detail}`);
}

export function applyManagerServiceChoice(value, choice, analysis = analyzeManagerService(value)) {
  let text = String(value || '').trim();
  const details = {
    'pedi-gel': ['pedicure', 'gel polish'],
    'pedi-regular': ['pedicure', 'regular polish'],
    'pedi-no-color': ['pedicure', 'no color'],
    'mani-gel': ['manicure', 'gel polish'],
    'mani-no-color': ['manicure', 'no color'],
    'mani-hard-gel': ['manicure', 'hard gel'],
    'mani-acrylic': ['manicure', 'acrylic'],
    'mani-regular': ['manicure', 'regular polish'],
    'mani-color-gel': ['manicure', 'gel polish'],
    'mani-color-regular': ['manicure', 'regular polish'],
    'mani-new-set': ['manicure', 'new set'],
    'mani-refill': ['manicure', 'refill'],
    'design-yes': ['manicure', 'design'],
    'design-no': ['manicure', 'no design']
  };

  const selected = details[choice];
  if (!selected) return text;
  const [scope, detail] = selected;

  if (analysis.compound) {
    text = ensureCompoundLabels(text);
    return setScopedDetail(text, scope, detail);
  }

  if (scope === 'pedicure' && analysis.pedicure?.genericColor) {
    const replaced = replaceGenericPedicureColor(text, detail);
    if (replaced !== text) return replaced;
  }

  return addUniqueDetail(text, detail);
}

export function getManagerServiceQuestion(analysis) {
  if (analysis?.groupDetected) {
    return {
      key: 'group',
      title: 'Is this group already assigned to technicians?',
      actionLayout: 'single-row',
      actions: [
        { id: 'group-yes', label: 'Yes' },
        { id: 'group-no', label: 'No' }
      ]
    };
  }

  if (!analysis?.hasRecognizedService) return null;

  if (analysis.pedicure?.needsColorKind) {
    return {
      key: 'pedi-color',
      title: 'Gel polish or regular polish?',
      helper: 'Tap an option to add it to Service.',
      actionLayout: 'single-row',
      actions: [
        { id: 'pedi-gel', label: 'Gel polish' },
        { id: 'pedi-regular', label: 'Regular polish' }
      ]
    };
  }

  if (analysis.pedicure?.needsType) {
    return {
      key: 'pedi-type',
      title: 'What kind of pedicure?',
      helper: 'Tap an option to add it to Service.',
      actionLayout: 'single-row',
      actions: [
        { id: 'pedi-gel', label: 'Gel polish' },
        { id: 'pedi-regular', label: 'Regular polish' },
        { id: 'pedi-no-color', label: 'No color' }
      ]
    };
  }

  if (analysis.manicure?.needsColorKind) {
    return {
      key: 'mani-color',
      title: 'Gel polish or regular polish?',
      helper: 'Tap an option to add it to Service.',
      actionLayout: 'single-row',
      actions: [
        { id: 'mani-color-gel', label: 'Gel polish' },
        { id: 'mani-color-regular', label: 'Regular polish' }
      ]
    };
  }

  if (analysis.manicure?.needsType) {
    return {
      key: 'mani-type',
      title: 'What kind of nail service?',
      helper: 'Tap an option to add it to Service.',
      actionLayout: 'mani-types',
      actions: [
        { id: 'mani-gel', label: 'Gel polish', emphasis: 'primary' },
        { id: 'mani-no-color', label: 'No color', emphasis: 'primary' },
        { id: 'mani-hard-gel', label: 'Hard gel', emphasis: 'primary' },
        { id: 'mani-acrylic', label: 'Acrylic', emphasis: 'secondary' },
        { id: 'mani-regular', label: 'Regular polish', emphasis: 'secondary' }
      ]
    };
  }

  if (analysis.manicure?.needsSetType) {
    const material = analysis.manicure.material === 'acrylic' ? 'Acrylic' : 'Hard gel';
    return {
      key: 'mani-set-type',
      title: `${material}: new set or refill?`,
      helper: 'Tap an option to add it to Service.',
      actionLayout: 'single-row',
      actions: [
        { id: 'mani-new-set', label: 'New set' },
        { id: 'mani-refill', label: 'Refill' }
      ]
    };
  }

  if (analysis.manicure?.needsDesign) {
    return {
      key: 'mani-design',
      title: 'Any nail design?',
      helper: 'Tap an option to add it to Service.',
      actionLayout: 'single-row',
      actions: [
        { id: 'design-yes', label: 'Yes' },
        { id: 'design-no', label: 'No' }
      ]
    };
  }

  return null;
}
