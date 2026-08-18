// server.js — tableau de bord web (Render) + API JSON. AUCUN mot de passe requis.
const path = require('path');
const express = require('express');
const config = require('./config');
const api = require('./api');
const fmt = require('./formats');
const { state, stats, predictionMessage, recentGames, SUITS } = require('./predictor');
const { startLoop, startBot, botStatus, activate, deactivate, persist } = require('./bot');
const strategyAbsent = require('./strategy-absent');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/state', (req, res) => {
  res.json({
    b: state.B,
    maxR: state.maxR,
    hand: 'joueur',
    format: state.format,
    formatCount: fmt.FORMAT_COUNT,
    formats: fmt.formatList(1, fmt.FORMAT_COUNT).text,
    template: state.template || null,
    counters: state.counters,
    suits: SUITS,
    live: state.live,
    lastFinished: state.lastFinished,
    error: state.lastError,
    bot: botStatus(),
    apiUrl: api.endpoints()[0],
    champId: config.CHAMP_ID,
    channels: state.channels.map((c) => ({ ...c, active: state.activeChannels.includes(c.id) })),
    predictions: state.predictions.slice(0, 50).map((p) => ({
      target: p.target, suit: p.suit, hand: p.hand, step: p.step, maxR: p.maxR,
      status: p.status, badge: p.badge, text: predictionMessage(p),
    })),
    stats: stats(),
    uptime: Date.now() - state.startedAt,
  });
});

app.get('/api/games', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 30);
  res.json({ live: state.live, games: recentGames(limit) });
});

// --- bot --------------------------------------------------------------------
app.get('/api/bot', (req, res) => res.json(botStatus()));

app.post('/api/bot/token', async (req, res) => {
  const token = (req.body.token || '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) return res.status(400).json({ error: 'Token Telegram invalide' });
  const r = await startBot(token);
  res.status(r.ok ? 200 : 400).json({ ...r, bot: botStatus() });
});

app.post('/api/bot/restart', async (req, res) => {
  const r = await startBot();
  res.json({ ...r, bot: botStatus() });
});

app.post('/api/bot/admin', (req, res) => {
  const id = parseInt(req.body.adminId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID administrateur invalide' });
  state.adminId = id;
  persist();
  res.json({ ok: true, bot: botStatus() });
});

// --- canaux / réglages ------------------------------------------------------
app.post('/api/channels/activate', (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID de canal invalide' });
  activate(id);
  res.json({ ok: true });
});

app.post('/api/channels/deactivate', (req, res) => {
  deactivate(parseInt(req.body.id, 10));
  res.json({ ok: true });
});

app.post('/api/setb', (req, res) => {
  state.B = Math.max(1, parseInt(req.body.b, 10) || 1);
  for (const s of SUITS) if (state.counters[s] > state.B) state.counters[s] = 0;
  persist();
  res.json({ ok: true, b: state.B });
});

app.post('/api/setmaxr', (req, res) => {
  state.maxR = Math.max(0, Math.min(9, parseInt(req.body.maxR, 10) || 0));
  persist();
  res.json({ ok: true, maxR: state.maxR });
});

app.post('/api/setformat', (req, res) => {
  state.format = fmt.clampFormat(req.body.format);
  state.template = null;
  persist();
  res.json({ ok: true, format: state.format, preview: fmt.formatPreview(state.format, { maxR: state.maxR }) });
});

// aperçu d'un style (⌛ / ✅ / ❌)
app.get('/api/formats', (req, res) => {
  res.json({ count: fmt.FORMAT_COUNT, formats: fmt.formatCatalog() });
});

app.post('/api/template', (req, res) => {
  const t = String(req.body.template || '').trim();
  state.template = t || null;
  persist();
  res.json({ ok: true, template: state.template, preview: fmt.renderMessage(state.format, { gameNumber: 1234, suit: '♦️', maxR: state.maxR }, state.template).text });
});

// La main analysée est toujours celle du joueur (banquier = archive seulement)
app.post('/api/sethand', (req, res) => res.json({ ok: true, hand: 'joueur' }));

// --- stratégie "absent apparue" ---------------------------------------------
app.get('/api/absent', (req, res) => {
  const a = strategyAbsent.state;
  res.json({
    enabled: a.enabled,
    channelId: a.channelId,
    bot: strategyAbsent.botStatus(),
    absenceTarget: strategyAbsent.ABSENCE_TARGET,
    resumeLead: strategyAbsent.RESUME_LEAD,
    maxR: strategyAbsent.MAX_R,
    absence: a.absence,
    watching: a.watching,
    suits: strategyAbsent.SUITS,
    meta: a.meta,
    stats: strategyAbsent.stats(),
    queueLog: a.queueLog.slice(0, 50),
    predictions: a.predictions.slice(0, 60).map((p) => ({
      id: p.id, appearGame: p.appearGame, target: p.target, suit: p.suit,
      step: p.step, maxR: p.maxR, status: p.status, badge: p.badge,
      forward: p.forward, text: strategyAbsent.predictionMessage(p),
    })),
  });
});

app.post('/api/absent/channel', async (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID de canal invalide' });
  const r = await strategyAbsent.setChannel(id);
  res.json({ ok: true, channelId: id, welcomeSent: r.welcomeSent, error: r.error });
});

app.post('/api/absent/token', async (req, res) => {
  const token = (req.body.token || '').trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) return res.status(400).json({ error: 'Token Telegram invalide' });
  const r = await strategyAbsent.startBot(token);
  res.status(r.ok ? 200 : 400).json({ ...r, bot: strategyAbsent.botStatus() });
});

app.post('/api/absent/toggle', (req, res) => {
  strategyAbsent.state.enabled = !!req.body.enabled;
  strategyAbsent.persist();
  res.json({ ok: true, enabled: strategyAbsent.state.enabled });
});

app.listen(config.PORT, '0.0.0.0', () => {
  console.log('Tableau de bord sur le port ' + config.PORT);
  startLoop();
});
