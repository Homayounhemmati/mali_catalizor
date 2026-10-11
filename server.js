'use strict';
// سرور بدون وابستگی خارجی: فقط Node 22.13+ (sqlite و crypto داخلی)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const S = require('./lib/security');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
const C = S.makeCrypto(S.loadKey(DATA_DIR));
const db = new DatabaseSync(path.join(DATA_DIR, 'finance.db'));
try { fs.chmodSync(path.join(DATA_DIR, 'finance.db'), 0o600); } catch {}
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','accountant','partner')),
  pass TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('income','expense')), UNIQUE(name,type));
CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('income','expense')),
  amount INTEGER NOT NULL CHECK(amount > 0), date TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id), party TEXT DEFAULT '', method TEXT DEFAULT 'cash',
  ref TEXT DEFAULT '', note TEXT DEFAULT '', created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS invoices(
  id INTEGER PRIMARY KEY, number INTEGER UNIQUE NOT NULL, date TEXT NOT NULL, customer TEXT NOT NULL,
  phone TEXT DEFAULT '', address TEXT DEFAULT '', discount INTEGER NOT NULL DEFAULT 0, tax_percent REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid')), tx_id INTEGER,
  created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invoice_items(
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  title TEXT NOT NULL, qty REAL NOT NULL, price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, company TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'lead' CHECK(status IN ('lead','active','vip','inactive')),
  source TEXT DEFAULT '', note TEXT DEFAULT '', follow_up TEXT, created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS customer_notes(
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note','call','meeting','message')), text TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_notes_cust ON customer_notes(customer_id);
CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'bank' CHECK(kind IN ('bank','cash','card','other')),
  opening INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS transfers(
  id INTEGER PRIMARY KEY, from_account INTEGER NOT NULL REFERENCES accounts(id), to_account INTEGER NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL CHECK(amount > 0), date TEXT NOT NULL, note TEXT DEFAULT '', created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dues(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('cheque','installment')), direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  title TEXT NOT NULL DEFAULT '', party TEXT NOT NULL DEFAULT '', customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL, number TEXT DEFAULT '', bank TEXT DEFAULT '',
  amount INTEGER NOT NULL CHECK(amount > 0), due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','bounced','cancelled')),
  done_date TEXT, tx_id INTEGER, account_id INTEGER REFERENCES accounts(id), group_id TEXT, note TEXT DEFAULT '',
  created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT, deleted_by INTEGER);
CREATE INDEX IF NOT EXISTS idx_dues_due ON dues(due_date);
CREATE TABLE IF NOT EXISTS attachments(
  id INTEGER PRIMARY KEY, entity TEXT NOT NULL CHECK(entity IN ('transaction','due')), entity_id INTEGER NOT NULL,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_att ON attachments(entity, entity_id);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, detail TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

if (!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'last_seen')) { // نشست‌های قدیمی (توکن خام) نامعتبر می‌شوند
  db.exec('DROP TABLE IF EXISTS sessions');
  db.exec('CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL, last_seen INTEGER NOT NULL)');
}
for (const [col, def] of [['totp_secret', 'TEXT'], ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['totp_last', 'INTEGER NOT NULL DEFAULT 0'], ['recovery', 'TEXT'], ['must_change', 'INTEGER NOT NULL DEFAULT 0']])
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
if (!db.prepare('PRAGMA table_info(transactions)').all().some((c) => c.name === 'account_id')) db.exec('ALTER TABLE transactions ADD COLUMN account_id INTEGER REFERENCES accounts(id)');
if (!db.prepare('PRAGMA table_info(invoices)').all().some((c) => c.name === 'customer_id'))
  db.exec('ALTER TABLE invoices ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL');

for (const [col, def] of [['tags', "TEXT NOT NULL DEFAULT ''"], ['follow_up_note', "TEXT NOT NULL DEFAULT ''"], ['assignee', 'INTEGER REFERENCES users(id) ON DELETE SET NULL']])
  if (!db.prepare('PRAGMA table_info(customers)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE customers ADD COLUMN ${col} ${def}`);
for (const t of ['transactions', 'invoices', 'customers']) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols.includes('deleted_at')) db.exec(`ALTER TABLE ${t} ADD COLUMN deleted_at TEXT`);
  if (!cols.includes('deleted_by')) db.exec(`ALTER TABLE ${t} ADD COLUMN deleted_by INTEGER`);
}

// ---------- رمز عبور ----------
const hash = (pw) => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const verify = (pw, stored) => {
  const [s, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, s, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ---------- داده اولیه ----------
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const u = process.env.ADMIN_USER || 'admin';
  const generated = !process.env.ADMIN_PASS, p = process.env.ADMIN_PASS || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users(username,name,role,pass,must_change) VALUES(?,?,?,?,1)').run(u.toLowerCase(), 'مدیر', 'owner', hash(p));
  console.log(`\n=== کاربر اولیه ساخته شد ===\nنام کاربری: ${u}\n${generated ? 'رمز عبور موقت: ' + p : 'رمز عبور: همان ADMIN_PASS که تنظیم کردید'}\n(در اولین ورود باید رمز جدید انتخاب کنید)\n`);
  const ins = db.prepare('INSERT OR IGNORE INTO categories(name,type) VALUES(?,?)');
  ['فروش', 'خدمات', 'سرمایه شریک', 'سایر درآمد'].forEach((n) => ins.run(n, 'income'));
  ['خرید کالا/مواد', 'حقوق و دستمزد', 'اجاره', 'قبوض', 'حمل و نقل', 'تبلیغات', 'مالیات و عوارض', 'برداشت شریک', 'سایر هزینه'].forEach((n) => ins.run(n, 'expense'));
}

if (!db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) db.prepare("INSERT INTO accounts(name,kind) VALUES('صندوق (نقد)','cash')").run();

// ---------- نقش‌ها ----------
// owner: همه‌چیز | accountant: ثبت/ویرایش تراکنش و دسته‌ها | partner: فقط مشاهده
const can = {
  write: (u) => u.role === 'owner' || u.role === 'accountant',
  delete: (u) => u.role === 'owner',
  admin: (u) => u.role === 'owner',
};
const audit = (u, action, detail) => db.prepare('INSERT INTO audit(user_id,action,detail) VALUES(?,?,?)').run(u ? u.id : null, action, JSON.stringify(detail));

// ---------- ابزارها ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const readRaw = (req, limit = 1e6) => new Promise((ok, no) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > limit) { no(new HttpError(413, 'حجم درخواست زیاد است')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', () => no(new HttpError(400, 'خطا در دریافت درخواست')));
});
const readBody = async (req, limit = 1e6) => {
  const raw = (await readRaw(req, limit)).toString('utf8');
  try { const o = raw ? JSON.parse(raw) : {}; if (o === null || typeof o !== 'object') throw 0; return o; } catch { throw new HttpError(400, 'JSON نامعتبر'); }
};
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const isSecure = (req) => process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
const SESSION_TTL = 7 * 864e5, IDLE_TTL = 12 * 36e5;
const tokenHash = (t) => S.sha(String(t));
const sessionCookie = (req, token, maxAge) => `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
const REQUIRE_2FA = process.env.REQUIRE_2FA === '1';
const currentUser = (req) => {
  const t = cookies(req).sid; if (!t || !/^[0-9a-f]{64}$/.test(t)) return null;
  const now = Date.now(), h = tokenHash(t);
  const u = db.prepare('SELECT u.id,u.username,u.name,u.role,u.must_change,u.totp_enabled,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND s.last_seen>? AND u.active=1').get(h, now, now - IDLE_TTL);
  if (!u) return null;
  if (now - u.last_seen > 60e3) db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now, h);
  u.sid_hash = h; u.need_2fa_setup = REQUIRE_2FA && u.role === 'owner' && !u.totp_enabled ? 1 : 0;
  return u;
};
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, username: u.username, must_change: !!u.must_change, totp_enabled: !!u.totp_enabled, need_2fa_setup: !!u.need_2fa_setup });
function issueSession(req, res, u, body = {}) {
  const token = crypto.randomBytes(32).toString('hex'), now = Date.now();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(tokenHash(token), u.id, now + SESSION_TTL, now);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND (expires<? OR last_seen<?)').run(u.id, now, now - IDLE_TTL);
  audit(u, 'login', { ip: clientIp(req) });
  send(res, 200, { ...publicUser({ ...u, totp_enabled: u.totp_enabled }), ...body }, { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL / 1000) });
}
const clientIp = (req) => { // پشت پراکسی مورد اعتماد، آخرین مقدار XFF را خود پراکسی اضافه کرده است
  const x = req.headers['x-forwarded-for']; if (x) { const parts = String(x).split(',').map((v) => v.trim()).filter(Boolean); if (parts.length) return parts[parts.length - 1]; }
  return req.socket.remoteAddress || 'unknown';
};
const DUMMY_HASH = hash('dummy-password-for-timing');
// قفل ورود: هر (کاربر+IP) ۵ تلاش، هر IP ۲۰ تلاش، هر نام کاربری در مجموع ۳۰ تلاش در ۱۵ دقیقه
// (قفل صرفاً بر اساس نام کاربری به مهاجم اجازه می‌داد حساب مدیر را عمداً قفل کند)
const W15 = 15 * 60e3;
const lockedOut = (ip, uname) => S.peek('login:ui:' + uname + '|' + ip, 5, W15) || S.peek('login:ip:' + ip, 20, W15) || S.peek('login:u:' + uname, 30, W15);
const recordFail = (ip, uname) => { S.hit('login:ui:' + uname + '|' + ip, 1e9, W15); S.hit('login:ip:' + ip, 1e9, W15); S.hit('login:u:' + uname, 1e9, W15); };
// بررسی کد TOTP یا کد بازیابی یک‌بارمصرف؛ وضعیت مصرف را ذخیره می‌کند
function verify2fa(u, code) {
  code = String(code || '').trim();
  const step = S.verifyTotp(C.decrypt(u.totp_secret), code, u.totp_last);
  if (step) { db.prepare('UPDATE users SET totp_last=? WHERE id=?').run(step, u.id); return true; }
  if (/^[0-9a-f]{5}-[0-9a-f]{5}$/i.test(code)) {
    const list = JSON.parse(u.recovery || '[]'), i = list.indexOf(S.sha(code.toLowerCase()));
    if (i >= 0) { list.splice(i, 1); db.prepare('UPDATE users SET recovery=? WHERE id=?').run(JSON.stringify(list), u.id); audit(u, '2fa.recovery_used', { left: list.length }); return true; }
  }
  return false;
}
const need = (ok, msg = 'دسترسی مجاز نیست') => { if (!ok) throw new HttpError(403, msg); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function txFilter(q) {
  const w = ['t.deleted_at IS NULL'], p = [];
  if (q.type === 'income' || q.type === 'expense') { w.push('t.type=?'); p.push(q.type); }
  if (isDate(q.from)) { w.push('t.date>=?'); p.push(q.from); }
  if (isDate(q.to)) { w.push('t.date<=?'); p.push(q.to); }
  if (q.category) { w.push('t.category_id=?'); p.push(+q.category); }
  if (q.account) { w.push('t.account_id=?'); p.push(+q.account); }
  if (q.q) { w.push('(t.party LIKE ? OR t.note LIKE ? OR t.ref LIKE ?)'); const s = `%${q.q}%`; p.push(s, s, s); }
  return { where: 'WHERE ' + w.join(' AND '), p };
}
const TX_SELECT = `SELECT t.*, c.name AS category, u.name AS author, ac.name AS account,
  (SELECT COUNT(*) FROM attachments a WHERE a.entity='transaction' AND a.entity_id=t.id) AS att FROM transactions t
  LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN users u ON u.id=t.created_by LEFT JOIN accounts ac ON ac.id=t.account_id`;

function accountId(v) {
  if (v === null || v === undefined || v === '') return null;
  const a = db.prepare('SELECT id FROM accounts WHERE id=? AND active=1').get(+v);
  if (!a) throw new HttpError(400, 'حساب نامعتبر یا غیرفعال است');
  return a.id;
}
function cleanTx(b) {
  const amount = Math.round(Number(b.amount));
  if (!['income', 'expense'].includes(b.type)) throw new HttpError(400, 'نوع تراکنش نامعتبر است');
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'مبلغ باید بزرگ‌تر از صفر باشد');
  if (!isDate(b.date)) throw new HttpError(400, 'تاریخ نامعتبر است');
  const method = ['cash', 'card', 'transfer', 'cheque', 'other'].includes(b.method) ? b.method : 'cash';
  let cat = null;
  if (b.category_id) { const c = db.prepare('SELECT id,type FROM categories WHERE id=?').get(+b.category_id); if (!c || c.type !== b.type) throw new HttpError(400, 'دسته نامعتبر است'); cat = c.id; }
  return [b.type, amount, b.date, cat, String(b.party || '').slice(0, 120), method, String(b.ref || '').slice(0, 60), String(b.note || '').slice(0, 500), accountId(b.account_id)];
}



const STATUSES = ['lead', 'active', 'vip', 'inactive'];
const invTotal = (sub, discount, taxPct) => { const base = Math.max(0, sub - discount); return base + Math.round(base * taxPct / 100); };
// آمار مالی همه مشتری‌ها: {customer_id: {count, invoiced, paid, due}}
function customerFinance(onlyId) {
  const invs = db.prepare(`SELECT id,customer_id,status,discount,tax_percent FROM invoices WHERE deleted_at IS NULL AND customer_id IS NOT NULL${onlyId ? ' AND customer_id=' + (+onlyId) : ''}`).all();
  const sums = new Map();
  for (const r of db.prepare('SELECT invoice_id, qty, price FROM invoice_items').all()) sums.set(r.invoice_id, (sums.get(r.invoice_id) || 0) + Math.round(r.qty * r.price));
  const out = new Map();
  for (const i of invs) {
    const t = invTotal(sums.get(i.id) || 0, i.discount, i.tax_percent), o = out.get(i.customer_id) || { count: 0, invoiced: 0, paid: 0, due: 0 };
    o.count++; o.invoiced += t; if (i.status === 'paid') o.paid += t; else o.due += t; out.set(i.customer_id, o);
  }
  return out;
}
const STATUS_FA = { lead: 'سرنخ', active: 'فعال', vip: 'ویژه', inactive: 'غیرفعال' };
const normTags = (v) => {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,،;\n]/);
  return [...new Set(arr.map((x) => String(x).trim().replace(/\s+/g, ' ').slice(0, 24)).filter(Boolean))].slice(0, 10).join(',');
};
const phoneKey = (p) => String(p || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/\D/g, '').slice(-10);
function cleanCustomer(b) {
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'نام مشتری را وارد کنید');
  if (b.status && !STATUSES.includes(b.status)) throw new HttpError(400, 'وضعیت نامعتبر است');
  const t = (k, n) => String(b[k] || '').trim().slice(0, n);
  let assignee = null;
  if (b.assignee) { if (!db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(+b.assignee)) throw new HttpError(400, 'مسئول پیگیری نامعتبر است'); assignee = +b.assignee; }
  const follow_up = isDate(b.follow_up) ? b.follow_up : null;
  return { name, company: t('company', 120), phone: t('phone', 40), email: t('email', 120), address: t('address', 300), status: b.status || 'lead', source: t('source', 60), note: t('note', 1000), follow_up, follow_up_note: follow_up ? t('follow_up_note', 200) : '', tags: normTags(b.tags), assignee };
}
// فهرست کامل مشتریان با آمار (برای فیلتر/مرتب‌سازی/بخش‌بندی در سرور)
function customersWithStats() {
  const fin = customerFinance();
  return db.prepare(`SELECT c.*, u.name AS assignee_name,
      (SELECT MAX(created_at) FROM customer_notes n WHERE n.customer_id=c.id) AS last_contact,
      (SELECT COUNT(*) FROM customer_notes n WHERE n.customer_id=c.id) AS notes_count,
      (SELECT MAX(date) FROM invoices i WHERE i.customer_id=c.id AND i.deleted_at IS NULL) AS last_invoice_date
    FROM customers c LEFT JOIN users u ON u.id=c.assignee WHERE c.deleted_at IS NULL`).all()
    .map((r) => ({ ...r, ...(fin.get(r.id) || { count: 0, invoiced: 0, paid: 0, due: 0 }) }));
}
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function invoiceFull(id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
  inv.items = db.prepare('SELECT title,qty,price FROM invoice_items WHERE invoice_id=? ORDER BY id').all(id);
  inv.subtotal = inv.items.reduce((a, i) => a + Math.round(i.qty * i.price), 0);
  inv.tax = Math.round(Math.max(0, inv.subtotal - inv.discount) * inv.tax_percent / 100);
  inv.total = Math.max(0, inv.subtotal - inv.discount) + inv.tax;
  if (inv.customer_id) inv.customer_status = (db.prepare('SELECT status FROM customers WHERE id=?').get(inv.customer_id) || {}).status || null;
  return inv;
}
function cleanInvoice(b) {
  if (!isDate(b.date)) throw new HttpError(400, 'تاریخ نامعتبر است');
  const customer = String(b.customer || '').trim().slice(0, 120);
  if (!customer) throw new HttpError(400, 'نام مشتری را وارد کنید');
  const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({ title: String(i.title || '').trim().slice(0, 200), qty: Number(i.qty), price: Math.round(Number(i.price)) }))
    .filter((i) => i.title);
  if (!items.length || items.length > 100) throw new HttpError(400, 'حداقل یک ردیف کالا/خدمت لازم است');
  if (items.some((i) => !(i.qty > 0) || !Number.isFinite(i.price) || i.price < 0)) throw new HttpError(400, 'تعداد و قیمت ردیف‌ها نامعتبر است');
  const tax_percent = Math.min(100, Math.max(0, Number(b.tax_percent) || 0));
  const discount = Math.max(0, Math.round(Number(b.discount) || 0));
  let customer_id = null;
  if (b.customer_id) { if (!db.prepare('SELECT 1 FROM customers WHERE id=? AND deleted_at IS NULL').get(+b.customer_id)) throw new HttpError(400, 'مشتری یافت نشد'); customer_id = +b.customer_id; }
  return { customer_id, date: b.date, customer, phone: String(b.phone || '').slice(0, 40), address: String(b.address || '').slice(0, 300), discount, tax_percent, note: String(b.note || '').slice(0, 500), items };
}
function saveItems(id, items) {
  const ins = db.prepare('INSERT INTO invoice_items(invoice_id,title,qty,price) VALUES(?,?,?,?)');
  items.forEach((i) => ins.run(id, i.title, i.qty, i.price));
}


// ---------- بکاپ ----------
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = +process.env.BACKUP_KEEP || 30;
const BACKUP_RE = /^finance-\d{4}-\d{2}-\d{2}(_\d{6})?\.db$/;
let lastTelegram = null;
const listBackups = () => { fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_RE.test(f)).map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, at: st.mtimeMs }; }).sort((a, b) => b.at - a.at); };
async function sendTelegram(file, name) {
  const tk = process.env.BACKUP_TELEGRAM_TOKEN, chat = process.env.BACKUP_TELEGRAM_CHAT; if (!tk || !chat) return;
  try {
    const fd = new FormData(); fd.append('chat_id', chat); fd.append('caption', `بکاپ حسابداری کاتالیزور — ${name}`);
    fd.append('document', new Blob([fs.readFileSync(file)]), name);
    const r = await fetch(`https://api.telegram.org/bot${tk}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
    lastTelegram = { ok: r.ok, at: Date.now(), status: r.status };
  } catch (e) { lastTelegram = { ok: false, at: Date.now(), error: e.message }; }
}
function makeBackup(manual) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const d = new Date(), day = d.toISOString().slice(0, 10), name = `finance-${day}${manual ? '_' + d.toISOString().slice(11, 19).replace(/:/g, '') : ''}.db`, file = path.join(BACKUP_DIR, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try { fs.chmodSync(file, 0o600); } catch {}
  for (const old of listBackups().slice(BACKUP_KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, old.name));
  sendTelegram(file, name);
  return name;
}
let lastBackupCheck = 0;
function ensureDailyBackup() { // روی هاست‌هایی که برنامه را در بی‌کاری خاموش می‌کنند هم کار می‌کند
  if (Date.now() - lastBackupCheck < 6e4) return; lastBackupCheck = Date.now();
  try { if (!fs.existsSync(path.join(BACKUP_DIR, `finance-${new Date().toISOString().slice(0, 10)}.db`))) { const n = makeBackup(false); console.log('بکاپ روزانه ساخته شد:', n); } }
  catch (e) { console.error('خطا در بکاپ:', e.message); }
}
const TRASH = { transactions: 'transactions', invoices: 'invoices', customers: 'customers', dues: 'dues' };

const ACC_BAL = `SELECT a.*, a.opening
  + COALESCE((SELECT SUM(CASE WHEN t.type='income' THEN t.amount ELSE -t.amount END) FROM transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL),0)
  + COALESCE((SELECT SUM(amount) FROM transfers WHERE to_account=a.id),0) - COALESCE((SELECT SUM(amount) FROM transfers WHERE from_account=a.id),0) AS balance FROM accounts a`;

// ---------- مسیرها ----------
async function api(req, res, url) {
  const m = req.method, p = url.pathname, q = Object.fromEntries(url.searchParams);
  const ip = clientIp(req);
  if (S.hit('api:ip:' + ip, 600, 60e3)) throw new HttpError(429, 'درخواست‌های بیش از حد؛ کمی صبر کنید');

  // محافظت CSRF: درخواست‌های تغییردهنده فقط از همین سایت پذیرفته می‌شوند
  if (m !== 'GET' && m !== 'HEAD') {
    const sfs = req.headers['sec-fetch-site'], origin = req.headers.origin;
    if (sfs && !['same-origin', 'none'].includes(sfs)) throw new HttpError(403, 'درخواست از مبدأ نامعتبر');
    if (!sfs && origin) {
      let oh = ''; try { oh = new URL(origin).host; } catch {}
      const ok = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).includes(oh) || (process.env.ALLOWED_ORIGINS || '').split(',').includes(origin);
      if (!ok) throw new HttpError(403, 'درخواست از مبدأ نامعتبر');
    }
  }

  // ---- ورود (مرحله ۱: رمز) ----
  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req, 1e4), uname = String(b.username || '').trim().toLowerCase().slice(0, 60);
    if (lockedOut(ip, uname)) throw new HttpError(429, 'تلاش‌های ناموفق زیاد؛ ۱۵ دقیقه بعد دوباره امتحان کنید');
    const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(uname);
    const ok = verify(String(b.password || '').slice(0, 300), u ? u.pass : DUMMY_HASH) && !!u; // زمان پاسخ تقریباً ثابت
    if (!ok) { recordFail(ip, uname); audit(null, 'login.fail', { u: uname, ip }); throw new HttpError(401, 'نام کاربری یا رمز اشتباه است'); }
    if (u.totp_enabled) return send(res, 200, { need_2fa: true, ticket: C.sign({ uid: u.id, k: 'login2fa' }, 5 * 60e3) });
    S.clear('login:ui:' + uname + '|' + ip);
    return issueSession(req, res, u);
  }
  // ---- ورود (مرحله ۲: کد دومرحله‌ای یا کد بازیابی) ----
  if (p === '/api/login/2fa' && m === 'POST') {
    const b = await readBody(req, 1e4), t = C.unsign(b.ticket);
    if (!t || t.k !== 'login2fa') throw new HttpError(401, 'نشست ورود منقضی شد؛ دوباره وارد شوید');
    const u = db.prepare('SELECT * FROM users WHERE id=? AND active=1 AND totp_enabled=1').get(t.uid);
    if (!u) throw new HttpError(401, 'کاربر نامعتبر');
    if (lockedOut(ip, u.username)) throw new HttpError(429, 'تلاش‌های ناموفق زیاد؛ ۱۵ دقیقه بعد دوباره امتحان کنید');
    const good = verify2fa(u, b.code);
    if (!good) { recordFail(ip, u.username); audit(null, 'login.fail2fa', { u: u.username, ip }); throw new HttpError(401, 'کد نادرست است'); }
    S.clear('login:ui:' + u.username + '|' + ip);
    return issueSession(req, res, u);
  }
  const user = currentUser(req);
  if (p === '/api/logout' && m === 'POST') {
    const t = cookies(req).sid; if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(t));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  if (!user) throw new HttpError(401, 'ابتدا وارد شوید');
  if (S.hit('api:user:' + user.id, 900, 60e3)) throw new HttpError(429, 'درخواست‌های بیش از حد؛ کمی صبر کنید');
  ensureDailyBackup();
  const isUpload = p === '/api/attachments' && m === 'POST';
  if (m !== 'GET' && !isUpload && !(req.headers['content-type'] || '').includes('json') && m !== 'DELETE') throw new HttpError(415, 'نوع محتوا نامعتبر');
  // تا رمز موقت عوض نشده (یا ۲FA اجباری فعال نشده) فقط مسیرهای مربوط مجازند
  const gateOk = p === '/api/me' || p === '/api/password' || p.startsWith('/api/2fa');
  if ((user.must_change || user.need_2fa_setup) && !gateOk) throw new HttpError(403, user.must_change ? 'ابتدا رمز عبور خود را تغییر دهید' : 'ابتدا ورود دومرحله‌ای را فعال کنید');

  if (p === '/api/me') return send(res, 200, publicUser(user));

  if (p === '/api/password' && m === 'POST') {
    const b = await readBody(req, 1e4);
    if (S.peek('pw:' + user.id, 5, 15 * 60e3)) throw new HttpError(429, 'تلاش زیاد؛ بعداً امتحان کنید');
    const row = db.prepare('SELECT pass FROM users WHERE id=?').get(user.id);
    if (!verify(String(b.old || '').slice(0, 300), row.pass)) { S.hit('pw:' + user.id, 1e9, 15 * 60e3); throw new HttpError(400, 'رمز فعلی اشتباه است'); }
    const bad = S.checkPassword(b.new, user.username); if (bad) throw new HttpError(400, bad);
    if (String(b.new) === String(b.old)) throw new HttpError(400, 'رمز جدید باید با رمز فعلی فرق کند');
    db.prepare('UPDATE users SET pass=?, must_change=0 WHERE id=?').run(hash(String(b.new)), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, user.sid_hash); // سایر دستگاه‌ها خارج می‌شوند
    audit(user, 'password', {});
    return send(res, 200, { ok: true });
  }

  // ---- ورود دومرحله‌ای (TOTP) برای حساب خود کاربر ----
  if (p === '/api/2fa' && m === 'GET') return send(res, 200, { enabled: !!user.totp_enabled, required: REQUIRE_2FA });
  if (p === '/api/2fa/setup' && m === 'POST') {
    const b = await readBody(req, 1e4), row = db.prepare('SELECT pass,totp_enabled FROM users WHERE id=?').get(user.id);
    if (row.totp_enabled) throw new HttpError(409, 'ورود دومرحله‌ای قبلاً فعال شده');
    if (S.peek('pw:' + user.id, 5, 15 * 60e3) || !verify(String(b.password || '').slice(0, 300), row.pass)) { S.hit('pw:' + user.id, 1e9, 15 * 60e3); throw new HttpError(400, 'رمز عبور اشتباه است'); }
    const secret = S.newSecret();
    db.prepare('UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?').run(C.encrypt(secret), user.id);
    return send(res, 200, { secret, uri: S.otpauth(secret, user.username, 'Catalizor') });
  }
  if (p === '/api/2fa/enable' && m === 'POST') {
    const b = await readBody(req, 1e4), row = db.prepare('SELECT totp_secret,totp_enabled FROM users WHERE id=?').get(user.id);
    if (row.totp_enabled || !row.totp_secret) throw new HttpError(409, 'ابتدا مرحله راه‌اندازی را انجام دهید');
    if (S.peek('2fa:' + user.id, 8, 15 * 60e3)) throw new HttpError(429, 'تلاش زیاد؛ بعداً امتحان کنید');
    const step = S.verifyTotp(C.decrypt(row.totp_secret), b.code, 0);
    if (!step) { S.hit('2fa:' + user.id, 1e9, 15 * 60e3); throw new HttpError(400, 'کد نادرست است؛ ساعت گوشی را هم بررسی کنید'); }
    const codes = S.newRecoveryCodes();
    db.prepare('UPDATE users SET totp_enabled=1, totp_last=?, recovery=? WHERE id=?').run(step, JSON.stringify(codes.map((c) => S.sha(c))), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, user.sid_hash);
    audit(user, '2fa.enable', {});
    return send(res, 200, { ok: true, recovery: codes });
  }
  if (p === '/api/2fa/disable' && m === 'POST') {
    const b = await readBody(req, 1e4), row = db.prepare('SELECT pass,totp_secret,totp_enabled,totp_last,recovery FROM users WHERE id=?').get(user.id);
    if (!row.totp_enabled) throw new HttpError(409, 'ورود دومرحله‌ای فعال نیست');
    if (REQUIRE_2FA && user.role === 'owner') throw new HttpError(403, 'در این نصب، ورود دومرحله‌ای برای مدیر اجباری است');
    if (S.peek('pw:' + user.id, 5, 15 * 60e3) || !verify(String(b.password || '').slice(0, 300), row.pass) || !verify2fa({ ...row, id: user.id }, b.code)) { S.hit('pw:' + user.id, 1e9, 15 * 60e3); throw new HttpError(400, 'رمز یا کد نادرست است'); }
    db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL, recovery=NULL, totp_last=0 WHERE id=?').run(user.id);
    audit(user, '2fa.disable', {});
    return send(res, 200, { ok: true });
  }

  if (p === '/api/categories') {
    if (m === 'GET') return send(res, 200, db.prepare('SELECT * FROM categories ORDER BY type,name').all());
    if (m === 'POST') {
      need(can.write(user)); const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 60);
      if (!name || !['income', 'expense'].includes(b.type)) throw new HttpError(400, 'اطلاعات نامعتبر');
      try { const r = db.prepare('INSERT INTO categories(name,type) VALUES(?,?)').run(name, b.type); return send(res, 201, { id: Number(r.lastInsertRowid), name, type: b.type }); }
      catch { throw new HttpError(409, 'این دسته قبلاً وجود دارد'); }
    }
  }
  let mm;
  if ((mm = p.match(/^\/api\/categories\/(\d+)$/)) && m === 'DELETE') {
    need(can.delete(user));
    const used = db.prepare('SELECT COUNT(*) n FROM transactions WHERE category_id=?').get(+mm[1]).n;
    if (used) throw new HttpError(409, 'این دسته در تراکنش‌ها استفاده شده و قابل حذف نیست');
    db.prepare('DELETE FROM categories WHERE id=?').run(+mm[1]);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/transactions') {
    if (m === 'GET') {
      const { where, p: params } = txFilter(q);
      const limit = Math.min(+q.limit || 50, 500), offset = +q.offset || 0;
      const rows = db.prepare(`${TX_SELECT} ${where} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const tot = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) inc, COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) exp FROM transactions t ${where}`).get(...params);
      return send(res, 200, { rows, total: tot.n, income: tot.inc, expense: tot.exp });
    }
    if (m === 'POST') {
      need(can.write(user));
      const v = cleanTx(await readBody(req));
      const r = db.prepare('INSERT INTO transactions(type,amount,date,category_id,party,method,ref,note,account_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...v, user.id);
      audit(user, 'tx.create', { id: Number(r.lastInsertRowid), v });
      return send(res, 201, { id: Number(r.lastInsertRowid) });
    }
  }
  if ((mm = p.match(/^\/api\/transactions\/(\d+)$/))) {
    const id = +mm[1];
    if (m === 'PUT') {
      need(can.write(user));
      const v = cleanTx(await readBody(req));
      const r = db.prepare("UPDATE transactions SET type=?,amount=?,date=?,category_id=?,party=?,method=?,ref=?,note=?,account_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL").run(...v, id);
      if (!r.changes) throw new HttpError(404, 'یافت نشد');
      audit(user, 'tx.update', { id, v });
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      need(can.delete(user), 'فقط مدیر می‌تواند حذف کند');
      const old = db.prepare('SELECT * FROM transactions WHERE id=? AND deleted_at IS NULL').get(id);
      if (!old) throw new HttpError(404, 'یافت نشد');
      db.prepare('UPDATE transactions SET deleted_at=CURRENT_TIMESTAMP, deleted_by=? WHERE id=?').run(user.id, id);
      audit(user, 'tx.delete', old);
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/summary' && m === 'GET') {
    const { where, p: params } = txFilter(q);
    const t = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) inc, COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) exp, COUNT(*) n FROM transactions t ${where}`).get(...params);
    const byCat = db.prepare(`SELECT t.type, COALESCE(c.name,'بدون دسته') name, SUM(t.amount) total FROM transactions t LEFT JOIN categories c ON c.id=t.category_id ${where} GROUP BY t.type, c.id ORDER BY total DESC`).all(...params);
    const byDay = db.prepare(`SELECT t.date, SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END) inc, SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END) exp FROM transactions t ${where} GROUP BY t.date ORDER BY t.date`).all(...params);
    return send(res, 200, { income: t.inc, expense: t.exp, balance: t.inc - t.exp, count: t.n, byCat, byDay });
  }

  if (p === '/api/export.csv' && m === 'GET') {
    const { where, p: params } = txFilter(q);
    const rows = db.prepare(`${TX_SELECT} ${where} ORDER BY t.date, t.id`).all(...params);
    const esc = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
    const csv = '﻿' + ['شناسه,نوع,مبلغ,تاریخ(میلادی),دسته,حساب,طرف حساب,روش پرداخت,شماره سند,توضیحات,ثبت‌کننده']
      .concat(rows.map((r) => [r.id, r.type === 'income' ? 'ورودی' : 'خروجی', r.amount, r.date, r.category, r.account, r.party, r.method, r.ref, r.note, r.author].map(esc).join(','))).join('\n');
    return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="transactions.csv"' });
  }



  // ---------- مشتریان (CRM) ----------
  if (p === '/api/team' && m === 'GET') return send(res, 200, db.prepare('SELECT id,name,role FROM users WHERE active=1 ORDER BY id').all());
  if (p === '/api/customers') {
    if (m === 'GET') {
      const today = isDate(q.today) ? q.today : new Date().toISOString().slice(0, 10), all = customersWithStats();
      const isStale = (r) => r.status !== 'inactive' && (r.last_contact || r.created_at).slice(0, 10) < addDays(today, -30);
      const seg = { due: (r) => r.due > 0, followup: (r) => r.follow_up && r.follow_up <= today && r.status !== 'inactive', stale: isStale, new: (r) => r.created_at.slice(0, 10) >= addDays(today, -30), mine: (r) => r.assignee === user.id };
      const facets = { segments: Object.fromEntries(Object.entries(seg).map(([k, f]) => [k, all.filter(f).length])), tags: {}, counts: {} };
      for (const r of all) { facets.counts[r.status] = (facets.counts[r.status] || 0) + 1; for (const t of r.tags ? r.tags.split(',') : []) facets.tags[t] = (facets.tags[t] || 0) + 1; }
      let rows = all;
      if (STATUSES.includes(q.status)) rows = rows.filter((r) => r.status === q.status);
      if (q.tag) rows = rows.filter((r) => r.tags.split(',').includes(q.tag));
      if (seg[q.segment]) rows = rows.filter(seg[q.segment]);
      if (+q.assignee) rows = rows.filter((r) => r.assignee === +q.assignee);
      if (q.q) { const x = String(q.q).toLowerCase(), pk = String(q.q).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/\D/g, '').replace(/^0+/, ''); rows = rows.filter((r) => [r.name, r.company, r.email, r.address, r.tags, r.phone].some((v) => String(v || '').toLowerCase().includes(x)) || (pk.length >= 4 && phoneKey(r.phone).includes(pk))); }
      const cmp = { recent: (a, b) => (b.updated_at > a.updated_at ? 1 : -1), name: (a, b) => a.name.localeCompare(b.name, 'fa'), due: (a, b) => b.due - a.due, revenue: (a, b) => b.paid - a.paid, followup: (a, b) => (a.follow_up || '9999').localeCompare(b.follow_up || '9999'), contact: (a, b) => (a.last_contact || a.created_at).localeCompare(b.last_contact || b.created_at) }[q.sort] || ((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
      rows = rows.sort(cmp).slice(0, 1000);
      return send(res, 200, { rows, counts: facets.counts, facets });
    }
    if (m === 'POST') {
      need(can.write(user)); const b = await readBody(req), v = cleanCustomer(b);
      if (!b.force && phoneKey(v.phone).length >= 7) {
        const dup = db.prepare('SELECT id,name,phone FROM customers WHERE deleted_at IS NULL').all().find((r) => phoneKey(r.phone) === phoneKey(v.phone));
        if (dup) return send(res, 409, { error: `مشتری با این شماره قبلاً ثبت شده: ${dup.name}`, duplicate_id: dup.id });
      }
      const r = db.prepare('INSERT INTO customers(name,company,phone,email,address,status,source,note,follow_up,follow_up_note,tags,assignee,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(v.name, v.company, v.phone, v.email, v.address, v.status, v.source, v.note, v.follow_up, v.follow_up_note, v.tags, v.assignee, user.id);
      audit(user, 'customer.create', { id: Number(r.lastInsertRowid), name: v.name });
      return send(res, 201, { id: Number(r.lastInsertRowid), ...v });
    }
  }
  if (p === '/api/customers/import' && m === 'POST') {
    need(can.write(user)); const b = await readBody(req, 2e6);
    if (!Array.isArray(b.rows) || !b.rows.length) throw new HttpError(400, 'ردیفی برای ورود وجود ندارد');
    if (b.rows.length > 3000) throw new HttpError(400, 'حداکثر ۳۰۰۰ مشتری در هر بار');
    const existing = db.prepare('SELECT name,phone FROM customers WHERE deleted_at IS NULL').all(), seenPhone = new Set(existing.map((r) => phoneKey(r.phone)).filter((k) => k.length >= 7)), seenName = new Set(existing.map((r) => r.name.trim()));
    const ins = db.prepare('INSERT INTO customers(name,company,phone,email,address,status,source,note,tags,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)');
    let imported = 0, skipped = 0, bad = 0; db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of b.rows) {
        let v; try { v = cleanCustomer({ ...r, status: STATUSES.includes(r.status) ? r.status : (b.status || 'lead'), follow_up: null, assignee: null }); } catch { bad++; continue; }
        const pk = phoneKey(v.phone); if ((pk.length >= 7 && seenPhone.has(pk)) || (pk.length < 7 && seenName.has(v.name))) { skipped++; continue; }
        ins.run(v.name, v.company, v.phone, v.email, v.address, v.status, v.source, v.note, v.tags, user.id); imported++; if (pk.length >= 7) seenPhone.add(pk); seenName.add(v.name);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(user, 'customer.import', { imported, skipped, bad }); return send(res, 200, { imported, skipped, bad });
  }
  if (p === '/api/crm/overview' && m === 'GET') {
    const today = isDate(q.today) ? q.today : new Date().toISOString().slice(0, 10), all = customersWithStats();
    const counts = {}; for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;
    const followups = all.filter((r) => r.follow_up && r.follow_up <= today && r.status !== 'inactive').sort((a, b) => a.follow_up.localeCompare(b.follow_up)).slice(0, 8).map((r) => ({ id: r.id, name: r.name, company: r.company, phone: r.phone, status: r.status, follow_up: r.follow_up, follow_up_note: r.follow_up_note, assignee_name: r.assignee_name }));
    const debtors = all.filter((r) => r.due > 0).sort((a, b) => b.due - a.due).slice(0, 6).map((r) => ({ id: r.id, name: r.name, company: r.company, phone: r.phone, status: r.status, due: r.due }));
    const srcs = {}; for (const r of all) { const k = r.source || 'نامشخص'; srcs[k] = (srcs[k] || 0) + 1; }
    const stats = { total: all.length, new30: all.filter((r) => r.created_at.slice(0, 10) >= addDays(today, -30)).length, outstanding: all.reduce((a, r) => a + r.due, 0), revenue: all.reduce((a, r) => a + r.paid, 0), followupsDue: all.filter((r) => r.follow_up && r.follow_up <= today && r.status !== 'inactive').length, stale: all.filter((r) => r.status !== 'inactive' && (r.last_contact || r.created_at).slice(0, 10) < addDays(today, -30)).length };
    const totalDue = [...customerFinance().values()].reduce((a, f) => a + f.due, 0);
    return send(res, 200, { counts, followups, debtors, totalDue, stats, sources: Object.entries(srcs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n })) });
  }
  if ((mm = p.match(/^\/api\/customers\/(\d+)$/))) {
    const id = +mm[1], c = db.prepare('SELECT * FROM customers WHERE id=? AND deleted_at IS NULL').get(id);
    if (!c) throw new HttpError(404, 'مشتری یافت نشد');
    if (m === 'GET') {
      const notes = db.prepare('SELECT n.*, u.name AS author FROM customer_notes n LEFT JOIN users u ON u.id=n.created_by WHERE n.customer_id=? ORDER BY n.id DESC').all(id);
      const invoices = db.prepare('SELECT id FROM invoices WHERE customer_id=? AND deleted_at IS NULL ORDER BY number DESC').all(id).map((r) => { const v = invoiceFull(r.id); v.paid_date = v.tx_id ? (db.prepare('SELECT date FROM transactions WHERE id=?').get(v.tx_id) || {}).date || null : null; return v; });
      const dues = db.prepare('SELECT id,kind,direction,title,number,amount,due_date,status,done_date FROM dues WHERE customer_id=? AND deleted_at IS NULL ORDER BY due_date DESC').all(id);
      const asg = c.assignee ? (db.prepare('SELECT name FROM users WHERE id=?').get(c.assignee) || {}).name : null;
      return send(res, 200, { ...c, assignee_name: asg, ...(customerFinance(id).get(id) || { count: 0, invoiced: 0, paid: 0, due: 0 }), notes, invoices, dues });
    }
    if (m === 'PUT') {
      need(can.write(user)); const b = await readBody(req);
      const v = cleanCustomer({ ...c, ...b, follow_up: 'follow_up' in b ? b.follow_up : c.follow_up });
      db.prepare('UPDATE customers SET name=?,company=?,phone=?,email=?,address=?,status=?,source=?,note=?,follow_up=?,follow_up_note=?,tags=?,assignee=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(v.name, v.company, v.phone, v.email, v.address, v.status, v.source, v.note, v.follow_up, v.follow_up_note, v.tags, v.assignee, id);
      if (v.status !== c.status) db.prepare('INSERT INTO customer_notes(customer_id,kind,text,created_by) VALUES(?,?,?,?)').run(id, 'note', `⚙️ وضعیت از «${STATUS_FA[c.status]}» به «${STATUS_FA[v.status]}» تغییر کرد`, user.id);
      audit(user, 'customer.update', { id, name: v.name, status: v.status });
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      need(can.delete(user), 'فقط مدیر می‌تواند حذف کند');
      db.prepare('UPDATE customers SET deleted_at=CURRENT_TIMESTAMP, deleted_by=? WHERE id=?').run(user.id, id);
      audit(user, 'customer.delete', c);
      return send(res, 200, { ok: true });
    }
  }
  if ((mm = p.match(/^\/api\/customers\/(\d+)\/notes$/)) && m === 'POST') {
    need(can.write(user)); const id = +mm[1], b = await readBody(req);
    if (!db.prepare('SELECT 1 FROM customers WHERE id=? AND deleted_at IS NULL').get(id)) throw new HttpError(404, 'مشتری یافت نشد');
    const text = String(b.text || '').trim().slice(0, 1000), kind = ['note', 'call', 'meeting', 'message'].includes(b.kind) ? b.kind : 'note';
    if (!text) throw new HttpError(400, 'متن یادداشت خالی است');
    const r = db.prepare('INSERT INTO customer_notes(customer_id,kind,text,created_by) VALUES(?,?,?,?)').run(id, kind, text, user.id);
    if (isDate(b.follow_up)) db.prepare('UPDATE customers SET follow_up=?, follow_up_note=? WHERE id=?').run(b.follow_up, String(b.follow_up_note || '').trim().slice(0, 200), id);
    db.prepare('UPDATE customers SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  if ((mm = p.match(/^\/api\/notes\/(\d+)$/)) && m === 'DELETE') {
    const n = db.prepare('SELECT * FROM customer_notes WHERE id=?').get(+mm[1]);
    if (!n) throw new HttpError(404, 'یافت نشد');
    need(can.delete(user) || (can.write(user) && n.created_by === user.id), 'فقط مدیر یا نویسنده می‌تواند حذف کند');
    db.prepare('DELETE FROM customer_notes WHERE id=?').run(n.id);
    return send(res, 200, { ok: true });
  }

  // ---------- تنظیمات کسب‌وکار (روی فاکتور چاپ می‌شود) ----------
  if (p === '/api/settings') {
    if (m === 'GET') return send(res, 200, Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value])));
    if (m === 'PUT') {
      need(can.admin(user)); const b = await readBody(req);
      const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const k of ['business_name', 'business_phone', 'business_address', 'business_note']) if (k in b) up.run(k, String(b[k]).slice(0, 300));
      return send(res, 200, { ok: true });
    }
  }

  // ---------- فاکتور ----------
  if (p === '/api/invoices') {
    if (m === 'GET') return send(res, 200, db.prepare('SELECT id FROM invoices WHERE deleted_at IS NULL ORDER BY number DESC LIMIT 300').all().map((r) => invoiceFull(r.id)));
    if (m === 'POST') {
      need(can.write(user)); const v = cleanInvoice(await readBody(req));
      const number = (db.prepare('SELECT MAX(number) n FROM invoices').get().n || 1000) + 1;
      const r = db.prepare('INSERT INTO invoices(number,date,customer,phone,address,discount,tax_percent,note,created_by,customer_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(number, v.date, v.customer, v.phone, v.address, v.discount, v.tax_percent, v.note, user.id, v.customer_id);
      const id = Number(r.lastInsertRowid); saveItems(id, v.items);
      audit(user, 'invoice.create', { id, number });
      return send(res, 201, invoiceFull(id));
    }
  }
  if ((mm = p.match(/^\/api\/invoices\/(\d+)(\/pay)?$/))) {
    const id = +mm[1], inv = db.prepare('SELECT * FROM invoices WHERE id=? AND deleted_at IS NULL').get(id);
    if (!inv) throw new HttpError(404, 'فاکتور یافت نشد');
    if (mm[2] && m === 'POST') {
      need(can.write(user));
      if (inv.status === 'paid') throw new HttpError(409, 'این فاکتور قبلاً پرداخت شده');
      const full = invoiceFull(id), body = await readBody(req);
      const cat = db.prepare("SELECT id FROM categories WHERE name='فروش' AND type='income'").get();
      const method = ['cash', 'card', 'transfer', 'cheque', 'other'].includes(body.method) ? body.method : 'cash';
      const r = db.prepare("INSERT INTO transactions(type,amount,date,category_id,party,method,ref,note,account_id,created_by) VALUES('income',?,?,?,?,?,?,?,?,?)")
        .run(full.total, isDate(body.date) ? body.date : inv.date, cat ? cat.id : null, inv.customer, method, String(inv.number), `دریافت وجه فاکتور ${inv.number}`, accountId(body.account_id), user.id);
      db.prepare("UPDATE invoices SET status='paid', tx_id=? WHERE id=?").run(Number(r.lastInsertRowid), id);
      if (inv.customer_id) db.prepare("UPDATE customers SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='lead'").run(inv.customer_id);
      audit(user, 'invoice.pay', { id, number: inv.number, amount: full.total });
      return send(res, 200, invoiceFull(id));
    }
    if (m === 'GET') return send(res, 200, invoiceFull(id));
    if (m === 'PUT') {
      need(can.write(user));
      if (inv.status === 'paid') throw new HttpError(409, 'فاکتور پرداخت‌شده قابل ویرایش نیست');
      const v = cleanInvoice(await readBody(req));
      db.prepare('UPDATE invoices SET date=?,customer=?,phone=?,address=?,discount=?,tax_percent=?,note=?,customer_id=? WHERE id=?').run(v.date, v.customer, v.phone, v.address, v.discount, v.tax_percent, v.note, v.customer_id, id);
      db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(id); saveItems(id, v.items);
      audit(user, 'invoice.update', { id, number: inv.number });
      return send(res, 200, invoiceFull(id));
    }
    if (m === 'DELETE') {
      need(can.delete(user), 'فقط مدیر می‌تواند حذف کند');
      db.prepare('UPDATE invoices SET deleted_at=CURRENT_TIMESTAMP, deleted_by=? WHERE id=?').run(user.id, id);
      audit(user, 'invoice.delete', inv);
      return send(res, 200, { ok: true });
    }
  }


  // ---------- بکاپ (فقط مدیر) ----------
  if (p === '/api/backups') {
    need(can.admin(user));
    if (m === 'GET') return send(res, 200, { list: listBackups(), keep: BACKUP_KEEP, telegram: !!(process.env.BACKUP_TELEGRAM_TOKEN && process.env.BACKUP_TELEGRAM_CHAT), lastTelegram });
    if (m === 'POST') { const n = makeBackup(true); audit(user, 'backup.create', { n }); return send(res, 201, { name: n, list: listBackups() }); }
  }
  if (p === '/api/backups/download' && m === 'GET') {
    need(can.admin(user)); const n = makeBackup(true); audit(user, 'backup.download', { n });
    return send(res, 200, fs.readFileSync(path.join(BACKUP_DIR, n)), { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${n}"` });
  }
  if ((mm = p.match(/^\/api\/backups\/file\/([^/]+)$/)) && m === 'GET') {
    need(can.admin(user)); const n = decodeURIComponent(mm[1]);
    if (!BACKUP_RE.test(n) || !fs.existsSync(path.join(BACKUP_DIR, n))) throw new HttpError(404, 'یافت نشد');
    audit(user, 'backup.download', { n });
    return send(res, 200, fs.readFileSync(path.join(BACKUP_DIR, n)), { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${n}"` });
  }

  // ---------- سطل بازیافت (فقط مدیر) ----------
  if (p === '/api/trash' && m === 'GET') {
    need(can.admin(user));
    const by = 'LEFT JOIN users u ON u.id=x.deleted_by';
    return send(res, 200, {
      transactions: db.prepare(`SELECT x.id,x.type,x.amount,x.date,x.party,x.note,x.deleted_at,u.name AS who,c.name AS category FROM transactions x ${by} LEFT JOIN categories c ON c.id=x.category_id WHERE x.deleted_at IS NOT NULL ORDER BY x.deleted_at DESC LIMIT 200`).all(),
      invoices: db.prepare('SELECT x.id FROM invoices x WHERE x.deleted_at IS NOT NULL ORDER BY x.deleted_at DESC LIMIT 200').all().map((r) => ({ ...invoiceFull(r.id), who: (db.prepare('SELECT u.name FROM invoices x LEFT JOIN users u ON u.id=x.deleted_by WHERE x.id=?').get(r.id) || {}).name })),
      customers: db.prepare(`SELECT x.id,x.name,x.company,x.phone,x.status,x.deleted_at,u.name AS who FROM customers x ${by} WHERE x.deleted_at IS NOT NULL ORDER BY x.deleted_at DESC LIMIT 200`).all(),
      dues: db.prepare(`SELECT x.id,x.kind,x.direction,x.party,x.number,x.amount,x.due_date,x.deleted_at,u.name AS who FROM dues x ${by} WHERE x.deleted_at IS NOT NULL ORDER BY x.deleted_at DESC LIMIT 200`).all(),
    });
  }
  if ((mm = p.match(/^\/api\/trash\/(transactions|invoices|customers|dues)\/(\d+)(\/restore)?$/))) {
    need(can.admin(user)); const tbl = TRASH[mm[1]], id = +mm[2];
    const row = db.prepare(`SELECT * FROM ${tbl} WHERE id=? AND deleted_at IS NOT NULL`).get(id);
    if (!row) throw new HttpError(404, 'در سطل بازیافت یافت نشد');
    if (mm[3] && m === 'POST') {
      db.prepare(`UPDATE ${tbl} SET deleted_at=NULL, deleted_by=NULL WHERE id=?`).run(id);
      audit(user, 'trash.restore', { type: mm[1], id }); return send(res, 200, { ok: true });
    }
    if (!mm[3] && m === 'DELETE') {
      db.prepare(`DELETE FROM ${tbl} WHERE id=?`).run(id);
      if (tbl === 'transactions' || tbl === 'dues') db.prepare('DELETE FROM attachments WHERE entity=? AND entity_id=?').run(tbl === 'dues' ? 'due' : 'transaction', id);
      audit(user, 'trash.purge', { type: mm[1], id }); return send(res, 200, { ok: true });
    }
  }


  // ---------- حساب‌های بانکی / صندوق ----------
  if (p === '/api/accounts') {
    if (m === 'GET') return send(res, 200, db.prepare(`${ACC_BAL} ORDER BY a.active DESC, a.id`).all());
    if (m === 'POST') {
      need(can.admin(user)); const b = await readBody(req, 1e4), name = String(b.name || '').trim().slice(0, 60);
      if (!name) throw new HttpError(400, 'نام حساب را وارد کنید');
      const kind = ['bank', 'cash', 'card', 'other'].includes(b.kind) ? b.kind : 'bank', opening = Math.round(Number(b.opening) || 0);
      if (!Number.isSafeInteger(opening)) throw new HttpError(400, 'موجودی اولیه نامعتبر است');
      try { const r = db.prepare('INSERT INTO accounts(name,kind,opening) VALUES(?,?,?)').run(name, kind, opening); audit(user, 'account.create', { name, kind, opening }); return send(res, 201, { id: Number(r.lastInsertRowid) }); }
      catch { throw new HttpError(409, 'حسابی با این نام وجود دارد'); }
    }
  }
  if ((mm = p.match(/^\/api\/accounts\/(\d+)$/))) {
    need(can.admin(user)); const id = +mm[1], a = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    if (!a) throw new HttpError(404, 'حساب یافت نشد');
    if (m === 'PUT') {
      const b = await readBody(req, 1e4), name = b.name !== undefined ? String(b.name).trim().slice(0, 60) : a.name;
      if (!name) throw new HttpError(400, 'نام حساب را وارد کنید');
      const kind = ['bank', 'cash', 'card', 'other'].includes(b.kind) ? b.kind : a.kind, opening = b.opening !== undefined ? Math.round(Number(b.opening) || 0) : a.opening;
      if (!Number.isSafeInteger(opening)) throw new HttpError(400, 'موجودی اولیه نامعتبر است');
      try { db.prepare('UPDATE accounts SET name=?,kind=?,opening=?,active=? WHERE id=?').run(name, kind, opening, typeof b.active === 'boolean' ? (b.active ? 1 : 0) : a.active, id); }
      catch { throw new HttpError(409, 'حسابی با این نام وجود دارد'); }
      audit(user, 'account.update', { id, name, opening }); return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      const used = db.prepare('SELECT (SELECT COUNT(*) FROM transactions WHERE account_id=?1)+(SELECT COUNT(*) FROM transfers WHERE from_account=?1 OR to_account=?1)+(SELECT COUNT(*) FROM dues WHERE account_id=?1) n').get(id).n;
      if (used) throw new HttpError(409, 'این حساب گردش دارد؛ به‌جای حذف، آن را غیرفعال کنید');
      db.prepare('DELETE FROM accounts WHERE id=?').run(id); audit(user, 'account.delete', a); return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/transfers') {
    if (m === 'GET') return send(res, 200, db.prepare('SELECT t.*, f.name AS from_name, o.name AS to_name FROM transfers t JOIN accounts f ON f.id=t.from_account JOIN accounts o ON o.id=t.to_account ORDER BY t.date DESC, t.id DESC LIMIT 100').all());
    if (m === 'POST') {
      need(can.write(user)); const b = await readBody(req, 1e4), amount = Math.round(Number(b.amount));
      const from = accountId(b.from_account), to = accountId(b.to_account);
      if (!from || !to || from === to) throw new HttpError(400, 'حساب مبدأ و مقصد باید متفاوت باشند');
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, 'مبلغ نامعتبر است');
      if (!isDate(b.date)) throw new HttpError(400, 'تاریخ نامعتبر است');
      const r = db.prepare('INSERT INTO transfers(from_account,to_account,amount,date,note,created_by) VALUES(?,?,?,?,?,?)').run(from, to, amount, b.date, String(b.note || '').slice(0, 300), user.id);
      audit(user, 'transfer.create', { id: Number(r.lastInsertRowid), from, to, amount }); return send(res, 201, { id: Number(r.lastInsertRowid) });
    }
  }
  if ((mm = p.match(/^\/api\/transfers\/(\d+)$/)) && m === 'DELETE') {
    need(can.delete(user), 'فقط مدیر می‌تواند حذف کند');
    const t = db.prepare('SELECT * FROM transfers WHERE id=?').get(+mm[1]); if (!t) throw new HttpError(404, 'یافت نشد');
    db.prepare('DELETE FROM transfers WHERE id=?').run(t.id); audit(user, 'transfer.delete', t); return send(res, 200, { ok: true });
  }

  // ---------- پیوست رسید ----------
  if (p === '/api/attachments') {
    const entity = q.entity === 'due' ? 'due' : q.entity === 'transaction' ? 'transaction' : null, eid = +q.id;
    if (!entity || !Number.isInteger(eid) || eid <= 0) throw new HttpError(400, 'پارامتر نامعتبر');
    const exists = db.prepare(`SELECT 1 FROM ${entity === 'due' ? 'dues' : 'transactions'} WHERE id=? AND deleted_at IS NULL`).get(eid);
    if (!exists) throw new HttpError(404, 'مورد یافت نشد');
    if (m === 'GET') return send(res, 200, db.prepare('SELECT a.id,a.name,a.mime,a.size,a.created_at,u.name AS author FROM attachments a LEFT JOIN users u ON u.id=a.created_by WHERE a.entity=? AND a.entity_id=? ORDER BY a.id').all(entity, eid));
    if (m === 'POST') {
      need(can.write(user));
      if (db.prepare('SELECT COUNT(*) n FROM attachments WHERE entity=? AND entity_id=?').get(entity, eid).n >= 6) throw new HttpError(409, 'حداکثر ۶ پیوست برای هر مورد مجاز است');
      const buf = await readRaw(req, 4 * 1024 * 1024), mime = S.sniff(buf);
      if (!buf.length) throw new HttpError(400, 'فایل خالی است');
      if (!mime) throw new HttpError(400, 'فقط تصویر (JPG/PNG/WEBP/GIF) یا PDF مجاز است');
      const name = String(q.name || 'file').replace(/[\\/\u0000-\u001f]/g, '').slice(0, 100) || 'file';
      const r = db.prepare('INSERT INTO attachments(entity,entity_id,name,mime,size,data,created_by) VALUES(?,?,?,?,?,?,?)').run(entity, eid, name, mime, buf.length, buf, user.id);
      audit(user, 'attachment.add', { id: Number(r.lastInsertRowid), entity, eid, size: buf.length });
      return send(res, 201, { id: Number(r.lastInsertRowid), name, mime, size: buf.length });
    }
  }
  if ((mm = p.match(/^\/api\/attachments\/(\d+)$/))) {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(+mm[1]); if (!a) throw new HttpError(404, 'یافت نشد');
    if (m === 'GET') {
      const isImg = a.mime.startsWith('image/'), fn = encodeURIComponent(a.name);
      return send(res, 200, Buffer.from(a.data), { 'Content-Type': a.mime, 'Content-Disposition': `${isImg ? 'inline' : 'attachment'}; filename*=UTF-8''${fn}`, 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=300' });
    }
    if (m === 'DELETE') {
      need(can.delete(user) || (can.write(user) && a.created_by === user.id), 'فقط مدیر یا بارگذارنده می‌تواند حذف کند');
      db.prepare('DELETE FROM attachments WHERE id=?').run(a.id); audit(user, 'attachment.delete', { id: a.id, name: a.name }); return send(res, 200, { ok: true });
    }
  }

  // ---------- چک‌ها و اقساط ----------
  const DUE_SELECT = `SELECT d.*, c.name AS customer_name, ac.name AS account, (SELECT COUNT(*) FROM attachments a WHERE a.entity='due' AND a.entity_id=d.id) AS att
    FROM dues d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN accounts ac ON ac.id=d.account_id`;
  const cleanDue = (b, kind) => {
    const amount = Math.round(Number(b.amount));
    if (!['in', 'out'].includes(b.direction)) throw new HttpError(400, 'جهت (دریافتی/پرداختی) نامعتبر است');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(400, 'مبلغ نامعتبر است');
    if (!isDate(b.due_date)) throw new HttpError(400, 'تاریخ سررسید نامعتبر است');
    let customer_id = null, invoice_id = null;
    if (b.customer_id) { if (!db.prepare('SELECT 1 FROM customers WHERE id=? AND deleted_at IS NULL').get(+b.customer_id)) throw new HttpError(400, 'مشتری یافت نشد'); customer_id = +b.customer_id; }
    if (b.invoice_id) { if (!db.prepare('SELECT 1 FROM invoices WHERE id=? AND deleted_at IS NULL').get(+b.invoice_id)) throw new HttpError(400, 'فاکتور یافت نشد'); invoice_id = +b.invoice_id; }
    return { kind, direction: b.direction, amount, due_date: b.due_date, customer_id, invoice_id, party: String(b.party || '').trim().slice(0, 120), number: String(b.number || '').trim().slice(0, 40), bank: String(b.bank || '').trim().slice(0, 60), title: String(b.title || '').trim().slice(0, 100), note: String(b.note || '').trim().slice(0, 500) };
  };
  const insDue = (v, group, userId) => Number(db.prepare('INSERT INTO dues(kind,direction,title,party,customer_id,invoice_id,number,bank,amount,due_date,group_id,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(v.kind, v.direction, v.title, v.party, v.customer_id, v.invoice_id, v.number, v.bank, v.amount, v.due_date, group, v.note, userId).lastInsertRowid);
  if (p === '/api/dues/overview' && m === 'GET') {
    const today = isDate(q.today) ? q.today : new Date().toISOString().slice(0, 10), lim = new Date(Date.parse(today + 'T00:00:00Z') + 7 * 864e5).toISOString().slice(0, 10);
    const sums = Object.fromEntries(db.prepare("SELECT direction, COALESCE(SUM(amount),0) total, COUNT(*) n FROM dues WHERE deleted_at IS NULL AND status='pending' GROUP BY direction").all().map((r) => [r.direction, r]));
    const upcoming = db.prepare(`${DUE_SELECT} WHERE d.deleted_at IS NULL AND d.status='pending' AND d.due_date<=? ORDER BY d.due_date, d.id LIMIT 8`).all(lim);
    const overdue = db.prepare("SELECT COUNT(*) n FROM dues WHERE deleted_at IS NULL AND status='pending' AND due_date<?").get(today).n;
    return send(res, 200, { in: sums.in || { total: 0, n: 0 }, out: sums.out || { total: 0, n: 0 }, upcoming, overdue });
  }
  if (p === '/api/dues') {
    if (m === 'GET') {
      const w = ['d.deleted_at IS NULL'], pr = [];
      if (['pending', 'done', 'bounced', 'cancelled'].includes(q.status)) { w.push('d.status=?'); pr.push(q.status); }
      if (['cheque', 'installment'].includes(q.kind)) { w.push('d.kind=?'); pr.push(q.kind); }
      if (['in', 'out'].includes(q.direction)) { w.push('d.direction=?'); pr.push(q.direction); }
      if (+q.customer) { w.push('d.customer_id=?'); pr.push(+q.customer); }
      return send(res, 200, db.prepare(`${DUE_SELECT} WHERE ${w.join(' AND ')} ORDER BY (d.status='pending') DESC, CASE WHEN d.status='pending' THEN d.due_date END ASC, d.due_date DESC, d.id DESC LIMIT 500`).all(...pr));
    }
    if (m === 'POST') {
      need(can.write(user)); const b = await readBody(req, 2e5);
      if (Array.isArray(b.items)) { // طرح اقساط
        if (!b.items.length || b.items.length > 60) throw new HttpError(400, 'تعداد اقساط باید بین ۱ تا ۶۰ باشد');
        const group = crypto.randomBytes(6).toString('hex'), ids = [];
        db.exec('BEGIN');
        try { b.items.forEach((it, i) => { const v = cleanDue({ ...b, amount: it.amount, due_date: it.due_date }, 'installment'); v.title = `${b.title ? String(b.title).slice(0, 80) : 'قسط'} ${i + 1} از ${b.items.length}`; ids.push(insDue(v, group, user.id)); }); db.exec('COMMIT'); }
        catch (e) { db.exec('ROLLBACK'); throw e; }
        audit(user, 'due.create', { group, n: ids.length, kind: 'installment' }); return send(res, 201, { ids });
      }
      const v = cleanDue(b, 'cheque'), id = insDue(v, null, user.id);
      audit(user, 'due.create', { id, kind: 'cheque', amount: v.amount }); return send(res, 201, { id });
    }
  }
  if ((mm = p.match(/^\/api\/dues\/(\d+)(?:\/(settle|reopen))?$/))) {
    const id = +mm[1], d = db.prepare('SELECT * FROM dues WHERE id=? AND deleted_at IS NULL').get(id); if (!d) throw new HttpError(404, 'یافت نشد');
    if (!mm[2] && m === 'PUT') {
      need(can.write(user)); if (d.status !== 'pending') throw new HttpError(409, 'فقط موارد در انتظار قابل ویرایش‌اند');
      const v = cleanDue({ ...d, ...(await readBody(req, 2e5)) }, d.kind);
      db.prepare('UPDATE dues SET direction=?,party=?,customer_id=?,invoice_id=?,number=?,bank=?,amount=?,due_date=?,note=?,title=? WHERE id=?').run(v.direction, v.party, v.customer_id, v.invoice_id, v.number, v.bank, v.amount, v.due_date, v.note, v.title || d.title, id);
      audit(user, 'due.update', { id }); return send(res, 200, { ok: true });
    }
    if (mm[2] === 'settle' && m === 'POST') {
      need(can.write(user)); if (d.status !== 'pending') throw new HttpError(409, 'قبلاً تعیین تکلیف شده');
      const b = await readBody(req, 1e4), outcome = ['done', 'bounced', 'cancelled'].includes(b.outcome) ? b.outcome : null; if (!outcome) throw new HttpError(400, 'نتیجه نامعتبر است');
      if (outcome !== 'done') { db.prepare('UPDATE dues SET status=?, done_date=? WHERE id=?').run(outcome, isDate(b.date) ? b.date : null, id); audit(user, 'due.' + outcome, { id }); return send(res, 200, { ok: true }); }
      if (!isDate(b.date)) throw new HttpError(400, 'تاریخ نامعتبر است');
      const acc = accountId(b.account_id), type = d.direction === 'in' ? 'income' : 'expense';
      const cat = type === 'income' ? db.prepare("SELECT id FROM categories WHERE name='فروش' AND type='income'").get() : null;
      const label = d.kind === 'cheque' ? `چک ${d.number || ''}`.trim() : (d.title || 'قسط');
      db.exec('BEGIN');
      try {
        const r = db.prepare('INSERT INTO transactions(type,amount,date,category_id,party,method,ref,note,account_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(type, d.amount, b.date, cat ? cat.id : null, d.party || '', d.kind === 'cheque' ? 'cheque' : (['cash', 'card', 'transfer', 'other'].includes(b.method) ? b.method : 'transfer'), d.number || '', `${type === 'income' ? 'وصول' : 'پرداخت'} ${label}`, acc, user.id);
        db.prepare("UPDATE dues SET status='done', done_date=?, tx_id=?, account_id=? WHERE id=?").run(b.date, Number(r.lastInsertRowid), acc, id);
        if (d.customer_id && d.direction === 'in') db.prepare("UPDATE customers SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='lead'").run(d.customer_id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      audit(user, 'due.done', { id, amount: d.amount }); return send(res, 200, { ok: true });
    }
    if (mm[2] === 'reopen' && m === 'POST') {
      need(can.admin(user)); if (d.status === 'pending') throw new HttpError(409, 'در انتظار است');
      db.exec('BEGIN');
      try { if (d.tx_id) db.prepare('UPDATE transactions SET deleted_at=CURRENT_TIMESTAMP, deleted_by=? WHERE id=? AND deleted_at IS NULL').run(user.id, d.tx_id); db.prepare("UPDATE dues SET status='pending', done_date=NULL, tx_id=NULL WHERE id=?").run(id); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      audit(user, 'due.reopen', { id }); return send(res, 200, { ok: true });
    }
    if (!mm[2] && m === 'DELETE') {
      need(can.delete(user), 'فقط مدیر می‌تواند حذف کند');
      db.prepare('UPDATE dues SET deleted_at=CURRENT_TIMESTAMP, deleted_by=? WHERE id=?').run(user.id, id); audit(user, 'due.delete', d); return send(res, 200, { ok: true });
    }
  }

  // ---------- گزارش ----------
  if (p === '/api/report' && m === 'GET') {
    if (!isDate(q.from) || !isDate(q.to) || q.from > q.to) throw new HttpError(400, 'بازه نامعتبر است');
    const per = (f, t) => {
      const a = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) inc, COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) exp, COUNT(*) n FROM transactions WHERE deleted_at IS NULL AND date BETWEEN ? AND ?").get(f, t);
      const cats = db.prepare("SELECT t.type, COALESCE(c.name,'بدون دسته') name, SUM(t.amount) total, COUNT(*) n FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.deleted_at IS NULL AND t.date BETWEEN ? AND ? GROUP BY t.type, c.id ORDER BY total DESC").all(f, t);
      return { income: a.inc, expense: a.exp, net: a.inc - a.exp, count: a.n, cats };
    };
    const days = Math.round((Date.parse(q.to) - Date.parse(q.from)) / 864e5) + 1, pTo = new Date(Date.parse(q.from) - 864e5), pFrom = new Date(pTo.getTime() - (days - 1) * 864e5);
    const prev = per(pFrom.toISOString().slice(0, 10), pTo.toISOString().slice(0, 10));
    const invs = db.prepare('SELECT id FROM invoices WHERE deleted_at IS NULL AND date BETWEEN ? AND ?').all(q.from, q.to).map((r) => invoiceFull(r.id));
    const fin = customerFinance(), names = Object.fromEntries(db.prepare('SELECT id,name,company FROM customers WHERE deleted_at IS NULL').all().map((c) => [c.id, c]));
    const debtors = [...fin.entries()].filter(([id, f]) => f.due > 0 && names[id]).map(([id, f]) => ({ name: names[id].name, company: names[id].company, due: f.due })).sort((a, b) => b.due - a.due).slice(0, 15);
    const unlinkedDue = db.prepare("SELECT id FROM invoices WHERE deleted_at IS NULL AND status='unpaid' AND customer_id IS NULL").all().map((r) => invoiceFull(r.id)).reduce((a, i) => a + i.total, 0);
    const dues = Object.fromEntries(db.prepare("SELECT direction, COALESCE(SUM(amount),0) total, COUNT(*) n FROM dues WHERE deleted_at IS NULL AND status='pending' GROUP BY direction").all().map((r) => [r.direction, r]));
    return send(res, 200, {
      from: q.from, to: q.to, ...per(q.from, q.to), prev: { from: pFrom.toISOString().slice(0, 10), to: pTo.toISOString().slice(0, 10), income: prev.income, expense: prev.expense, net: prev.net },
      invoices: { count: invs.length, total: invs.reduce((a, i) => a + i.total, 0), paid: invs.filter((i) => i.status === 'paid').reduce((a, i) => a + i.total, 0) },
      debtors, unlinkedDue, totalDue: debtors.reduce((a, d) => a + d.due, 0) + unlinkedDue,
      accounts: db.prepare(`${ACC_BAL} WHERE a.active=1 ORDER BY a.id`).all().map((a) => ({ name: a.name, kind: a.kind, balance: a.balance })),
      dues: { in: dues.in || { total: 0, n: 0 }, out: dues.out || { total: 0, n: 0 } },
    });
  }

  // ---------- ورود از اکسل/CSV ----------
  if (p === '/api/import' && m === 'POST') {
    need(can.write(user)); const b = await readBody(req, 4e6);
    if (!Array.isArray(b.rows) || !b.rows.length) throw new HttpError(400, 'ردیفی برای ورود وجود ندارد');
    if (b.rows.length > 5000) throw new HttpError(400, 'حداکثر ۵۰۰۰ ردیف در هر بار');
    const acc = accountId(b.account_id), errors = [], good = [];
    b.rows.forEach((r, i) => {
      const amount = Math.round(Number(r.amount));
      if (!['income', 'expense'].includes(r.type)) return errors.push(`ردیف ${i + 1}: نوع نامعتبر`);
      if (!Number.isSafeInteger(amount) || amount <= 0) return errors.push(`ردیف ${i + 1}: مبلغ نامعتبر`);
      if (!isDate(r.date) || Number.isNaN(Date.parse(r.date))) return errors.push(`ردیف ${i + 1}: تاریخ نامعتبر`);
      good.push({ type: r.type, amount, date: r.date, category: String(r.category || '').trim().slice(0, 60), party: String(r.party || '').trim().slice(0, 120), note: String(r.note || '').trim().slice(0, 500), ref: String(r.ref || '').trim().slice(0, 60) });
    });
    const dupQ = db.prepare('SELECT 1 FROM transactions WHERE deleted_at IS NULL AND date=? AND type=? AND amount=? AND party=? AND note=? LIMIT 1');
    const dup = b.skip_duplicates === false ? good.map(() => false) : good.map((r) => !!dupQ.get(r.date, r.type, r.amount, r.party, r.note));
    const catCache = new Map(), findCat = (name, type) => {
      if (!name) return null; const k = type + '|' + name; if (catCache.has(k)) return catCache.get(k);
      let c = db.prepare('SELECT id FROM categories WHERE name=? AND type=?').get(name, type);
      if (!c) c = { id: Number(db.prepare('INSERT INTO categories(name,type) VALUES(?,?)').run(name, type).lastInsertRowid) };
      catCache.set(k, c.id); return c.id;
    };
    const ins = db.prepare('INSERT INTO transactions(type,amount,date,category_id,party,method,ref,note,account_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)');
    let imported = 0; db.exec('BEGIN IMMEDIATE');
    try { good.forEach((r, i) => { if (dup[i]) return; ins.run(r.type, r.amount, r.date, findCat(r.category, r.type), r.party, 'other', r.ref, r.note, acc, user.id); imported++; }); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(user, 'import', { imported, skipped: dup.filter(Boolean).length, errors: errors.length });
    return send(res, 200, { imported, skipped: dup.filter(Boolean).length, errors: errors.slice(0, 20), errorCount: errors.length });
  }

  if (p === '/api/users') {
    need(can.admin(user));
    if (m === 'GET') return send(res, 200, db.prepare('SELECT id,username,name,role,active,totp_enabled,must_change FROM users ORDER BY id').all());
    if (m === 'POST') {
      const b = await readBody(req);
      const username = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_.]{3,30}$/.test(username)) throw new HttpError(400, 'نام کاربری: ۳ تا ۳۰ حرف انگلیسی/عدد');
      if (!['owner', 'accountant', 'partner'].includes(b.role)) throw new HttpError(400, 'نقش نامعتبر');
      const bad = S.checkPassword(b.password, username); if (bad) throw new HttpError(400, bad);
      try { db.prepare('INSERT INTO users(username,name,role,pass,must_change) VALUES(?,?,?,?,1)').run(username, String(b.name || username).slice(0, 60), b.role, hash(String(b.password))); }
      catch { throw new HttpError(409, 'این نام کاربری وجود دارد'); }
      audit(user, 'user.create', { username, role: b.role });
      return send(res, 201, { ok: true });
    }
  }
  if ((mm = p.match(/^\/api\/users\/(\d+)$/)) && m === 'PUT') {
    need(can.admin(user)); const id = +mm[1]; const b = await readBody(req);
    if (id === user.id && (b.active === false || (b.role && b.role !== 'owner'))) throw new HttpError(400, 'نمی‌توانید دسترسی خودتان را کم کنید');
    if (b.role && ['owner', 'accountant', 'partner'].includes(b.role)) db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, id);
    if (typeof b.active === 'boolean') { db.prepare('UPDATE users SET active=? WHERE id=?').run(b.active ? 1 : 0, id); if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }
    if (b.password) {
      const t = db.prepare('SELECT username FROM users WHERE id=?').get(id); if (!t) throw new HttpError(404, 'کاربر یافت نشد');
      const bad = S.checkPassword(b.password, t.username); if (bad) throw new HttpError(400, bad);
      db.prepare('UPDATE users SET pass=?, must_change=1 WHERE id=?').run(hash(String(b.password)), id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    }
    if (b.reset_2fa === true) { db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL, recovery=NULL, totp_last=0 WHERE id=?').run(id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }
    audit(user, 'user.update', { id, role: b.role, active: b.active, reset_2fa: b.reset_2fa === true, password_reset: !!b.password });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/audit' && m === 'GET') {
    need(can.admin(user));
    return send(res, 200, db.prepare('SELECT a.*, u.name AS who FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100').all());
  }
  throw new HttpError(404, 'مسیر پیدا نشد');
}

const PUB = path.join(__dirname, 'public');
const BOT_RE = /(bot\b|bot[\/ _-]|robot|crawl|spider|slurp|scrap|facebookexternalhit|embedly|preview|mediapartners|ia_archiver|archive\.org|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|ccbot|gptbot|perplexity|diffbot|omgili|seznam|yandex|baidu|sogou|naver|apis-google|inspectiontool|googleother|feedfetcher|lighthouse|pagespeed|phantomjs|whatsapp|telegram|discord|twitter|linkedin|skypeuri|viber|pinterest|snapchat|vkshare|duckduck|googleweblight|nmap|zgrab|masscan|nikto)/i;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
function secHeaders(req, res) {
  const h = {
    'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet', 'X-Permitted-Cross-Domain-Policies': 'none',
  };
  if (isSecure(req)) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}
const server = http.createServer(async (req, res) => {
  secHeaders(req, res);
  let url; try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, { error: 'درخواست نامعتبر' }); }
  try {
    // لایه ۱: robots.txt همه را از خزیدن منع می‌کند (ربات‌های مؤدب اصلاً نمی‌آیند)
    if (url.pathname === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    // لایه ۲: هر ربات/خزنده/پیش‌نمایش‌گیر (گوگل، بینگ، هوش مصنوعی، تلگرام، واتساپ…) فقط ۴۰۴ می‌بیند، انگار این آدرس وجود ندارد
    if (BOT_RE.test(String(req.headers['user-agent'] || ''))) return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    if (url.pathname.startsWith('/api/')) { res.setHeader('Cache-Control', 'no-store'); return await api(req, res, url); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'روش مجاز نیست' });
    let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUB + path.sep) || !MIME[path.extname(f)] || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e); if (!res.headersSent) send(res, 500, { error: 'خطای سرور' });
  }
});
server.headersTimeout = 15e3; server.requestTimeout = 60e3; server.keepAliveTimeout = 5e3; server.maxHeadersCount = 60;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires<? OR last_seen<?').run(Date.now(), Date.now() - IDLE_TTL), 36e5).unref();
ensureDailyBackup(); setInterval(ensureDailyBackup, 30 * 60e3).unref();
