'use strict';
// سرور بدون وابستگی خارجی: فقط Node 22.13+ (sqlite و crypto داخلی)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'finance.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','accountant','partner')),
  pass TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
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
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, detail TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

if (!db.prepare('PRAGMA table_info(invoices)').all().some((c) => c.name === 'customer_id'))
  db.exec('ALTER TABLE invoices ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL');

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
  const p = process.env.ADMIN_PASS || crypto.randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO users(username,name,role,pass) VALUES(?,?,?,?)').run(u, 'مدیر', 'owner', hash(p));
  console.log(`\n=== کاربر اولیه ساخته شد ===\nنام کاربری: ${u}\nرمز عبور:  ${p}\n(بعد از اولین ورود رمز را عوض کنید)\n`);
  const ins = db.prepare('INSERT OR IGNORE INTO categories(name,type) VALUES(?,?)');
  ['فروش', 'خدمات', 'سرمایه شریک', 'سایر درآمد'].forEach((n) => ins.run(n, 'income'));
  ['خرید کالا/مواد', 'حقوق و دستمزد', 'اجاره', 'قبوض', 'حمل و نقل', 'تبلیغات', 'مالیات و عوارض', 'برداشت شریک', 'سایر هزینه'].forEach((n) => ins.run(n, 'expense'));
}

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
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const readBody = (req) => new Promise((ok, no) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) { no(new HttpError(413, 'حجم درخواست زیاد است')); req.destroy(); } });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new HttpError(400, 'JSON نامعتبر')); } });
});
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const isSecure = (req) => process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
const currentUser = (req) => {
  const t = cookies(req).sid; if (!t) return null;
  return db.prepare('SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1').get(t, Date.now()) || null;
};
const need = (ok, msg = 'دسترسی مجاز نیست') => { if (!ok) throw new HttpError(403, msg); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

const attempts = new Map(); // محدودیت تلاش ورود
const tooMany = (ip) => { const a = attempts.get(ip); return a && a.n >= 8 && Date.now() - a.t < 15 * 60e3; };
const failed = (ip) => { const a = attempts.get(ip); attempts.set(ip, { n: a && Date.now() - a.t < 15 * 60e3 ? a.n + 1 : 1, t: Date.now() }); };

function txFilter(q) {
  const w = ['t.deleted_at IS NULL'], p = [];
  if (q.type === 'income' || q.type === 'expense') { w.push('t.type=?'); p.push(q.type); }
  if (isDate(q.from)) { w.push('t.date>=?'); p.push(q.from); }
  if (isDate(q.to)) { w.push('t.date<=?'); p.push(q.to); }
  if (q.category) { w.push('t.category_id=?'); p.push(+q.category); }
  if (q.q) { w.push('(t.party LIKE ? OR t.note LIKE ? OR t.ref LIKE ?)'); const s = `%${q.q}%`; p.push(s, s, s); }
  return { where: 'WHERE ' + w.join(' AND '), p };
}
const TX_SELECT = `SELECT t.*, c.name AS category, u.name AS author FROM transactions t
  LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN users u ON u.id=t.created_by`;

function cleanTx(b) {
  const amount = Math.round(Number(b.amount));
  if (!['income', 'expense'].includes(b.type)) throw new HttpError(400, 'نوع تراکنش نامعتبر است');
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'مبلغ باید بزرگ‌تر از صفر باشد');
  if (!isDate(b.date)) throw new HttpError(400, 'تاریخ نامعتبر است');
  const method = ['cash', 'card', 'transfer', 'cheque', 'other'].includes(b.method) ? b.method : 'cash';
  return [b.type, amount, b.date, b.category_id ? +b.category_id : null, String(b.party || '').slice(0, 120), method, String(b.ref || '').slice(0, 60), String(b.note || '').slice(0, 500)];
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
function cleanCustomer(b) {
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'نام مشتری را وارد کنید');
  if (b.status && !STATUSES.includes(b.status)) throw new HttpError(400, 'وضعیت نامعتبر است');
  const t = (k, n) => String(b[k] || '').trim().slice(0, n);
  return { name, company: t('company', 120), phone: t('phone', 40), email: t('email', 120), address: t('address', 300), status: b.status || 'lead', source: t('source', 60), note: t('note', 1000), follow_up: isDate(b.follow_up) ? b.follow_up : null };
}

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
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date(), day = d.toISOString().slice(0, 10), name = `finance-${day}${manual ? '_' + d.toISOString().slice(11, 19).replace(/:/g, '') : ''}.db`, file = path.join(BACKUP_DIR, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
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
const TRASH = { transactions: 'transactions', invoices: 'invoices', customers: 'customers' };

// ---------- مسیرها ----------
async function api(req, res, url) {
  const m = req.method, p = url.pathname, q = Object.fromEntries(url.searchParams);
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  if (p === '/api/login' && m === 'POST') {
    if (tooMany(ip)) throw new HttpError(429, 'تلاش‌های زیاد؛ چند دقیقه بعد دوباره امتحان کنید');
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(b.username || '').trim().toLowerCase());
    if (!u || !verify(String(b.password || ''), u.pass)) { failed(ip); throw new HttpError(401, 'نام کاربری یا رمز اشتباه است'); }
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, Date.now() + 14 * 864e5);
    audit(u, 'login', {});
    return send(res, 200, { id: u.id, name: u.name, role: u.role, username: u.username },
      { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${isSecure(req) ? '; Secure' : ''}` });
  }
  const user = currentUser(req);
  if (p === '/api/logout' && m === 'POST') {
    const t = cookies(req).sid; if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
  }
  if (!user) throw new HttpError(401, 'ابتدا وارد شوید');
  ensureDailyBackup();
  if (m !== 'GET' && !(req.headers['content-type'] || '').includes('json') && m !== 'DELETE') throw new HttpError(415, 'نوع محتوا نامعتبر');

  if (p === '/api/me') return send(res, 200, user);

  if (p === '/api/password' && m === 'POST') {
    const b = await readBody(req);
    const row = db.prepare('SELECT pass FROM users WHERE id=?').get(user.id);
    if (!verify(String(b.old || ''), row.pass)) throw new HttpError(400, 'رمز فعلی اشتباه است');
    if (String(b.new || '').length < 6) throw new HttpError(400, 'رمز جدید حداقل ۶ کاراکتر باشد');
    db.prepare('UPDATE users SET pass=? WHERE id=?').run(hash(b.new), user.id);
    audit(user, 'password', {});
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
      const r = db.prepare('INSERT INTO transactions(type,amount,date,category_id,party,method,ref,note,created_by) VALUES(?,?,?,?,?,?,?,?,?)').run(...v, user.id);
      audit(user, 'tx.create', { id: Number(r.lastInsertRowid), v });
      return send(res, 201, { id: Number(r.lastInsertRowid) });
    }
  }
  if ((mm = p.match(/^\/api\/transactions\/(\d+)$/))) {
    const id = +mm[1];
    if (m === 'PUT') {
      need(can.write(user));
      const v = cleanTx(await readBody(req));
      const r = db.prepare("UPDATE transactions SET type=?,amount=?,date=?,category_id=?,party=?,method=?,ref=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL").run(...v, id);
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
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '﻿' + ['شناسه,نوع,مبلغ,تاریخ(میلادی),دسته,طرف حساب,روش پرداخت,شماره سند,توضیحات,ثبت‌کننده']
      .concat(rows.map((r) => [r.id, r.type === 'income' ? 'ورودی' : 'خروجی', r.amount, r.date, r.category, r.party, r.method, r.ref, r.note, r.author].map(esc).join(','))).join('\n');
    return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="transactions.csv"' });
  }



  // ---------- مشتریان (CRM) ----------
  if (p === '/api/customers') {
    if (m === 'GET') {
      const w = ['c.deleted_at IS NULL'], pr = [];
      if (STATUSES.includes(q.status)) { w.push('c.status=?'); pr.push(q.status); }
      if (q.q) { w.push('(c.name LIKE ? OR c.company LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)'); const x = `%${q.q}%`; pr.push(x, x, x, x); }
      const rows = db.prepare(`SELECT c.*, (SELECT MAX(created_at) FROM customer_notes n WHERE n.customer_id=c.id) last_contact,
        (SELECT COUNT(*) FROM customer_notes n WHERE n.customer_id=c.id) notes_count FROM customers c WHERE ${w.join(' AND ')} ORDER BY c.updated_at DESC, c.id DESC LIMIT 1000`).all(...pr);
      const fin = customerFinance(), counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM customers WHERE deleted_at IS NULL GROUP BY status').all().map((r) => [r.status, r.n]));
      return send(res, 200, { rows: rows.map((r) => ({ ...r, ...(fin.get(r.id) || { count: 0, invoiced: 0, paid: 0, due: 0 }) })), counts });
    }
    if (m === 'POST') {
      need(can.write(user)); const v = cleanCustomer(await readBody(req));
      const r = db.prepare('INSERT INTO customers(name,company,phone,email,address,status,source,note,follow_up,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(v.name, v.company, v.phone, v.email, v.address, v.status, v.source, v.note, v.follow_up, user.id);
      audit(user, 'customer.create', { id: Number(r.lastInsertRowid), name: v.name });
      return send(res, 201, { id: Number(r.lastInsertRowid), ...v });
    }
  }
  if (p === '/api/crm/overview' && m === 'GET') {
    const today = isDate(q.today) ? q.today : new Date().toISOString().slice(0, 10), fin = customerFinance();
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM customers WHERE deleted_at IS NULL GROUP BY status').all().map((r) => [r.status, r.n]));
    const followups = db.prepare("SELECT id,name,company,phone,status,follow_up FROM customers WHERE deleted_at IS NULL AND follow_up IS NOT NULL AND follow_up<=? AND status!='inactive' ORDER BY follow_up LIMIT 8").all(today);
    const debtors = db.prepare('SELECT id,name,company,phone,status FROM customers WHERE deleted_at IS NULL').all().map((c) => ({ ...c, due: (fin.get(c.id) || {}).due || 0 })).filter((c) => c.due > 0).sort((a, b) => b.due - a.due).slice(0, 6);
    const totalDue = [...fin.values()].reduce((a, f) => a + f.due, 0);
    return send(res, 200, { counts, followups, debtors, totalDue });
  }
  if ((mm = p.match(/^\/api\/customers\/(\d+)$/))) {
    const id = +mm[1], c = db.prepare('SELECT * FROM customers WHERE id=? AND deleted_at IS NULL').get(id);
    if (!c) throw new HttpError(404, 'مشتری یافت نشد');
    if (m === 'GET') {
      const notes = db.prepare('SELECT n.*, u.name AS author FROM customer_notes n LEFT JOIN users u ON u.id=n.created_by WHERE n.customer_id=? ORDER BY n.id DESC').all(id);
      const invoices = db.prepare('SELECT id FROM invoices WHERE customer_id=? AND deleted_at IS NULL ORDER BY number DESC').all(id).map((r) => invoiceFull(r.id));
      return send(res, 200, { ...c, ...(customerFinance(id).get(id) || { count: 0, invoiced: 0, paid: 0, due: 0 }), notes, invoices });
    }
    if (m === 'PUT') {
      need(can.write(user)); const b = await readBody(req);
      const v = cleanCustomer({ ...c, ...b, follow_up: 'follow_up' in b ? b.follow_up : c.follow_up });
      db.prepare('UPDATE customers SET name=?,company=?,phone=?,email=?,address=?,status=?,source=?,note=?,follow_up=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(v.name, v.company, v.phone, v.email, v.address, v.status, v.source, v.note, v.follow_up, id);
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
    if (isDate(b.follow_up)) db.prepare('UPDATE customers SET follow_up=? WHERE id=?').run(b.follow_up, id);
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
      const r = db.prepare("INSERT INTO transactions(type,amount,date,category_id,party,method,ref,note,created_by) VALUES('income',?,?,?,?,?,?,?,?)")
        .run(full.total, isDate(body.date) ? body.date : inv.date, cat ? cat.id : null, inv.customer, method, String(inv.number), `دریافت وجه فاکتور ${inv.number}`, user.id);
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
    });
  }
  if ((mm = p.match(/^\/api\/trash\/(transactions|invoices|customers)\/(\d+)(\/restore)?$/))) {
    need(can.admin(user)); const tbl = TRASH[mm[1]], id = +mm[2];
    const row = db.prepare(`SELECT * FROM ${tbl} WHERE id=? AND deleted_at IS NOT NULL`).get(id);
    if (!row) throw new HttpError(404, 'در سطل بازیافت یافت نشد');
    if (mm[3] && m === 'POST') {
      db.prepare(`UPDATE ${tbl} SET deleted_at=NULL, deleted_by=NULL WHERE id=?`).run(id);
      audit(user, 'trash.restore', { type: mm[1], id }); return send(res, 200, { ok: true });
    }
    if (!mm[3] && m === 'DELETE') {
      db.prepare(`DELETE FROM ${tbl} WHERE id=?`).run(id);
      audit(user, 'trash.purge', { type: mm[1], id }); return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/users') {
    need(can.admin(user));
    if (m === 'GET') return send(res, 200, db.prepare('SELECT id,username,name,role,active FROM users ORDER BY id').all());
    if (m === 'POST') {
      const b = await readBody(req);
      const username = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_.]{3,30}$/.test(username)) throw new HttpError(400, 'نام کاربری: ۳ تا ۳۰ حرف انگلیسی/عدد');
      if (!['owner', 'accountant', 'partner'].includes(b.role)) throw new HttpError(400, 'نقش نامعتبر');
      if (String(b.password || '').length < 6) throw new HttpError(400, 'رمز حداقل ۶ کاراکتر');
      try { db.prepare('INSERT INTO users(username,name,role,pass) VALUES(?,?,?,?)').run(username, String(b.name || username).slice(0, 60), b.role, hash(b.password)); }
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
    if (b.password) { if (String(b.password).length < 6) throw new HttpError(400, 'رمز حداقل ۶ کاراکتر'); db.prepare('UPDATE users SET pass=? WHERE id=?').run(hash(b.password), id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }
    audit(user, 'user.update', { id, role: b.role, active: b.active });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/audit' && m === 'GET') {
    need(can.admin(user));
    return send(res, 200, db.prepare('SELECT a.*, u.name AS who FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100').all());
  }
  throw new HttpError(404, 'مسیر پیدا نشد');
}

const PUB = path.join(__dirname, 'public');
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e); send(res, 500, { error: 'خطای سرور' });
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()), 36e5).unref();
ensureDailyBackup(); setInterval(ensureDailyBackup, 30 * 60e3).unref();
