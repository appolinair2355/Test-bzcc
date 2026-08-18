// predictor.js — moteur de prédiction + compteur B + vérification avec rattrapages
//
// Règles corrigées :
//  • Le costume est lu sur TOUTE la main choisie (joueur par défaut) : si l'un
//    des costumes de cette main correspond au costume prédit → trouvé.
//  • Compteur B : +1 quand le costume apparaît dans la main choisie, remis à 0
//    quand il manque. Il ne dépasse JAMAIS le B configuré : quand il atteint B,
//    il repart à 0, et la prochaine apparition le remet à 1.
//  • Vérification : on contrôle d'abord le numéro prédit, puis les rattrapages
//    (MAX_R configurable). Au-delà → ❌.
const config = require('./config');
const fmt = require('./formats');
const BADGES = ['0⃣','1⃣','2⃣','3⃣','4⃣','5⃣','6⃣','7⃣','8⃣','9⃣'];

const SUITS = ['♦️', '❤️', '♣️', '♠️'];

const state = {
  B: config.DEFAULT_B,
  maxR: config.DEFAULT_MAX_R,
  hand: 'joueur', // le projet ne suit QUE la main du joueur
  format: config.DEFAULT_FORMAT,
  template: null,   // template personnalisé optionnel (/settemplate)
  channels: [],
  activeChannels: [],
  history: [],
  games: new Map(),
  counters: { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 }, // compteur B par costume
  predictions: [],
  live: null,
  lastFinished: null,
  lastError: null,
  startedAt: Date.now(),
};

function suitForNumber(n) {
  return config.SUIT_BY_LAST_DIGIT[n % 10] || null;
}

// costumes de la main réellement vérifiée
// Le projet ne vérifie QUE la main du joueur (la main du banquier n'est
// utilisée que pour l'enregistrement en base de données).
function handSuits(game) {
  if (!game) return [];
  return game.playerSuits || [];
}

function hasSuit(game, suit) {
  return handSuits(game).includes(suit);
}

function nextTarget(current) {
  for (let n = current + config.LEAD; n < current + 40; n++) {
    if (suitForNumber(n)) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Enregistrement des jeux + détection du jeu LIVE
// ---------------------------------------------------------------------------
let onFinishedHook = null;
function setOnFinished(fn) { onFinishedHook = fn; }

function registerGames(games) {
  for (const g of games) {
    const prev = state.games.get(g.number);
    state.games.set(g.number, g);
    if (g.finished && (!prev || !prev.finished)) onFinished(g);
  }
  if (state.games.size > 400) {
    const keys = [...state.games.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, state.games.size - 400)) state.games.delete(k);
  }
  state.live = detectLive();
  return state.live;
}

function detectLive() {
  const all = [...state.games.values()].sort((a, b) => a.number - b.number);
  const dealing = all.filter((g) => !g.finished && g.dealing);
  if (dealing.length) return dealing[0];
  const pending = all.filter((g) => !g.finished);
  if (pending.length) return pending[0];
  return state.lastFinished;
}

// compteur B : 0 si absent, +1 si présent, jamais au-dessus de B (repart à 0 sur B)
function bumpCounters(round) {
  for (const s of SUITS) {
    if (hasSuit(round, s)) {
      if (state.counters[s] >= state.B) state.counters[s] = 1; // B atteint → repart
      else state.counters[s] += 1;
      if (state.counters[s] > state.B) state.counters[s] = state.B;
    } else {
      state.counters[s] = 0;
    }
  }
}

function onFinished(round) {
  state.lastFinished = round;
  state.history.unshift(round);
  state.history = state.history.slice(0, 200);
  bumpCounters(round);
  if (onFinishedHook) { try { onFinishedHook(round); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Prédiction — le B s'impose à TOUTES les prédictions
// ---------------------------------------------------------------------------
function evaluate() {
  const cur = state.live;
  if (!cur) return null;
  const target = cur.number + config.LEAD;
  const suit = suitForNumber(target);
  if (!suit) return null;
  if (state.predictions.some((p) => p.target === target)) return null;
  // blocage tant que le costume est en pleine série (compteur = B)
  if (state.counters[suit] >= state.B) return null;

  const pred = {
    target,
    suit,
    hand: state.hand,
    from: cur.number,
    step: 0,                  // 0 = numéro prédit, puis 1..maxR = rattrapages
    maxR: state.maxR,
    counter: state.counters[suit],
    b: state.B,
    format: state.format,
    sentAt: Date.now(),
    status: 'en attente',
    badge: null,
    result: null,
    hitNumber: null,
    messages: [],
  };
  state.predictions.unshift(pred);
  state.predictions = state.predictions.slice(0, 200);
  return pred;
}

// ---------------------------------------------------------------------------
// Vérification fidèle : numéro prédit d'abord, puis les rattrapages
// ---------------------------------------------------------------------------
function verify() {
  const closed = [];
  for (const p of state.predictions) {
    if (p.status !== 'en attente') continue;
    let guard = 0;
    while (p.status === 'en attente' && guard++ <= p.maxR + 1) {
      const num = p.target + p.step;
      const g = state.games.get(num);
      if (!g || !g.finished) break;            // le jeu n'a pas fini : on attend
      if (hasSuit(g, p.suit)) {        // costume trouvé dans la main choisie
        p.status = 'gagné';
        p.badge = BADGES[p.step] || `${p.step}`;
        p.result = handSuits(g).join(' ');
        p.hitNumber = num;
        p.game = g;
        closed.push(p);
        break;
      }
      if (p.step >= p.maxR) {                  // rattrapages épuisés → perdu
        p.status = 'perdu';
        p.badge = '❌';
        p.result = handSuits(g).join(' ');
        p.hitNumber = num;
        p.game = g;
        closed.push(p);
        break;
      }
      p.step += 1;                             // rattrapage suivant
    }
  }
  return closed;
}

function predictionText(p) {
  const g = p.game || null;
  return fmt.renderMessage(p.format || state.format, {
    gameNumber: p.target,
    suit: p.suit,
    strategy: 'costume joueur',
    maxR: p.maxR != null ? p.maxR : state.maxR,
    status: p.status,
    rattrapage: p.step,
    playerCards: g ? g.player : null,
  }, p.template || state.template || null);
}

// texte seul (Telegram + panel web)
function predictionMessage(p) {
  return predictionText(p).text;
}

function liveText() {
  const g = state.live;
  if (!g) return '⚠️ Aucun jeu live détecté pour le moment.';
  const hand = 'joueur';
  return (
    `🔴 *JEU LIVE*\n\n` +
    `🔢 Tour : *#N${g.number}*\n` +
    `✋ Main vérifiée : *${hand}*\n` +
    `🃏 Costumes joueur : *${(g.playerSuits || []).join(' ') || '—'}*\n` +
    `🂠 Cartes : joueur ${(g.player || []).join(' ') || '—'} / banquier ${(g.banker || []).join(' ') || '—'}\n` +
    `🔟 Valeurs : joueur ${g.playerValue ?? '—'} (${g.playerParity || '—'}) / banquier ${g.bankerValue ?? '—'} (${g.bankerParity || '—'})\n` +
    `⏳ Phase : ${g.phase || '—'}\n` +
    `📌 État : ${g.finished ? 'terminé' : g.dealing ? 'distribution en cours' : 'en attente des cartes'}\n` +
    `🔢 Compteurs B (${state.B}) : ${SUITS.map((s) => `${s}${state.counters[s]}`).join(' ')}\n` +
    `♻️ Rattrapages : ${state.maxR} | 🎨 Format : ${state.format}\n` +
    `✔️ Dernier tour terminé : ${state.lastFinished ? '#N' + state.lastFinished.number : '—'}`
  );
}

function recentGames(limit = 30) {
  return [...state.games.values()].sort((a, b) => b.number - a.number).slice(0, limit);
}

function stats() {
  const done = state.predictions.filter((p) => p.status !== 'en attente');
  const win = done.filter((p) => p.status === 'gagné').length;
  return {
    total: state.predictions.length,
    win,
    loss: done.length - win,
    rate: done.length ? Math.round((win / done.length) * 100) : 0,
  };
}

module.exports = {
  state,
  SUITS,
  evaluate,
  verify,
  registerGames,
  setOnFinished,
  suitForNumber,
  nextTarget,
  handSuits,
  hasSuit,
  predictionText,
  predictionMessage,
  liveText,
  recentGames,
  stats,
  BADGES,
};
