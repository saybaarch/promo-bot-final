import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import helperPkg from "baileys_helper";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";
import path from "path";

const { sendButtons } = helperPkg;

const BASE_DIR = process.cwd();
const CONFIG_DIR = path.join(BASE_DIR, "config");
const DATA_DIR = path.join(BASE_DIR, "data");

const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");
const MESSAGES_PATH = path.join(CONFIG_DIR, "messages.json");
const BUTTONS_PATH = path.join(CONFIG_DIR, "buttons.json");

const ADMINS_DB = path.join(DATA_DIR, "admins.json");
const WHITELIST_DB = path.join(DATA_DIR, "whitelist.json");
const USERS_DB = path.join(DATA_DIR, "users.json");
const STATS_DB = path.join(DATA_DIR, "stats.json");
const AUTO_REPLY_LOG_DB = path.join(DATA_DIR, "autoReplyLog.json");
const SESSION_DIR = path.join(BASE_DIR, "session");

const WELCOME_CONTACT_BUTTON_ID = "welcome_contact_owner";

let SETTINGS = {};
let MESSAGES = {};
let BUTTONS = {};

const knownUsers = new Set();
const whitelistUsers = new Set();
const adminNumbers = new Set();
const adminLids = new Set();
const commandCooldown = new Map();

let stats = {
  totalMessages: 0,
  totalCommands: 0,
  totalAutoReplies: 0,
  totalBroadcastSuccess: 0,
  totalBroadcastFailed: 0
};

let autoReplyLog = {};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureJsonFile(filePath, defaultValue) {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

function readJson(filePath, defaultValue) {
  try {
    ensureJsonFile(filePath, defaultValue);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.log("Gagal baca JSON:", filePath, err?.message || err);
    return defaultValue;
  }
}

function writeJson(filePath, value) {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  } catch (err) {
    console.log("Gagal tulis JSON:", filePath, err?.message || err);
  }
}

function loadConfig() {
  SETTINGS = readJson(SETTINGS_PATH, {
    prefix: "!",
    brand: { name: "Sayba Arc", website: "https://sayba.web.id" },
    owner: { name: "Sayba Arc", number: "6287721916495" },
    paths: { welcomeImage: "./media/welcome.jpg" },
    autoReply: { cooldownMs: 86400000 },
    commandCooldownMs: 5000,
    broadcast: { minDelayMs: 15000, maxDelayMs: 30000 }
  });

  MESSAGES = readJson(MESSAGES_PATH, {
    welcomeCaption:
      "Halo kak {name} 👋\n\nSelamat datang di *{brandName}*.",
    welcomeInfo:
      "Informasi kontak kami:\n\n🌐 Website: {website}\n📱 Owner: {ownerNumber}\n👤 Nama Owner: {ownerName}\n\nKlik tombol *Hubungi Sekarang* di bawah untuk terhubung langsung.",
    noWelcomeImage: "Gambar welcome tidak ditemukan.",
    welcomeFollowup:
      "Silakan hubungi admin melalui link berikut:\n{waLink}",
    menu:
      "*MENU ADMIN*\n\n{prefix}stats\n{prefix}listwl\n{prefix}listadmin\n{prefix}addadmin\n{prefix}deladmin\n{prefix}addwl\n{prefix}delwl\n{prefix}bcwl\n{prefix}bcall\n{prefix}reload",
    stats:
      "*STATISTIK BOT*\n\nTotal pesan: {totalMessages}\nTotal command: {totalCommands}\nUser tersimpan: {totalKnownUsers}\nTotal whitelist: {totalWhitelist}\nAdmin number: {totalAdminNumbers}\nAdmin lid: {totalAdminLids}\nAuto reply: {totalAutoReplies}\nBroadcast sukses: {totalBroadcastSuccess}\nBroadcast gagal: {totalBroadcastFailed}",
    noAdmin: "Kamu tidak punya akses admin.",
    tooFast: "Terlalu cepat.",
    addAdminFormat: "Format: {prefix}addadmin 628xxxx atau 123456789012345@lid",
    delAdminFormat: "Format: {prefix}deladmin 628xxxx atau 123456789012345@lid",
    addWlFormat: "Format: {prefix}addwl 628xxxx,628xxxx",
    delWlFormat: "Format: {prefix}delwl 628xxxx,628xxxx",
    bcFormat: "Format: {prefix}{command} isi pesan",
    startBroadcast: "Broadcast dimulai.\nMode: {mode}\nTarget: {total}",
    endBroadcast: "Broadcast selesai.\nMode: {mode}\nTotal: {total}\nSukses: {success}\nGagal: {failed}",
    emptyTarget: "Target broadcast kosong.",
    unknownCommand: "Command tidak dikenal. Ketik {prefix}menu"
  });

  BUTTONS = readJson(BUTTONS_PATH, {
    adminFooter: "Menu admin",
    adminMenu: [
      { id: "!stats", text: "Stats" },
      { id: "!listwl", text: "Whitelist" },
      { id: "!listadmin", text: "Admin" }
    ]
  });
}

function applyTemplate(text, vars = {}) {
  let out = String(text || "");
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out;
}

function normalizeNumber(input = "") {
  return String(input).replace(/\D/g, "");
}

function normalizeJid(input = "") {
  return String(input).trim().toLowerCase();
}

function parseManyNumbers(input = "") {
  return String(input)
    .split(/[,\n\r\t;|]+/)
    .map(v => normalizeNumber(v))
    .filter(Boolean);
}

function jidFromNumber(number = "") {
  const clean = normalizeNumber(number);
  return clean ? `${clean}@s.whatsapp.net` : "";
}

function getSenderJid(msg) {
  return msg.key.participant || msg.key.remoteJid || "";
}

function getSenderNumber(senderJid = "") {
  const base = String(senderJid).split("@")[0];
  return normalizeNumber(base.split(":")[0]);
}

function getTextMessage(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    msg.message?.buttonsResponseMessage?.selectedButtonId ||
    msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.message?.templateButtonReplyMessage?.selectedId ||
    msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    ""
  );
}

function parseInteractiveResponse(rawText = "") {
  if (!rawText.startsWith("{")) return rawText;
  try {
    const parsed = JSON.parse(rawText);
    return parsed.id || parsed.selectedId || parsed.button_id || parsed.rowId || rawText;
  } catch {
    return rawText;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function ownerWaLink() {
  const raw = String(SETTINGS.owner?.number || "").replace(/\D/g, "");
  if (!raw) return "https://wa.me/";
  return `https://wa.me/${raw}`;
}

function loadDatabases() {
  const users = readJson(USERS_DB, []);
  const whitelist = readJson(WHITELIST_DB, []);
  const admins = readJson(ADMINS_DB, []);
  const savedStats = readJson(STATS_DB, stats);
  const replyLog = readJson(AUTO_REPLY_LOG_DB, {});

  knownUsers.clear();
  whitelistUsers.clear();
  adminNumbers.clear();
  adminLids.clear();

  for (const jid of users) {
    if (jid) knownUsers.add(String(jid).trim());
  }

  for (const jid of whitelist) {
    if (jid) whitelistUsers.add(String(jid).trim());
  }

  for (const admin of admins) {
    const val = normalizeJid(admin);
    if (!val) continue;

    if (val.endsWith("@lid")) {
      adminLids.add(val);
    } else {
      const num = normalizeNumber(val);
      if (num) adminNumbers.add(num);
    }
  }

  stats = {
    totalMessages: Number(savedStats.totalMessages || 0),
    totalCommands: Number(savedStats.totalCommands || 0),
    totalAutoReplies: Number(savedStats.totalAutoReplies || 0),
    totalBroadcastSuccess: Number(savedStats.totalBroadcastSuccess || 0),
    totalBroadcastFailed: Number(savedStats.totalBroadcastFailed || 0)
  };

  autoReplyLog = replyLog || {};
}

function saveUsers() {
  writeJson(USERS_DB, Array.from(knownUsers));
}

function saveWhitelist() {
  writeJson(WHITELIST_DB, Array.from(whitelistUsers));
}

function saveAdmins() {
  const merged = [...Array.from(adminNumbers), ...Array.from(adminLids)];
  writeJson(ADMINS_DB, merged);
}

function saveStats() {
  writeJson(STATS_DB, stats);
}

function saveAutoReplyLog() {
  writeJson(AUTO_REPLY_LOG_DB, autoReplyLog);
}

function isAdmin(senderJid = "") {
  const cleanJid = normalizeJid(senderJid);
  const senderNumber = getSenderNumber(cleanJid);
  return adminNumbers.has(senderNumber) || adminLids.has(cleanJid);
}

function rememberUser(senderJid = "") {
  const clean = String(senderJid || "").trim();

  if (!clean) return;
  if (!clean.endsWith("@s.whatsapp.net") && !clean.endsWith("@lid")) return;
  if (clean.endsWith("@g.us")) return;
  if (clean.endsWith("@broadcast")) return;

  if (!knownUsers.has(clean)) {
    knownUsers.add(clean);
    saveUsers();
  }
}

function isOnCommandCooldown(senderJid = "") {
  const now = Date.now();
  const last = commandCooldown.get(senderJid) || 0;

  if (now - last < Number(SETTINGS.commandCooldownMs || 5000)) {
    return true;
  }

  commandCooldown.set(senderJid, now);
  return false;
}

function canSendAutoReply(senderJid = "") {
  const last = autoReplyLog[senderJid] || 0;
  const now = Date.now();
  return now - last >= Number(SETTINGS.autoReply?.cooldownMs || 86400000);
}

function markAutoReplySent(senderJid = "") {
  autoReplyLog[senderJid] = Date.now();
  saveAutoReplyLog();
}

function getAllTargets() {
  return Array.from(knownUsers).filter(
    jid => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")
  );
}

function getWhitelistTargets() {
  return Array.from(whitelistUsers).filter(
    jid => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")
  );
}

function addWhitelistBulk(numbers = []) {
  let added = 0;
  let skipped = 0;
  const addedList = [];

  for (const number of numbers) {
    const jid = jidFromNumber(number);
    if (!jid) {
      skipped++;
      continue;
    }

    if (whitelistUsers.has(jid)) {
      skipped++;
      continue;
    }

    whitelistUsers.add(jid);
    added++;
    addedList.push(number);
  }

  saveWhitelist();
  return { added, skipped, addedList };
}

function removeWhitelistBulk(numbers = []) {
  let removed = 0;
  let skipped = 0;
  const removedList = [];

  for (const number of numbers) {
    const jid = jidFromNumber(number);
    if (!jid) {
      skipped++;
      continue;
    }

    if (!whitelistUsers.has(jid)) {
      skipped++;
      continue;
    }

    whitelistUsers.delete(jid);
    removed++;
    removedList.push(number);
  }

  saveWhitelist();
  return { removed, skipped, removedList };
}

function addAdmin(input = "") {
  const raw = normalizeJid(input);
  if (!raw) return { ok: false, reason: "invalid" };

  if (raw.endsWith("@lid")) {
    if (adminLids.has(raw)) return { ok: false, reason: "exists" };
    adminLids.add(raw);
    saveAdmins();
    return { ok: true, value: raw, type: "lid" };
  }

  const clean = normalizeNumber(raw);
  if (!clean) return { ok: false, reason: "invalid" };
  if (adminNumbers.has(clean)) return { ok: false, reason: "exists" };

  adminNumbers.add(clean);
  saveAdmins();
  return { ok: true, value: clean, type: "number" };
}

function removeAdmin(input = "") {
  const raw = normalizeJid(input);
  if (!raw) return { ok: false, reason: "invalid" };

  if (raw.endsWith("@lid")) {
    if (!adminLids.has(raw)) return { ok: false, reason: "not_found" };
    adminLids.delete(raw);
    saveAdmins();
    return { ok: true, value: raw, type: "lid" };
  }

  const clean = normalizeNumber(raw);
  if (!clean) return { ok: false, reason: "invalid" };
  if (!adminNumbers.has(clean)) return { ok: false, reason: "not_found" };

  adminNumbers.delete(clean);
  saveAdmins();
  return { ok: true, value: clean, type: "number" };
}

function menuText() {
  return applyTemplate(MESSAGES.menu, { prefix: SETTINGS.prefix });
}

function statsText() {
  return applyTemplate(MESSAGES.stats, {
    totalMessages: stats.totalMessages,
    totalCommands: stats.totalCommands,
    totalKnownUsers: knownUsers.size,
    totalWhitelist: whitelistUsers.size,
    totalAdminNumbers: adminNumbers.size,
    totalAdminLids: adminLids.size,
    totalAutoReplies: stats.totalAutoReplies,
    totalBroadcastSuccess: stats.totalBroadcastSuccess,
    totalBroadcastFailed: stats.totalBroadcastFailed
  });
}

async function safeSendAdminButtons(sock, jid, text, title = "MENU") {
  try {
    await sendButtons(sock, jid, {
      title,
      text,
      footer: BUTTONS.adminFooter || "Menu admin",
      buttons: Array.isArray(BUTTONS.adminMenu) ? BUTTONS.adminMenu : []
    });
  } catch (err) {
    console.log("Admin button gagal, fallback text:", err?.message || err);
    await sock.sendMessage(jid, { text });
  }
}

async function sendWelcome(sock, jid, pushName = "kak") {
  const welcomeImage = SETTINGS.paths?.welcomeImage || "./media/welcome.jpg";

  const caption = applyTemplate(MESSAGES.welcomeCaption, {
    name: pushName,
    brandName: SETTINGS.brand?.name || "Brand"
  });

  const infoText = applyTemplate(MESSAGES.welcomeInfo, {
    website: SETTINGS.brand?.website || "-",
    ownerNumber: SETTINGS.owner?.number || "-",
    ownerName: SETTINGS.owner?.name || "Owner"
  });

  // Bubble 1 = foto + caption welcome
  if (fs.existsSync(welcomeImage)) {
    try {
      await sock.sendMessage(jid, {
        image: fs.readFileSync(welcomeImage),
        caption
      });
    } catch (err) {
      console.log("Gagal kirim foto welcome:", err?.message || err);
      await sock.sendMessage(jid, { text: caption });
    }
  } else {
    await sock.sendMessage(jid, { text: caption });
  }

  // Bubble 2 = info + tombol reply
  try {
    await sock.sendMessage(jid, {
      text: infoText,
      footer: SETTINGS.brand?.name || "Brand",
      buttons: [
        {
          buttonId: WELCOME_CONTACT_BUTTON_ID,
          buttonText: { displayText: "Hubungi Sekarang" },
          type: 1
        }
      ],
      headerType: 1
    });
  } catch (err) {
    console.log("Gagal kirim tombol welcome:", err?.message || err);

    // fallback kalau button gagal
    await sock.sendMessage(jid, {
      text: `${infoText}\n\nKetik *Hubungi Sekarang* untuk lanjut.`
    });
  }
}

async function sendOwnerLink(sock, jid) {
  const waLink = ownerWaLink();
  const ownerName = SETTINGS.owner?.name || "Owner";

  await sock.sendMessage(jid, {
    text: `Silakan hubungi *${ownerName}* melalui link berikut:\n${waLink}`
  });
}

async function broadcastText(sock, targets, text) {
  let success = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const targetJid = targets[i];

    try {
      await sock.sendMessage(targetJid, { text });
      success++;
      stats.totalBroadcastSuccess++;
      saveStats();
    } catch (err) {
      failed++;
      stats.totalBroadcastFailed++;
      saveStats();
      console.log("Broadcast gagal:", targetJid, err?.message || err);
    }

    if (i < targets.length - 1) {
      await delay(
        randomDelay(
          Number(SETTINGS.broadcast?.minDelayMs || 15000),
          Number(SETTINGS.broadcast?.maxDelayMs || 30000)
        )
      );
    }
  }

  return { total: targets.length, success, failed };
}

console.log("BOT STARTING...");

async function startBot() {
  loadConfig();
  loadDatabases();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log("Baileys version:", version);
  console.log("Admin Numbers:", Array.from(adminNumbers));
  console.log("Admin LIDs:", Array.from(adminLids));

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.04"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    console.log("connection.update:", connection);

    if (qr) {
      console.log("SCAN QR:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("BOT CONNECTED");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log("Connection closed. Status:", statusCode);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("Logged out. Hapus folder session lalu login ulang.");
        return;
      }

      console.log("RECONNECT...");
      setTimeout(startBot, 3000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;

      const msg = messages[0];
      if (!msg || msg.key.fromMe || !msg.message) return;

      const jid = msg.key.remoteJid;
      const sender = getSenderJid(msg);
      const pushName = msg.pushName || "kak";

      if (!jid || jid.endsWith("@g.us")) return;

      let rawText = getTextMessage(msg);
      rawText = parseInteractiveResponse(rawText);

      const originalText = String(rawText || "").trim();
      const lowerText = originalText.toLowerCase();

      stats.totalMessages++;
      saveStats();

      rememberUser(sender);

      if (
        originalText === WELCOME_CONTACT_BUTTON_ID ||
        lowerText === "hubungi sekarang"
      ) {
        await sendOwnerLink(sock, jid);
        return;
      }

      if (!isAdmin(sender) && canSendAutoReply(sender)) {
        await sendWelcome(sock, jid, pushName);
        markAutoReplySent(sender);
        stats.totalAutoReplies++;
        saveStats();
      }

      if (!lowerText.startsWith(SETTINGS.prefix || "!")) return;

      stats.totalCommands++;
      saveStats();

      if (!isAdmin(sender)) {
        await sock.sendMessage(jid, {
          text: MESSAGES.noAdmin || "Kamu tidak punya akses admin."
        });
        return;
      }

      if (isOnCommandCooldown(sender)) {
        await sock.sendMessage(jid, {
          text: MESSAGES.tooFast || "Terlalu cepat."
        });
        return;
      }

      const args = originalText
        .slice((SETTINGS.prefix || "!").length)
        .trim()
        .split(/\s+/);

      const command = (args.shift() || "").toLowerCase();
      const text = args.join(" ").trim();

      if (command === "reload") {
        loadConfig();
        await safeSendAdminButtons(sock, jid, "Config berhasil di-reload.", "RELOAD");
        return;
      }

      if (command === "menu") {
        await safeSendAdminButtons(sock, jid, menuText(), "MENU ADMIN");
        return;
      }

      if (command === "stats") {
        await safeSendAdminButtons(sock, jid, statsText(), "STATISTIK");
        return;
      }

      if (command === "listadmin") {
        const numberList = Array.from(adminNumbers).map(v => `- ${v}`);
        const lidList = Array.from(adminLids).map(v => `- ${v}`);

        const textAdmin = `*DAFTAR ADMIN*

*Admin Number:*
${numberList.length ? numberList.join("\n") : "- kosong"}

*Admin LID:*
${lidList.length ? lidList.join("\n") : "- kosong"}`;

        await safeSendAdminButtons(sock, jid, textAdmin, "ADMIN");
        return;
      }

      if (command === "addadmin") {
        if (!text) {
          await sock.sendMessage(jid, {
            text: applyTemplate(MESSAGES.addAdminFormat, {
              prefix: SETTINGS.prefix || "!"
            })
          });
          return;
        }

        const result = addAdmin(text);
        await sock.sendMessage(jid, {
          text: result.ok
            ? `Admin berhasil ditambahkan (${result.type}): ${result.value}`
            : `Gagal tambah admin: ${result.reason}`
        });
        return;
      }

      if (command === "deladmin") {
        if (!text) {
          await sock.sendMessage(jid, {
            text: applyTemplate(MESSAGES.delAdminFormat, {
              prefix: SETTINGS.prefix || "!"
            })
          });
          return;
        }

        const result = removeAdmin(text);
        await sock.sendMessage(jid, {
          text: result.ok
            ? `Admin berhasil dihapus (${result.type}): ${result.value}`
            : `Gagal hapus admin: ${result.reason}`
        });
        return;
      }

      if (command === "listwl") {
        const list = Array.from(whitelistUsers)
          .map(v => `- ${v.replace("@s.whatsapp.net", "")}`)
          .join("\n");

        await safeSendAdminButtons(
          sock,
          jid,
          `*DAFTAR WHITELIST*
Total: ${whitelistUsers.size}

${list || "- kosong"}`,
          "WHITELIST"
        );
        return;
      }

      if (command === "addwl") {
        const numbers = parseManyNumbers(text);
        if (!numbers.length) {
          await sock.sendMessage(jid, {
            text: applyTemplate(MESSAGES.addWlFormat, {
              prefix: SETTINGS.prefix || "!"
            })
          });
          return;
        }

        const result = addWhitelistBulk(numbers);
        await sock.sendMessage(jid, {
          text: `*ADD WHITELIST SELESAI*

Input: ${numbers.length}
Berhasil ditambah: ${result.added}
Dilewati: ${result.skipped}

${
  result.addedList.length
    ? `Nomor masuk:\n- ${result.addedList.join("\n- ")}`
    : "Tidak ada nomor baru."
}`
        });
        return;
      }

      if (command === "delwl") {
        const numbers = parseManyNumbers(text);
        if (!numbers.length) {
          await sock.sendMessage(jid, {
            text: applyTemplate(MESSAGES.delWlFormat, {
              prefix: SETTINGS.prefix || "!"
            })
          });
          return;
        }

        const result = removeWhitelistBulk(numbers);
        await sock.sendMessage(jid, {
          text: `*HAPUS WHITELIST SELESAI*

Input: ${numbers.length}
Berhasil dihapus: ${result.removed}
Dilewati: ${result.skipped}

${
  result.removedList.length
    ? `Nomor terhapus:\n- ${result.removedList.join("\n- ")}`
    : "Tidak ada nomor yang dihapus."
}`
        });
        return;
      }

      if (command === "bcwl" || command === "bcall") {
        if (!text) {
          await sock.sendMessage(jid, {
            text: applyTemplate(MESSAGES.bcFormat, {
              prefix: SETTINGS.prefix || "!",
              command
            })
          });
          return;
        }

        const targets = command === "bcwl" ? getWhitelistTargets() : getAllTargets();
        if (!targets.length) {
          await sock.sendMessage(jid, {
            text: MESSAGES.emptyTarget || "Target broadcast kosong."
          });
          return;
        }

        await sock.sendMessage(jid, {
          text: applyTemplate(MESSAGES.startBroadcast, {
            mode: command,
            total: targets.length
          })
        });

        const result = await broadcastText(sock, targets, text);

        await sock.sendMessage(jid, {
          text: applyTemplate(MESSAGES.endBroadcast, {
            mode: command,
            total: result.total,
            success: result.success,
            failed: result.failed
          })
        });
        return;
      }

      if (command === "testwelcome") {
        await sendWelcome(sock, jid, pushName);
        return;
      }

      await sock.sendMessage(jid, {
        text: applyTemplate(MESSAGES.unknownCommand, {
          prefix: SETTINGS.prefix || "!"
        })
      });
    } catch (err) {
      console.error("ERROR BALAS PESAN:", err);
    }
  });
}

startBot().catch(console.error);
