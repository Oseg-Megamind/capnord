// Aucun emoji dans l'interface : chaque emoji affiché est remplacé par un pictogramme
// au trait (ou retiré s'il n'a pas d'équivalent utile). Fonctionne sur tout ce qui s'affiche.
import { icon, ICONS } from './constants.js';

Object.assign(ICONS, {
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  bag: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/>',
  wallet: '<path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 6v12a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  fuel: '<path d="M3 22h12M4 9h10M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.8a2 2 0 0 0-.6-1.4L18 5"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2ZM13 5v2M13 17v2M13 11v2"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a13 13 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3 8 10 8a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  thumb: '<path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/>',
  save: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 13h4M10 17h4"/>',
  clip: '<path d="m21.4 11-8.8 8.8a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.7 8.6a2 2 0 0 1-2.8-2.8l8-8"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3M12 9v4M12 17h.01"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
  landmark: '<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l8 5H4z"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z" fill="currentColor"/>',
  heartOutline: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pen: '<path d="M12 20h9M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
  id: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h4M14 14h4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>',
  health: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  coffee: '<path d="M10 2v2M14 2v2M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1M6 2v2"/>',
  mountain: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
  shop: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  wifiOff: '<path d="M12 20h.01M8.5 16.4a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8a15 15 0 0 0-11.3-3.7M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2.3-1.7M2 2l20 20"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
});

const MAP = {
  '📍': 'pin', '📌': 'pin', '🧭': 'nav', '📤': 'share', '📲': 'share', '🧳': 'bag', '💶': 'wallet', '💼': 'wallet', '💱': 'wallet', '💰': 'wallet',
  '🌙': 'moon', '📸': 'camera', '📷': 'camera', '📝': 'note', '✍': 'pen', '🛏': 'bed', '✅': 'check', '✔': 'check', '🗂': 'folder', '📁': 'folder',
  '🗺': 'map', '📅': 'calendar', '🗓': 'calendar', '⏰': 'clock', '🕓': 'clock', '⏳': 'clock', '⏱': 'clock', '⛽': 'fuel', '🎫': 'ticket', '🎟': 'ticket',
  '💬': 'message', '👁': 'eye', '👀': 'eye', '🙈': 'eyeOff', '👍': 'thumb', '💾': 'save', '📄': 'file', '🧾': 'file', '📎': 'clip', '🗑': 'trash', '🧹': 'trash',
  '🖨': 'printer', '⚠': 'alert', '🏁': 'flag', '🚩': 'flag', '🏙': 'building', '🏛': 'landmark', '❤': 'heart', '🤍': 'heartOutline', '🛣': 'route',
  '🚗': 'car', '🚙': 'car', '🚕': 'car', '✈': 'plane', '🚆': 'train', '🚅': 'train', '🚌': 'bus', '🚏': 'bus', '🚐': 'van', '🏍': 'moto', '⛴': 'ferry', '🚢': 'ferry',
  '🚲': 'bike', '🥾': 'walk', '🚶': 'walk', '🛂': 'id', '🪪': 'id', '🩺': 'shield', '💉': 'health', '💊': 'health', '☎': 'phone', '📞': 'phone',
  '🍽': 'food', '☕': 'coffee', '⛰': 'mountain', '🏞': 'mountain', '🏖': 'sun', '☀': 'sun', '🌤': 'sunCloud', '⛅': 'sunCloud', '☁': 'cloud',
  '🛍': 'shop', '🏠': 'home', '📴': 'wifiOff', '📡': 'wifiOff', '🔗': 'link', '⚙': 'settings', '🛠': 'settings', '🌍': 'globe', '🌎': 'globe',
  '🔎': 'search', '🔍': 'search', '📏': 'route', '🧩': 'list', '📔': 'note', '📢': 'message', '💡': 'sun',
};
const RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|︎|⃣|‍(?:\p{Extended_Pictographic}|️)+|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const KEEP = new Set(['©', '®', '™', '↔', '↕', '↩', '↪', '▶', '◀', '⏏', '⌘', '✕', '✓', '★', '☆', '↑', '↓', '→', '←', '↺', '↻']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'TITLE', 'NOSCRIPT']);

function convertText(node) {
  const text = node.nodeValue;
  if (!text || !RE.test(text)) return;
  RE.lastIndex = 0;
  const parent = node.parentNode;
  if (!parent || SKIP.has(parent.nodeName) || parent.closest?.('svg, [contenteditable]')) return;
  // Dans une option de liste déroulante, on ne peut pas mettre d'image : on retire juste l'emoji
  if (parent.nodeName === 'OPTION' || parent.nodeName === 'SELECT') {
    node.nodeValue = text.replace(RE, (m) => (KEEP.has(m) ? m : '')).replace(/^\s+/, '');
    return;
  }
  const frag = document.createDocumentFragment();
  let last = 0, m, changed = false;
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) {
    const base = [...m[0]][0];
    if (KEEP.has(base)) continue;
    changed = true;
    frag.append(text.slice(last, m.index));
    const name = MAP[base];
    if (name) {
      const span = document.createElement('span');
      span.className = 'pic';
      span.innerHTML = icon(name);
      frag.append(span);
    }
    last = m.index + m[0].length;
    // espace en trop laissé par un emoji retiré
    if (!name && text[last] === ' ') last++;
  }
  if (!changed) return;
  frag.append(text.slice(last));
  parent.replaceChild(frag, node);
}

function convertTree(root) {
  if (root.nodeType === 3) return convertText(root);
  if (root.nodeType !== 1 || SKIP.has(root.nodeName) || root.closest?.('svg')) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(convertText);
}

export function startPicto() {
  convertTree(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') convertText(m.target);
      else m.addedNodes.forEach(convertTree);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
