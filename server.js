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
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, detail TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

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
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const readBody = (req) => new Promise((ok, no) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) { no(new HttpError(413, 'حجم درخواست زیاد است')); req.destroy(); } });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new HttpError(400, 'JSON نامعتبر')); } });
});
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https';
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
  const w = [], p = [];
  if (q.type === 'income' || q.type === 'expense') { w.push('t.type=?'); p.push(q.type); }
  if (isDate(q.from)) { w.push('t.date>=?'); p.push(q.from); }
  if (isDate(q.to)) { w.push('t.date<=?'); p.push(q.to); }
  if (q.category) { w.push('t.category_id=?'); p.push(+q.category); }
  if (q.q) { w.push('(t.party LIKE ? OR t.note LIKE ? OR t.ref LIKE ?)'); const s = `%${q.q}%`; p.push(s, s, s); }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', p };
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


function invoiceFull(id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
  inv.items = db.prepare('SELECT title,qty,price FROM invoice_items WHERE invoice_id=? ORDER BY id').all(id);
  inv.subtotal = inv.items.reduce((a, i) => a + Math.round(i.qty * i.price), 0);
  inv.tax = Math.round(Math.max(0, inv.subtotal - inv.discount) * inv.tax_percent / 100);
  inv.total = Math.max(0, inv.subtotal - inv.discount) + inv.tax;
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
  return { date: b.date, customer, phone: String(b.phone || '').slice(0, 40), address: String(b.address || '').slice(0, 300), discount, tax_percent, note: String(b.note || '').slice(0, 500), items };
}
function saveItems(id, items) {
  const ins = db.prepare('INSERT INTO invoice_items(invoice_id,title,qty,price) VALUES(?,?,?,?)');
  items.forEach((i) => ins.run(id, i.title, i.qty, i.price));
}

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
      const r = db.prepare("UPDATE transactions SET type=?,amount=?,date=?,category_id=?,party=?,method=?,ref=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(...v, id);
      if (!r.changes) throw new HttpError(404, 'یافت نشد');
      audit(user, 'tx.update', { id, v });
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      need(can.delete(user), 'فقط مدیر می‌تواند حذف کند');
      const old = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
      if (!old) throw new HttpError(404, 'یافت نشد');
      db.prepare('DELETE FROM transactions WHERE id=?').run(id);
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
    if (m === 'GET') return send(res, 200, db.prepare('SELECT id FROM invoices ORDER BY number DESC LIMIT 300').all().map((r) => invoiceFull(r.id)));
    if (m === 'POST') {
      need(can.write(user)); const v = cleanInvoice(await readBody(req));
      const number = (db.prepare('SELECT MAX(number) n FROM invoices').get().n || 1000) + 1;
      const r = db.prepare('INSERT INTO invoices(number,date,customer,phone,address,discount,tax_percent,note,created_by) VALUES(?,?,?,?,?,?,?,?,?)').run(number, v.date, v.customer, v.phone, v.address, v.discount, v.tax_percent, v.note, user.id);
      const id = Number(r.lastInsertRowid); saveItems(id, v.items);
      audit(user, 'invoice.create', { id, number });
      return send(res, 201, invoiceFull(id));
    }
  }
  if ((mm = p.match(/^\/api\/invoices\/(\d+)(\/pay)?$/))) {
    const id = +mm[1], inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
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
      audit(user, 'invoice.pay', { id, number: inv.number, amount: full.total });
      return send(res, 200, invoiceFull(id));
    }
    if (m === 'GET') return send(res, 200, invoiceFull(id));
    if (m === 'PUT') {
      need(can.write(user));
      if (inv.status === 'paid') throw new HttpError(409, 'فاکتور پرداخت‌شده قابل ویرایش نیست');
      const v = cleanInvoice(await readBody(req));
      db.prepare('UPDATE invoices SET date=?,customer=?,phone=?,address=?,discount=?,tax_percent=?,note=? WHERE id=?').run(v.date, v.customer, v.phone, v.address, v.discount, v.tax_percent, v.note, id);
      db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(id); saveItems(id, v.items);
      audit(user, 'invoice.update', { id, number: inv.number });
      return send(res, 200, invoiceFull(id));
    }
    if (m === 'DELETE') {
      need(can.delete(user), 'فقط مدیر می‌تواند حذف کند');
      db.prepare('DELETE FROM invoices WHERE id=?').run(id);
      audit(user, 'invoice.delete', inv);
      return send(res, 200, { ok: true });
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
