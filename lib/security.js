'use strict';
// ابزارهای امنیتی بدون وابستگی خارجی: TOTP (RFC 6238)، رمزنگاری کلید، امضای بلیت، محدودکننده نرخ، سیاست رمز
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---------- کلید برنامه ----------
// کلید در فایل جدا (خارج از دیتابیس) نگه داشته می‌شود تا بکاپ دیتابیس به‌تنهایی رازهای 2FA را فاش نکند.
function loadKey(dataDir) {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(String(process.env.APP_SECRET)).digest();
  const f = path.join(dataDir, 'app.key');
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
  return k;
}
const b64u = (b) => Buffer.from(b).toString('base64url');
function makeCrypto(key) {
  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), enc].map((x) => x.toString('base64')).join('.');
    },
    decrypt(blob) {
      const [iv, tag, enc] = String(blob).split('.').map((x) => Buffer.from(x, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    },
    sign(obj, ttlMs) { // بلیت امضاشده کوتاه‌عمر
      const body = b64u(JSON.stringify({ ...obj, exp: Date.now() + ttlMs }));
      return body + '.' + crypto.createHmac('sha256', key).update(body).digest('base64url');
    },
    unsign(tok) {
      const [body, sig] = String(tok || '').split('.'); if (!body || !sig) return null;
      const good = crypto.createHmac('sha256', key).update(body).digest('base64url');
      const a = Buffer.from(sig), b = Buffer.from(good);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
    },
  };
}

// ---------- TOTP ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32enc = (buf) => { let bits = '', out = ''; for (const x of buf) bits += x.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const b32dec = (s) => { let bits = ''; for (const c of s.replace(/[\s=-]/g, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) throw new Error('bad base32'); bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
const newSecret = () => b32enc(crypto.randomBytes(20));
function hotp(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(buf).digest(), o = h[19] & 15;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).padStart(6, '0');
}
// خروجی: گام زمانی معتبر (برای جلوگیری از استفاده مجدد) یا null
function verifyTotp(secret, code, lastStep = 0) {
  code = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const step = now + d, ok = crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code));
    if (ok && step > lastStep) return step;
  }
  return null;
}
const otpauth = (secret, account, issuer = 'Catalizor') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---------- کدهای بازیابی ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newRecoveryCodes = (n = 8) => Array.from({ length: n }, () => { const h = crypto.randomBytes(5).toString('hex'); return h.slice(0, 5) + '-' + h.slice(5); });

// ---------- محدودکننده نرخ (حافظه) ----------
const buckets = new Map();
function hit(key, limit, windowMs) { // true = از حد گذشته
  const now = Date.now(); let b = buckets.get(key);
  if (!b || now - b.t > windowMs) { b = { n: 0, t: now }; buckets.set(key, b); }
  b.n++; return b.n > limit;
}
const peek = (key, limit, windowMs) => { const b = buckets.get(key); return !!b && Date.now() - b.t <= windowMs && b.n >= limit; };
const clear = (key) => buckets.delete(key);
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 3600e3) buckets.delete(k); }, 600e3).unref();

// ---------- سیاست رمز ----------
function checkPassword(pw, username = '') {
  pw = String(pw || '');
  if (pw.length < 10) return 'رمز باید حداقل ۱۰ کاراکتر باشد';
  if (pw.length > 200) return 'رمز بیش از حد طولانی است';
  if (/^\d+$/.test(pw)) return 'رمز نباید فقط عدد باشد';
  if (new Set(pw).size < 5) return 'رمز بیش از حد ساده است';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'رمز نباید شامل نام کاربری باشد';
  if (/^(password|12345678|qwertyuiop|1q2w3e4r5t)/i.test(pw)) return 'این رمز بسیار رایج است';
  return null;
}

// ---------- تشخیص نوع فایل از محتوا (نه از نام یا هدر کاربر) ----------
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

module.exports = { loadKey, makeCrypto, newSecret, verifyTotp, otpauth, sha, newRecoveryCodes, hit, peek, clear, checkPassword, sniff, b32dec, hotp };
