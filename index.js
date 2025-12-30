const http = require('http');
const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bot is running!');
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});















const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const { exec, spawn } = require('child_process');
const path = require('path');
const qrcode = require('qrcode-terminal');

// ================= CONFIG =================
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const YT_DLP_PATH = 'yt-dlp';
const FFMPEG_PATH = 'ffmpeg';
// ==========================================

// ---------- HELPERS ----------
const timeToSeconds = (t) => {
    const p = t.split(':').map(Number);
    return p[0] * 3600 + p[1] * 60 + p[2];
};

const makeProgressBar = (p) => {
    const f = Math.floor(p / 10);
    return '█'.repeat(f) + '░'.repeat(10 - f);
};

const getVideoMeta = (url) => {
    return new Promise((resolve) => {
        exec(`${YT_DLP_PATH} -J "${url}"`, { maxBuffer: 15 * 1024 * 1024 }, (e, out) => {
            if (e) return resolve(null);
            try {
                const j = JSON.parse(out);
                resolve({
                    duration: j.duration || 60
                });
            } catch {
                resolve(null);
            }
        });
    });
};
// ------------------------------------------

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ['HQ Video Bot', 'Chrome', '1.0']
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut)
                connectToWhatsApp();
        }

        if (connection === 'open') console.log('✅ Bot Online');
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const body =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            '';

        if (!body.startsWith('.dl')) return;

        const url = body.split(' ')[1];
        if (!url) {
            return sock.sendMessage(msg.key.remoteJid, { text: '❌ Provide a video link' });
        }

        const statusMsg = await sock.sendMessage(msg.key.remoteJid, { text: '⏳ Initializing HQ Processing...' });
        const statusKey = statusMsg.key;
        let last = 0;

        const update = async (t) => {
            if (Date.now() - last > 1500) {
                last = Date.now();
                await sock.sendMessage(msg.key.remoteJid, { edit: statusKey, text: t });
            }
        };

        const ts = Date.now();
        const raw = path.join(DOWNLOAD_DIR, `raw_${ts}.mp4`);
        const finalHQ = path.join(DOWNLOAD_DIR, `HQ_${ts}.mp4`);

        try {
            const meta = await getVideoMeta(url);

            // DOWNLOAD (BEST QUALITY SOURCE)
            await update('⬇️ Downloading best source...');

            const dl = spawn(YT_DLP_PATH, [
                url,
                '-f', 'bv*+ba/best',
                '--merge-output-format', 'mp4',
                '--no-playlist',
                '-o', raw
            ]);

            await new Promise((r, j) => dl.on('close', c => c === 0 ? r() : j()));

            // ONE-TIME HIGH QUALITY TRANSFORM
            await update('🎥 Transforming to EXTREMELY HIGH QUALITY...');

            const ff = spawn(FFMPEG_PATH, [
                '-i', raw,

                '-c:v', 'libx264',
                '-crf', '18',
                '-preset', 'slow',
                '-profile:v', 'high',
                '-level', '4.1',
                '-pix_fmt', 'yuv420p',
                '-r', '30',
                '-vsync', 'cfr',

                '-c:a', 'aac',
                '-b:a', '192k',
                '-ar', '48000',
                '-ac', '2',

                '-movflags', '+faststart',
                '-y',
                finalHQ
            ]);

            ff.stderr.on('data', d => {
                const t = d.toString().match(/time=(\d+:\d+:\d+)/);
                if (t && meta?.duration) {
                    const p = Math.min(100, Math.floor(timeToSeconds(t[1]) / meta.duration * 100));
                    update(`🎥 Processing HQ...\n[${makeProgressBar(p)}] ${p}%`);
                }
            });

            await new Promise((r, j) => ff.on('close', c => c === 0 ? r() : j()));

            // SEND FINAL VIDEO
            await update('📤 Uploading final HQ video...');

            await sock.sendMessage(msg.key.remoteJid, {
                video: { url: finalHQ },
                mimetype: 'video/mp4'
            });

            await update('✅ Done (HQ Complete)');

            fs.unlinkSync(raw);
            fs.unlinkSync(finalHQ);

        } catch (e) {
            await update('❌ Failed');
            if (fs.existsSync(raw)) fs.unlinkSync(raw);
            if (fs.existsSync(finalHQ)) fs.unlinkSync(finalHQ);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();
