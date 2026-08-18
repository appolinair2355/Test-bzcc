// strategy-absent.js — Stratégie "absent apparue"
//
// Règle de suivi (par costume, indépendante du compteur B principal) :
//  • À chaque tour terminé, si le costume est ABSENT de la main du joueur,
//    on incrémente un compteur d'absence (1 → 4). Le compteur ne dépasse
//    jamais 4 : une fois à 4, le costume est "suivi" (on attend juste
//    qu'il réapparaisse, sans continuer à compter).
//  • Dès que le costume suivi RÉAPPARAÎT au tour A, on prédit qu'il
//    reviendra au tour A + 4, vérifié avec 2 rattrapages (A, A+1, A+2... en
//    fait A+4, A+5, A+6 vu le décalage).
//  • Cette prédiction est INTERNE AU SITE : elle n'est jamais envoyée seule
//    sur le canal Telegram. Seul le tableau de bord web l'affiche.
//
// Relais vers le canal Telegram ("Nous allons juste faire simple") :
//  • On observe la suite des résultats (gagné/perdu) de CETTE stratégie,
//    dans l'ordre où ils se terminent.
//  • Dès qu'une perte survient, elle devient la RÉFÉRENCE.
//  • On cherche la perte SUIVANTE (la "2ème perte"). N = nombre de gains
//    survenus entre la référence et cette 2ème perte.
//  • On relaie alors sur Telegram la (N+1)ème prédiction créée APRÈS cette
//    2ème perte (les N précédentes restent internes au site) :
//      - perdu, perdu                              → N=0 → la 1ère suivante
//      - perdu, gagné, perdu                        → N=1 → la 2ème suivante
//      - perdu, gagné, gagné, perdu                 → N=2 → la 3ème suivante
//      - perdu, gagné, gagné, gagné, perdu          → N=3 → la 4ème suivante
//      - perdu, gagné, gagné, gagné, gagné, perdu   → N=4 → la 5ème suivante
//  • Cette 2ème perte devient aussitôt la nouvelle référence, et le cycle
//    recommence indéfiniment.
//  • Si l'écart N dépasse 5 (N ≥ 6, soit 6 gains ou plus entre les deux
//    pertes) : on n'arme PAS de relais pour cette paire. La perte qui suit
//    ces 6+ gains devient simplement la nouvelle référence, et on attend la
//    perte suivante pour recalculer N.
'use strict';

const TelegramBot = require('node-telegram-bot-api');
const predictor = require('./predictor');
const store = require('./store');

const SUITS = predictor.SUITS; // ['♦️', '❤️', '♣️', '♠️']
const STRATEGY_LABEL = 'absent apparue';

// Paramètres fixes de la stratégie (non modifiables) :
const ABSENCE_TARGET = 4; // seuil d'absences consécutives avant suivi
const RESUME_LEAD = 4;    // tour prédit = tour de réapparition + 4
const MAX_R = 2;          // rattrapages vérifiés après le tour prédit
const MAX_N_FOR_FORWARD = 5; // écart maximal (gains entre 2 pertes) accepté pour armer le relais ; au-delà, la perte devient la nouvelle référence

const state = {
  enabled: true,
  channelId: null,              // canal Telegram dédié au relais (id unique)
  botToken: null,                // token API Telegram dédié à cette stratégie
  botUsername: null,
  botError: null,
  absence: { '♦️': 0, '❤️': 0, '♣️': 0, '♠️': 0 },
  watching: { '♦️': false, '❤️': false, '♣️': false, '♠️': false },
  predictions: [],              // historique des prédictions du site (plus récentes en tête)
  seq: 0,
  meta: {
    reference: null,            // id de la dernière "perte" utilisée comme référence
    winsSinceReference: 0,
    forwardArmed: false,
    forwardRemaining: null,
    forwardInfo: null,          // { lossGame, position } de l'armement en cours
  },
  pendingBroadcast: [],         // prédictions créées ce tick, à relayer sur Telegram
  queueLog: [],                 // historique des envois : { lossGame, position, sentTarget, sentAt }
};

let bot = null; // instance Telegram dédiée à cette stratégie (son propre token)

// ---------------------------------------------------------------------------
// Persistance (réutilise data.json via store.js, clé "absent")
// ---------------------------------------------------------------------------
function loadPersisted() {
  const saved = store.read();
  const a = saved.absent;
  if (a && typeof a === 'object') {
    if (a.channelId !== undefined) state.channelId = a.channelId;
    if (a.enabled != null) state.enabled = a.enabled;
    if (a.botToken !== undefined) state.botToken = a.botToken;
  }
}
function persist() {
  store.patch({
    absent: {
      channelId: state.channelId,
      enabled: state.enabled,
      botToken: state.botToken,
    },
  });
}
loadPersisted();

// ---------------------------------------------------------------------------
// Bot Telegram dédié à cette stratégie (son propre token API)
// ---------------------------------------------------------------------------
async function startBot(token) {
  if (token) state.botToken = token.trim();
  persist();
  state.botError = null;
  bot = null;
  if (!state.botToken) {
    state.botError = 'Aucun token configuré';
    return { ok: false, error: state.botError };
  }
  try {
    bot = new TelegramBot(state.botToken, { polling: false });
    const me = await bot.getMe();
    state.botUsername = me.username;
    return { ok: true, username: me.username };
  } catch (e) {
    state.botError = e.message;
    bot = null;
    return { ok: false, error: e.message };
  }
}

function botStatus() {
  return {
    running: !!bot,
    username: state.botUsername || null,
    tokenSet: !!state.botToken,
    tokenMasked: state.botToken ? state.botToken.slice(0, 8) + '••••••' + state.botToken.slice(-4) : null,
    error: state.botError || null,
  };
}

// configure le canal relais et envoie un message de bienvenue avec le token dédié
async function setChannel(id) {
  state.channelId = id;
  persist();
  if (!bot || !id) return { ok: true, welcomeSent: false };
  try {
    await bot.sendMessage(
      id,
      '🟢 *Stratégie "absent apparue" activée sur ce canal*\nLes prédictions filtrées seront envoyées ici.',
      { parse_mode: 'Markdown' }
    );
    return { ok: true, welcomeSent: true };
  } catch (e) {
    console.error('Bienvenue (absent apparue) échouée', id, e.message);
    return { ok: true, welcomeSent: false, error: e.message };
  }
}

// envoi + mise à jour des messages, avec le bot dédié à cette stratégie
async function broadcast(pred) {
  if (!bot || !state.channelId) return;
  const { text, parse_mode } = predictionText(pred);
  try {
    const m = await bot.sendMessage(state.channelId, text, parse_mode ? { parse_mode } : {});
    pred.messages.push({ chatId: state.channelId, messageId: m.message_id });
  } catch (e) {
    console.error('Envoi (absent apparue) échoué', state.channelId, e.message);
  }
}

async function updateResult(pred) {
  if (!bot) return;
  const { text, parse_mode } = predictionText(pred);
  for (const m of pred.messages) {
    try {
      await bot.editMessageText(text, { chat_id: m.chatId, message_id: m.messageId, ...(parse_mode ? { parse_mode } : {}) });
    } catch (e) {
      try { await bot.sendMessage(m.chatId, text, { reply_to_message_id: m.messageId, ...(parse_mode ? { parse_mode } : {}) }); } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// Suivi absence → réapparition
// ---------------------------------------------------------------------------
function bumpAbsence(round) {
  if (!state.enabled) return;
  for (const s of SUITS) {
    const present = predictor.hasSuit(round, s);
    if (present) {
      if (state.watching[s]) {
        createPrediction(s, round.number);
        state.watching[s] = false;
      }
      state.absence[s] = 0;
    } else if (!state.watching[s]) {
      state.absence[s] += 1;
      if (state.absence[s] >= ABSENCE_TARGET) {
        state.absence[s] = ABSENCE_TARGET;
        state.watching[s] = true;
      }
    }
    // si déjà "watching" et toujours absent : on attend simplement, sans recompter
  }
}

function createPrediction(suit, appearGame) {
  const target = appearGame + RESUME_LEAD;
  const pred = {
    id: ++state.seq,
    suit,
    appearGame,
    target,
    step: 0,
    maxR: MAX_R,
    status: 'en attente',
    badge: null,
    result: null,
    hitNumber: null,
    game: null,
    forward: false,
    messages: [],
    createdAt: Date.now(),
  };
  armForward(pred);
  state.predictions.unshift(pred);
  state.predictions = state.predictions.slice(0, 300);
  if (pred.forward) state.pendingBroadcast.push(pred);
  return pred;
}

// applique le relais en attente (si armé) à la prédiction qui vient d'être créée
function armForward(pred) {
  if (!state.meta.forwardArmed) return;
  if (state.meta.forwardRemaining > 0) {
    state.meta.forwardRemaining -= 1;
  } else {
    pred.forward = true;
    const info = state.meta.forwardInfo;
    if (info) {
      state.queueLog.unshift({
        lossGame: info.lossGame,
        position: info.position,
        sentTarget: pred.target,
        sentAt: Date.now(),
      });
      state.queueLog = state.queueLog.slice(0, 200);
    }
    state.meta.forwardArmed = false;
    state.meta.forwardRemaining = null;
    state.meta.forwardInfo = null;
  }
}

// ---------------------------------------------------------------------------
// Vérification (numéro prédit puis rattrapages), même logique que le moteur
// principal mais appliquée aux prédictions "absent apparue"
// ---------------------------------------------------------------------------
function verify() {
  const closed = [];
  for (const p of state.predictions) {
    if (p.status !== 'en attente') continue;
    let guard = 0;
    while (p.status === 'en attente' && guard++ <= p.maxR + 1) {
      const num = p.target + p.step;
      const g = predictor.state.games.get(num);
      if (!g || !g.finished) break;
      if (predictor.hasSuit(g, p.suit)) {
        p.status = 'gagné';
        p.badge = predictor.BADGES[p.step] || `${p.step}`;
        p.result = predictor.handSuits(g).join(' ');
        p.hitNumber = num;
        p.game = g;
        closed.push(p);
        break;
      }
      if (p.step >= p.maxR) {
        p.status = 'perdu';
        p.badge = '❌';
        p.result = predictor.handSuits(g).join(' ');
        p.hitNumber = num;
        p.game = g;
        closed.push(p);
        break;
      }
      p.step += 1;
    }
  }
  // le relais se calcule dans l'ordre où les prédictions se terminent
  for (const p of closed) processClosed(p);
  return closed;
}

function processClosed(pred) {
  const isLoss = pred.status === 'perdu';
  const isWin = pred.status === 'gagné';
  if (!isLoss && !isWin) return;

  if (state.meta.reference == null) {
    if (isLoss) {
      state.meta.reference = pred.id;
      state.meta.winsSinceReference = 0;
    }
    return;
  }
  if (isWin) {
    state.meta.winsSinceReference += 1;
    return;
  }
  // isLoss : c'est la 2ème perte du cycle
  const n = state.meta.winsSinceReference;
  if (n > MAX_N_FOR_FORWARD) {
    // écart trop grand (> 5 gains) : on n'arme pas de relais pour cette
    // paire, cette perte devient simplement la nouvelle référence et on
    // attend la perte suivante pour recalculer N.
    state.meta.reference = pred.id;
    state.meta.winsSinceReference = 0;
    return;
  }
  state.meta.forwardArmed = true;
  state.meta.forwardRemaining = n;
  state.meta.forwardInfo = { lossGame: pred.hitNumber, position: n + 1 };
  state.meta.reference = pred.id; // devient la nouvelle référence
  state.meta.winsSinceReference = 0;
}

// ---------------------------------------------------------------------------
// Rendu des messages — format "Royal Club" dédié à cette stratégie
// ---------------------------------------------------------------------------
const BOLD_DIGITS = { '0': '𝟎', '1': '𝟏', '2': '𝟐', '3': '𝟑', '4': '𝟒', '5': '𝟓', '6': '𝟔', '7': '𝟕', '8': '𝟖', '9': '𝟗' };
function toBoldDigits(n) {
  return String(n).split('').map((d) => BOLD_DIGITS[d] || d).join('');
}

function predictionText(p) {
  let resultPart;
  if (p.status === 'gagné') resultPart = `✅${p.badge ? ' ' + p.badge : ''}`;
  else if (p.status === 'perdu') resultPart = '❌';
  else resultPart = '⏳';
  const text =
    `⭐️ 𝐑𝐎𝐘𝐀𝐋 𝐂𝐋𝐔𝐁 💎\n` +
    `🎱 𝐉𝐄𝐔 #𝐍${p.target} · ${p.suit} · 𝐃𝐎𝐆𝐎𝐍 +${toBoldDigits(p.maxR)}\n` +
    `💠 𝐑𝐄𝐒𝐔𝐋𝐓𝐀𝐓 ➜${resultPart}`;
  return { text, parse_mode: null };
}

function predictionMessage(p) {
  return predictionText(p).text;
}

// File d'attente d'envoi vers le canal Telegram configuré.
// Le filtre (quelle prédiction est armée pour le relais) ne change pas.
// Seul l'ORDRE d'envoi change quand plusieurs prédictions armées attendent
// en même temps : celle dont le tour cible (target) est le plus proche du
// tour actuellement en cours (predictor.state.live) passe en premier —
// même si elle est arrivée dans la file après une autre (le "dernier venu"
// peut donc doubler le "premier venu" s'il est plus proche du jeu actuel).
function takePendingBroadcast() {
  const list = state.pendingBroadcast;
  state.pendingBroadcast = [];
  const cur = predictor.state.live ? predictor.state.live.number : null;
  if (cur != null && list.length > 1) {
    list.sort((a, b) => Math.abs(a.target - cur) - Math.abs(b.target - cur));
  }
  return list;
}

function stats() {
  const done = state.predictions.filter((p) => p.status !== 'en attente');
  const win = done.filter((p) => p.status === 'gagné').length;
  const forwarded = state.predictions.filter((p) => p.forward);
  const forwardedDone = forwarded.filter((p) => p.status !== 'en attente');
  const forwardedWin = forwardedDone.filter((p) => p.status === 'gagné').length;
  return {
    total: state.predictions.length,
    win,
    loss: done.length - win,
    rate: done.length ? Math.round((win / done.length) * 100) : 0,
    forwardedTotal: forwarded.length,
    forwardedWin,
    forwardedLoss: forwardedDone.length - forwardedWin,
    forwardedRate: forwardedDone.length ? Math.round((forwardedWin / forwardedDone.length) * 100) : 0,
  };
}

function settingsText() {
  return (
    `🧩 *Stratégie "absent apparue"*\n` +
    `• État : ${state.enabled ? 'activée ✅' : 'désactivée ⛔'}\n` +
    `• Seuil d'absence : *${ABSENCE_TARGET}* (fixe)\n` +
    `• Décalage de retour : *+${RESUME_LEAD}* (fixe)\n` +
    `• Rattrapages : *${MAX_R}* (fixe)\n` +
    `• Canal relais Telegram : ${state.channelId ? '`' + state.channelId + '`' : '_non configuré_'}\n` +
    `• Bot dédié : ${state.botToken ? (state.botUsername ? '@' + state.botUsername : 'connecté') : '_token non configuré_'}\n` +
    `• Suivi par costume : ${SUITS.map((s) => `${s}${state.watching[s] ? '👀' : state.absence[s]}`).join(' ')}`
  );
}

// ---------------------------------------------------------------------------
// Tableau de la file d'attente de position (historique des envois)
// ---------------------------------------------------------------------------
function ordinal(n) {
  return n === 1 ? '1ʳᵉ' : `${n}ᵉ`;
}

function queueLogText(limit = 20) {
  const list = state.queueLog.slice(0, limit);
  const pending = state.meta.forwardArmed ? 1 : 0;
  const header = '📋 *File d\'attente de position — Prédiction*';
  if (!list.length) {
    return `${header}\n\n_Aucun envoi pour l'instant._\n\n📊 0 affichée(s) · ${pending} en attente`;
  }
  const lines = list.map(
    (e) => `✅ Jeu perdu #N${e.lossGame} → position ${ordinal(e.position)} — envoyée sur #N${e.sentTarget}`
  );
  return `${header}\n\n${lines.join('\n')}\n\n📊 ${list.length} affichée(s) · ${pending} en attente`;
}

module.exports = {
  state,
  SUITS,
  STRATEGY_LABEL,
  ABSENCE_TARGET,
  RESUME_LEAD,
  MAX_R,
  bumpAbsence,
  verify,
  predictionText,
  predictionMessage,
  takePendingBroadcast,
  stats,
  settingsText,
  persist,
  startBot,
  botStatus,
  setChannel,
  broadcast,
  updateResult,
  queueLogText,
};

// se branche sur la fin de chaque tour du moteur principal
predictor.setOnFinished(bumpAbsence);
