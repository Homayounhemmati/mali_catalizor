'use strict';
// تست سرتاسری API: node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/security');

const PORT = 3900 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-'));
const OWNER_PW = 'Owner-Pass-12345', NEW_PW = 'Better-Pass-98765';
let proc;
const jar = {}; // نام -> کوکی
async function call(who, method, url, body, extra = {}) {
  const headers = { ...(body !== undefined && !extra.raw ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...(extra.headers || {}) };
  const r = await fetch(BASE + url, { method, headers, body: extra.raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const login = async (who, username, password) => call(who, 'POST', '/api/login', { username, password });

before(async () => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_USER: 'admin', ADMIN_PASS: OWNER_PW }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('security headers & noindex', async () => {
  const r = await call('x', 'GET', '/');
  for (const h of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'permissions-policy', 'x-robots-tag']) assert.ok(r.headers.get(h), h);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match((await call('x', 'GET', '/robots.txt')).body.toString(), /Disallow: \//);
  assert.equal((await call('x', 'GET', '/server.js')).headers.get('content-type').includes('html'), true, 'source must not be served');
  assert.equal((await call('x', 'GET', '/..%2fserver.js')).headers.get('content-type').includes('html'), true);
});

test('auth required & forced password change', async () => {
  assert.equal((await call('x', 'GET', '/api/transactions')).status, 401);
  const l = await login('owner', 'admin', OWNER_PW); assert.equal(l.status, 200); assert.equal(l.body.must_change, true);
  assert.equal((await call('owner', 'GET', '/api/transactions')).status, 403, 'blocked until password changed');
  assert.equal((await call('owner', 'POST', '/api/password', { old: OWNER_PW, new: 'short' })).status, 400);
  assert.equal((await call('owner', 'POST', '/api/password', { old: OWNER_PW, new: '1234567890' })).status, 400);
  assert.equal((await call('owner', 'POST', '/api/password', { old: OWNER_PW, new: NEW_PW })).status, 200);
  assert.equal((await call('owner', 'GET', '/api/transactions')).status, 200);
});

test('session cookie is hashed in DB and hardened', async () => {
  const l = await login('o2', 'admin', NEW_PW);
  const sc = l.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(path.join(DATA, 'finance.db'));
  const tok = jar.o2.split('=')[1];
  assert.equal(d.prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash=?').get(tok).n, 0, 'raw token must not be stored');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash=?').get(S.sha(tok)).n, 1);
  d.close();
});

test('CSRF: cross-site requests rejected', async () => {
  const r = await call('owner', 'POST', '/api/categories', { name: 'x', type: 'income' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
  const r2 = await call('owner', 'POST', '/api/categories', { name: 'x', type: 'income' }, { headers: { Origin: 'https://evil.example' } });
  assert.equal(r2.status, 403);
  const r3 = await call('owner', 'POST', '/api/categories', 'name=x', { raw: true, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r3.status, 415);
});

test('login rate limit & generic error', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await login('bad', 'victim', 'wrong-password-' + i);
  assert.equal(last.status, 429);
  const e = await login('bad2', 'admin', 'wrong-password');
  assert.equal(e.status, 401); assert.equal(e.body.error, 'نام کاربری یا رمز اشتباه است');
});

test('lockout is per user+IP (attacker cannot lock the owner out)', async () => {
  for (let i = 0; i < 6; i++) await call('atk', 'POST', '/api/login', { username: 'admin', password: 'guess-' + i }, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  const blocked = await call('atk', 'POST', '/api/login', { username: 'admin', password: NEW_PW }, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(blocked.status, 429, 'attacker IP is locked');
  const real = await call('real', 'POST', '/api/login', { username: 'admin', password: NEW_PW }, { headers: { 'X-Forwarded-For': '198.51.100.7' } });
  assert.equal(real.status, 200, 'owner from another IP can still log in');
});

test('users: policy, roles', async () => {
  assert.equal((await call('owner', 'POST', '/api/users', { username: 'acc', name: 'Acc', password: 'weak', role: 'accountant' })).status, 400);
  assert.equal((await call('owner', 'POST', '/api/users', { username: 'acc', name: 'Acc', password: 'Temp-Pass-Alpha1', role: 'accountant' })).status, 201);
  assert.equal((await call('owner', 'POST', '/api/users', { username: 'par', name: 'Par', password: 'Temp-Pass-Beta22', role: 'partner' })).status, 201);
  for (const [who, u, pw, np] of [['acc', 'acc', 'Temp-Pass-Alpha1', 'Final-Pass-Alpha1'], ['par', 'par', 'Temp-Pass-Beta22', 'Final-Pass-Beta22']]) {
    assert.equal((await login(who, u, pw)).body.must_change, true);
    assert.equal((await call(who, 'POST', '/api/password', { old: pw, new: np })).status, 200);
  }
  assert.equal((await call('par', 'POST', '/api/transactions', { type: 'income', amount: 1, date: '2026-01-01' })).status, 403);
  assert.equal((await call('acc', 'GET', '/api/users')).status, 403);
  assert.equal((await call('acc', 'GET', '/api/backups')).status, 403);
});

test('2FA: setup, login step, replay, recovery code', async () => {
  const s = await call('owner', 'POST', '/api/2fa/setup', { password: NEW_PW }); assert.equal(s.status, 200); assert.match(s.body.uri, /^otpauth:\/\/totp\//);
  assert.equal((await call('owner', 'POST', '/api/2fa/enable', { code: '000000' })).status, 400);
  const step = Math.floor(Date.now() / 30000), code = S.hotp(s.body.secret, step);
  const en = await call('owner', 'POST', '/api/2fa/enable', { code }); assert.equal(en.status, 200); assert.equal(en.body.recovery.length, 8);
  // دوباره وارد شو: بدون کد نباید نشست بدهد
  delete jar.o3; const l1 = await login('o3', 'admin', NEW_PW); assert.equal(l1.body.need_2fa, true); assert.equal(jar.o3, undefined);
  assert.equal((await call('o3', 'POST', '/api/login/2fa', { ticket: l1.body.ticket, code: '123456' })).status, 401);
  // کد همان گام قبلاً مصرف شده → باید رد شود (replay)
  assert.equal((await call('o3', 'POST', '/api/login/2fa', { ticket: l1.body.ticket, code })).status, 401);
  const next = S.hotp(s.body.secret, step + 1);
  const ok = await call('o3', 'POST', '/api/login/2fa', { ticket: l1.body.ticket, code: next }); assert.equal(ok.status, 200);
  assert.equal((await call('o3', 'GET', '/api/transactions')).status, 200);
  // کد بازیابی یک‌بارمصرف
  const l2 = await login('o4', 'admin', NEW_PW), rc = en.body.recovery[0];
  assert.equal((await call('o4', 'POST', '/api/login/2fa', { ticket: l2.body.ticket, code: rc })).status, 200);
  const l3 = await login('o5', 'admin', NEW_PW);
  assert.equal((await call('o5', 'POST', '/api/login/2fa', { ticket: l3.body.ticket, code: rc })).status, 401);
  assert.equal((await call('x', 'POST', '/api/login/2fa', { ticket: 'forged.ticket', code: '111111' })).status, 401);
  const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(path.join(DATA, 'finance.db'));
  const row = d.prepare("SELECT totp_secret FROM users WHERE username='admin'").get(); d.close();
  assert.ok(!row.totp_secret.includes(s.body.secret), 'TOTP secret must be encrypted at rest');
  // غیرفعال‌سازی برای ادامه تست‌ها
  const dis = await call('o3', 'POST', '/api/2fa/disable', { password: NEW_PW, code: en.body.recovery[1] });
  assert.equal(dis.status, 200);
});

test('accounts, transfers, balances', async () => {
  const cash = (await call('owner', 'GET', '/api/accounts')).body[0];
  const bank = (await call('owner', 'POST', '/api/accounts', { name: 'ملی', kind: 'bank', opening: 1000 })).body.id;
  assert.equal((await call('acc', 'POST', '/api/accounts', { name: 'x' })).status, 403);
  const tx = await call('acc', 'POST', '/api/transactions', { type: 'income', amount: 500, date: '2026-10-01', account_id: bank });
  assert.equal(tx.status, 201);
  assert.equal((await call('acc', 'POST', '/api/transfers', { from_account: bank, to_account: cash.id, amount: 300, date: '2026-10-02' })).status, 201);
  const bal = Object.fromEntries((await call('owner', 'GET', '/api/accounts')).body.map((a) => [a.name, a.balance]));
  assert.equal(bal['ملی'], 1000 + 500 - 300); assert.equal(bal['صندوق (نقد)'], 300);
  assert.equal((await call('acc', 'POST', '/api/transfers', { from_account: bank, to_account: bank, amount: 1, date: '2026-10-02' })).status, 400);
});

test('attachments: magic-byte validation, access, XSS-safe serving', async () => {
  const tx = (await call('acc', 'POST', '/api/transactions', { type: 'expense', amount: 700, date: '2026-10-03' })).body.id;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const up = await call('acc', 'POST', `/api/attachments?entity=transaction&id=${tx}&name=${encodeURIComponent('رسید.png')}`, png, { raw: true, headers: { 'Content-Type': 'image/png' } });
  assert.equal(up.status, 201);
  const html = await call('acc', 'POST', `/api/attachments?entity=transaction&id=${tx}&name=x.png`, Buffer.from('<script>alert(1)</script>........'), { raw: true, headers: { 'Content-Type': 'image/png' } });
  assert.equal(html.status, 400, 'non-image content rejected even with image content-type');
  assert.equal((await call('par', 'POST', `/api/attachments?entity=transaction&id=${tx}&name=x.png`, png, { raw: true, headers: { 'Content-Type': 'image/png' } })).status, 403);
  const g = await call('par', 'GET', `/api/attachments/${up.body.id}`);
  assert.equal(g.status, 200); assert.equal(g.headers.get('content-type'), 'image/png'); assert.match(g.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await call('x', 'GET', `/api/attachments/${up.body.id}`)).status, 401);
  assert.equal((await call('par', 'DELETE', `/api/attachments/${up.body.id}`)).status, 403);
});

test('cheques & installments settle into transactions', async () => {
  const bank = (await call('owner', 'GET', '/api/accounts')).body.find((a) => a.name === 'ملی').id;
  const ch = await call('acc', 'POST', '/api/dues', { direction: 'in', number: '123456', bank: 'ملی', party: 'علی', amount: 2000, due_date: '2026-10-20' });
  assert.equal(ch.status, 201);
  const inst = await call('acc', 'POST', '/api/dues', { direction: 'out', party: 'تأمین‌کننده', title: 'قسط خرید', items: [{ amount: 100, due_date: '2026-11-01' }, { amount: 100, due_date: '2026-12-01' }] });
  assert.equal(inst.status, 201); assert.equal(inst.body.ids.length, 2);
  const before = (await call('owner', 'GET', '/api/summary')).body;
  assert.equal((await call('acc', 'POST', `/api/dues/${ch.body.id}/settle`, { outcome: 'done', date: '2026-10-20', account_id: bank })).status, 200);
  const after = (await call('owner', 'GET', '/api/summary')).body;
  assert.equal(after.income - before.income, 2000);
  assert.equal((await call('acc', 'POST', `/api/dues/${ch.body.id}/settle`, { outcome: 'done', date: '2026-10-20' })).status, 409);
  assert.equal((await call('acc', 'POST', `/api/dues/${ch.body.id}/reopen`, {})).status, 403);
  assert.equal((await call('owner', 'POST', `/api/dues/${ch.body.id}/reopen`, {})).status, 200);
  assert.equal((await call('owner', 'GET', '/api/summary')).body.income, before.income, 'reopen removes the linked transaction');
  const ov = (await call('owner', 'GET', '/api/dues/overview?today=2026-10-18')).body; assert.equal(ov.in.n, 1);
});

test('report & import & csv injection', async () => {
  const rep = await call('par', 'GET', '/api/report?from=2026-10-01&to=2026-10-31'); assert.equal(rep.status, 200);
  assert.ok(rep.body.accounts.length >= 2); assert.equal(typeof rep.body.prev.income, 'number');
  assert.equal((await call('par', 'POST', '/api/import', { rows: [{ type: 'income', amount: 1, date: '2026-10-01' }] })).status, 403);
  const rows = [{ type: 'income', amount: 10, date: '2026-09-01', category: 'درآمد جدید', party: '=cmd|calc', note: 'a' }, { type: 'expense', amount: 5, date: '2026-09-02' }, { type: 'bad', amount: 5, date: '2026-09-02' }];
  const im = await call('acc', 'POST', '/api/import', { rows }); assert.equal(im.body.imported, 2); assert.equal(im.body.errorCount, 1);
  assert.equal((await call('acc', 'POST', '/api/import', { rows: rows.slice(0, 2) })).body.skipped, 2, 'duplicates skipped');
  const csv = (await call('owner', 'GET', '/api/export.csv')).body.toString();
  assert.ok(csv.includes('"\'=cmd|calc"'), 'formula injection neutralized'); 
});

test('soft delete, trash and backups', async () => {
  const id = (await call('acc', 'POST', '/api/transactions', { type: 'income', amount: 9, date: '2026-10-04' })).body.id;
  assert.equal((await call('acc', 'DELETE', `/api/transactions/${id}`)).status, 403);
  assert.equal((await call('owner', 'DELETE', `/api/transactions/${id}`)).status, 200);
  assert.equal((await call('owner', 'GET', '/api/trash')).body.transactions.some((t) => t.id === id), true);
  assert.equal((await call('owner', 'POST', `/api/trash/transactions/${id}/restore`, {})).status, 200);
  assert.equal((await call('owner', 'POST', '/api/backups', {})).status, 201);
  assert.equal((await call('owner', 'GET', '/api/backups/file/..%2F..%2Fetc%2Fpasswd')).status, 404);
});
