require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Jakarta';
const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BOT_TOKEN = process.env.BOT_TOKEN;
const AUTHORIZED_USER_ID = String(process.env.AUTHORIZED_USER_ID || '');
const WORKDIR = process.env.WORKDIR || '/home/oc';
// State pilihan bot yang tidak punya kunci di opencode.json (varian model terpilih)
const BOT_STATE_PATH = path.join(os.homedir(), '.config', 'opencode-telegram-bot', 'state.json');
let savedSessions = {}; // chatId → { id, lastAt, turns } — dipakai hydrate chatSessions di bawah
const DEFAULT_TIMEOUT_SECONDS = Number(process.env.RUN_TIMEOUT_SECONDS || 60);
// Perintah berbasis agent (/init, /review, /update run) butuh waktu lebih lama dari chat biasa
const COMMAND_TIMEOUT_SECONDS = Number(process.env.COMMAND_TIMEOUT_SECONDS || 300);
// Begitu agent menjalankan tool (mis. `npm install -g wrangler` yang lama), limit waktu
// dinaikkan ke sini — supaya install panjang tidak dibunuh di tengah jalan (npm bisa korup).
const TOOL_TIMEOUT_SECONDS = Number(process.env.TOOL_TIMEOUT_SECONDS || 600);
// Batas keras total satu percobaan, apa pun yang terjadi (anti run nakal tanpa henti).
const RUN_HARD_TIMEOUT_SECONDS = Number(process.env.RUN_HARD_TIMEOUT_SECONDS || 1200);
// Prompt bertipe tugas berat → limit panjang (TOOL_TIMEOUT_SECONDS) berlaku SEJAK AWAL,
// bukan nunggu event tool pertama. Alasan: model yang lambat bisa "diam" lama saat
// berpikir sebelum akhirnya memanggil bash — kalau pakai limit 120 dtk biasa, tugas
// seperti `install wrangler` mati sebelum sempat menjalankan perintah apa pun.
const LONG_TASK_RE = new RegExp(
  '\\b(?:install(?:ing|s)?|instal|pasang|setup|set\\s+up|build(?:ing)?|compile|deploy' +
  '|upgrade|update|refactor|migrat\\w*|generate|create|buat|npm|pnpm|yarn|npx|pip3?' +
  '|cargo|apt(?:-get)?|brew|docker|git\\s+clone|eksekusi|execute|jalankan)\\b', 'i');

if (!BOT_TOKEN || BOT_TOKEN.includes('123456789')) {
  console.error('ERROR: Set a real BOT_TOKEN in .env');
  process.exit(1);
}
if (!AUTHORIZED_USER_ID) {
  console.error('ERROR: Set AUTHORIZED_USER_ID in .env');
  process.exit(1);
}

// handlerTimeout: 600000 (10 menit, default Telegraf cuma 90 dtk). Tanpa ini, handler yang
// menunggu run lama dilempar TimeoutError → "Internal bot error." palsu di chat.
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 600000 });

// --- State ---
let defaultModel = null;
// Varian model = reasoning effort provider (low/medium/high/xhigh/max) — pasangkan dengan
// `opencode run --variant`. OpenCode tidak punya kunci global untuk varian terpilih di
// config, jadi bot menyimpannya sendiri (BOT_STATE_PATH) supaya tetap setelah restart.
let defaultVariant = null;
let cavemanLevel = 'full';
let showThinking = false;

// Model aktif dibaca dari config OpenCode (source of truth) supaya ganti model lewat
// /model maupun edit opencode.json langsung dipakai pesan berikutnya — tanpa restart.
try {
  const ocCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'));
  if (ocCfg && typeof ocCfg.model === 'string' && ocCfg.model.trim()) defaultModel = ocCfg.model.trim();
} catch (_) {}

try {
  const st = JSON.parse(fs.readFileSync(BOT_STATE_PATH, 'utf8'));
  if (st && typeof st.variant === 'string' && st.variant.trim()) {
    defaultVariant = st.variant.trim();
    log('Varian model dari state:', defaultVariant);
  }
  if (st && st.sessions && typeof st.sessions === 'object') savedSessions = st.sessions;
} catch (_) {}

const CAVEMAN_LEVELS = new Set(['lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra']);

function cavemanInstruction(level) {
  return [
    'IMPORTANT: Respond terse like smart caveman. All technical substance stay. Only fluff die.',
    `Active every response. Level: ${level}.`,
    '',
    'Rules:',
    '- Drop filler, pleasantries, hedging. Fragments OK. Short synonyms.',
    '- lite: no filler/hedging, keep articles and full sentences.',
    '- full: drop articles, fragments OK, classic caveman.',
    '- ultra: abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X -> Y).',
    '- Technical terms exact. Code blocks unchanged.',
    '- Pattern: [thing] [action] [reason]. [Next step].',
    '- Drop caveman for: security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread, and when user asks to clarify or repeats a question. Resume caveman after clear part done.',
    '- Code, commits, PRs: write normal English.',
    '- Stay in caveman mode every response. Do not revert after many turns.',
  ].join('\n');
}

function withCavemanRules(prompt) {
  if (!cavemanLevel) return prompt;
  return cavemanInstruction(cavemanLevel) + '\n\n---\n\nUser request:\n' + prompt;
}

function log(...args) {
  const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  console.log(`[${ts}]`, ...args);
}

// --- Auth middleware ---
bot.use((ctx, next) => {
  const userId = String(ctx.from && ctx.from.id);
  if (userId !== AUTHORIZED_USER_ID) {
    log('Unauthorized access attempt from userId=', userId);
    return ctx.reply('⛔ Unauthorized. You are not allowed to use this bot.');
  }
  return next();
});

// --- Registry perintah: satu sumber untuk /help DAN saran slash Telegram (setMyCommands) ---
const HELP_GROUPS = [
  {
    title: '💬 Chat & sesi',
    items: [
      { cmd: 'start', desc: 'Mulai bot & tampilkan bantuan' },
      { cmd: 'help', desc: 'Bantuan berhalaman & daftar semua perintah' },
      { cmd: 'status', desc: 'Status model, sesi, caveman, timeout' },
      { cmd: 'newsess', aliases: ['newsession', 'new', 'clear'], desc: 'Sesi baru (sesi default tidak pernah berganti otomatis)' },
      { cmd: 'sessions', aliases: ['resume', 'continue'], desc: 'Daftar sesi berhalaman + tombol ketuk untuk pindah (setara /sessions opencode)' },
      { cmd: 'switch', desc: '<nomor|sesiID|new> Pindah sesi — tombolnya ada di /sessions atau /switch' },
      { cmd: 'export', desc: 'Ekspor sesi chat ini sebagai file JSON (setara /export opencode)' },
      { cmd: 'undo', desc: 'Batalkan perubahan terakhir (setara /undo opencode)' },
      { cmd: 'redo', desc: 'Ulangi yang tadi dibatalkan (setara /redo opencode)' },
      { cmd: 'compact', aliases: ['summarize'], desc: 'Kompak sesi (setara /compact opencode)' },
      { cmd: 'caveman', desc: '[level] Gaya jawaban singkat: off|lite|full|ultra|wenyan-*' },
      { cmd: 'thinking', desc: '[on|off] Tampilkan blok pemikiran model (setara /thinking opencode)' },
      { cmd: 'cooldown', desc: 'Info fitur cooldown (sudah dihapus)' },
    ],
  },
  {
    title: '🤖 Perintah OpenCode',
    items: [
      { cmd: 'init', desc: 'Buat/ubah AGENTS.md lewat agent (setara /init opencode)' },
      { cmd: 'review', desc: '[commit|branch|pr] Review perubahan git (setara /review opencode)' },
      { cmd: 'models', desc: 'Daftar model berhalaman + tombol ketuk untuk ganti (setara /models opencode)' },
      { cmd: 'model', desc: '<nama|reset> Ganti model — tersimpan permanen, tanpa restart' },
      { cmd: 'variant', desc: '[nama|off] Varian model / reasoning effort — setara --variant opencode (low, medium, high, xhigh, max)' },
      { cmd: 'themes', desc: 'Info tema TUI (setara /themes opencode)' },
      { cmd: 'details', desc: 'Info detail tool (setara /details opencode)' },
      { cmd: 'editor', desc: 'Info editor eksternal (setara /editor opencode)' },
      { cmd: 'connect', desc: 'Info sambung provider (setara /connect opencode)' },
      { cmd: 'update', desc: '[run] Cek/upgrade versi opencode (setara /update opencode)' },
      { cmd: 'exit', aliases: ['quit', 'q'], desc: 'Info keluar TUI (setara /exit opencode)' },
    ],
  },
  {
    title: '🔑 Provider',
    items: [
      { cmd: 'providers', desc: 'Daftar provider & key tersimpan (berhalaman)' },
      { cmd: 'addkey', desc: '<provider> <key> Simpan API key' },
      { cmd: 'addprovider', desc: '<id> <url> <key> <models> Tambah provider eksternal' },
      { cmd: 'removeprovider', desc: '<id> Hapus provider' },
    ],
  },
  {
    title: '🖥️ VPS & terminal',
    items: [
      { cmd: 'usage', aliases: ['resources', 'sysinfo'], desc: 'Monitor resource VPS: CPU, RAM, swap, disk, load, uptime, proses teratas' },
      { cmd: 'term', desc: '<perintah|end> Terminal VPS di chat — keluaran CLI → chat, balasan Anda → terminal (untuk login semua CLI)' },
      { cmd: 'cron', desc: 'Daftar jadwal/timer VPS (systemd timers user & sistem)' },
    ],
  },
];

function allCommandNames() {
  const names = [];
  for (const g of HELP_GROUPS) for (const it of g.items) names.push(it.cmd, ...(it.aliases || []));
  return names;
}

// Payload untuk setMyCommands: nama + deskripsi (termasuk alias) → muncul sebagai saran saat mengetik "/"
function commandMenuPayload() {
  const out = [];
  for (const g of HELP_GROUPS) {
    for (const it of g.items) {
      out.push({ command: it.cmd, description: truncate(it.desc, 250) });
      for (const a of it.aliases || []) {
        out.push({ command: a, description: truncate('Alias /' + it.cmd + '. ' + it.desc, 250) });
      }
    }
  }
  return out;
}

function helpText() {
  let out =
    '🤖 OpenCode Telegram Bot\n\n' +
    'Kirim pesan apa pun — dijalankan sebagai prompt OpenCode (bisa multi-langkah, pakai tool).\n';
  for (const g of HELP_GROUPS) {
    out += '\n' + g.title + '\n';
    for (const it of g.items) {
      const names = [it.cmd, ...(it.aliases || [])].map((n) => '/' + n).join(', ');
      out += '  ' + names + ' — ' + it.desc + '\n';
    }
  }
  return out.trimEnd();
}

// --- Commands ---
bot.start((ctx) => {
  log('/start from', ctx.from.id);
  const { text, keyboard } = buildHelpPage(1);
  return ctx.reply(text, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {});
});

bot.help((ctx) => {
  const { text, keyboard } = buildHelpPage(1);
  return ctx.reply(text, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {});
});

bot.command('status', (ctx) => {
  const sess = getStoredSession(ctx.chat.id);
  const chain = modelChain();
  return ctx.reply(
    '📋 Status\n' +
    `Model utama: ${defaultModel || '(default config)'}\n` +
    `Varian: ${defaultVariant ? defaultVariant + ' (opencode run --variant)' : 'off (bawaan model)'}\n` +
    `Fallback: ${chain.length} model (retry ${FALLBACK_RETRIES}x)\n` +
    (sess
      ? `Sesi chat: ${sess.id} (tetap — hanya ganti via /switch atau /newsess)`
      : 'Sesi chat: (belum ada / sesi baru)') +
    `\nCaveman: ${cavemanLevel || 'off'}\n` +
    `Thinking: ${showThinking ? 'ON (--thinking)' : 'OFF'}\n` +
    `Timeout: ${DEFAULT_TIMEOUT_SECONDS}s (chat) · ${COMMAND_TIMEOUT_SECONDS}s (/init, /review)\n` +
    `Authorized user: ${ctx.from.id}`
  );
});

bot.command(['newsess', 'newsession', 'new', 'clear'], (ctx) => {
  const had = chatSessions.delete(ctx.chat.id);
  if (had) persistSessions();
  log('/newsess from', ctx.from.id, had ? '(sesi aktif direset)' : '(tidak ada sesi aktif)');
  return ctx.reply(had ? '✅ Sesi chat ini direset. Pesan berikutnya mulai sesi OpenCode baru.'
                       : 'ℹ️ Belum ada sesi aktif untuk chat ini (pesanan berikutnya tetap sesi baru).');
});

bot.command('caveman', (ctx) => {
  const args = ctx.message.text.replace(/^\/caveman\s*/i, '').trim().toLowerCase();

  if (!args) {
    return ctx.reply(
      '🪨 Caveman mode\n' +
      `Current: ${cavemanLevel || 'off'}\n` +
      'Usage: /caveman <level>\n' +
      'Levels: off, lite, full, ultra, wenyan-lite, wenyan-full, wenyan-ultra'
    );
  }

  if (['off', 'stop', 'normal'].includes(args)) {
    cavemanLevel = null;
    log('Caveman mode off');
    return ctx.reply('✅ Caveman mode off. Normal replies.');
  }

  if (!CAVEMAN_LEVELS.has(args)) {
    return ctx.reply('⚠️ Unknown level. Use: off, lite, full, ultra, wenyan-lite, wenyan-full, wenyan-ultra');
  }

  cavemanLevel = args;
  log('Caveman level set to:', cavemanLevel);
  return ctx.reply(`✅ Caveman level set to: ${cavemanLevel}`);
});

bot.command('model', async (ctx) => {
  const args = cmdArgs(ctx, 'model');

  if (!args.length) {
    return ctx.reply(
      '⚙️ Model aktif: ' + (defaultModel || '(default config)') + '\n' +
      'Varian aktif: ' + (defaultVariant || 'off (bawaan model)') + '\n' +
      'Ganti: /model <provider/model>\n' +
      'Daftar: /models\n' +
      'Varian: /variant <nama> (contoh /variant high)\n' +
      'Kembalikan ke config awal: /model reset\n' +
      'Berlaku untuk pesan berikutnya — tanpa restart.'
    );
  }

  const res = await applyModel(args[0], ctx.chat.id);
  return ctx.reply(res.msg);
});

// Terapkan model — dipakai oleh /model (teks) dan tombol inline /models.
// return { ok, short (toast), msg (tampilan), variants (nama varian utk tombol) }
async function applyModel(nameRaw, chatId) {
  const name = String(nameRaw || '').trim();
  if (!name) return { ok: false, short: 'Nama model kosong', msg: '⚠️ Nama model kosong. Lihat /models.' };

  if (/^(reset|default|config|hapus|balikin)$/i.test(name)) {
    defaultModel = null;
    try {
      const cfg = readJsonFile(OC_CONFIG_PATH, {});
      delete cfg.model;
      writeJsonFile(OC_CONFIG_PATH, cfg, 0o644);
    } catch (e) {
      log('Gagal hapus model di config:', e.message);
    }
    log('Model direset ke default config');
    return { ok: true, short: 'Model direset', msg: '✅ Model dikembalikan ke default config OpenCode. Berlaku untuk pesan berikutnya, tanpa restart.' };
  }

  // Validasi ke daftar model supaya typo tidak bikin semua run berikutnya gagal
  let known = null;
  try {
    const out = await runCommandSync('opencode', ['models']);
    known = String(out.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    log('Validasi model gagal (dilewati):', e.message);
  }
  if (known && !known.includes(name)) {
    const near = known.filter((m) => m.includes(name) || name.includes(m)).slice(0, 5);
    return {
      ok: false,
      short: 'Model tidak dikenal',
      msg: '⚠️ Model "' + name + '" tidak ada di daftar.' +
        (near.length ? '\nMungkin maksud kamu:\n' + near.join('\n') : '') +
        '\n\nLihat semua: /models',
    };
  }

  defaultModel = name;
  try {
    const cfg = readJsonFile(OC_CONFIG_PATH, {});
    cfg.model = name;
    writeJsonFile(OC_CONFIG_PATH, cfg, 0o644);
  } catch (e) {
    log('Gagal simpan model ke config:', e.message);
    return { ok: false, short: 'Gagal simpan ke config', msg: '⚠️ Model dipakai bot sekarang, tapi gagal disimpan ke config: ' + String(e.message).slice(0, 300) };
  }
  log('Model set to:', defaultModel, '(disimpan permanen di opencode.json)');

  // Varian model yang tersedia (mis. low/medium/high/xhigh/max) → ditawarkan sebagai tombol
  let variants = [];
  if (chatId) { try { variants = await variantNamesFor(chatId, defaultModel); } catch (e) { log('Varian tak terbaca:', e.message); } }

  return {
    ok: true,
    short: 'Model: ' + defaultModel,
    variants,
    msg: '✅ Model: ' + defaultModel + '\nTersimpan permanen di opencode.json — berlaku untuk pesan berikutnya, tanpa restart.' +
      (variants.length
        ? '\n\nVarian (' + variants.join(', ') + ') — ketuk di bawah atau /variant <nama>'
        : '\n\nModel ini tidak punya varian terdaftar (/variant info).') +
      '\nCek: /status · Ganti lewat: /models',
  };
}

// Simpan/hapus varian terpilih di state bot (bukan config OpenCode — di sana varian
// dikonfigurasi per model, bukan sebagai pilihan global).
function saveVariant(name) {
  try {
    const st = readJsonFile(BOT_STATE_PATH, {});
    if (name) st.variant = name; else delete st.variant;
    writeJsonFile(BOT_STATE_PATH, st, 0o600);
    return null;
  } catch (e) { return e.message; }
}

// Terapkan varian — dipakai /variant (teks) dan tombol inline (var:).
// return { ok, short (toast), msg (tampilan) }
async function applyVariant(nameRaw, chatId) {
  const raw = String(nameRaw || '').trim();
  if (!raw) return { ok: false, short: 'Nama varian kosong', msg: '⚠️ Nama varian kosong. Lihat /variant.' };

  if (/^(off|reset|hapus|default|none|clear|tanpa|matikan)$/i.test(raw)) {
    defaultVariant = null;
    const err = saveVariant(null);
    log('Varian dimatikan' + (err ? ' (gagal simpan: ' + err + ')' : ''));
    return {
      ok: true,
      short: 'Varian: off',
      msg: '✅ Varian dimatikan — memakai pengaturan bawaan model.' +
        (err ? '\n⚠️ Tapi gagal disimpan permanen: ' + err : ''),
    };
  }

  const name = raw.toLowerCase();
  let avail = [];
  if (chatId) { try { avail = await variantNamesFor(chatId, defaultModel); } catch (e) { log('Varian tak terbaca:', e.message); } }
  if (avail.length && !avail.includes(name)) {
    return {
      ok: false,
      short: 'Varian tidak dikenal',
      msg: '⚠️ Varian "' + name + '" tidak ada untuk model ' + (defaultModel || '(default config)') +
        '.\nVarian tersedia: ' + avail.join(', ') + '\nContoh: /variant ' + avail[0],
    };
  }

  defaultVariant = name;
  const err = saveVariant(name);
  log('Varian set to:', name, err ? '(gagal simpan: ' + err + ')' : '(permanen di state bot)');
  return {
    ok: true,
    short: 'Varian: ' + name,
    msg: '✅ Varian: ' + name + '  (opencode run --variant ' + name + ')\n' +
      'Berlaku untuk pesan berikutnya — tanpa restart.' +
      (err ? '\n⚠️ Tapi gagal disimpan permanen: ' + err : '\nCek: /status · Matikan: /variant off'),
  };
}

bot.command('variant', async (ctx) => {
  const args = cmdArgs(ctx, 'variant');

  if (!args.length) {
    let avail = [];
    try { avail = await variantNamesFor(ctx.chat.id, defaultModel); } catch (_) {}
    return ctx.reply(
      '🧩 Varian model — setara flag --variant di opencode CLI (reasoning effort)\n' +
      'Aktif: ' + (defaultVariant || 'off (bawaan model)') + '\n' +
      'Model: ' + (defaultModel || '(default config)') + '\n' +
      (avail.length
        ? 'Varian tersedia: ' + avail.join(', ') + '\n\nPakai: /variant <nama>  ·  Matikan: /variant off'
        : 'Varian model ini tidak terdaftar (atau model tidak punya varian).\n\nPakai: /variant <nama> · Matikan: /variant off') +
      '\nCara lain: /models → ketuk model → pilih varian tombol'
    );
  }

  const res = await applyVariant(args[0], ctx.chat.id);
  return ctx.reply(res.msg);
});

bot.command('models', async (ctx) => {
  try {
    const { text, keyboard } = await buildModelsPage(ctx.chat.id, 1);
    return ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
  } catch (err) {
    return ctx.reply('❌ Failed to fetch models: ' + String(err.message).slice(0, 500));
  }
});

bot.command('cooldown', (ctx) => {
  return ctx.reply('ℹ️ Fitur cooldown sudah dihapus. Bot langsung membalas setiap pesan.');
});

// --- Perintah setara slash OpenCode (headless) ---
// Jalankan tugas lewat antrean per chat supaya tidak tabrakan dengan pesan biasa.
// Penting: promise-nya TIDAK dikembalikan ke Telegraf. Handler Telegraf punya batas
// handlerTimeout (90 dtk default) — kalau dijawab dengan promise run 120 dtk, Telegraf
// melempar TimeoutError dan bot menampilkan "⚠️ Internal bot error." padahal run sehat dan
// tetap jalan. Antrean + error tetap ditangani di dalam sini.
function enqueueOpencode(ctx, work) {
  const chatId = ctx.chat.id;
  const ahead = chatPending.get(chatId) || 0;
  chatPending.set(chatId, ahead + 1);
  if (ahead > 0) {
    ctx.reply(`⏳ Diterima. Menunggu ${ahead} tugas sebelumnya selesai...`).catch(() => {});
  }
  enqueueForChat(chatId, work)
    .catch((err) => {
      log('Bot error:', err);
      ctx.reply('❌ Bot error: ' + String(err.message).slice(0, 1000)).catch(() => {});
    })
    .finally(() => {
      const left = (chatPending.get(chatId) || 1) - 1;
      if (left <= 0) chatPending.delete(chatId);
      else chatPending.set(chatId, left);
    });
  return Promise.resolve();
}

// /init — agent membuat/memperbarui AGENTS.md (satu-satunya slash OpenCode yang jalan headless selain /review)
bot.command('init', (ctx) => {
  log('/init from', ctx.from.id);
  return enqueueOpencode(ctx, () =>
    runOpencode(ctx, cmdArgs(ctx, 'init').join(' '), { command: 'init', timeoutSeconds: COMMAND_TIMEOUT_SECONDS })
  );
});

// /review — agent mereview perubahan git (butuh repo git di WORKDIR)
bot.command('review', (ctx) => {
  log('/review from', ctx.from.id, ':', cmdArgs(ctx, 'review').join(' ') || '(default)');
  return enqueueOpencode(ctx, () =>
    runOpencode(ctx, cmdArgs(ctx, 'review').join(' '), { command: 'review', timeoutSeconds: COMMAND_TIMEOUT_SECONDS })
  );
});

// /export — ekspor sesi chat ini ke JSON lalu kirim sebagai dokumen
bot.command('export', async (ctx) => {
  const sess = getStoredSession(ctx.chat.id);
  if (!sess) return ctx.reply('ℹ️ Belum ada sesi aktif di chat ini. Kirim pesan dulu, lalu ulangi /export.');
  log('/export from', ctx.from.id, 'sesi', sess.id);
  try {
    const res = await runCommandSync('opencode', ['export', sess.id]);
    let out = String(res.stdout || '');
    const brace = out.indexOf('{');
    if (brace > 0) out = out.slice(brace); // buang baris log "Exporting session: ..."
    if (!out.trim()) return ctx.reply('❌ Export menghasilkan file kosong.');
    const file = path.join(os.tmpdir(), 'opencode-' + sess.id + '.json');
    fs.writeFileSync(file, out);
    await ctx.replyWithDocument(
      { source: file, filename: 'opencode-session-' + sess.id + '.json' },
      { caption: '📦 Ekspor sesi ' + sess.id }
    );
    fs.unlink(file, () => {});
  } catch (e) {
    return ctx.reply('❌ Export gagal: ' + String(e.message).slice(0, 400));
  }
});

// Daftar sesi terakhir per chat → dipakai /switch <nomor>
const chatSessionLists = new Map();

async function fetchSessionRows() {
  try {
    const res = await runCommandSync('opencode', ['session', 'list']);
    const rows = [];
    for (const line of String(res.stdout || '').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('─') || /^Session ID\b/.test(t)) continue;
      const cols = t.split(/\s{2,}/);
      if (cols.length >= 2 && /^ses_/.test(cols[0])) rows.push({ id: cols[0], title: cols[1] || '', updated: cols[2] || '' });
      if (rows.length >= 25) break;
    }
    return rows;
  } catch (e) {
    log('session list gagal:', e.message);
    return null;
  }
}

// ================= Pagination untuk semua daftar =================
// Model, sesi, provider, dan help dikirim berhalaman + tombol ◀️ ▶️.
const PAGE_SIZE = { models: 6, sessions: 8, providers: 4, help: 1 };
const MODELS_TTL_MS = 10 * 60 * 1000;
const SESSIONS_TTL_MS = 30 * 1000;
const modelsCache = new Map();   // chatId → { items, ts }
const sessionListTs = new Map(); // chatId → ts fetch terakhir

function clampPage(page, total) {
  const n = Number(page);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.round(n)), Math.max(1, total));
}

function pageRow(kind, page, total) {
  const row = [];
  if (page > 1) row.push({ text: '◀️ Sebelumnya', callback_data: `pg:${kind}:${page - 1}` });
  row.push({ text: `${page}/${total}`, callback_data: `pg:${kind}:${page}` });
  if (page < total) row.push({ text: '▶️ Berikutnya', callback_data: `pg:${kind}:${page + 1}` });
  return row;
}

// --- Model ---
// `opencode models --verbose` → tiap model berupa baris id diikuti blok JSON yang
// memuat "variants" (mis. {low, medium, high, xhigh, max}). Blok JSON dipisah dengan
// scanner tahan string/escape supaya kurung di dalam nilai string tidak salah hitung.
function scanJsonEnd(s, from) {
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function parseModelsVerbose(output) {
  const text = String(output || '');
  const items = [];
  const variants = new Map(); // id model → daftar nama varian
  const idRe = /^([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*)[ \t]*$/gim;
  let m;
  const marks = [];
  while ((m = idRe.exec(text))) marks.push({ id: m[1], start: idRe.lastIndex });

  for (const mk of marks) {
    if (items[items.length - 1] !== mk.id) items.push(mk.id);
    const brace = text.indexOf('{', mk.start);
    if (brace < 0) continue;
    const end = scanJsonEnd(text, brace);
    if (end < 0) continue;
    try {
      const d = JSON.parse(text.slice(brace, end + 1));
      const names = d && d.variants && typeof d.variants === 'object' ? Object.keys(d.variants) : [];
      if (names.length) variants.set(mk.id, names);
    } catch (_) {}
  }
  return { items, variants };
}

async function fetchModelsData(chatId) {
  const hit = modelsCache.get(chatId);
  if (hit && Date.now() - hit.ts < MODELS_TTL_MS && hit.variants) return hit;

  // Data model sama untuk semua chat → pinjam entri chat lain yang masih segar
  // (supaya chat kedua tidak membayar biaya spawn `models --verbose` lagi)
  const now = Date.now();
  for (const other of modelsCache.values()) {
    if (other && other.variants && now - other.ts < MODELS_TTL_MS) {
      modelsCache.set(chatId, other);
      return other;
    }
  }

  let items = [];
  let variants = new Map();
  try {
    const out = await runCommandSync('opencode', ['models', '--verbose'], 120000);
    const parsed = parseModelsVerbose(out.stdout);
    items = parsed.items;
    variants = parsed.variants;
  } catch (e) {
    log('opencode models --verbose gagal (fallback polos):', e.message);
  }
  if (!items.length) {
    const out = await runCommandSync('opencode', ['models']);
    items = String(out.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  }

  const data = { items, variants, ts: Date.now() };
  modelsCache.set(chatId, data);
  return data;
}

async function fetchModelsItems(chatId) {
  return (await fetchModelsData(chatId)).items;
}

// Nama varian untuk model tertentu; kalau model tidak diketahui → gabungan semua varian
async function variantNamesFor(chatId, modelId) {
  const data = await fetchModelsData(chatId);
  if (modelId && data.variants.has(modelId)) return data.variants.get(modelId);
  if (modelId) return [];
  const all = new Set();
  for (const list of data.variants.values()) for (const n of list) all.add(n);
  return Array.from(all);
}

async function buildModelsPage(chatId, page) {
  const items = await fetchModelsItems(chatId);
  const size = PAGE_SIZE.models;
  const total = Math.max(1, Math.ceil(items.length / size));
  const p = clampPage(page, total);
  const slice = items.slice((p - 1) * size, p * size);

  const keyboard = slice.map((m) => ([{
    text: (m === defaultModel ? '✓ ' : '') + m,
    callback_data: 'mdl:' + m,
  }]));
  if (total > 1) keyboard.push(pageRow('models', p, total));
  keyboard.push([{ text: '↩️ Kembali ke default config (/model reset)', callback_data: 'mdl:reset' }]);

  return {
    text:
      '📦 Model — ketuk untuk ganti (berlaku pesan berikutnya, tanpa restart)' +
      (total > 1 ? `\nHalaman ${p}/${total} · ` : '\n') +
      'Aktif: ' + (defaultModel || '(default config)') +
      ' · Varian: ' + (defaultVariant || 'off') +
      (items.length ? '' : '\n\n⚠️ Tidak ada model yang terbaca.'),
    keyboard,
  };
}

// --- Sesi ---
async function getSessionRowsFresh(chatId) {
  const cached = chatSessionLists.get(chatId) || null;
  const ts = sessionListTs.get(chatId) || 0;
  if (cached && cached.length && Date.now() - ts < SESSIONS_TTL_MS) return cached;
  const fetched = await fetchSessionRows();
  if (fetched) {
    chatSessionLists.set(chatId, fetched);
    sessionListTs.set(chatId, Date.now());
    return fetched;
  }
  return cached;
}

async function buildSessionsPage(chatId, page) {
  const rows = await getSessionRowsFresh(chatId);
  const sess = getStoredSession(chatId);
  const size = PAGE_SIZE.sessions;
  const list = rows || [];
  const total = Math.max(1, Math.ceil(list.length / size));
  const p = clampPage(page, total);
  const startNo = (p - 1) * size;
  const slice = list.slice(startNo, startNo + size);

  const keyboard = slice.map((r, i) => ([{
    text: `${startNo + i + 1}. ${truncate(r.title, 34)}${sess && r.id === sess.id ? ' ✓ aktif' : ''}`,
    callback_data: 'sw:' + r.id,
  }]));
  if (total > 1) keyboard.push(pageRow('sess', p, total));
  keyboard.push([{ text: '🆕 Mulai sesi baru', callback_data: 'sw:new' }]);

  const empty = !list.length;
  return {
    text:
      '🗂️ Sesi OpenCode — ketuk untuk pindah' +
      (total > 1 ? `\nHalaman ${p}/${total} · ` : '\n') +
      (sess ? `Aktif: ${sess.id}` : 'Aktif: — (belum ada)') +
      (empty ? '\n\n' + (rows === null ? '❌ gagal membaca daftar sesi' : 'Belum ada sesi tersimpan — kirim pesan biasa dulu.') : ''),
    keyboard,
  };
}

// --- Provider ---
function providerItems() {
  const auth = readJsonFile(OC_AUTH_PATH, {});
  const cfg = readJsonFile(OC_CONFIG_PATH, {});
  const custom = (cfg.provider && typeof cfg.provider === 'object') ? cfg.provider : {};
  const ids = new Set([...Object.keys(auth), ...Object.keys(custom)]);
  const items = [];
  for (const id of ids) {
    let line = '• ' + id + (hasOwn(auth, id) ? ' 🔑' : ' (tanpa key)');
    const c = hasOwn(custom, id) ? custom[id] : null;
    if (c) {
      const base = c.options && c.options.baseURL;
      const ms = c.models ? Object.keys(c.models) : [];
      if (base) line += '\n   ' + base;
      if (ms.length) line += '\n   model: ' + ms.map((m) => id + '/' + m).join(', ');
    }
    items.push(line);
  }
  return items;
}

function buildProvidersPage(page) {
  const items = providerItems();
  const size = PAGE_SIZE.providers;
  const total = Math.max(1, Math.ceil(items.length / size));
  const p = clampPage(page, total);
  const slice = items.slice((p - 1) * size, (p - 1) * size + size);

  const keyboard = [];
  if (total > 1) keyboard.push(pageRow('prov', p, total));

  const text = items.length
    ? '🔌 Provider terpasang' + (total > 1 ? ` (halaman ${p}/${total})` : '') +
      '\n\n' + slice.join('\n\n') +
      '\n\nPilih model: /model <provider>/<model>'
    : 'Belum ada provider atau key tersimpan. Pakai /addkey atau /addprovider.';
  return { text, keyboard };
}

// --- Help ---
const HELP_HEADER =
  '🤖 OpenCode Telegram Bot\n' +
  'Kirim pesan apa pun — dijalankan sebagai prompt OpenCode (bisa multi-langkah, pakai tool).';

function helpGroupText(g) {
  let out = g.title + '\n';
  for (const it of g.items) {
    const names = [it.cmd, ...(it.aliases || [])].map((n) => '/' + n).join(', ');
    out += '  ' + names + ' — ' + it.desc + '\n';
  }
  return out.trimEnd();
}

function buildHelpPage(page) {
  const total = HELP_GROUPS.length;
  if (Number(page) === 0) {
    // halaman 0 = seluruh bantuan dalam satu pesan (perilaku lama)
    return { text: helpText(), keyboard: [[{ text: '📖 Tampilkan per halaman', callback_data: 'pg:help:1' }]] };
  }
  const p = clampPage(page, total);
  const row = pageRow('help', p, total);
  row.push({ text: '📄 Tampilkan semua', callback_data: 'pg:help:0' });
  return {
    text: `${HELP_HEADER}\n\n📖 Halaman ${p}/${total}\n\n` + helpGroupText(HELP_GROUPS[p - 1]),
    keyboard: [row],
  };
}

// /sessions (+ alias /resume, /continue) — daftar sesi opencode (berhalaman)
bot.command(['sessions', 'resume', 'continue'], async (ctx) => {
  try {
    const { text, keyboard } = await buildSessionsPage(ctx.chat.id, 1);
    return ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
  } catch (e) {
    return ctx.reply('❌ Gagal membaca daftar sesi: ' + String(e.message).slice(0, 300));
  }
});

// /switch (+ /switch1 … /switch12) — pindah ke sesi opencode lain tanpa restart
const SWITCH_NUM_CMDS = Array.from({ length: 12 }, (_, i) => 'switch' + (i + 1));
bot.command(['switch', ...SWITCH_NUM_CMDS], async (ctx) => {
  const chatId = ctx.chat.id;
  const head = String((ctx.message && ctx.message.text) || '').trim().match(/^\/(\w+)/);
  const headName = head ? head[1].toLowerCase() : 'switch';
  const numArg = headName.match(/^switch(\d{1,2})$/);
  const arg = numArg ? numArg[1] : cmdArgs(ctx, 'switch')[0];

  if (!arg) {
    try {
      const { text, keyboard } = await buildSessionsPage(chatId, 1);
      return ctx.reply(text, { reply_markup: { inline_keyboard: keyboard } });
    } catch (e) {
      return ctx.reply('❌ Gagal membaca daftar sesi: ' + String(e.message).slice(0, 300));
    }
  }

  if (/^(new|baru|clear|reset|newsess)$/i.test(arg)) {
    const had = chatSessions.delete(chatId);
    if (had) persistSessions();
    log('/switch new oleh', ctx.from.id, had ? '(reset)' : '(tanpa sesi aktif)');
    return ctx.reply(had
      ? '✅ Sesi direset. Pesan berikutnya mulai sesi OpenCode baru.'
      : 'ℹ️ Belum ada sesi aktif — pesan berikutnya tetap sesi baru.');
  }

  let rows = await getSessionRowsFresh(chatId);

  let target = null;
  if (/^\d+$/.test(arg)) {
    const idx = Number(arg) - 1;
    if (!rows || idx < 0 || idx >= rows.length) {
      return ctx.reply('⚠️ Nomor tidak ada di daftar. Jalankan /sessions dulu, lalu /switch <nomor>.');
    }
    target = rows[idx].id;
  } else {
    const q = arg.trim();
    if (!/^ses_/i.test(q)) {
      return ctx.reply('⚠️ Format: /switch <nomor|sessionID|new>\nJalankan /sessions untuk daftar sesi.');
    }
    if (rows) {
      const hit = rows.find((r) => r.id === q) || rows.find((r) => r.id.startsWith(q));
      if (!hit) return ctx.reply('⚠️ Sesi "' + q + '" tidak ada di daftar terbaru. Jalankan /sessions dulu.');
      target = hit.id;
    } else {
      target = q; // tanpa daftar → biarkan OpenCode yang menilai (ada penanganan error sesi di run)
    }
  }

  chatSessions.set(chatId, { id: target, lastAt: Date.now(), turns: 0 });
  persistSessions();
  chatSessionLists.delete(chatId);
  log('/switch →', target, 'oleh', ctx.from.id);
  return ctx.reply(
    '✅ Sesi dipindah ke ' + target + '\n' +
    'Pesan berikutnya melanjutkan sesi itu. Cek: /status · Kembali: /switch new'
  );
});

// --- Tombol inline: ketuk sekali, tanpa mengetik ---
bot.action(/^sw:(ses_[A-Za-z0-9]+|new)$/, async (ctx) => {
  const target = ctx.match[1];
  const chatId = ctx.chat && ctx.chat.id;
  if (!chatId) {
    try { await ctx.answerCbQuery('⚠️ Chat tidak dikenal'); } catch (_) {}
    return;
  }

  let msg;
  if (target === 'new') {
    const had = chatSessions.delete(chatId);
    if (had) persistSessions();
    log('/switch new (tombol) oleh', ctx.from && ctx.from.id, had ? '(reset)' : '(tanpa sesi aktif)');
    msg = had
      ? '✅ Sesi direset — pesan berikutnya mulai sesi OpenCode baru.'
      : 'ℹ️ Belum ada sesi aktif — pesan berikutnya tetap sesi baru.';
  } else {
    chatSessions.set(chatId, { id: target, lastAt: Date.now(), turns: 0 });
    persistSessions();
    chatSessionLists.delete(chatId);
    log('/switch →', target, '(tombol) oleh', ctx.from && ctx.from.id);
    msg = '✅ Sesi dipindah ke ' + target +
      '\nPesan berikutnya melanjutkan sesi itu.\nCek: /status · Pindah lagi: /sessions';
  }

  try { await ctx.answerCbQuery('✅ OK'); } catch (_) {}
  try { await ctx.editMessageText(msg); } catch (e) { log('Edit pesan tombol sesi gagal:', e.message); }
});

bot.action(/^mdl:(.+)$/, async (ctx) => {
  const name = String(ctx.match[1] || '');
  const res = await applyModel(name, ctx.chat && ctx.chat.id);
  try { await ctx.answerCbQuery(res.ok ? '✅ ' + res.short : '⚠️ ' + res.short); } catch (_) {}
  if (res.ok) {
    // sukses → ganti isi pesan jadi konfirmasi; kalau model punya varian, tawarkan tombolnya
    const rows = [];
    if (Array.isArray(res.variants) && res.variants.length) {
      for (let i = 0; i < res.variants.length; i += 3) {
        rows.push(res.variants.slice(i, i + 3).map((v) => ({
          text: (v === defaultVariant ? '✓ ' : '') + v,
          callback_data: 'var:' + v,
        })));
      }
      rows.push([{ text: '🔕 Tanpa varian', callback_data: 'var:off' }]);
    }
    try {
      await ctx.editMessageText(res.msg, rows.length ? { reply_markup: { inline_keyboard: rows } } : undefined);
    } catch (e) { log('Edit pesan tombol model gagal:', e.message); }
  }
  // gagal → tombol dibiarkan supaya bisa langsung memilih lagi
});

bot.action('noop', async (ctx) => {
  try { await ctx.answerCbQuery('OK'); } catch (_) {}
});

bot.action(/^var:(.+)$/, async (ctx) => {
  const name = String(ctx.match[1] || '');
  const res = await applyVariant(name, ctx.chat && ctx.chat.id);
  try { await ctx.answerCbQuery(res.ok ? '✅ ' + res.short : '⚠️ ' + res.short); } catch (_) {}
  try {
    await ctx.editMessageText(res.msg, res.ok ? undefined : {
      reply_markup: { inline_keyboard: [[{ text: '↩️ Tutup', callback_data: 'noop' }]] },
    });
  } catch (e) { log('Edit pesan tombol varian gagal:', e.message); }
});

// Paginasi: ◀️ ▶️ untuk semua daftar (model, sesi, provider, help)
bot.action(/^pg:([a-z]+):(\d+)$/, async (ctx) => {
  const kind = ctx.match[1];
  const page = Number(ctx.match[2]);
  const chatId = ctx.chat && ctx.chat.id;
  if (!chatId) {
    try { await ctx.answerCbQuery('⚠️ Chat tidak dikenal'); } catch (_) {}
    return;
  }

  try {
    let built;
    if (kind === 'models') built = await buildModelsPage(chatId, page);
    else if (kind === 'sess') built = await buildSessionsPage(chatId, page);
    else if (kind === 'prov') built = buildProvidersPage(page);
    else if (kind === 'help') built = buildHelpPage(page);
    else {
      try { await ctx.answerCbQuery('⚠️ Jenis daftar tidak dikenal'); } catch (_) {}
      return;
    }

    try { await ctx.answerCbQuery(`📖 Halaman ${page}`); } catch (_) {}

    const prev = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.text;
    if (prev === built.text) return; // halaman sama → tidak perlu edit ulang
    await ctx.editMessageText(built.text, { reply_markup: { inline_keyboard: built.keyboard } });
  } catch (e) {
    log('Paginasi gagal:', kind, e.message);
    try { await ctx.answerCbQuery('⚠️ ' + String(e.message).slice(0, 80)); } catch (_) {}
  }
});

// /compact (+ alias /summarize) — kompaksi hanya ada di TUI
bot.command(['compact', 'summarize'], (ctx) => {
  const sess = getStoredSession(ctx.chat.id);
  return ctx.reply(
    '🗜️ /compact OpenCode hanya berjalan di TUI — server headless tidak menyediakannya.\n' +
    'Kompaksi konteks terjadi otomatis saat percakapan panjang.\n' +
    (sess ? `Sesi sekarang: ${sess.id} (tidak berganti otomatis)\n` : '') +
    'Untuk konteks bersih: /newsess'
  );
});

// /undo — pengembalian file via git, hanya di TUI
bot.command('undo', (ctx) =>
  ctx.reply(
    '↩️ /undo OpenCode hanya tersedia di TUI (dikelola lewat git, butuh repo git).\n' +
    'Alternatif di bot: kirim pesan "batalkan perubahan terakhir" — agent akan mengembalikan filenya.'
  )
);

// /redo — pasangan /undo
bot.command('redo', (ctx) =>
  ctx.reply(
    '↪️ /redo OpenCode hanya tersedia di TUI (dikelola lewat git, butuh repo git).\n' +
    'Alternatif di bot: kirim pesan "ulangi perubahan yang tadi dibatalkan".'
  )
);

// /themes — tema TUI
bot.command('themes', (ctx) =>
  ctx.reply(
    '🎨 /themes mengatur tampilan TUI, tidak berpengaruh ke balasan bot.\n' +
    'Tema TUI diatur lewat tui.json — lihat https://opencode.ai/docs/themes'
  )
);

// /details — selalu tampil di bot
bot.command('details', (ctx) =>
  ctx.reply(
    '🔍 /details menampilkan/menyembunyikan detail tool di TUI.\n' +
    'Di bot ini detail tool (write/edit/bash) selalu tampil di pesan progres.'
  )
);

// /thinking [on|off] — benar-benar menyalakan flag --thinking pada opencode run
bot.command('thinking', (ctx) => {
  const args = cmdArgs(ctx, 'thinking').join(' ').toLowerCase();
  if (['on', '1', 'true', 'yes'].includes(args)) showThinking = true;
  else if (['off', '0', 'false', 'no'].includes(args)) showThinking = false;
  log('/thinking →', showThinking ? 'on' : 'off', 'oleh', ctx.from.id);
  return ctx.reply(
    '🧠 Blok pemikiran (thinking): ' + (showThinking ? 'ON' : 'OFF') + '\n' +
    (showThinking
      ? 'Pesan berikutnya ikut flag --thinking (lebih lama, lebih banyak token).'
      : 'Pesan berikutnya tanpa flag --thinking. Nyalakan: /thinking on')
  );
});

// /editor — butuh $EDITOR interaktif, tidak ada di bot
bot.command('editor', (ctx) =>
  ctx.reply(
    '✏️ /editor membuka $EDITOR di TUI — tidak berlaku di bot.\n' +
    'Tulis langsung di chat, atau edit file lewat pesan ke agent (mis. "ubah baris 12 di file X").'
  )
);

// /connect — padanan bot: /addkey, /addprovider, /providers
bot.command('connect', (ctx) =>
  ctx.reply(
    '🔌 /connect di OpenCode membuka dialog pemilihan provider.\n' +
    'Di bot ini padanannya:\n' +
    '/providers — daftar provider & key\n' +
    '/addkey <provider> <key>\n' +
    '/addprovider <id> <url> <key> <models>\n' +
    '/removeprovider <id>'
  )
);

// /update [run] — cek versi, dan dengan argumen "run" benar-benar upgrade
bot.command('update', async (ctx) => {
  const args = cmdArgs(ctx, 'update');
  try {
    const ver = (await runCommandSync('opencode', ['--version'])).stdout.trim();
    if (args[0] && /^(run|yes|install|upgrade)$/i.test(args[0])) {
      await ctx.reply(`⬆️ Menjalankan opencode upgrade (sekarang ${ver})...`);
      log('/update run oleh', ctx.from.id);
      const res = await runCommandSync('opencode', ['upgrade'], 300000);
      return ctx.reply('✅ Upgrade selesai.\n' + truncate((res.stdout || '') + (res.stderr || ''), 800));
    }
    return ctx.reply(
      `ℹ️ Versi opencode di VPS: ${ver}\n` +
      'Upgrade ke versi terbaru: /update run\n' +
      '(atau manual di VPS: opencode upgrade)'
    );
  } catch (e) {
    return ctx.reply('❌ Update gagal: ' + String(e.message).slice(0, 400));
  }
});

// /exit (+ alias /quit, /q) — bot tidak pernah keluar
bot.command(['exit', 'quit', 'q'], (ctx) =>
  ctx.reply(
    '🚪 /exit menutup TUI OpenCode. Bot ini tidak keluar — jalan terus lewat systemd.\n' +
    'Untuk membersihkan konteks chat: /new (alias /clear)'
  )
);

// --- Incoming formatting (bold / italic / underline) ---
const ENTITY_MARKERS = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  underline: { open: '__', close: '__' },
  strikethrough: { open: '~~', close: '~~' },
  spoiler: { open: '||', close: '||' },
  code: { open: '`', close: '`' },
  pre: { open: '\n```\n', close: '\n```\n' },
};

function formatIncoming(message) {
  const text = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  if (!text || !entities.length) return text;

  const events = [];
  for (const entity of entities) {
    const marker = ENTITY_MARKERS[entity.type];
    if (!marker) continue;
    const start = entity.offset;
    const end = entity.offset + entity.length;
    if (start < 0 || end > text.length) continue;
    events.push({ pos: start, kind: 1, marker: marker.open });
    events.push({ pos: end, kind: 0, marker: marker.close });
  }
  if (!events.length) return text;

  events.sort((a, b) => a.pos - b.pos || a.kind - b.kind);

  let out = '';
  let last = 0;
  for (const ev of events) {
    if (ev.pos > last) {
      out += text.slice(last, ev.pos);
      last = ev.pos;
    }
    out += ev.marker;
  }
  return out + text.slice(last);
}

// --- Per-chat FIFO queue ---
// Messages arriving while a run is active are queued and answered in order.
const chatQueues = new Map();
const chatPending = new Map();

function enqueueForChat(chatId, task) {
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(task, task);
  const tracked = next.catch(() => {}).finally(() => {
    if (chatQueues.get(chatId) === tracked) chatQueues.delete(chatId);
  });
  chatQueues.set(chatId, tracked);
  return next;
}

// --- Direct message handler ---
// [patch] provider-commands: /addkey /addprovider /providers /removeprovider
const OC_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
const OC_AUTH_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
const API_KEY_RE = /^\S{8,512}$/;

function readJsonFile(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    throw new Error('Tidak bisa membaca ' + path.basename(file));
  }
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error(path.basename(file) + ' bukan JSON valid (tidak diubah)');
  }
}

function writeJsonFile(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, file + '.bak');
      fs.chmodSync(file + '.bak', mode);
    } catch (_) {}
  }
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch (_) {}
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Hapus pesan pengguna yang berisi API key dari chat
function scrubMessage(ctx) {
  try { ctx.deleteMessage().catch(() => {}); } catch (_) {}
}

function cmdArgs(ctx, name) {
  const re = new RegExp('^/' + name + '(@\\w+)?\\s*', 'i');
  return ctx.message.text.replace(re, '').trim().split(/\s+/).filter(Boolean);
}

bot.command('addkey', async (ctx) => {
  modelsCache.clear(); // key berubah → daftar model ikut basi
  const args = cmdArgs(ctx, 'addkey');
  if (args.length === 0) {
    return ctx.reply(
      '🔑 Simpan API key provider bawaan OpenCode\n' +
      'Format: /addkey <provider> <api_key>\n' +
      'Contoh: /addkey openrouter sk-or-xxxxxxxx\n' +
      'Provider umum: anthropic, openai, google, openrouter, groq, deepseek, xai, mistral\n' +
      'Pesan yang berisi key akan dihapus otomatis dari chat.'
    );
  }
  scrubMessage(ctx);
  if (args.length !== 2) {
    return ctx.reply('⚠️ Format: /addkey <provider> <api_key>');
  }
  const id = args[0].toLowerCase();
  const key = args[1];
  if (!PROVIDER_ID_RE.test(id)) {
    return ctx.reply('⚠️ Nama provider tidak valid. Pakai huruf kecil, angka, titik, strip, atau garis bawah.');
  }
  if (!API_KEY_RE.test(key)) {
    return ctx.reply('⚠️ API key tidak valid (8-512 karakter, tanpa spasi).');
  }
  try {
    const auth = readJsonFile(OC_AUTH_PATH, {});
    auth[id] = { type: 'api', key };
    writeJsonFile(OC_AUTH_PATH, auth, 0o600);
  } catch (e) {
    return ctx.reply('❌ Gagal menyimpan key: ' + e.message);
  }
  log('API key saved for provider:', id);
  let hint = '';
  try {
    const out = await runCommandSync('opencode', ['models', id]);
    const lines = String(out.stdout || '').trim().split('\n').filter(Boolean).slice(0, 12);
    if (lines.length) hint = '\n\nModel tersedia:\n' + lines.join('\n');
  } catch (_) {}
  return ctx.reply(
    '✅ API key untuk "' + id + '" tersimpan. Pesan Anda yang berisi key sudah dihapus.' +
    hint +
    '\n\nPilih model: /model ' + id + '/<nama-model>'
  );
});

bot.command('addprovider', async (ctx) => {
  modelsCache.clear(); // provider berubah → daftar model ikut basi
  const args = cmdArgs(ctx, 'addprovider');
  if (args.length === 0) {
    return ctx.reply(
      '🔌 Tambah provider eksternal (kompatibel OpenAI)\n' +
      'Format: /addprovider <id> <base_url> <api_key> <model1,model2>\n' +
      'Contoh: /addprovider mygateway https://api.example.com/v1 sk-xxxxxxxx gpt-4o,llama-3.1-70b\n' +
      'Pesan yang berisi key akan dihapus otomatis dari chat.'
    );
  }
  scrubMessage(ctx);
  if (args.length < 4) {
    return ctx.reply('⚠️ Format: /addprovider <id> <base_url> <api_key> <model1,model2>');
  }
  const id = args[0].toLowerCase();
  const baseRaw = args[1];
  const key = args[2];
  const models = args.slice(3).join(',').split(',').map((s) => s.trim()).filter(Boolean);

  if (!PROVIDER_ID_RE.test(id)) {
    return ctx.reply('⚠️ ID provider tidak valid. Pakai huruf kecil, angka, titik, strip, atau garis bawah.');
  }
  let baseURL;
  try {
    const u = new URL(baseRaw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
    baseURL = baseRaw.replace(/\/+$/, '');
  } catch (_) {
    return ctx.reply('⚠️ Base URL tidak valid. Contoh: https://api.example.com/v1');
  }
  if (!API_KEY_RE.test(key)) {
    return ctx.reply('⚠️ API key tidak valid (8-512 karakter, tanpa spasi).');
  }
  if (models.length === 0 || models.length > 30 || !models.every((m) => MODEL_ID_RE.test(m))) {
    return ctx.reply('⚠️ Daftar model tidak valid. Pisahkan dengan koma, maksimal 30 model.');
  }

  try {
    const auth = readJsonFile(OC_AUTH_PATH, {});
    const cfg = readJsonFile(OC_CONFIG_PATH, {});
    if (!cfg.$schema) cfg.$schema = 'https://opencode.ai/config.json';
    if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {};
    const modelsObj = {};
    for (const m of models) modelsObj[m] = { name: m };
    cfg.provider[id] = {
      npm: '@ai-sdk/openai-compatible',
      name: id,
      options: { baseURL },
      models: modelsObj,
    };
    auth[id] = { type: 'api', key };
    writeJsonFile(OC_AUTH_PATH, auth, 0o600);
    writeJsonFile(OC_CONFIG_PATH, cfg, 0o644);
  } catch (e) {
    return ctx.reply('❌ Gagal menyimpan provider: ' + e.message);
  }
  log('Custom provider saved:', id, baseURL);
  return ctx.reply(
    '✅ Provider "' + id + '" ditambahkan. Pesan Anda yang berisi key sudah dihapus.\n' +
    'Base URL: ' + baseURL + '\n' +
    'Model: ' + models.map((m) => id + '/' + m).join(', ') + '\n\n' +
    'Pakai dengan: /model ' + id + '/' + models[0]
  );
});

bot.command('providers', (ctx) => {
  try {
    const { text, keyboard } = buildProvidersPage(1);
    return ctx.reply(text, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {});
  } catch (e) {
    return ctx.reply('❌ ' + e.message);
  }
});

bot.command('removeprovider', (ctx) => {
  modelsCache.clear(); // provider berubah → daftar model ikut basi
  const args = cmdArgs(ctx, 'removeprovider');
  if (args.length !== 1) {
    return ctx.reply('Format: /removeprovider <id>\nLihat daftar dengan /providers');
  }
  const id = args[0].toLowerCase();
  if (!PROVIDER_ID_RE.test(id)) {
    return ctx.reply('⚠️ ID provider tidak valid.');
  }
  try {
    const auth = readJsonFile(OC_AUTH_PATH, {});
    const cfg = readJsonFile(OC_CONFIG_PATH, {});
    let removed = false;
    if (hasOwn(auth, id)) {
      delete auth[id];
      writeJsonFile(OC_AUTH_PATH, auth, 0o600);
      removed = true;
    }
    if (cfg.provider && typeof cfg.provider === 'object' && hasOwn(cfg.provider, id)) {
      delete cfg.provider[id];
      if (Object.keys(cfg.provider).length === 0) delete cfg.provider;
      writeJsonFile(OC_CONFIG_PATH, cfg, 0o644);
      removed = true;
    }
    if (!removed) return ctx.reply('Provider "' + id + '" tidak ditemukan. Cek dengan /providers');
    let note = '';
    if (defaultModel && defaultModel.startsWith(id + '/')) {
      defaultModel = null;
      note = '\nModel aktif direset ke default.';
    }
    log('Provider removed:', id);
    return ctx.reply('🗑️ Provider "' + id + '" dihapus.' + note);
  } catch (e) {
    return ctx.reply('❌ ' + e.message);
  }
});

// ============ Jembatan terminal interaktif untuk SEMUA CLI yang butuh auth ============
// Perintah dijalankan di tmux (PTY penuh → TUI/prompt CLI berjalan normal), layarnya
// diteruskan ke chat, dan balasan Anda dikirim balik ke terminal. Alur login berbasis
// browser (gh, npm, vercel, gcloud, …) selesai dari Telegram: bot menunggu sampai CLI
// sendiri melaporkan login berhasil.
const TERM_POLL_MS = 1200;
const TERM_TIMEOUT_SECONDS = Number(process.env.TERM_TIMEOUT_SECONDS) > 0
  ? Number(process.env.TERM_TIMEOUT_SECONDS) : 600;
const termSessions = new Map(); // chatId → { key, cmd, script, startedAt, prevLines, … }

// Perintah autentikasi per CLI (yang umum). CLI lain otomatis: `<tool> auth login`
// kalau ada subcommand auth, selain itu `<tool> login`.
const AUTH_COMMANDS = {
  gh: 'gh auth login --hostname github.com --git-protocol https --web',
  github: 'gh auth login --hostname github.com --git-protocol https --web',
  npm: 'npm login',
  pnpm: 'pnpm login',
  yarn: 'yarn login',
  docker: 'docker login',
  vercel: 'vercel login',
  netlify: 'netlify login',
  fly: 'flyctl auth login',
  flyctl: 'flyctl auth login',
  supabase: 'supabase login',
  railway: 'railway login',
  wrangler: 'wrangler login --browser=false', // tanpa xdg-open (VPS headless) → tidak crash, URL dicetak & menunggu
  hf: 'hf auth login',
  huggingface: 'huggingface-cli login',
  gcloud: 'gcloud auth login --no-launch-browser',
  aws: 'aws configure sso --no-browser',
  stripe: 'stripe login',
  turso: 'turso auth login',
  render: 'render login',
  doctl: 'doctl auth init',
  kubectl: 'kubectl config set-credentials',
};
const AUTH_INTENT_RE = /\b(?:login|log\s*in|masuk(?:kan)?\s+akun|autentikasi|auth(?:enticate|oriz)?|sign[\s-]?in)\b/i;
// Pertanyaan/keluhan → jangan diambil alih, biarkan model yang menjawab
const NOT_AUTH_REQUEST_RE = /\?|\b(?:kenapa|kenapa|gagal|error|failed|failure|bug|masalah|salah|tidak|tak|bukan|kok|udah|sudah|tolong\s+perbaiki|fix)\b/i;
const AUTH_STOPWORDS = new Set(['di', 'ke', 'yang', 'saya', 'aku', 'ini', 'itu', 'saja', 'dan', 'atau', 'dengan', 'pakai', 'guna', 'untuk', 'lah', 'kah', 'login', 'auth']);
const AUTO_ENTER_RE = /^\s*(?:press|tekan)\s+(?:enter|enter\s*\/\s*return|the\s+enter|enter\s+key)/i;
// Boilerplate alur login (instruksi press-enter, buka-browser, clipboard, jawaban select
// CLI) disembunyikan SETELAH callout terkirim — info pentingnya sudah ada di callout,
// sehingga satu login tidak membanjiri chat jadi banyak balon.
const AUTH_NOISE_RE = new RegExp([
  '^\\?\\s+.*\\s+(?:yes|no)\\s*$',          // jawaban select CLI (mis. gh) — redundan
  'failed to copy one-time code',
  'no clipboard utilities',
  'first copy your one-time code',
  'press enter',                             // instruksi → sudah di-Enter otomatis
  'opening\\s+https?://',
  'browser has been opened',
  'failed opening a web browser',
  'executable file not found in \\$path',     // error xdg-open di VPS tanpa GUI
  'please try entering the url',
  'enter the code displayed',
  'oauth login page will always redirect',    // sudah dijelaskan di callout (hint tunnel)
].join('|'), 'i');
// Template perintah tunnel SSH (diisi via .env). Dipakai saat callback login mengarah ke
// localhost — browser user menembak mesin USER, bukan VPS, jadi portnya harus ditunnel.
const VPS_SSH_HINT = process.env.VPS_SSH_HINT || 'ssh -L {port}:localhost:{port} <vps> -N';

function termActive(chatId) {
  const s = termSessions.get(chatId);
  return !!(s && !s.exited);
}

// --- VPS headless: hampir semua `*_login` CLI mencoba membuka browser (xdg-open dkk).
// Di server tanpa GUI file itu tidak ada → CLI crash di tengah login (mis. wrangler exit 1
// dalam 5 detik) dan sesi mati sebelum user sempat membuka URL. Stub ini membuat semua
// pembuka browser yang dicari CLI "berhasil" (exit 0) tanpa membuka apa pun — URL-nya
// sendiri sudah dicetak CLI dan diteruskan bot ke chat. Berlaku untuk semua CLI apps,
// bukan satu perintah tertentu.
const HEADLESS_OPENERS = ['xdg-open', 'x-www-browser', 'www-browser', 'wslview', 'sensible-browser'];
const HEADLESS_STUB = '#!/bin/sh\n' +
  '# Stub pembuka browser untuk VPS headless (dibuat otomatis oleh bot).\n' +
  '# Tidak ada browser di server; exit 0 supaya CLI login tidak crash.\n' +
  'exit 0\n';
function ensureHeadlessOpener() {
  try {
    const dir = path.join(os.homedir(), '.local', 'bin');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    for (const name of HEADLESS_OPENERS) {
      const f = path.join(dir, name);
      let stale = false;
      try { stale = fs.readFileSync(f, 'utf8') !== HEADLESS_STUB; } catch (_) { stale = true; }
      if (stale) fs.writeFileSync(f, HEADLESS_STUB, { mode: 0o755 });
    }
    return dir;
  } catch (e) {
    log('Gagal memasang stub pembuka browser:', e.message);
    return null;
  }
}
const HEADLESS_OPENER_DIR = ensureHeadlessOpener();
if (HEADLESS_OPENER_DIR && !String(process.env.PATH || '').split(':').includes(HEADLESS_OPENER_DIR)) {
  process.env.PATH = HEADLESS_OPENER_DIR + ':' + process.env.PATH; // anak proses (opencode, tmux) ikut dapat stub
}

async function safeSend(chatId, text) {
  if (!text || !String(text).trim()) return;
  try { await bot.telegram.sendMessage(chatId, String(text)); }
  catch (e) { log('Kirim output terminal gagal:', e.message); }
}

function cleanBatch(lines) {
  let out = lines;
  if (out.length > 40) out = ['… (' + (lines.length - 40) + ' baris sebelumnya dipangkas)'].concat(out.slice(-40));
  let text = out.join('\n');
  if (text.length > 3900) text = '…\n' + text.slice(-3900);
  return text;
}

async function whichTool(name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name)) return false;
  try {
    await runCommandSync('sh', ['-lc', 'command -v ' + JSON.stringify(name) + ' >/dev/null 2>&1'], 15000);
    return true;
  } catch (_) { return false; }
}

async function resolveAuthCommand(tool, preferred) {
  if (!(await whichTool(tool))) return null;
  if (preferred) return preferred;
  try {
    await runCommandSync(tool, ['auth', '--help'], 15000);
    return tool + ' auth login';
  } catch (_) {}
  return tool + ' login';
}

// Deteksi permintaan login dari bahasa sehari-hari: "login gh cli", "auth npm", …
function detectAuthRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 100 || !AUTH_INTENT_RE.test(t) || NOT_AUTH_REQUEST_RE.test(t)) return null;
  const low = t.toLowerCase();
  for (const key of Object.keys(AUTH_COMMANDS)) {
    if (new RegExp('\\b' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(t)) {
      return { tool: key, cmd: AUTH_COMMANDS[key] };
    }
  }
  const m = low.match(/\b(?:login|auth(?:enticate)?|masuk)\s+(?:ke\s+|dengan\s+|pakai\s+|guna(?:kan)?\s+)?([a-z0-9][a-z0-9._-]{1,31})\b/);
  if (m && !AUTH_STOPWORDS.has(m[1])) return { tool: m[1], cmd: null };
  return null;
}

async function startTerm(chatId, cmd) {
  await stopTerm(chatId, null); // tutup sesi lama tanpa pesan
  const key = 'octerm-' + chatId;
  const script = path.join(os.tmpdir(), 'octerm-' + chatId + '.sh');
  const body =
    '#!/bin/bash\n' +
    'export PATH="$HOME/.local/bin:$HOME/.nodejs/bin:$HOME/.bun/bin:$HOME/.opencode/bin:/usr/local/bin:/usr/bin:/bin"\n' +
    'export BROWSER="$HOME/.local/bin/xdg-open"\n' + // CLI yang membaca $BROWSER pakai stub (lihat ensureHeadlessOpener)
    'export NO_COLOR=1\n' +
    'set +e\n' +
    cmd + '\n' +
    'rc=$?\n' +
    'echo\n' +
    'echo __OCTERM_EXIT=$rc\n' +
    'sleep 7200\n';
  fs.writeFileSync(script, body, { mode: 0o700 });
  await runCommandSync('tmux', ['kill-session', '-t', key], 10000).catch(() => {});
  await runCommandSync('tmux', ['new-session', '-d', '-s', key, '-x', '120', '-y', '32', 'bash ' + JSON.stringify(script)], 20000);

  termSessions.set(chatId, {
    key, cmd, script,
    startedAt: Date.now(),
    prevLines: [],
    lastCode: null, lastUrl: null, callout: null,
    autoEntered: new Set(), autoEnterCount: 0,
    timer: null, exited: false, polling: false,
  });
  const s = termSessions.get(chatId);
  s.timer = setInterval(() => {
    pollTerm(chatId).catch((e) => log('poll terminal gagal:', e.message));
  }, TERM_POLL_MS);
  lastAuthCmd.set(chatId, { cmd, at: Date.now() }); // dipakai handleCallbackPaste untuk auto-ulang
  log('Terminal dimulai [' + key + ']:', truncate(cmd, 140));
}

async function stopTerm(chatId, notice) {
  const s = termSessions.get(chatId);
  if (!s) return false;
  if (s.timer) clearInterval(s.timer);
  s.exited = true;
  termSessions.delete(chatId);
  try { await runCommandSync('tmux', ['kill-session', '-t', s.key], 10000).catch(() => {}); } catch (_) {}
  try { fs.unlinkSync(s.script); } catch (_) {}
  log('Terminal ditutup [' + s.key + ']');
  if (notice) await safeSend(chatId, notice);
  return true;
}

// Pesan chat → input ke terminal (Selama sesi berjalan, chat = terminal)
async function feedTermInput(ctx) {
  const s = termSessions.get(ctx.chat.id);
  if (!s || s.exited) return false;
  const text = String((ctx.message && (ctx.message.text || ctx.message.caption)) || '');
  if (!text.trim()) return false;
  try {
    await runCommandSync('tmux', ['send-keys', '-t', s.key, '-l', '--', text], 10000);
    await runCommandSync('tmux', ['send-keys', '-t', s.key, 'Enter'], 10000);
    log('Terminal ←', truncate(text, 80));
  } catch (e) {
    log('Terminal input gagal:', e.message);
    await safeSend(ctx.chat.id, '⚠️ Gagal mengirim input ke terminal: ' + truncate(e.message, 150));
  }
  return true;
}

// Catatan alternatif di callout (bukan cuma tunnel): user bisa menempel URL callback ke chat.
const CALLBACK_PASTE_HINT =
  'Tanpa tunnel pun bisa: salin URL callback yang muncul di address bar browser ' +
  '(yang localhost:…/…?code=…) lalu tempel ke chat ini — bot meneruskannya ke sesi login.';

// User menyalin URL callback OAuth dari halaman error browser (localhost:8976/oauth/callback?code=…).
// CLI (wrangler, gcloud, netlify, dkk) biasanya masih menunggu di listener lokal → request-nya
// diteruskan lewat fetch ke localhost sehingga login selesai tanpa tunnel sama sekali.
const lastAuthCmd = new Map(); // chatId → { cmd, at } — perintah login terakhir, untuk auto-ulang
function handleCallbackPaste(ctx, text) {
  const t = String(text || '').trim();
  if (!t || t.length > 3000) return false;
  const m = t.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?(\/[^\s]*)$/i);
  if (!m || !/[?&]code=/.test(m[2])) return false;
  const chatId = ctx.chat.id;
  const port = Number(m[1] || 80);
  (async () => {
    let s = termSessions.get(chatId);
    if (!s || s.exited) {
      const last = lastAuthCmd.get(chatId);
      if (last && Date.now() - last.at < 30 * 60 * 1000) {
        await ctx.reply('🔁 Sesi login sudah tertutup — dijalankan ulang otomatis:\n' + truncate(last.cmd, 160));
        await startTerm(chatId, last.cmd);
        await new Promise((r) => setTimeout(r, 2500)); // listener lokal butuh waktu siap
        s = termSessions.get(chatId);
      }
    }
    if (!s || s.exited) {
      await ctx.reply('ℹ️ Tidak ada sesi login yang menunggu callback ini.\n' +
        'Jalankan dulu "login <cli>", lalu tempel link ini lagi.');
      return;
    }
    try {
      await fetch(t, { redirect: 'manual' });
      await ctx.reply('📨 Callback diteruskan ke listener lokal (localhost:' + port + ') — ' +
        'tunggu konfirmasi CLI-nya.');
      log('OAuth callback ←', truncate(t, 140));
    } catch (e) {
      log('OAuth callback gagal:', e.message);
      await ctx.reply('⚠️ localhost:' + port + ' tidak menjawab (' + truncate(e.message, 120) + ').\n' +
        'Sesi login mungkin sudah mati — jalankan ulang, lalu tempel link ini lagi.');
    }
  })().catch((e) => log('Callback paste error:', e.message));
  return true;
}

// Saring baris noise alur login. Hanya aktif SETELAH callout terkirim — kalau callout
// tidak pernah terbentuk (CLI tanpa URL+kode), semua output tetap diteruskan utuh.
function filterAuthNoise(lines, s) {
  if (!s || !s.callout) return lines;
  return lines.filter((l) => {
    if (AUTH_NOISE_RE.test(l)) return false;
    if (s.lastCode && l.includes(s.lastCode)) return false; // sudah ada di callout
    if (s.lastUrl && l.includes(s.lastUrl)) return false;
    return true;
  });
}

async function pollTerm(chatId) {
  const s = termSessions.get(chatId);
  if (!s || s.exited || s.polling) return;
  s.polling = true;
  try {
    if (Date.now() - s.startedAt > TERM_TIMEOUT_SECONDS * 1000) {
      await stopTerm(chatId, '⏳ Terminal ditutup (lewat ' + Math.round(TERM_TIMEOUT_SECONDS / 60) +
        ' menit). Ulangi dengan /term <perintah> bila perlu.');
      return;
    }

    let text = '';
    try {
      const res = await runCommandSync('tmux', ['capture-pane', '-p', '-J', '-t', s.key], 10000);
      text = String(res.stdout || '');
    } catch (e) {
      await stopTerm(chatId, '❌ Sesi terminal hilang: ' + truncate(e.message, 180));
      return;
    }

    const lines = text.replace(/\n+$/, '').split('\n');
    const changed = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\s+$/, '');
      if (line && s.prevLines[i] !== line) changed.push(line);
    }
    s.prevLines = lines;

    // --- CLI selesai (marker exit di wrapper) → SATU pesan: hasil akhir + ringkasan ---
    const exitMatch = text.match(/__OCTERM_EXIT=(-?\d+)/);
    if (exitMatch) {
      const rc = Number(exitMatch[1]);
      const body = filterAuthNoise(changed.filter((l) => !l.startsWith('__OCTERM_EXIT=')), s);
      const openerBroken = rc !== 0 &&
        /xdg-open|x-www-browser|www-browser|wslview|sensible-browser|(?:failed|unable|error)[^\n]{0,40}browser|no browser/i.test(text);
      const summary = rc === 0
        ? '✅ Perintah selesai (exit 0) — CLI-nya sendiri yang mengonfirmasi hasilnya.'
        : '❌ Perintah berakhir dengan exit ' + rc + (body.length ? '\nPenyebabnya ada di baris di atas.' : '') +
          (openerBroken
            ? '\n\n💡 Server ini tanpa browser, tapi stub pembuka (~/.local/bin/xdg-open) sudah terpasang. ' +
              'Kalau CLI tetap menolak, selesaikan login dari browser Anda lalu pakai jalur token/API ' +
              '(atau ulangi dengan /term <perintah> untuk lihat prompt lengkapnya).'
            : '');
      const finalText = [body.length ? cleanBatch(body) : '', summary].filter(Boolean).join('\n\n');
      await stopTerm(chatId, finalText);
      return;
    }

    if (!changed.length) return;

    // --- Panggilan login → jadi KEPALA pesan batch ini (disatu balon dengan outputnya,
    //     bukan balon terpisah → chat tidak dibloat). URL saja sudah cukup: CLI macam
    //     wrangler/gcloud tidak memberi kode, hanya link panjang. ---
    const joined = changed.join(' ');
    const u = joined.match(/https?:\/\/[^\s`'"<>()]+/);
    const c = joined.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
    if (u) s.lastUrl = u[0];
    if (c) s.lastCode = c[0];
    let calloutHead = '';
    const calloutKey = (s.lastCode || '') + '|' + (s.lastUrl || '');
    if (s.lastUrl && s.callout !== calloutKey) {
      s.callout = calloutKey;
      // Callback ke localhost → browser user menembak MESIN USER (bukan VPS),
      // jadi tanpa tunnel halaman callback tidak akan tersambung. Kasih tahu caranya.
      // Bisa berupa URL langsung (gcloud) atau param redirect_uri di dalam URL OAuth
      // (wrangler: https://dash.cloudflare.com/...?redirect_uri=http%3A%2F%2Flocalhost%3A8976...).
      let decoded = s.lastUrl;
      try { decoded = decodeURIComponent(s.lastUrl); } catch (_) {}
      const cb = decoded.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?/i);
      const cbBlock = cb
        ? '⚠️ Link itu mengembalikan browser ke localhost:' + (cb[1] || '80') + ' — bukan ke VPS.\n' +
          '   Dari komputer Anda, buka tunnel dulu (biarkan jalan di terminal baru):\n' +
          '   ' + String(VPS_SSH_HINT).replace(/\{port\}/g, cb[1] || '80') + '\n' +
          '   Baru setelah itu klik link-nya. Tanpa tunnel, callback mati di halaman error.\n' +
          '   ' + CALLBACK_PASTE_HINT + '\n\n'
        : '';
      calloutHead =
        '🔐 LOGIN MENUNGGU ANDA\n' +
        '1. Buka: ' + s.lastUrl + '\n' +
        (s.lastCode ? '2. Masukkan kode: ' + s.lastCode + '\n' : '') +
        (cbBlock ? '\n' + cbBlock : '\n') +
        'Sesi tetap berjalan — begitu Anda selesai di browser, CLI akan mendeteksi login ' +
        'otomatis dan bot melaporkan hasilnya.\n\n';
    }

    // --- "Press Enter to open …" → Enter otomatis supaya Anda tinggal buka URL ---
    // (cek di changed sebelum disaring — barisnya memang dilewatkan dari tampilan)
    for (const line of changed) {
      if (!AUTO_ENTER_RE.test(line)) continue;
      if (s.autoEntered.has(line) || s.autoEnterCount >= 10) continue;
      s.autoEntered.add(line);
      s.autoEnterCount++;
      try {
        await runCommandSync('tmux', ['send-keys', '-t', s.key, 'Enter'], 10000);
        log('Terminal ← Enter otomatis:', truncate(line, 90));
      } catch (e) { log('Enter otomatis gagal:', e.message); }
    }

    const body = filterAuthNoise(changed, s);
    const payload = (calloutHead + (body.length ? cleanBatch(body) : '')).replace(/\s+$/, '');
    if (payload) await safeSend(chatId, payload);
  } finally {
    const s2 = termSessions.get(chatId);
    if (s2) s2.polling = false;
  }
}

// Bersihkan sesi terminal sisa run sebelum restart bot
;(async () => {
  try {
    await runCommandSync('sh', ['-lc',
      'for s in $(tmux ls -F "#{session_name}" 2>/dev/null | grep "^octerm-"); do tmux kill-session -t "$s"; done'], 15000);
  } catch (_) {}
  // Prewarm katalog model+varian (`opencode models --verbose` butuh beberapa detik)
  // supaya /models, /model, /variant pertama langsung balas cepat.
  try { await fetchModelsData('__prewarm__'); log('Katalog model+varian siap (' + (modelsCache.get('__prewarm__') || { items: [] }).items.length + ' model)'); }
  catch (e) { log('Prewarm model gagal:', e.message); }
})();

// --- /usage: monitor resource VPS (baca /proc langsung, tanpa subprocess) ---
function readProcCpu() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const p = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = p[3] + (p[4] || 0);
  const total = p.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function cpuSample() {
  const a = readProcCpu();
  return new Promise((resolve) => {
    setTimeout(() => {
      const b = readProcCpu();
      const dt = b.total - a.total;
      const di = b.idle - a.idle;
      resolve(dt > 0 ? (1 - di / dt) * 100 : 0);
    }, 250);
  });
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function diskStats(mount) {
  try {
    const st = fs.statfsSync(mount);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    const used = total - st.bfree * st.bsize;
    return { total, used, free, pct: total ? (used / total) * 100 : 0 };
  } catch (_) {
    return null;
  }
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(d + ' hari');
  if (h) parts.push(h + ' jam');
  if (m || !parts.length) parts.push(m + ' mnt');
  return parts.join(' ');
}

function bar(pct, width = 10) {
  const f = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(f) + '░'.repeat(width - f);
}

function topProcesses(limit = 5) {
  const names = {};
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, end);
      const rest = stat.slice(end + 2).split(' ');
      const utime = Number(rest[11]) || 0;
      const stime = Number(rest[12]) || 0;
      names[name] = (names[name] || 0) + utime + stime;
    } catch (_) { /* proses hilang */ }
  }
  return Object.entries(names)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

async function buildUsageReport() {
  const cpuPct = await cpuSample();
  const cpus = os.cpus();
  const model = cpus[0] ? cpus[0].model.trim() : 'CPU';
  const load = os.loadavg();
  const cores = cpus.length || 1;
  const loadPct = (load[0] / cores) * 100;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = (usedMem / totalMem) * 100;

  let swapTotal = 0, swapFree = 0, swapPct = 0;
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k) => {
      const m = mi.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'));
      return m ? Number(m[1]) * 1024 : 0;
    };
    swapTotal = g('SwapTotal');
    swapFree = g('SwapFree');
    swapPct = swapTotal ? ((swapTotal - swapFree) / swapTotal) * 100 : 0;
  } catch (_) { /* tanpa swap */ }

  const disk = diskStats('/');
  const upSec = os.uptime();
  const procCount = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).length;

  const lines = [
    '🖥️ Monitor VPS — ' + new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB',
    '',
    `⚙️ CPU (${cores} core · ${truncate(model, 40)})`,
    `   ${bar(cpuPct)} ${cpuPct.toFixed(1)}% terpakai`,
    `   Load: ${load.map((l) => l.toFixed(2)).join(' / ')}  → ${loadPct.toFixed(0)}% dari ${cores} core`,
    '',
    `🧠 RAM  ${bar(memPct)} ${memPct.toFixed(1)}%`,
    `   ${fmtBytes(usedMem)} / ${fmtBytes(totalMem)} (free ${fmtBytes(freeMem)})`,
  ];

  if (swapTotal > 0) {
    lines.push(
      `💾 Swap ${bar(swapPct)} ${swapPct.toFixed(1)}%`,
      `   ${fmtBytes(swapTotal - swapFree)} / ${fmtBytes(swapTotal)}`
    );
  } else {
    lines.push('💾 Swap: tidak ada');
  }

  if (disk) {
    lines.push(
      '',
      `📀 Disk / ${bar(disk.pct)} ${disk.pct.toFixed(1)}%`,
      `   ${fmtBytes(disk.used)} / ${fmtBytes(disk.total)} (free ${fmtBytes(disk.free)})`
    );
  }

  lines.push(
    '',
    `⏱️ Uptime: ${fmtUptime(upSec)} · Proses: ${procCount}`,
    '',
    '🔥 Proses teratas (dari total waktu CPU):'
  );
  for (const [name, t] of topProcesses(5)) {
    lines.push('   • ' + truncate(name, 28) + ' — ' + t.toFixed(0) + ' tick');
  }

  return lines.join('\n');
}

bot.command(['usage', 'resources', 'sysinfo'], async (ctx) => {
  log('/usage from', ctx.from.id);
  try {
    const text = await buildUsageReport();
    return ctx.reply(text);
  } catch (e) {
    log('/usage gagal:', e.message);
    return ctx.reply('❌ Gagal baca resource: ' + truncate(e.message, 300));
  }
});

bot.command('cron', async (ctx) => {
  log('/cron from', ctx.from.id);
  const fmt = async (scope, args) => {
    try {
      const { stdout } = await runCommandSync('systemctl', args, 15000);
      const lines = stdout.trim().split('\n');
      if (lines.length <= 1) return `— (${scope}: kosong)`;
      return '```\n' + lines.slice(0, 25).join('\n') + '\n```';
    } catch (e) {
      return `— (${scope}: ${truncate(e.message, 120)})`;
    }
  };
  const user = await fmt('user', ['--user', 'list-timers', '--all', '--no-pager']);
  const system = await fmt('system', ['list-timers', '--all', '--no-pager']);
  const text =
    '⏰ Jadwal VPS (systemd timers)\n\n' +
    '👤 Timer user (bot/berita):\n' + user + '\n\n' +
    '🖥️ Timer sistem (distro):\n' + system +
    '\n\nDetail: /term systemctl --user list-timers --all';
  return ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => ctx.reply(text));
});

bot.command('term', async (ctx) => {
  const chatId = ctx.chat.id;
  const arg = String((ctx.message && ctx.message.text) || '').replace(/^\/term(@\w+)?/i, '').trim();
  const s = termSessions.get(chatId);

  if (/^(end|stop|kill|batal|close|quit|exit)$/i.test(arg)) {
    const ok = await stopTerm(chatId, null);
    return ctx.reply(ok ? '🛑 Sesi terminal ditutup.' : 'ℹ️ Tidak ada sesi terminal yang aktif.');
  }

  if (!arg || /^(status|info|help)$/i.test(arg)) {
    if (!s || s.exited) {
      return ctx.reply(
        '🖥️ Terminal interaktif di chat\n\n' +
        'Pakai: /term <perintah>\n' +
        'Semua keluaran layar terminal dikirim ke chat ini, dan pesan Anda dikirim balik ke terminal.\n\n' +
        'Contoh:\n' +
        '  /term gh auth login --hostname github.com --web\n' +
        '  /term npm login\n' +
        '  /term gcloud auth login --no-launch-browser\n' +
        '  /term docker login\n\n' +
        'Permintaan login sehari-hari juga langsung jalan tanpa perintah: tulis saja "login gh cli".\n' +
        'Akhiri dengan /term end · otomatis berhenti setelah ' + Math.round(TERM_TIMEOUT_SECONDS / 60) + ' menit.'
      );
    }
    const shown = s.prevLines.filter((l) => l.trim()).slice(-12);
    return ctx.reply(
      '🖥️ Terminal aktif: ' + truncate(s.cmd, 180) + '\n' +
      'Berjalan ' + Math.round((Date.now() - s.startedAt) / 1000) + ' detik · pesan Anda = input terminal\n' +
      'Akhiri: /term end\n\nLayar saat ini:\n' + (shown.join('\n') || '(kosong)')
    );
  }

  try {
    await startTerm(chatId, arg);
    return ctx.reply(
      '🖥️ Sesi terminal dimulai:\n' + truncate(arg, 300) + '\n\n' +
      'Keluaran terminal (termasuk URL & kode login) menyusul di chat ini.\n' +
      'Balasan Anda = input ke terminal. Akhiri: /term end · timeout ' +
      Math.round(TERM_TIMEOUT_SECONDS / 60) + ' menit.'
    );
  } catch (e) {
    log('startTerm gagal:', e.message);
    return ctx.reply('❌ Gagal menjalankan perintah: ' + truncate(e.message, 300));
  }
});

bot.on('message', (ctx) => {
  const raw = ctx.message.text || ctx.message.caption || '';
  if (raw.startsWith('/')) {
    // Slash yang tidak dikenal → beri saran (supaya pengguna tahu ada menu saran di input Telegram)
    const name = (raw.slice(1).split(/[\s@]/)[0] || '').toLowerCase();
    const all = allCommandNames();
    const hits = all.filter((n) => n.startsWith(name) || (name.length > 1 && name.startsWith(n))).slice(0, 5);
    return ctx
      .reply(
        '❓ Perintah /' + name + ' tidak dikenal.' +
        (hits.length ? '\nMaksud kamu: ' + hits.map((h) => '/' + h).join(', ') : '') +
        '\n\nKetik /help untuk daftar semua perintah (menu muncul saat mengetik /).'
      )
      .catch(() => {});
  }

  // URL callback OAuth ditempel user (localhost:…/oauth/callback?code=…) → diteruskan
  // ke listener login lokal. HARUS sebelum cabang terminal: kalau tidak, link itu diketik
  // mentah ke shell.
  if (handleCallbackPaste(ctx, raw)) return;

  // Terminal aktif → pesan biasa menjadi input terminal (chat = terminal)
  if (termActive(ctx.chat.id)) {
    feedTermInput(ctx).catch((e) => log('Terminal input:', e.message));
    return;
  }

  const prompt = formatIncoming(ctx.message).trim();
  if (!prompt) return;

  const uid = String(ctx.from.id);
  log('Message from', uid, ':', prompt.slice(0, 100));

  // Permintaan login CLI ("login gh cli", "auth npm", …) → jalankan langsung di VPS
  const auth = detectAuthRequest(prompt);
  if (auth) {
    resolveAuthCommand(auth.tool, auth.cmd)
      .then(async (cmd) => {
        if (!cmd) {
          log('Auto-login dilewati (CLI tidak ditemukan di VPS):', auth.tool);
          return enqueueOpencode(ctx, () => runOpencode(ctx, prompt));
        }
        log('Auto-login →', auth.tool, '→', cmd);
        await ctx.reply('🔐 Menjalankan login ' + auth.tool + ' di VPS — hasilnya menyusul di chat ini.');
        await startTerm(ctx.chat.id, cmd);
      })
      .catch((e) => {
        log('Auto-login gagal:', e.message);
        ctx.reply('❌ Gagal menjalankan login ' + auth.tool + ': ' + truncate(e.message, 200)).catch(() => {});
      });
    return;
  }

  return enqueueOpencode(ctx, () => runOpencode(ctx, prompt));
});

function runCommandSync(cmd, args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: WORKDIR,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timeoutMs > 0 && code === null) return reject(new Error('timeout ' + Math.round(timeoutMs / 1000) + 's'));
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`exit ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function truncate(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function describeTool(part) {
  const input = (part.state && part.state.input) || {};
  const status = part.state && part.state.status;
  const done = status === 'completed' ? '✓' : status === 'error' ? '✗' : '…';
  const name = part.tool || 'tool';

  let line;
  switch (name) {
    case 'bash': {
      line = `${done} 💻 bash: ${truncate(input.command, 180)}`;
      if (done === '✓' && part.state.output) {
        const out = truncate(stripAnsi(String(part.state.output)), 200);
        if (out) line += `\n   ↳ ${out}`;
      }
      break;
    }
    case 'read':
      line = `${done} 📖 read: ${truncate(input.filePath || input.path, 180)}`;
      break;
    case 'edit':
    case 'patch':
      line = `${done} ✏️ edit: ${truncate(input.filePath || input.path, 180)}`;
      break;
    case 'write':
      line = `${done} 📝 write: ${truncate(input.filePath || input.path, 180)}`;
      break;
    case 'glob':
    case 'grep':
    case 'list':
      line = `${done} 🔎 ${name}: ${truncate(input.pattern || input.path || input.query, 180)}`;
      break;
    case 'webfetch':
      line = `${done} 🌐 webfetch: ${truncate(input.url, 180)}`;
      break;
    case 'task':
      line = `${done} 🧩 task: ${truncate(input.description || input.prompt, 180)}`;
      break;
    default:
      line = `${done} 🔧 ${name}${input.filePath ? ': ' + truncate(input.filePath, 160) : ''}`;
  }
  return line;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createProgress(ctx) {
  const chatId = ctx.chat.id;
  let messageId = null;
  let text = '';
  let timer = null;
  let inFlight = false;
  let dirty = false;
  let stopped = false;

  function trim() {
    const MAX = 3500;
    if (text.length <= MAX) return;
    text = '…\n' + text.slice(text.length - MAX);
  }

  async function render() {
    if (stopped || !text) return;
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    try {
      if (!messageId) {
        const msg = await ctx.telegram.sendMessage(chatId, text, { disable_notification: true });
        messageId = msg.message_id;
      } else {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, text, { disable_notification: true });
      }
    } catch (err) {
      if (!String(err.message || '').includes('not modified')) {
        log('Progress update failed:', err.message);
      }
    } finally {
      inFlight = false;
      if (dirty && !stopped) { dirty = false; schedule(400); }
    }
  }

  function schedule(delay = 700) {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; render(); }, delay);
  }

  return {
    add(line) {
      if (stopped) return;
      text = text ? text + '\n' + line : line;
      trim();
      schedule();
    },
    getMessageId() {
      return messageId;
    },
    hasContent() {
      return !!String(text).trim();
    },
    // Sisakan pesan progres sebagai jawaban (dipakai saat output kosong / run gagal)
    async keep(note) {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      for (let i = 0; i < 40 && inFlight; i++) await sleep(50);
      if (note) { text = text ? text + '\n' + note : note; trim(); }
      if (!text) return;
      try {
        if (!messageId) {
          const msg = await ctx.telegram.sendMessage(chatId, text, { disable_notification: true });
          messageId = msg.message_id;
        } else {
          await ctx.telegram.editMessageText(chatId, messageId, undefined, text, { disable_notification: true });
        }
      } catch (err) {
        if (!String(err.message || '').includes('not modified')) log('Progress final render failed:', err.message);
      }
    },
    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      for (let i = 0; i < 40 && inFlight; i++) await sleep(50);
      if (messageId) {
        try { await ctx.telegram.deleteMessage(chatId, messageId); } catch (_) {}
      }
    },
  };
}

function extractBashFiles(command) {
  const files = [];
  if (!command) return files;
  const re = /(?:^|[\s;&|])(?:>>?|tee(?:\s+-a)?)\s*("([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  let m;
  while ((m = re.exec(String(command))) !== null) {
    const f = m[2] || m[3] || m[4];
    if (!f) continue;
    if (f.startsWith('&') || f.startsWith('/dev/') || f.startsWith('$')) continue;
    files.push(f);
  }
  return files;
}

const FILE_EXT_RE = /\.(?:html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|json|jsonl|ndjson|md|mdx|txt|rtf|csv|tsv|xlsx?|ods|pdf|docx?|odt|pptx?|odp|zip|tar|tgz|gz|bz2|xz|rar|7z|png|jpe?g|gif|webp|bmp|ico|svg|mp3|wav|ogg|flac|m4a|mp4|mov|avi|mkv|webm|py|go|rs|java|kt|kts|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|ps1|sql|db|sqlite|log|xml|ya?ml|toml|ini|conf|apk|exe|bin|iso|epub)$/i;

// Only auto-upload files when the user explicitly asks to send/receive one.
const FILE_REQUEST_RE = /\b(?:kirim(?:kan)?|send|upload|attach|berikan|kasih)\b[\s\S]{0,40}?\b(?:file|berkas|dokumen|document|attachment|zip|script|kode|code)\b|\b(?:file|berkas|dokumen|document|attachment)\b[\s\S]{0,40}?\b(?:kirim(?:kan)?|send|upload|attach|kirimkan)\b/i;

const NO_FILE_RE = /\b(?:jangan|jgn|tidak|gak|ga|don'?t|do\s+not|never)\b[\s\S]{0,25}?\b(?:kirim(?:kan)?|send|upload|attach)\b[\s\S]{0,25}?\b(?:file|berkas|dokumen|document)\b/i;

function userWantsFiles(prompt) {
  const p = String(prompt || '');
  if (NO_FILE_RE.test(p)) return false;
  return FILE_REQUEST_RE.test(p);
}

const SNAPSHOT_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.cache', '.local', '.npm', '.bun',
  '.nvm', '.nodejs', '.ssh', '.config', '.opencode',
]);

function fileCandidates(text) {
  const out = [];
  if (!text) return out;
  const re = /(?:^|[\s`"'(<\[])((?:~|\.{1,2})?\/[^\s`"'()<>\[\]]+|[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]{1,8})(?=$|[\s`"'),;:<>\]])/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    let p = m[1].replace(/[.,;:]+$/, '');
    if (!p) continue;
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    let abs;
    try {
      abs = path.isAbsolute(p) ? p : path.resolve(WORKDIR, p);
    } catch (_) {
      continue;
    }
    if (!FILE_EXT_RE.test(abs) && !p.includes('/')) continue;
    try {
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch (_) {}
  }
  return out;
}

function snapshotWorkspace(root) {
  const map = new Map();
  let count = 0;

  function walk(dir) {
    if (count >= 20000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) continue;
        try {
          const stat = fs.statSync(abs);
          map.set(abs, `${stat.mtimeMs}:${stat.size}`);
          count++;
        } catch (_) {}
      }
    }
  }

  walk(root);
  return map;
}

// ─── F1: auto-fallback model gratis · F2: log penyebab error · F3: 1 chat = 1 sesi ───
const FALLBACK_RETRIES = Number(process.env.FALLBACK_RETRIES || 2);
const FREE_FALLBACK_MODELS = (
  process.env.FALLBACK_MODELS ||
  'opencode/glm-5.3-flash-free,opencode/mimo-v2.6-flash-free,opencode/nemotron-3.5-lightning-free,opencode/beam-free,opencode/flint-40b-free,opencode/nemotron-3-ultra-free,opencode/nemotron-3.5-super-vl-free'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const chatSessions = new Map(); // chatId → { id, lastAt, turns }

// Sesi default TIDAK PERNAH berganti sendiri: tidak ada kadaluarsa idle, tidak ada rotasi
// giliran. Hanya dua cara berubah: perintah user (/switch, /newsess) dan pemulihan paksa
// kalau OpenCode sendiri menolak id sesinya. Disimpan di state.json → restart bot pun
// tidak mengganti sesi chat.
for (const [k, v] of Object.entries(savedSessions)) {
  if (v && typeof v === 'object' && v.id) {
    chatSessions.set(String(k), {
      id: String(v.id),
      lastAt: Number(v.lastAt) || Date.now(),
      turns: Number(v.turns) || 0,
    });
  }
}
const restoredSessions = chatSessions.size;
if (restoredSessions) log('Sesi dipulihkan dari state:', restoredSessions, 'chat');

function persistSessions() {
  try {
    const st = readJsonFile(BOT_STATE_PATH, {});
    st.sessions = Object.fromEntries(Array.from(chatSessions, ([k, v]) => [String(k), v]));
    writeJsonFile(BOT_STATE_PATH, st, 0o600);
  } catch (e) {
    log('Simpan sesi ke state gagal:', e.message);
  }
}

function modelChain() {
  const chain = [];
  // null = tanpa flag --model → OpenCode memakai model bawaan config-nya sendiri
  chain.push(defaultModel || null);
  for (const m of FREE_FALLBACK_MODELS) if (!chain.includes(m)) chain.push(m);
  return chain.slice(0, 1 + Math.max(0, FALLBACK_RETRIES));
}

function getStoredSession(chatId) {
  const s = chatSessions.get(chatId);
  if (!s || !s.id) return null;
  return s; // tanpa kadaluarsa waktu & tanpa rotasi turn — sesi bertahan sampai user pindah sendiri
}

function storeSession(chatId, sessionId, prev) {
  if (!sessionId) return null;
  const turns = prev && prev.id === sessionId ? prev.turns + 1 : 1;
  const meta = { id: sessionId, lastAt: Date.now(), turns };
  chatSessions.set(chatId, meta);
  persistSessions();
  return meta;
}

function killChildGroup(child) {
  if (!child || child.pid === undefined) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { child.kill('SIGKILL'); } catch (_) {}
}

function isFreeUsage(text) {
  return (/Free usage limit/i.test(text) ? (text.match(/Free usage limit[^\n"]*/) || [''])[0] : '') || '';
}

// Jalankan opencode sekali (satu model, satu percobaan).
// Resolve: {kind: 'ok'|'freelimit'|'timeout'|'error', code, output, errOutput, detail, sessionId, files}
function runOpencodeAttempt(chatId, prompt, model, sessionID, progress, onFirstText, beforeSnapshot, opts = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let lineBuffer = '';
    let finalText = '';
    let lastError = '';
    const writtenFiles = new Set();
    const startSnapshot = beforeSnapshot || snapshotWorkspace(WORKDIR);

    let capturedSessionId = null;
    let freeLimit = false;   // ada indikasi "Free usage limit" (termasuk tahap title-agent)
    let freeKill = false;    // indikasi pada tahap build/awal -> layak dibunuh & di-fallback
    let freeDetail = '';
    let streamErrLogged = false;
    let timedOut = false;
    let childFinished = false;
    let timer = null;
    let reaper = null;

    const timeoutSeconds = Number(opts.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS);
    // Mode perintah: `opencode run --command <nama> <args>` (setara slash di TUI)
    const runText = opts.command ? String(opts.args || '') : withCavemanRules(prompt);
    const args = ['run'];
    if (opts.command) args.push('--command', opts.command);
    if (runText) args.push(runText);
    args.push('--auto', '--format', 'json', '--print-logs', '--log-level', 'ERROR');
    if (model) args.push('--model', model);
    if (opts.variant) args.push('--variant', String(opts.variant));
    if (sessionID) args.push('-s', sessionID);
    if (showThinking) args.push('--thinking');

    let child;
    try {
      child = spawn('opencode', args, {
        cwd: WORKDIR,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TERM: 'dumb',
          CI: 'true',
          OPENCODE_NON_INTERACTIVE: '1',
          PWD: WORKDIR,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const logAttempt = (msg) => log(`[run chat=${chatId}${opts.command ? ' cmd=' + opts.command : ''} model=${model || 'default'}${sessionID ? ' sesi=' + sessionID : ' (sesi baru)'}] ${msg}`);

    const kill = () => {
      if (childFinished) return;
      killChildGroup(child);
      if (reaper) clearTimeout(reaper);
      reaper = setTimeout(() => { if (!childFinished) killChildGroup(child); }, 3000);
    };

    // F2: pentahap & catat free usage.
    // title-agent = panggilan bantu (judul sesi): dicatat, TIDAK mematikan run utama.
    const noteFree = (detail, stage) => {
      if (!detail) return;
      const first = !freeDetail;
      freeLimit = true;
      if (first) freeDetail = detail;
      const shouldKill = stage === 'build' || (stage === 'unknown' && finalText.length === 0);
      if (shouldKill) {
        if (first) logAttempt('free usage limit (tahap ' + stage + ') → bunuh & fallback: ' + String(detail).slice(0, 180));
        if (!freeKill) { freeKill = true; setTimeout(kill, 700); }
      } else if (first) {
        logAttempt('free usage limit (tahap ' + stage + ', tidak memblokir run): ' + String(detail).slice(0, 180));
      }
    };

    const scan = (data) => {
      const text = String(data);
      const detail = isFreeUsage(text);
      if (!detail) {
        if (!streamErrLogged && /stream error/.test(text)) {
          const m = text.match(/stream error[^\n]{0,240}/);
          if (m) { streamErrLogged = true; logAttempt('provider error (bukan kuota): ' + String(m[0]).slice(0, 240)); }
        }
        return;
      }
      let stage = 'unknown';
      if (/agent=build|\bsmall=false\b/.test(text)) stage = 'build';
      else if (/agent=title|\bsmall=true\b/.test(text)) stage = 'title';
      noteFree(detail, stage);
    };

    child.stdout.on('data', (data) => {
      const s = data.toString();
      lastActivity = Date.now(); // ada output → reset timer inaktivitas
      if (armTimeout) armTimeout();
      scan(s);
      lineBuffer += s;
      let idx;
      while ((idx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); } catch (_) {}
      }
    });

    child.stderr.on('data', (data) => {
      const s = String(data);
      lastActivity = Date.now();
      if (armTimeout) armTimeout();
      stderr += stripAnsi(s);
      scan(s);
    });

    // --- Batas waktu: inaktivitas + limit dua tingkat + batas keras ---
    // soft = timeoutSeconds saat run "diam"; naik ke TOOL_TIMEOUT_SECONDS begitu tugas
    // tergolong berat (LONG_TASK_RE) atau agent memakai tool (npm install, build, dll).
    // Timer dihitung dari output TERAKHIR (jadi run yang terus menghasilkan data tidak
    // dibunuh), dan RUN_HARD_TIMEOUT_SECONDS membatasi total waktu.
    const startedAt = Date.now();
    const longTask = LONG_TASK_RE.test(String(prompt || ''));
    let toolSeen = false;
    let eventCount = 0;
    let lastActivity = startedAt;
    let effectiveLimit = timeoutSeconds;

    function armTimeout() {
      if (timer) { clearTimeout(timer); timer = null; }
      const soft = timeoutSeconds > 0
        ? ((toolSeen || longTask) ? Math.max(timeoutSeconds, TOOL_TIMEOUT_SECONDS) : timeoutSeconds)
        : Infinity;
      const hard = RUN_HARD_TIMEOUT_SECONDS > 0 ? RUN_HARD_TIMEOUT_SECONDS : Infinity;
      const cap = Math.min(soft, hard);
      if (!Number.isFinite(cap)) return;
      effectiveLimit = Math.round(cap);
      const deadline = Math.min(lastActivity + cap * 1000, startedAt + hard * 1000);
      timer = setTimeout(() => {
        if (childFinished) return;
        timedOut = true;
        const silent = Math.round((Date.now() - lastActivity) / 1000);
        logAttempt('timeout ' + effectiveLimit + 's (' + silent + ' dtk tanpa output' +
          (toolSeen ? ', tool pernah jalan' : longTask ? ', tugas berat' : '') +
          ', events=' + eventCount + ') → membunuh process group');
        kill();
      }, Math.max(0, deadline - Date.now()));
    }
    armTimeout();

    function handleEvent(event) {
      if (!event || typeof event !== 'object') return;
      eventCount++;
      if (event.sessionID) capturedSessionId = event.sessionID;
      if (event.type === 'tool_use' && event.part) {
        if (!toolSeen) { toolSeen = true; armTimeout(); } // tool pertama → limit naik
        progress.add(describeTool(event.part));
        const part = event.part;
        const status = part.state && part.state.status;
        if (status === 'completed' && ['write', 'edit', 'patch'].includes(part.tool)) {
          const input = (part.state && part.state.input) || {};
          const filePath = input.filePath || input.path;
          if (filePath) writtenFiles.add(String(filePath));
        }
        if (status === 'completed' && part.tool === 'bash') {
          const input = (part.state && part.state.input) || {};
          for (const f of extractBashFiles(input.command)) {
            const abs = path.resolve(WORKDIR, f);
            if (abs === WORKDIR || abs.startsWith(WORKDIR + path.sep)) writtenFiles.add(abs);
          }
        }
      } else if (event.type === 'text' && event.part && event.part.text) {
        // Teks jawaban JANGAN dimasukkan ke bubble progres: teks hanya diakumulasi
        // lalu dikirim sekali di akhir. Bubble khusus aktivitas tool (baca/edit/bash).
        finalText += event.part.text;
        if (onFirstText) onFirstText();
      } else if (event.type === 'error') {
        const msg =
          (event.error && (event.error.message || (event.error.data && event.error.data.message))) ||
          JSON.stringify(event);
        lastError = msg;
        const detail = isFreeUsage(String(msg));
        if (detail) noteFree(detail, 'unknown');
      }
    }

    child.on('error', (err) => { reject(err); });

    child.on('close', (code) => {
      childFinished = true;
      if (timer) clearTimeout(timer);
      if (reaper) clearTimeout(reaper);

      if (lineBuffer.trim()) {
        try { handleEvent(JSON.parse(lineBuffer.trim())); } catch (_) {}
        lineBuffer = '';
      }

      for (const f of fileCandidates(finalText)) writtenFiles.add(f);
      for (const f of fileCandidates(prompt)) writtenFiles.add(f);

      try {
        const afterSnapshot = snapshotWorkspace(WORKDIR);
        for (const [f, sig] of afterSnapshot) {
          if (startSnapshot.get(f) !== sig) writtenFiles.add(f);
        }
      } catch (err) {
        log('Snapshot diff failed:', err.message);
      }

      const output = finalText.trim();
      const errOutput = stderr.trim() || lastError;
      const okWithOutput = code === 0 && !!output;

      let kind;
      if (freeLimit && !okWithOutput) kind = 'freelimit';
      else if (timedOut) kind = 'timeout';
      else if (code === 0) kind = 'ok';
      else kind = 'error';

      log(
        `OpenCode closed model=${model || 'default'} code=${code} kind=${kind}` +
        (sessionID ? ' (lanjut sesi ' + sessionID + ')' : '') +
        (capturedSessionId ? ' → sesi=' + capturedSessionId : '') +
        ` · events=${eventCount} · ${Math.round((Date.now() - startedAt) / 1000)}s`
      );

      resolve({
        kind,
        code,
        output,
        errOutput,
        detail: freeDetail,
        sessionId: capturedSessionId,
        files: Array.from(writtenFiles),
        timedOut,
        timeoutSeconds: effectiveLimit || timeoutSeconds,
        command: opts.command || null,
      });
    });
  });
}

async function runOpencode(ctx, prompt, opts = {}) {
  const chatId = ctx.chat.id;
  const uid = String(ctx.from.id);
  const progress = createProgress(ctx);
  const beforeSnapshot = snapshotWorkspace(WORKDIR);

  // Tanpa bubble "Menjalankan…" (permintaan user): cukup typing indicator.
  const runStartedAt = Date.now();
  const liveness = setInterval(() => {
    // Heartbeat hanya untuk run yang memang sudah menampilkan bubble tool.
    // Percakapan murni (tanpa tool) tetap tanpa bubble.
    if (!progress.hasContent()) return;
    const secs = Math.round((Date.now() - runStartedAt) / 1000);
    progress.add(`⏳ Masih berjalan… (${secs} dtk)`);
  }, 60000);

  let typingInterval = null;
  const sendTyping = () => ctx.telegram.sendChatAction(chatId, 'typing').catch(() => {});
  const startTyping = () => {
    sendTyping();
    if (typingInterval) clearInterval(typingInterval);
    typingInterval = setInterval(sendTyping, 4000);
  };
  const stopTyping = () => {
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
  };

  const chain = modelChain();
  let stored = getStoredSession(chatId);
  let result = null;
  let resultModel = null;
  let usedAttempts = 0;

  try {
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      const useSession = i === 0 && stored ? stored.id : null;
      // Tanpa preview model di pesan progres (permintaan user): hanya status penting —
      // perintah berjalan (mis. /init) dan saat fallback kuota.
      const label = i === 0
        ? null // label awal sudah ditanam di atas (progress.add sebelum loop)
        : `🔁 kuota model sebelumnya habis → coba [${i + 1}/${chain.length}] ${model}`;
      if (label) progress.add(label);
      startTyping();

      // Varian (reasoning effort) hanya dipakai di percobaan utama — model fallback gratis
      // punya set varian sendiri, flag model lain bisa tidak relevan/menolak.
      opts.variant = i === 0 ? defaultVariant : null;
      const res = await runOpencodeAttempt(chatId, prompt, model, useSession, progress, stopTyping, beforeSnapshot, opts);
      usedAttempts = i + 1;
      result = res;
      resultModel = model;

      if (res.kind === 'freelimit') {
        if (i + 1 < chain.length) log(`[fallback] ${model || 'default'} ditolak kuota gratis → lanjut ke ${chain[i + 1]}`);
        continue;
      }

      if (res.kind === 'error' && useSession && /session/i.test(res.errOutput || '') && /not|unknown|invalid|missing|expired|no such/i.test(res.errOutput || '')) {
        log('[sesi] id tidak dipakai opencode (' + useSession + ') → mulai sesi baru');
        chatSessions.delete(chatId);
        persistSessions(); // dipaksa CLI menolak id-nya, bukan pergantian otomatis
        stored = null;
        i--;
        continue;
      }

      break;
    }
  } catch (err) {
    await progress.stop();
    throw err;
  } finally {
    stopTyping();
    clearInterval(liveness);
  }

  log(`OpenCode closed (code=${result ? result.code : 'n/a'} kind=${result ? result.kind : 'none'}) for user ${uid}`);

  if (!result) {
    await progress.stop();
    await ctx.reply('⚠️ Tidak ada model yang tersedia.').catch(() => {});
    return;
  }

  if (result.kind === 'freelimit') {
    const tried = chain.map((m, idx) => `${idx + 1}. ${m || '(default config)'}`).join('\n');
    const extra = FREE_FALLBACK_MODELS.filter((m) => !chain.includes(m)).slice(0, 5).map((m) => `/model ${m}`);
    const msg =
      '⚠️ Kuota model gratis habis.\n\n' +
      'Sudah dicoba (' + usedAttempts + ' model):\n' + tried + '\n' +
      (result.detail ? '\nDetail: ' + String(result.detail).slice(0, 260) + '\n' : '') +
      '\nKuota gratis memakai jendela waktu; prompt panjang/multi-langkah lebih boros dan lebih cepat menembus jendela.\n' +
      'Tunggu jendela terisi ulang, atau ganti model sekarang:\n' +
      (extra.length ? extra.join('\n') : '/models') +
      '\nSemua model: /models';
    log(`[fallback] semua model kena kuota untuk chat=${chatId} user=${uid}`);
    await progress.stop();
    await ctx.reply(msg).catch(() => {});
    return;
  }

  if (result.kind === 'timeout') {
    // Tanpa nama model (user tidak mau preview model di chat); detail ada di jurnal.
    const note =
      `⏱️ Dihentikan: tidak ada aktivitas selama ${result.timeoutSeconds} detik.\n` +
      'Kalau tugasnya memang panjang (install/build), ulangi perintahnya — atau naikkan TOOL_TIMEOUT_SECONDS di .env.';
    if (progress.hasContent()) await progress.keep(note); // progres = jawaban cadangan
    else { await progress.stop(); await ctx.reply(note).catch(() => {}); }
    return;
  }

  if (result.kind === 'error') {
    if (progress.hasContent()) {
      // progres tetap tampil, error ditambahkan sebagai baris terakhir
      await progress.keep('❌ Gagal: exited with code ' + result.code + ' — ' + truncate(String(result.errOutput || result.detail || ''), 300));
    } else {
      await progress.stop();
      await sendChunks(
        ctx,
        '❌ OpenCode exited with code ' + result.code + '\n\nError:\n' + String(result.errOutput || '').slice(0, 3000)
      ).catch(() => {});
    }
    return;
  }

  // kind === 'ok' → simpan sesi (F3) lalu kirim hasil
  storeSession(chatId, result.sessionId, stored && stored.id === result.sessionId ? stored : null);

  if (result.output) {
    await progress.stop();
    await sendChunks(ctx, result.output).catch((e) => log('Kirim hasil gagal:', e.message));
  } else if (progress.hasContent()) {
    // tidak ada output teks → progres (tool/stream) dijadikan jawaban, bukan "no output"
    await progress.keep('✅ Selesai tanpa output teks — ringkasan di atas.');
  } else {
    await progress.stop();
    await ctx.reply('✅ OpenCode completed with no output.').catch(() => {});
  }

  // File yang dibuat/diubah selama run → dikirim ke chat otomatis (tanpa diminta),
  // kecuali permintaan project / "jangan kirim file" (cukup tersimpan di VPS).
  let changed = [];
  try {
    const after = snapshotWorkspace(WORKDIR);
    for (const [f, sig] of after) if (beforeSnapshot.get(f) !== sig) changed.push(f);
  } catch (e) {
    log('Snapshot akhir gagal:', e.message);
  }
  const explicit = userWantsFiles(prompt) ? result.files : [];
  await deliverFiles(ctx, prompt, changed.concat(explicit));
}

const MAX_CHUNK = 3900;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownToHtml(input) {
  const placeholders = [];
  const hold = (html) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };

  let text = escapeHtml(input);

  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) =>
    hold(`<pre>${code.replace(/\n$/, '')}</pre>`)
  );
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => hold(`<code>${code}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) =>
    hold(`<a href="${url}">${label}</a>`)
  );

  text = text.replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<b><i>$1</i></b>');
  text = text.replace(/\*\*([^*\n]+?)\*([^*\n]+?)\*\*\*/g, '<b>$1<i>$2</i></b>');
  text = text.replace(/\*\*((?:[^*\n]|\*(?!\*))+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/(^|[^\w])__((?:[^_\n]|_(?!_))+?)__(?!\w)/g, '$1<u>$2</u>');
  text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
  text = text.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');
  text = text.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');

  return text.replace(/\u0000(\d+)\u0000/g, (_m, idx) => placeholders[Number(idx)]);
}

async function sendFormatted(ctx, text) {
  try {
    await ctx.reply(markdownToHtml(text), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    log('Formatted reply failed, sending plain:', err.message);
    await ctx.reply(text).catch(() => {});
  }
}

function splitIntoChunks(text, max) {
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.6) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendChunks(ctx, text) {
  const chunks = splitIntoChunks(text, MAX_CHUNK);
  for (let i = 0; i < chunks.length; i++) {
    const label = chunks.length > 1
      ? `📦 Part ${i + 1}/${chunks.length}:\n` + chunks[i]
      : chunks[i];
    await sendFormatted(ctx, label);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 10;

// Permintaan project → file tidak dikirim ke chat, cukup disimpan di VPS
// (?!\.ext) supaya "file project.py / template.html" tetap dianggap file biasa
const PROJECT_RE = /\b(?:project|projek|repo(?:sitori)?|aplikasi|application|website|scaffold|template|full[\s-]?stack)(?!\.[A-Za-z0-9]{1,8})\b|struktur\s*(?:folder|direktori)|buat(?:kan)?\s+(?:sebuah\s+)?(?:project|projek|aplikasi|website|repo)/i;
const MAX_AUTO_SEND_FILES = 6;

// Kirim file yang dibuat/diubah TANPA diminta (kecuali: project besar / diminta jangan kirim)
async function deliverFiles(ctx, prompt, files) {
  const list = [];
  const seen = new Set();
  for (const raw of files || []) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(WORKDIR, raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try { if (fs.statSync(abs).isFile()) list.push(abs); } catch (_) {}
  }
  if (!list.length) return 0;

  const p = String(prompt || '');
  const explicitAsk = FILE_REQUEST_RE.test(p) && !NO_FILE_RE.test(p); // "kirim file X" → tetap kirim
  const isProject = PROJECT_RE.test(p) || list.length > MAX_AUTO_SEND_FILES;
  const noSend = !explicitAsk; // kirim file hanya bila diminta eksplisit

  if (!noSend) {
    const sent = await sendFiles(ctx, list);
    log(`File dikirim ke chat: ${sent}/${list.length}${explicitAsk ? ' (permintaan eksplisit)' : ''}`);
    return sent;
  }

  const rel = (f) => { const r = path.relative(WORKDIR, f); return r.startsWith('..') ? f : r; };
  const sample = list.slice(0, 5).map(rel).map((f) => '• ' + f).join('\n');
  await ctx.reply(
    '📁 ' + list.length + ' file dibuat/diubah — tersimpan di VPS (' + WORKDIR + '):\n' + sample +
    (list.length > 5 ? '\n• … +' + (list.length - 5) + ' file lain' : '') +
    '\n\n' + (isProject
      ? 'Tidak dikirim ke chat (project besar). Mau satu file? Sebut nama filenya: "kirim file X".'
      : 'Tidak dikirim (kamu minta jangan). Mau? Bilang "kirim file X".')
  ).catch(() => {});
  log(`File tidak dikirim (project/jangan): ${list.length} file di ${WORKDIR}`);
  return 0;
}

async function sendFiles(ctx, files) {
  const list = [];
  const seen = new Set();
  for (const raw of files) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(WORKDIR, raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    list.push(abs);
  }
  let sent = 0;
  for (const abs of list.slice(0, MAX_FILES)) {
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        await ctx.reply(`📎 ${path.basename(abs)} too big (${Math.round(stat.size / 1048576)}MB > 50MB).`).catch(() => {});
        continue;
      }
      await ctx.replyWithDocument(
        { source: fs.createReadStream(abs), filename: path.basename(abs) },
        { caption: `📎 ${path.basename(abs)}` }
      );
      sent++;
      await sleep(300);
    } catch (err) {
      log('Send file failed:', abs, err.message);
      await ctx.reply(`⚠️ Gagal kirim file: ${path.basename(abs)}`).catch(() => {});
    }
  }
  if (list.length > MAX_FILES) {
    await ctx.reply(`📎 ${list.length - MAX_FILES} file lain tidak dikirim (max ${MAX_FILES}).`).catch(() => {});
  }
  return sent;
}

const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]|\u001b\].*?\u0007|\u001b[()][AB012]|\u001b[[\]]?[0-9;]*[a-zA-Z]/g;
function stripAnsi(text) {
  return text.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim();
}

bot.catch((err, ctx) => {
  log('Telegraf error:', (err && (err.stack || err.message)) || err);
  const msg = String((err && err.message) || err || '');
  const isTimeout = (err && err.name === 'TimeoutError') || /timed out/i.test(msg);
  ctx.reply(isTimeout
    ? '⚠️ Batas waktu handler Telegram terlampaui — tugas tetap berjalan di antrean, abaikan pesan ini.'
    : '⚠️ Error bot: ' + truncate(msg, 300)).catch(() => {});
});

// Saran slash di input Telegram. Dipanggil SEBELUM launch(): promise launch() pada
// telegraf versi ini baru resolve saat polling berhenti, jadi tidak dipakai di .then().
const MENU = commandMenuPayload();
bot.telegram
  .setMyCommands(MENU)
  .then(() => log('✅ Saran slash Telegram disinkronkan:', MENU.length, 'perintah'))
  .catch((err) => log('setMyCommands gagal:', err.message));

bot.launch()
  .then(() => {
    log('✅ OpenCode Telegram bot is running (polling).');
  })
  .catch((err) => {
    log('Failed to launch bot:', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
