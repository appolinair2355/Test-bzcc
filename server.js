// server.js
// Bot Telegram + Mini App "Bar Bot" — jeu de cartes basé sur l'heure ivoirienne.
// Tout le projet est volontairement à plat (aucun sous-dossier), max 7 fichiers.

const express = require('express');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// ---------- Config ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return { BOT_TOKEN: '', ADMIN_ID: '', CHANNEL_ID: '' };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
let bot = null;
let welcomedChannels = new Set(); // évite de souhaiter "bienvenue" plusieurs fois par run

// Membres approuvés par l'admin (en mémoire ; se réinitialise si le service redémarre)
const approved = new Set();

// Liste des 10 derniers messages du canal (nouveaux + modifiés)
let channelMessages = []; // { text, timestamp, edited }
const MAX_CHANNEL_MESSAGES = 10;

// ---------- URL publique de l'app (fournie par Render automatiquement) ----------
function getPublicUrl() {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  return null;
}

// ---------- Bot Telegram ----------
function startBot() {
  if (bot) {
    try { bot.stopPolling(); } catch (e) { /* ignore */ }
    bot = null;
  }
  if (!config.BOT_TOKEN) {
    console.log('BOT_TOKEN manquant — bot non démarré (configurer via / (page d'accueil)).');
    return;
  }

  bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
  console.log('Bot Telegram démarré.');

  // Le bot vient d'être ajouté / promu dans le canal -> message de bienvenue + panneau
  bot.on('my_chat_member', async (msg) => {
    try {
      const chat = msg.chat;
      const newStatus = msg.new_chat_member && msg.new_chat_member.status;
      const isTargetChannel = config.CHANNEL_ID && String(chat.id) === String(config.CHANNEL_ID);
      const justAdded = newStatus === 'administrator' || newStatus === 'member';

      if (isTargetChannel && justAdded && !welcomedChannels.has(chat.id)) {
        welcomedChannels.add(chat.id);
        await bot.sendMessage(chat.id, '🎉 Bienvenue ! Bar Bot est actif sur ce canal.');

        const publicUrl = getPublicUrl();
        if (publicUrl) {
          await bot.sendMessage(chat.id, 'Cliquez ci-dessous pour ouvrir le panneau :', {
            reply_markup: {
              inline_keyboard: [[
                { text: '🎴 Ouvrir le panneau', web_app: { url: publicUrl } }
              ]]
            }
          });
        } else {
          await bot.sendMessage(chat.id, "⚠️ URL publique non détectée — vérifiez la config Render (RENDER_EXTERNAL_URL).");
        }
      }
    } catch (err) {
      console.error('Erreur my_chat_member:', err.message);
    }
  });

  // Réponses de l'admin (Approuver / Refuser)
  bot.on('callback_query', async (query) => {
    try {
      const data = query.data || '';
      const [action, userId] = data.split(':');
      if (!userId) return;

      if (action === 'approve') {
        approved.add(String(userId));
        await bot.answerCallbackQuery(query.id, { text: 'Membre approuvé ✅' });
        await bot.editMessageText(`✅ Accès approuvé — ID ${userId}`, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }).catch(() => {});
      } else if (action === 'refuse') {
        approved.delete(String(userId));
        await bot.answerCallbackQuery(query.id, { text: 'Membre refusé ❌' });
        await bot.editMessageText(`❌ Accès refusé — ID ${userId}`, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }).catch(() => {});
      }
    } catch (err) {
      console.error('Erreur callback_query:', err.message);
    }
  });

  bot.on('polling_error', (err) => console.error('polling_error:', err.message));

  // Message posté dans le canal -> on le récupère, on l'ajoute à la liste, puis on le supprime du canal
  bot.on('channel_post', async (msg) => {
    try {
      const isTargetChannel = config.CHANNEL_ID && String(msg.chat.id) === String(config.CHANNEL_ID);
      if (!isTargetChannel) return;

      const text = msg.text || msg.caption || '[message sans texte]';
      channelMessages.unshift({ text, timestamp: Date.now(), edited: false });
      if (channelMessages.length > MAX_CHANNEL_MESSAGES) {
        channelMessages = channelMessages.slice(0, MAX_CHANNEL_MESSAGES);
      }

      await bot.deleteMessage(msg.chat.id, msg.message_id);
    } catch (err) {
      console.error('Erreur channel_post:', err.message);
    }
  });

  // Message modifié dans le canal -> on capture la version modifiée, on l'ajoute à la liste, on tente de supprimer
  bot.on('edited_channel_post', async (msg) => {
    try {
      const isTargetChannel = config.CHANNEL_ID && String(msg.chat.id) === String(config.CHANNEL_ID);
      if (!isTargetChannel) return;

      const text = msg.text || msg.caption || '[message sans texte]';
      channelMessages.unshift({ text, timestamp: Date.now(), edited: true });
      if (channelMessages.length > MAX_CHANNEL_MESSAGES) {
        channelMessages = channelMessages.slice(0, MAX_CHANNEL_MESSAGES);
      }

      // Tentative de suppression au cas où le message original n'aurait pas encore été supprimé
      try {
        await bot.deleteMessage(msg.chat.id, msg.message_id);
      } catch (e) { /* ignore */ }
    } catch (err) {
      console.error('Erreur edited_channel_post:', err.message);
    }
  });
}

startBot();

// ---------- Cycle des numéros / cartes (heure de la Côte d'Ivoire, UTC+0, pas de changement d'heure) ----------
const SUIT_CYCLE = ['♦️', '❤️', '♠️', '♣️', '❤️', '♦️', '♣️', '♠️']; // boucle de 8 étapes, confirmée
const SUIT_NAMES = { '♠️': 'Pique', '♦️': 'Carreau', '♣️': 'Trèfle', '❤️': 'Cœur' };

function buildSequence() {
  const seq = [];
  for (let m = 6; m <= 1436; m++) {
    const last = m % 10;
    if (last === 2 || last === 4 || last === 6 || last === 8) seq.push(m);
  }
  return seq;
}
const SEQUENCE = buildSequence();
const NUMBER_TO_SUIT = {};
SEQUENCE.forEach((num, i) => {
  NUMBER_TO_SUIT[num] = SUIT_CYCLE[i % SUIT_CYCLE.length];
});
const SEQUENCE_SET = new Set(SEQUENCE);

function getIvoryCoastNow() {
  // Côte d'Ivoire (Abidjan) = UTC+0 toute l'année (pas d'heure d'été)
  const d = new Date();
  return {
    date: d,
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    minutesSinceMidnight: d.getUTCHours() * 60 + d.getUTCMinutes()
  };
}

// ---------- Serveur web ----------
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/config-status', (req, res) => {
  res.json({
    configured: !!(config.BOT_TOKEN && config.ADMIN_ID && config.CHANNEL_ID)
  });
});

// Renvoie les infos de config non sensibles (sans le token)
app.get('/api/config-info', (req, res) => {
  res.json({
    adminId: config.ADMIN_ID || '',
    channelId: config.CHANNEL_ID || '',
    hasToken: !!config.BOT_TOKEN
  });
});

app.post('/api/config', (req, res) => {
  const { BOT_TOKEN, ADMIN_ID, CHANNEL_ID } = req.body || {};
  if (!BOT_TOKEN || !ADMIN_ID || !CHANNEL_ID) {
    return res.status(400).json({ error: 'BOT_TOKEN, ADMIN_ID et CHANNEL_ID sont requis.' });
  }
  config = { BOT_TOKEN: String(BOT_TOKEN).trim(), ADMIN_ID: String(ADMIN_ID).trim(), CHANNEL_ID: String(CHANNEL_ID).trim() };
  saveConfig(config);
  welcomedChannels = new Set();
  startBot();
  res.json({ ok: true });
});

app.post('/api/request-access', async (req, res) => {
  try {
    const { userId, username, firstName } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId manquant' });
    if (approved.has(String(userId))) return res.json({ status: 'approved' });
    if (!bot || !config.ADMIN_ID) return res.status(400).json({ error: 'Bot non configuré' });

    const label = username ? `@${username}` : (firstName || 'Membre');
    await bot.sendMessage(
      config.ADMIN_ID,
      `🔔 Nouvelle demande d'accès au panneau\nNom : ${label}\nID Telegram : ${userId}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approuver', callback_data: `approve:${userId}` },
            { text: '❌ Refuser', callback_data: `refuse:${userId}` }
          ]]
        }
      }
    );
    res.json({ status: 'pending' });
  } catch (err) {
    console.error('Erreur /api/request-access:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/status/:userId', (req, res) => {
  res.json({ approved: approved.has(String(req.params.userId)) });
});

app.get('/api/greeting/:userId', (req, res) => {
  const isAdmin = !!config.ADMIN_ID && String(req.params.userId) === String(config.ADMIN_ID);
  const message = isAdmin
    ? 'Bienvenue administrateur'
    : 'Bienvenue sur le site de Sossou Kouamé';
  res.json({ isAdmin, message });
});

app.get('/api/current', (req, res) => {
  const now = getIvoryCoastNow();
  const nextMinute = now.minutesSinceMidnight + 1;

  let payload = { active: false, hours: now.hours, minutes: now.minutes, seconds: now.seconds };

  if (SEQUENCE_SET.has(nextMinute) && now.seconds >= 30) {
    const suit = NUMBER_TO_SUIT[nextMinute];
    payload = {
      active: true,
      number: nextMinute,
      suit,
      suitName: SUIT_NAMES[suit],
      hours: now.hours,
      minutes: now.minutes,
      seconds: now.seconds
    };
  }

  // Renvoie toujours la liste des 10 derniers messages (nouveaux + modifiés)
  payload.channelMessages = channelMessages;

  res.json(payload);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
