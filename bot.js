// bot.js — bot Telegram + boucle de prédiction/vérification
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const api = require('./api');
const store = require('./store');
const fmt = require('./formats');
const {
  state, evaluate, verify, registerGames,
  predictionText, predictionMessage, liveText, stats, SUITS,
} = require('./predictor');
const strategyAbsent = require('./strategy-absent');

let bot = null;
let loopStarted = false;

const saved = store.read();
state.botToken = saved.botToken || config.BOT_TOKEN || '';
state.adminId = saved.adminId || config.ADMIN_ID;
if (Array.isArray(saved.channels)) state.channels = saved.channels;
if (Array.isArray(saved.activeChannels)) state.activeChannels = saved.activeChannels;
if (saved.B) state.B = saved.B;
if (saved.maxR != null) state.maxR = saved.maxR;
state.hand = 'joueur';
if (saved.format) state.format = saved.format;
if (saved.template !== undefined) state.template = saved.template;

function persist() {
  store.patch({
    botToken: state.botToken,
    adminId: state.adminId,
    channels: state.channels,
    activeChannels: state.activeChannels,
    B: state.B,
    maxR: state.maxR,
    hand: 'joueur',
    format: state.format,
    template: state.template,
  });
}

const isAdmin = (msg) => msg.from && msg.from.id === Number(state.adminId);
const deny = (id) => bot && bot.sendMessage(id, "⛔ Commande réservée à l'administrateur.");

function rememberChannel(chat) {
  if (!chat || !['channel', 'supergroup', 'group'].includes(chat.type)) return;
  if (!state.channels.some((c) => c.id === chat.id)) {
    state.channels.push({ id: chat.id, title: chat.title || String(chat.id) });
    persist();
    if (bot)
      bot.sendMessage(
        state.adminId,
        `📡 Nouveau canal détecté : *${chat.title}*\n\`${chat.id}\`\n\n` +
          `Lance \`/activer ${chat.id}\` pour y envoyer les prédictions.`,
        { parse_mode: 'Markdown' }
      );
  }
}

function listChannels() {
  if (!state.channels.length) return '_aucun_';
  return state.channels
    .map((c) => `${state.activeChannels.includes(c.id) ? '✅' : '⚪'} ${c.title} — \`${c.id}\``)
    .join('\n');
}

const HELP =
  '🎴 *Bot Baccara 1xbet — main du JOUEUR*\n\n' +
  '*Jeu*\n' +
  '/live — jeu réellement en cours (cartes + costumes joueur)\n' +
  '/stats — statistiques des prédictions\n' +
  '/reglages — réglages actuels\n\n' +
  '*Canaux*\n' +
  '/canaux — canaux où je suis admin\n' +
  '/activer <id> — activer les prédictions\n' +
  '/desactiver <id> — arrêter\n\n' +
  '*Prédiction*\n' +
  '/setb <n> — compteur B (apparitions consécutives max)\n' +
  '/setmaxr <n> — nombre de rattrapages vérifiés\n' +
  '/setformat <1-77> — style du message de prédiction\n' +
  '/formats [page] — liste des 77 styles\n' +
  '/apercu <n> — aperçu complet d\'un style (⌛ / ✅ / ❌)\n' +
  '/settemplate <texte> — style personnalisé ({game} {emoji} {suit} {status} {maxR})\n' +
  '/notemplate — revenir au style numéroté\n\n' +
  '*Stratégie "absent apparue"*\n' +
  '/reglagesabsent — réglages et suivi par costume\n' +
  '/canalabsent <id> — canal Telegram relais (envoie un message de bienvenue)\n' +
  '/tokenabsent <token> — token API Telegram dédié à cette stratégie\n' +
  '/fileabsent — tableau de la file d\'attente de position\n' +
  '/absentstats — statistiques site + relayées\n' +
  '/absenton /absentoff — activer / désactiver la stratégie';

function settingsText() {
  return (
    `⚙️ *Réglages*\n` +
    `• Compteur B : *${state.B}*\n` +
    `• Rattrapages : *${state.maxR}*\n` +
    `• Main vérifiée : *joueur uniquement*\n` +
    `• Format : *${state.format}/77*${state.template ? ' (template perso)' : ''}\n` +
    `• Compteurs : ${SUITS.map((s) => `${s}${state.counters[s]}`).join(' ')}`
  );
}

function fmtDate(d) {
  if (!d) return '—';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const [y, mo, da] = s.split('-');
  return da ? `${da}/${mo}/${y}` : s;
}

function wire(b) {
  b.on('polling_error', (e) => { state.botError = e.message; });
  b.on('my_chat_member', (u) => {
    const status = u.new_chat_member && u.new_chat_member.status;
    if (['administrator', 'member', 'creator'].includes(status)) rememberChannel(u.chat);
  });
  b.on('channel_post', (m) => rememberChannel(m.chat));

  b.onText(/^\/(start|aide|help)/, (msg) =>
    b.sendMessage(msg.chat.id, HELP, { parse_mode: 'Markdown' })
  );

  b.onText(/^\/(live|encours|jeu)\b/, (msg) =>
    b.sendMessage(msg.chat.id, liveText(), { parse_mode: 'Markdown' })
  );

  b.onText(/^\/reglages/, (msg) =>
    b.sendMessage(msg.chat.id, settingsText(), { parse_mode: 'Markdown' })
  );

  b.onText(/^\/canaux/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    b.sendMessage(msg.chat.id, `📋 *Canaux*\n${listChannels()}`, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/setb(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /setb <n>  (actuel : ${state.B})`);
    state.B = Math.max(1, parseInt(m[1], 10));
    for (const s of SUITS) if (state.counters[s] > state.B) state.counters[s] = 0;
    persist();
    b.sendMessage(
      msg.chat.id,
      `✅ B = ${state.B}\nLe compteur monte de 1 à ${state.B} quand le costume apparaît dans la main du joueur, retombe à 0 quand il manque, et repart à 1 après avoir atteint ${state.B}.`
    );
  });

  b.onText(/^\/setmaxr(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /setmaxr <n>  (actuel : ${state.maxR})`);
    state.maxR = Math.max(0, Math.min(9, parseInt(m[1], 10)));
    persist();
    b.sendMessage(msg.chat.id, `✅ Rattrapages = ${state.maxR} : on vérifie le numéro prédit puis ${state.maxR} tour(s) suivant(s).`);
  });

  b.onText(/^\/setformat(?:\s+(\d+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const list = fmt.formatList(1, 26);
    if (!m[1])
      return b.sendMessage(
        msg.chat.id,
        `ℹ️ Usage : /setformat <1-${fmt.FORMAT_COUNT}>  (actuel : ${state.format})\n\n${list.text}\n\n➡️ /formats 2 pour la suite`
      );
    state.format = fmt.clampFormat(m[1]);
    state.template = null;
    persist();
    b.sendMessage(
      msg.chat.id,
      `✅ Format des prédictions = ${state.format}/${fmt.FORMAT_COUNT}\n\n` +
        `⌛ Prédiction :\n${fmt.formatPreview(state.format, { maxR: state.maxR })}\n\n` +
        `✅ Gagné :\n${fmt.formatPreview(state.format, { maxR: state.maxR, status: 'gagné', rattrapage: 1 })}\n\n` +
        `❌ Perdu :\n${fmt.formatPreview(state.format, { maxR: state.maxR, status: 'perdu', rattrapage: state.maxR })}`
    );
  });

  b.onText(/^\/formats(?:\s+(\d+))?/, (msg, m) => {
    const list = fmt.formatList(m[1] || 1, 26);
    b.sendMessage(
      msg.chat.id,
      `🎨 Styles de prédiction (${list.page}/${list.pages}) — ${fmt.FORMAT_COUNT} au total\n\n${list.text}\n\n` +
        `➡️ /formats <page> • /apercu <n> • /setformat <n>`
    );
  });

  b.onText(/^\/apercu(?:\s+(\d+))?/, (msg, m) => {
    if (!m[1]) return b.sendMessage(msg.chat.id, `ℹ️ Usage : /apercu <1-${fmt.FORMAT_COUNT}>`);
    const id = fmt.clampFormat(m[1]);
    b.sendMessage(
      msg.chat.id,
      `🎨 Style ${id}/${fmt.FORMAT_COUNT}\n\n⌛\n${fmt.formatPreview(id, { maxR: state.maxR })}\n\n` +
        `✅\n${fmt.formatPreview(id, { maxR: state.maxR, status: 'gagné', rattrapage: 1 })}\n\n` +
        `❌\n${fmt.formatPreview(id, { maxR: state.maxR, status: 'perdu', rattrapage: state.maxR })}`
    );
  });

  b.onText(/^\/settemplate(?:\s+([\s\S]+))?/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1])
      return b.sendMessage(
        msg.chat.id,
        'ℹ️ Usage : /settemplate 🎯 #{game} | {emoji} {suit} | {status}\n' +
          'Variables : {game} {emoji} {suit} {status} {maxR} {rattrapage} {strategy}'
      );
    state.template = m[1].trim();
    persist();
    b.sendMessage(msg.chat.id, `✅ Template personnalisé actif :\n\n${fmt.renderMessage(state.format, { gameNumber: 1234, suit: '♦️', maxR: state.maxR }, state.template).text}`);
  });

  b.onText(/^\/notemplate/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    state.template = null;
    persist();
    b.sendMessage(msg.chat.id, `✅ Retour au style numéroté ${state.format}/${fmt.FORMAT_COUNT}.`);
  });

  b.onText(/^\/sethand(?:\s+(\w+))?/, (msg) =>
    b.sendMessage(
      msg.chat.id,
      'ℹ️ Ce bot analyse *uniquement la main du joueur*.',
      { parse_mode: 'Markdown' }
    )
  );

  b.onText(/^\/activer\s+(-?\d+)/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const id = parseInt(m[1], 10);
    activate(id);
    b.sendMessage(msg.chat.id, `✅ Prédictions activées pour \`${id}\``, { parse_mode: 'Markdown' });
    try {
      await b.sendMessage(id, '🟢 *Prédictions actives*', { parse_mode: 'Markdown' });
    } catch (e) {
      b.sendMessage(msg.chat.id, `⚠️ Impossible d'écrire dans ce canal : ${e.message}`);
    }
  });

  b.onText(/^\/desactiver\s+(-?\d+)/, (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    deactivate(parseInt(m[1], 10));
    b.sendMessage(msg.chat.id, `🔴 Prédictions désactivées pour \`${m[1]}\``, { parse_mode: 'Markdown' });
  });

  b.onText(/^\/stats/, (msg) => {
    const s = stats();
    b.sendMessage(
      msg.chat.id,
      `📊 Prédictions : ${s.total}\n✅ ${s.win} | ❌ ${s.loss} | 🎯 ${s.rate}%\nB = ${state.B} • R = ${state.maxR} • main joueur\nTour live : ${state.live ? '#N' + state.live.number : '—'}`
    );
  });

  // --- stratégie "absent apparue" ------------------------------------------
  b.onText(/^\/reglagesabsent/, (msg) =>
    b.sendMessage(msg.chat.id, strategyAbsent.settingsText(), { parse_mode: 'Markdown' })
  );

  b.onText(/^\/canalabsent(?:\s+(-?\d+))?/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) {
      return b.sendMessage(
        msg.chat.id,
        strategyAbsent.state.channelId
          ? `📡 Canal relais actuel : \`${strategyAbsent.state.channelId}\``
          : 'ℹ️ Aucun canal relais configuré.\nUsage : /canalabsent <id>',
        { parse_mode: 'Markdown' }
      );
    }
    const id = parseInt(m[1], 10);
    const r = await strategyAbsent.setChannel(id);
    b.sendMessage(
      msg.chat.id,
      `✅ Canal relais "absent apparue" = \`${id}\`` +
        (r.welcomeSent ? '\n👋 Message de bienvenue envoyé sur le canal.' : ''),
      { parse_mode: 'Markdown' }
    );
    if (r.error) b.sendMessage(msg.chat.id, `⚠️ Bienvenue non envoyée : ${r.error}`);
  });

  b.onText(/^\/tokenabsent(?:\s+(\S+))?/, async (msg, m) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    if (!m[1]) {
      const s = strategyAbsent.botStatus();
      return b.sendMessage(
        msg.chat.id,
        s.tokenSet
          ? `🔑 Token dédié : \`${s.tokenMasked}\`${s.username ? ' (@' + s.username + ')' : ''}`
          : 'ℹ️ Aucun token dédié configuré.\nUsage : /tokenabsent <token>',
        { parse_mode: 'Markdown' }
      );
    }
    const r = await strategyAbsent.startBot(m[1]);
    if (r.ok) {
      b.sendMessage(msg.chat.id, `✅ Bot dédié "absent apparue" connecté : @${r.username}`);
    } else {
      b.sendMessage(msg.chat.id, `⚠️ Connexion échouée : ${r.error}`);
    }
  });

  b.onText(/^\/fileabsent/, (msg) =>
    b.sendMessage(msg.chat.id, strategyAbsent.queueLogText(), { parse_mode: 'Markdown' })
  );

  b.onText(/^\/absentstats/, (msg) => {
    const s = strategyAbsent.stats();
    b.sendMessage(
      msg.chat.id,
      `📊 *Absent → apparue*\n` +
        `Site : ${s.total} • ✅${s.win} ❌${s.loss} (${s.rate}%)\n` +
        `Relayées Telegram : ${s.forwardedTotal} • ✅${s.forwardedWin} ❌${s.forwardedLoss} (${s.forwardedRate}%)`,
      { parse_mode: 'Markdown' }
    );
  });

  b.onText(/^\/absenton/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    strategyAbsent.state.enabled = true;
    strategyAbsent.persist();
    b.sendMessage(msg.chat.id, '✅ Stratégie "absent apparue" activée.');
  });

  b.onText(/^\/absentoff/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    strategyAbsent.state.enabled = false;
    strategyAbsent.persist();
    b.sendMessage(msg.chat.id, '⛔ Stratégie "absent apparue" désactivée.');
  });
}

function activate(id) {
  if (!state.activeChannels.includes(id)) state.activeChannels.push(id);
  if (!state.channels.some((c) => c.id === id)) state.channels.push({ id, title: String(id) });
  persist();
}

function deactivate(id) {
  state.activeChannels = state.activeChannels.filter((c) => c !== id);
  persist();
}

async function startBot(token) {
  if (token) state.botToken = token.trim();
  persist();
  state.botError = null;
  if (bot) {
    try { await bot.stopPolling({ cancel: true }); } catch (_) {}
    bot = null;
  }
  if (!state.botToken) {
    state.botError = 'Aucun token configuré';
    return { ok: false, error: state.botError };
  }
  try {
    bot = new TelegramBot(state.botToken, { polling: true });
    wire(bot);
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
    adminId: state.adminId,
    error: state.botError || null,
  };
}

// ---------------------------------------------------------------------------
// Envoi + vérification des prédictions
// ---------------------------------------------------------------------------
async function broadcast(pred) {
  if (!bot) return;
  const { text, parse_mode } = predictionText(pred);
  for (const id of state.activeChannels) {
    try {
      const m = await bot.sendMessage(id, text, parse_mode ? { parse_mode } : {});
      pred.messages.push({ chatId: id, messageId: m.message_id });
    } catch (e) {
      console.error('Envoi échoué', id, e.message);
    }
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

// --- relais "absent apparue" (bot + canal Telegram dédiés) ----------------
// Envoyé via strategyAbsent.broadcast/updateResult, qui utilisent le token
// API propre à cette stratégie (voir /tokenabsent) et non le bot principal.

async function tick() {
  try {
    const games = await api.fetchGames();
    state.lastError = null;
    // registerGames déclenche onFinished -> strategyAbsent.bumpAbsence,
    // qui peut créer de nouvelles prédictions "absent apparue" (site) et,
    // le cas échéant, en marquer une à relayer sur le canal Telegram dédié.
    registerGames(games);

    const closed = verify();
    for (const p of closed) await updateResult(p);

    const pred = evaluate();
    if (pred) await broadcast(pred);

    // envoyer les prédictions "absent apparue" qui viennent d'être relayées
    const toSend = strategyAbsent.takePendingBroadcast();
    for (const p of toSend) await strategyAbsent.broadcast(p);

    // vérifier/clôturer les prédictions "absent apparue" (site) et mettre à
    // jour dans le canal Telegram uniquement celles qui y ont été relayées
    const absClosed = strategyAbsent.verify();
    for (const p of absClosed) {
      if (p.forward) await strategyAbsent.updateResult(p);
    }
  } catch (e) {
    state.lastError = e.message;
  }
}

async function startLoop() {
  if (!loopStarted) {
    loopStarted = true;
    setInterval(tick, config.POLL_INTERVAL_MS);
    tick();
  }
  startBot();
  strategyAbsent.startBot();
}

module.exports = { startLoop, startBot, botStatus, activate, deactivate, persist, listChannels };
