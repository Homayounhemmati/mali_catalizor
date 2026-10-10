'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fa = (n) => Number(n).toLocaleString('fa-IR');
const ROLES = { owner: 'مدیر', accountant: 'حسابدار', partner: 'شریک' };
const METHODS = { cash: 'نقد', card: 'کارت', transfer: 'انتقال بانکی', cheque: 'چک', other: 'سایر' };
const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

// ---------- تاریخ شمسی ----------
const div = (a, b) => Math.floor(a / b);
function g2j(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * div(days, 12053); days %= 12053;
  jy += 4 * div(days, 1461); days %= 1461;
  if (days > 365) { jy += div(days - 1, 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + div(days, 31) : 7 + div(days - 186, 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}
function j2g(jy, jm, jd) {
  jy += 1595;
  let days = -355668 + 365 * jy + div(jy, 33) * 8 + div((jy % 33) + 3, 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * div(days, 146097); days %= 146097;
  if (days > 36524) { gy += 100 * div(--days, 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * div(days, 1461); days %= 1461;
  if (days > 365) { gy += div(days - 1, 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const sal = [0, 31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm; for (gm = 0; gm < 13 && gd > sal[gm]; gm++) gd -= sal[gm];
  return [gy, gm, gd];
}
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (jy, jm, jd) => { const [y, m, d] = j2g(jy, jm, jd); return `${y}-${pad(m)}-${pad(d)}`; };
const jOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return g2j(y, m, d); };
const showDate = (iso) => { const [y, m, d] = jOf(iso); return `${fa(d)} ${MONTHS[m - 1]} ${fa(y).replace(/٬/g, '')}`; };
const todayIso = () => { const t = new Date(); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
const daysIn = (jy, jm) => (jm <= 6 ? 31 : jm <= 11 ? 30 : (g2j(...j2g(jy, 12, 30)).join() === [jy, 12, 30].join() ? 30 : 29));

// انتخابگر تاریخ شمسی (سه سلکت)
function datePicker(el, iso, onChange) {
  const [cy] = jOf(todayIso());
  let [y, m, d] = iso ? jOf(iso) : [0, 0, 0];
  el.innerHTML = `<select data-p="d"></select><select data-p="m"></select><select data-p="y"></select>`;
  const sd = $('[data-p=d]', el), sm = $('[data-p=m]', el), sy = $('[data-p=y]', el);
  if (iso) { sy.innerHTML = ''; } 
  const years = [...Array(12)].map((_, i) => cy + 2 - i);
  if (y && !years.includes(y)) years.push(y);
  sy.innerHTML = (iso ? '' : '<option value="">سال</option>') + years.sort((a, b) => b - a).map((v) => `<option value="${v}">${fa(v).replace(/٬/g, '')}</option>`).join('');
  sm.innerHTML = (iso ? '' : '<option value="">ماه</option>') + MONTHS.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');
  const fillDays = () => {
    const n = sy.value && sm.value ? daysIn(+sy.value, +sm.value) : 31, cur = sd.value;
    sd.innerHTML = (iso ? '' : '<option value="">روز</option>') + [...Array(n)].map((_, i) => `<option value="${i + 1}">${fa(i + 1)}</option>`).join('');
    if (cur && +cur <= n) sd.value = cur;
  };
  if (y) { sy.value = y; sm.value = m; } fillDays(); if (d) sd.value = d;
  el.get = () => (sy.value && sm.value && sd.value ? isoOf(+sy.value, +sm.value, +sd.value) : '');
  el.onchange = (e) => { if (e.target !== sd) fillDays(); onChange && onChange(el.get()); };
  el.set = (v) => datePicker(el, v, onChange);
}

// ---------- API ----------
let me = null;
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) { if (r.status === 401 && me) { me = null; showLogin(); } throw new Error(data.error || 'خطا'); }
  return data;
}
function toast(msg, kind = 'good') {
  const d = document.createElement('div'); d.className = kind; d.textContent = msg; $('#toast').append(d);
  setTimeout(() => { d.style.transition = '.4s'; d.style.opacity = 0; setTimeout(() => d.remove(), 400); }, 2600);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'bad'); } };

// ---------- ورود ----------
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  const f = new FormData(e.target);
  try { me = await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } }); e.target.reset(); start(); }
  catch (er) { $('#loginErr').textContent = er.message; }
};
$('#logoutBtn').onclick = async () => { await api('/logout', { method: 'POST', body: {} }); me = null; showLogin(); };
$('#pwBtn').onclick = () => modal(`<h2>تغییر رمز عبور</h2><form class="form" id="pwForm">
  <label class="full">رمز فعلی<input name="old" type="password" dir="ltr" required></label>
  <label class="full">رمز جدید<input name="new" type="password" dir="ltr" minlength="6" required></label>
  <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">ذخیره</button></div></form>`,
  (s) => { $('#pwForm', s).onsubmit = guard(async (e) => { e.preventDefault(); const f = new FormData(e.target); await api('/password', { method: 'POST', body: { old: f.get('old'), new: f.get('new') } }); closeModal(); toast('رمز تغییر کرد'); }); });

// ---------- مودال ----------
function modal(html, init) {
  const s = $('#sheet'); s.innerHTML = html; $('#modal').classList.remove('hidden');
  $$('[data-close]', s).forEach((b) => (b.onclick = closeModal)); init && init(s);
}
function closeModal() { $('#modal').classList.add('hidden'); $('#sheet').classList.remove('wide'); }
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());

// ---------- شروع برنامه ----------
let cats = [];
async function start() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#meName').textContent = me.name; $('#meRole').textContent = ROLES[me.role];
  document.body.classList.toggle('readonly', me.role === 'partner'); document.body.classList.toggle('is-owner', me.role === 'owner');
  $$('[data-role=owner]').forEach((b) => b.classList.toggle('hidden', me.role !== 'owner'));
  await loadCats(); goTab('dash');
}
async function loadCats() {
  cats = await api('/categories');
  $('#fcat').innerHTML = '<option value="">همه دسته‌ها</option>' + cats.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.type === 'income' ? 'ورودی' : 'خروجی'})</option>`).join('');
  const li = (c) => `<li>${esc(c.name)}${me.role === 'owner' ? `<button title="حذف" data-delcat="${c.id}">✕</button>` : ''}</li>`;
  $('#catIn').innerHTML = cats.filter((c) => c.type === 'income').map(li).join('');
  $('#catOut').innerHTML = cats.filter((c) => c.type === 'expense').map(li).join('');
  $$('[data-delcat]').forEach((b) => (b.onclick = guard(async () => { if (!confirm('این دسته حذف شود؟')) return; await api('/categories/' + b.dataset.delcat, { method: 'DELETE' }); await loadCats(); toast('حذف شد'); })));
}
$('#catForm').onsubmit = guard(async (e) => {
  e.preventDefault(); const f = new FormData(e.target);
  await api('/categories', { method: 'POST', body: { name: f.get('name'), type: f.get('type') } }); e.target.reset(); await loadCats(); toast('دسته اضافه شد');
});

let tab = 'dash';
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) goTab(b.dataset.tab); };
function goTab(t) {
  tab = t;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.tab').forEach((s) => { const on = s.id === 'tab-' + t; s.classList.toggle('hidden', !on); });
  ({ dash: loadDash, tx: () => loadTx(true), users: loadUsers, cats: () => {}, inv: loadInv })[t]();
}
$$('[data-new]').forEach((b) => (b.onclick = () => txModal()));

// ---------- شمارنده متحرک ----------
function countUp(el, to) {
  const from = Number(el.dataset.v || 0); el.dataset.v = to; const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - k, 4); el.textContent = fa(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// ---------- داشبورد ----------
let range = 'month';
$('#range').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; range = b.dataset.r; $$('#range button').forEach((x) => x.classList.toggle('active', x === b)); loadDash(); };
function rangeQuery() {
  const [jy, jm] = jOf(todayIso()), now = new Date();
  if (range === 'month') return { from: isoOf(jy, jm, 1), to: isoOf(jy, jm, daysIn(jy, jm)) };
  if (range === 'year') return { from: isoOf(jy, 1, 1), to: isoOf(jy, 12, daysIn(jy, 12)) };
  if (range === '30') { const f = new Date(now - 29 * 864e5); return { from: `${f.getFullYear()}-${pad(f.getMonth() + 1)}-${pad(f.getDate())}`, to: todayIso() }; }
  return {};
}
const qs = (o) => '?' + new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null))).toString();
const PALETTE = ['#7c8cff', '#ff6b81', '#2ee59d', '#ffb454', '#b47cff', '#4cc9f0', '#f78fb3', '#a3e635'];
const loadDash = guard(async () => {
  const q = rangeQuery(), [s, tx] = await Promise.all([api('/summary' + qs(q)), api('/transactions' + qs({ ...q, limit: 8 }))]);
  countUp($('#sIn'), s.income); countUp($('#sOut'), s.expense); countUp($('#sBal'), s.balance);
  // نمودار: روزانه برای بازه کوتاه، ماهانه برای بقیه
  const monthly = range === 'year' || range === 'all', groups = new Map();
  s.byDay.forEach((r) => { const [y, m, d] = jOf(r.date), k = monthly ? `${y}-${pad(m)}` : r.date, label = monthly ? MONTHS[m - 1] : fa(d); const g = groups.get(k) || { label, inc: 0, exp: 0 }; g.inc += r.inc; g.exp += r.exp; groups.set(k, g); });
  const arr = [...groups.values()], max = Math.max(1, ...arr.flatMap((g) => [g.inc, g.exp]));
  $('#barChart').innerHTML = arr.length ? arr.map((g, i) => `<div class="col"><div class="bars">
    <div class="bar i" title="ورودی: ${fa(g.inc)}" style="height:${g.inc / max * 100}%;animation-delay:${i * 40}ms"></div>
    <div class="bar o" title="خروجی: ${fa(g.exp)}" style="height:${g.exp / max * 100}%;animation-delay:${i * 40 + 60}ms"></div></div><small>${g.label}</small></div>`).join('') : '<div class="empty">داده‌ای در این بازه نیست</div>';
  // دونات هزینه‌ها
  const ex = s.byCat.filter((c) => c.type === 'expense'), tot = ex.reduce((a, c) => a + c.total, 0);
  if (!tot) $('#donut').innerHTML = '<div class="empty">هزینه‌ای ثبت نشده</div>';
  else {
    const R = 60, C = 2 * Math.PI * R; let off = 0;
    const segs = ex.map((c, i) => { const len = c.total / tot * C, el = `<circle class="seg" r="${R}" cx="80" cy="80" stroke="${PALETTE[i % 8]}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" style="animation-delay:${i * 120}ms"/>`; off += len; return el; }).join('');
    $('#donut').innerHTML = `<svg class="donut" width="160" height="160" viewBox="0 0 160 160"><g transform="rotate(-90 80 80)">${segs}</g></svg>
      <div class="legend">${ex.map((c, i) => `<div style="animation-delay:${i * 80}ms"><i style="background:${PALETTE[i % 8]}"></i>${esc(c.name)}<em>${fa(Math.round(c.total / tot * 100))}٪</em></div>`).join('')}</div>`;
  }
  $('#recent').innerHTML = txTable(tx.rows, false);
});

// ---------- جدول تراکنش‌ها ----------
function txTable(rows, actions = true) {
  if (!rows.length) return '<div class="empty">تراکنشی وجود ندارد</div>';
  const canW = me.role !== 'partner';
  return `<table><thead><tr><th>تاریخ</th><th>نوع</th><th>مبلغ (تومان)</th><th>علت</th><th>طرف حساب</th><th>روش</th><th>توضیحات</th>${actions && canW ? '<th></th>' : ''}</tr></thead><tbody>${rows.map((r, i) => `
  <tr style="animation-delay:${Math.min(i, 15) * 35}ms"><td>${showDate(r.date)}</td><td><span class="tag">${r.type === 'income' ? '⬇ ورودی' : '⬆ خروجی'}</span></td>
  <td class="amt ${r.type}">${r.type === 'income' ? '+' : '−'}${fa(r.amount)}</td><td>${esc(r.category || '—')}</td><td>${esc(r.party || '—')}</td>
  <td>${METHODS[r.method] || ''}${r.ref ? ` <small class="muted">#${esc(r.ref)}</small>` : ''}</td><td class="muted">${esc(r.note)}</td>
  ${actions && canW ? `<td class="act"><button data-edit="${r.id}" title="ویرایش">✎</button>${me.role === 'owner' ? `<button class="del" data-del="${r.id}" title="حذف">🗑</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table>`;
}
let txRows = [], txOffset = 0, txTotal = 0, fFrom, fTo;
const filters = () => ({ q: $('#fq').value.trim(), type: $('#ftype').value, category: $('#fcat').value, from: fFrom.get(), to: fTo.get() });
fFrom = $('#ffrom'); fTo = $('#fto'); datePicker(fFrom, '', () => loadTx(true)); datePicker(fTo, '', () => loadTx(true));
let debounce; $('#fq').oninput = () => { clearTimeout(debounce); debounce = setTimeout(() => loadTx(true), 300); };
$('#ftype').onchange = $('#fcat').onchange = () => loadTx(true);
$('#fclear').onclick = () => { $('#fq').value = ''; $('#ftype').value = ''; $('#fcat').value = ''; fFrom.set(''); fTo.set(''); loadTx(true); };
$('#more').onclick = () => loadTx(false);
$('#csv').onclick = (e) => { e.preventDefault(); location.href = '/api/export.csv' + qs(filters()); };
const loadTx = guard(async (reset) => {
  if (reset) { txRows = []; txOffset = 0; }
  const r = await api('/transactions' + qs({ ...filters(), limit: 50, offset: txOffset }));
  txRows = txRows.concat(r.rows); txOffset = txRows.length; txTotal = r.total;
  $('#txTable').innerHTML = txTable(txRows).replace(/^<table>|<\/table>$/g, '');
  $('#more').hidden = txRows.length >= txTotal;
  $('#txInfo').textContent = `${fa(txRows.length)} از ${fa(txTotal)} — ورودی ${fa(r.income)} | خروجی ${fa(r.expense)} | مانده ${fa(r.income - r.expense)}`;
  $$('[data-edit]', $('#txTable')).forEach((b) => (b.onclick = () => txModal(txRows.find((x) => x.id == b.dataset.edit))));
  $$('[data-del]', $('#txTable')).forEach((b) => (b.onclick = guard(async () => { if (!confirm('این تراکنش حذف شود؟ (قابل بازگشت نیست)')) return; await api('/transactions/' + b.dataset.del, { method: 'DELETE' }); toast('حذف شد'); loadTx(true); })));
});

// ---------- فرم ثبت/ویرایش ----------
function txModal(tx) {
  let type = tx ? tx.type : 'income';
  modal(`<h2>${tx ? 'ویرایش تراکنش' : 'ثبت تراکنش جدید'}</h2><form class="form" id="txForm">
    <div class="seg2 full" id="seg"><span class="pill"></span><button type="button" data-t="income">⬇ ورودی (دریافت)</button><button type="button" data-t="expense">⬆ خروجی (پرداخت)</button></div>
    <label>مبلغ (تومان)<input name="amount" inputmode="numeric" dir="ltr" required autofocus value="${tx ? tx.amount.toLocaleString('en') : ''}"></label>
    <label>تاریخ<div class="jdate" id="fdate"></div></label>
    <label id="catLbl">علت / دسته<select name="category_id"></select></label>
    <label>روش پرداخت<select name="method">${Object.entries(METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
    <label>طرف حساب<input name="party" maxlength="120" placeholder="نام شخص یا شرکت" value="${esc(tx?.party)}"></label>
    <label>شماره سند / فاکتور<input name="ref" maxlength="60" dir="ltr" value="${esc(tx?.ref)}"></label>
    <label class="full">توضیحات<textarea name="note" rows="2" maxlength="500">${esc(tx?.note)}</textarea></label>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">${tx ? 'ذخیره تغییرات' : 'ثبت'}</button></div></form>`,
  (s) => {
    const f = $('#txForm', s), seg = $('#seg', s), dp = $('#fdate', s);
    datePicker(dp, tx ? tx.date : todayIso());
    const paint = () => {
      seg.classList.toggle('out', type === 'expense'); $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.t === type));
      $('[name=category_id]', f).innerHTML = '<option value="">— بدون دسته —</option>' + cats.filter((c) => c.type === type).map((c) => `<option value="${c.id}" ${tx && tx.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    };
    seg.onclick = (e) => { const b = e.target.closest('button'); if (b) { type = b.dataset.t; paint(); } };
    paint(); if (tx) f.method.value = tx.method;
    const amt = f.amount; amt.oninput = () => { const n = amt.value.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/\D/g, ''); amt.value = n ? Number(n).toLocaleString('en') : ''; };
    f.onsubmit = guard(async (e) => {
      e.preventDefault(); const d = dp.get(); if (!d) throw new Error('تاریخ را کامل انتخاب کنید');
      const body = { type, date: d, amount: f.amount.value.replace(/,/g, ''), category_id: f.category_id.value, method: f.method.value, party: f.party.value, ref: f.ref.value, note: f.note.value };
      await api(tx ? '/transactions/' + tx.id : '/transactions', { method: tx ? 'PUT' : 'POST', body });
      closeModal(); toast(tx ? 'ویرایش شد' : 'ثبت شد'); goTab(tab === 'tx' ? 'tx' : 'dash');
    });
  });
}

// ---------- کاربران ----------
const loadUsers = guard(async () => {
  const us = await api('/users');
  $('#userTable').innerHTML = `<thead><tr><th>نام</th><th>نام کاربری</th><th>نقش</th><th>وضعیت</th><th></th></tr></thead><tbody>${us.map((u, i) => `<tr style="animation-delay:${i * 40}ms">
    <td>${esc(u.name)}</td><td dir="ltr" style="text-align:right">${esc(u.username)}</td>
    <td><select data-role="${u.id}" ${u.id === me.id ? 'disabled' : ''}>${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
    <td><span class="tag">${u.active ? 'فعال' : 'غیرفعال'}</span></td>
    <td class="act">${u.id !== me.id ? `<button data-toggle="${u.id}" data-on="${u.active}">${u.active ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</button>` : ''}<button data-reset="${u.id}">رمز جدید</button></td></tr>`).join('')}</tbody>`;
  $$('[data-role]', $('#userTable')).forEach((s) => (s.onchange = guard(async () => { await api('/users/' + s.dataset.role, { method: 'PUT', body: { role: s.value } }); toast('نقش تغییر کرد'); })));
  $$('[data-toggle]').forEach((b) => (b.onclick = guard(async () => { await api('/users/' + b.dataset.toggle, { method: 'PUT', body: { active: b.dataset.on !== '1' } }); loadUsers(); })));
  $$('[data-reset]').forEach((b) => (b.onclick = guard(async () => { const p = prompt('رمز جدید (حداقل ۶ کاراکتر):'); if (!p) return; await api('/users/' + b.dataset.reset, { method: 'PUT', body: { password: p } }); toast('رمز تغییر کرد'); })));
  const log = await api('/audit'), L = { login: 'ورود', password: 'تغییر رمز', 'tx.create': 'ثبت تراکنش', 'tx.update': 'ویرایش تراکنش', 'tx.delete': 'حذف تراکنش', 'user.create': 'افزودن کاربر', 'user.update': 'ویرایش کاربر', 'invoice.create': 'صدور فاکتور', 'invoice.update': 'ویرایش فاکتور', 'invoice.delete': 'حذف فاکتور', 'invoice.pay': 'ثبت پرداخت فاکتور' };
  $('#auditList').innerHTML = log.map((a) => `<div><b>${esc(a.who || '—')}</b>${L[a.action] || esc(a.action)}<span style="margin-inline-start:auto" dir="ltr">${esc(a.at)}</span></div>`).join('') || '<div class="empty">—</div>';
});
$('#userForm').onsubmit = guard(async (e) => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
  await api('/users', { method: 'POST', body: f }); e.target.reset(); toast('کاربر اضافه شد'); loadUsers();
});

// ---------- فاکتور ----------
let biz = {}, invs = [];
const loadInv = guard(async () => {
  [invs, biz] = await Promise.all([api('/invoices'), api('/settings')]);
  const canW = me.role !== 'partner';
  $('#invTable').innerHTML = invs.length ? `<thead><tr><th>شماره</th><th>تاریخ</th><th>مشتری</th><th>مبلغ کل (تومان)</th><th>وضعیت</th><th></th></tr></thead><tbody>${invs.map((v, i) => `
    <tr style="animation-delay:${Math.min(i, 15) * 35}ms"><td><b>${fa(v.number).replace(/٬/g, '')}</b></td><td>${showDate(v.date)}</td><td>${esc(v.customer)}</td>
    <td class="amt">${fa(v.total)}</td><td><span class="status ${v.status}">${v.status === 'paid' ? 'پرداخت شده' : 'پرداخت نشده'}</span></td>
    <td class="act"><button data-view="${v.id}" title="مشاهده و چاپ">🖨</button>${canW && v.status === 'unpaid' ? `<button data-pay="${v.id}" title="ثبت دریافت وجه">✔ دریافت شد</button><button data-editinv="${v.id}" title="ویرایش">✎</button>` : ''}${me.role === 'owner' ? `<button class="del" data-delinv="${v.id}" title="حذف">🗑</button>` : ''}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td><div class="empty">هنوز فاکتوری صادر نشده</div></td></tr></tbody>';
  const byId = (id) => invs.find((x) => x.id == id);
  $$('[data-view]', $('#invTable')).forEach((b) => (b.onclick = () => invView(byId(b.dataset.view))));
  $$('[data-editinv]', $('#invTable')).forEach((b) => (b.onclick = () => invModal(byId(b.dataset.editinv))));
  $$('[data-pay]', $('#invTable')).forEach((b) => (b.onclick = () => payModal(byId(b.dataset.pay))));
  $$('[data-delinv]', $('#invTable')).forEach((b) => (b.onclick = guard(async () => { if (!confirm('فاکتور حذف شود؟ (تراکنش مالی ثبت‌شده حذف نمی‌شود)')) return; await api('/invoices/' + b.dataset.delinv, { method: 'DELETE' }); toast('حذف شد'); loadInv(); })));
});
$('#newInv').onclick = () => invModal();
$('#bizBtn').onclick = guard(async () => {
  biz = await api('/settings');
  modal(`<h2>اطلاعات کسب‌وکار (بالای فاکتور)</h2><form class="form" id="bizForm">
    <label class="full">نام کسب‌وکار<input name="business_name" value="${esc(biz.business_name)}"></label>
    <label>تلفن<input name="business_phone" dir="ltr" value="${esc(biz.business_phone)}"></label>
    <label>آدرس<input name="business_address" value="${esc(biz.business_address)}"></label>
    <label class="full">متن پایین فاکتور (شماره حساب، شرایط…)<textarea name="business_note" rows="2">${esc(biz.business_note)}</textarea></label>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">ذخیره</button></div></form>`,
  (s) => { $('#bizForm', s).onsubmit = guard(async (e) => { e.preventDefault(); await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); closeModal(); toast('ذخیره شد'); }); });
});
const num = (v) => Number(String(v).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^\d.]/g, '')) || 0;
function invModal(inv) {
  modal(`<h2>${inv ? 'ویرایش فاکتور ' + fa(inv.number).replace(/٬/g, '') : 'صدور فاکتور جدید'}</h2><form class="form" id="invForm">
    <label>نام مشتری<input name="customer" required maxlength="120" value="${esc(inv?.customer)}"></label>
    <label>تاریخ<div class="jdate" id="idate"></div></label>
    <label>تلفن<input name="phone" dir="ltr" maxlength="40" value="${esc(inv?.phone)}"></label>
    <label>آدرس<input name="address" maxlength="300" value="${esc(inv?.address)}"></label>
    <div class="full"><div class="itemhead"><span>شرح کالا / خدمت</span><span>تعداد</span><span>قیمت واحد</span><span>جمع</span><span></span></div><div class="items" id="items"></div>
      <button type="button" class="btn ghost sm" id="addItem" style="margin-top:8px">＋ افزودن ردیف</button></div>
    <label>تخفیف (تومان)<input name="discount" inputmode="numeric" dir="ltr" value="${inv ? inv.discount : ''}"></label>
    <label>مالیات (٪)<input name="tax_percent" inputmode="decimal" dir="ltr" value="${inv ? inv.tax_percent : ''}" placeholder="۰"></label>
    <label class="full">توضیحات<textarea name="note" rows="2" maxlength="500">${esc(inv?.note)}</textarea></label>
    <div class="totals full" id="totals"></div>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">${inv ? 'ذخیره' : 'صدور فاکتور'}</button></div></form>`,
  (s) => {
    $('#sheet').classList.add('wide');
    const f = $('#invForm', s), box = $('#items', s), dp = $('#idate', s); datePicker(dp, inv ? inv.date : todayIso());
    const calc = () => {
      const rows = $$('.item', box).map((r) => ({ q: num($('[data-q]', r).value), p: num($('[data-p]', r).value), el: $('.ln', r) }));
      let sub = 0; rows.forEach((r) => { const l = Math.round(r.q * r.p); r.el.textContent = fa(l); sub += l; });
      const disc = Math.min(sub, num(f.discount.value)), tax = Math.round((sub - disc) * Math.min(100, num(f.tax_percent.value)) / 100);
      $('#totals', s).innerHTML = `<div><span>جمع کل</span><b>${fa(sub)}</b></div><div><span>تخفیف</span><b>${fa(disc)}</b></div><div><span>مالیات</span><b>${fa(tax)}</b></div><div class="grand"><span>مبلغ قابل پرداخت (تومان)</span><span>${fa(sub - disc + tax)}</span></div>`;
    };
    const addRow = (it = {}) => {
      const r = document.createElement('div'); r.className = 'item';
      r.innerHTML = `<input data-t placeholder="مثلاً: طراحی لوگو" maxlength="200" value="${esc(it.title)}"><input data-q inputmode="decimal" dir="ltr" value="${it.qty ?? 1}"><input data-p inputmode="numeric" dir="ltr" value="${it.price != null ? it.price.toLocaleString('en') : ''}"><span class="ln">۰</span><button type="button" title="حذف ردیف">✕</button>`;
      $('[data-p]', r).oninput = (e) => { const n = num(e.target.value); e.target.value = n ? n.toLocaleString('en') : ''; };
      $('button', r).onclick = () => { if ($$('.item', box).length > 1) { r.remove(); calc(); } };
      box.append(r); calc();
    };
    (inv ? inv.items : [{}]).forEach(addRow);
    $('#addItem', s).onclick = () => addRow();
    f.oninput = calc; calc();
    f.onsubmit = guard(async (e) => {
      e.preventDefault(); const d = dp.get(); if (!d) throw new Error('تاریخ را کامل انتخاب کنید');
      const items = $$('.item', box).map((r) => ({ title: $('[data-t]', r).value, qty: num($('[data-q]', r).value), price: num($('[data-p]', r).value) })).filter((i) => i.title.trim());
      const body = { customer: f.customer.value, phone: f.phone.value, address: f.address.value, date: d, items, discount: num(f.discount.value), tax_percent: num(f.tax_percent.value), note: f.note.value };
      const saved = await api(inv ? '/invoices/' + inv.id : '/invoices', { method: inv ? 'PUT' : 'POST', body });
      toast(inv ? 'فاکتور ذخیره شد' : 'فاکتور صادر شد'); await loadInv(); invView(saved);
    });
  });
}
function payModal(inv) {
  modal(`<h2>ثبت دریافت وجه فاکتور ${fa(inv.number).replace(/٬/g, '')}</h2><p class="muted">مبلغ ${fa(inv.total)} تومان به‌عنوان «ورودی» در تراکنش‌ها ثبت می‌شود.</p><form class="form" id="payForm">
    <label>تاریخ دریافت<div class="jdate" id="pdate"></div></label>
    <label>روش پرداخت<select name="method">${Object.entries(METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">ثبت دریافت</button></div></form>`,
  (s) => { const dp = $('#pdate', s); datePicker(dp, todayIso());
    $('#payForm', s).onsubmit = guard(async (e) => { e.preventDefault(); await api(`/invoices/${inv.id}/pay`, { method: 'POST', body: { date: dp.get(), method: e.target.method.value } }); closeModal(); toast('دریافت ثبت شد'); loadInv(); }); });
}
function paperHtml(v) {
  const n = fa(v.number).replace(/٬/g, '');
  return `<div class="paper"><div class="hd"><div><h1>${esc(biz.business_name || 'فاکتور فروش')}</h1><div>${esc(biz.business_address || '')}</div><div dir="ltr" style="text-align:right">${esc(biz.business_phone || '')}</div></div>
    <div class="meta"><b>فاکتور شماره ${n}</b><br>تاریخ: ${showDate(v.date)}${v.status === 'paid' ? '<br><span class="stamp">پرداخت شد</span>' : ''}</div></div>
    <div class="cust"><b>مشتری:</b> ${esc(v.customer)}${v.phone ? ` &nbsp;|&nbsp; <b>تلفن:</b> <span dir="ltr">${esc(v.phone)}</span>` : ''}${v.address ? `<br><b>آدرس:</b> ${esc(v.address)}` : ''}</div>
    <table><thead><tr><th>#</th><th>شرح</th><th>تعداد</th><th>قیمت واحد</th><th>جمع (تومان)</th></tr></thead><tbody>${v.items.map((i, k) => `<tr><td>${fa(k + 1)}</td><td>${esc(i.title)}</td><td>${fa(i.qty)}</td><td>${fa(i.price)}</td><td>${fa(Math.round(i.qty * i.price))}</td></tr>`).join('')}</tbody></table>
    <div class="sum"><div><span>جمع کل</span><span>${fa(v.subtotal)}</span></div>${v.discount ? `<div><span>تخفیف</span><span>${fa(v.discount)}</span></div>` : ''}${v.tax ? `<div><span>مالیات (${fa(v.tax_percent)}٪)</span><span>${fa(v.tax)}</span></div>` : ''}<div class="g"><span>مبلغ قابل پرداخت</span><span>${fa(v.total)} تومان</span></div></div>
    ${v.note ? `<p>${esc(v.note)}</p>` : ''}${biz.business_note ? `<div class="foot">${esc(biz.business_note).replace(/\n/g, '<br>')}</div>` : ''}</div>`;
}
function invView(v) {
  modal(`${paperHtml(v)}<div class="form-actions"><button class="btn ghost" data-close>بستن</button><button class="btn primary" id="doPrint">🖨 چاپ / ذخیره PDF</button></div>`, (s) => {
    s.classList.add('wide'); $('#doPrint', s).onclick = () => { $('#printArea').innerHTML = paperHtml(v); window.print(); };
  });
}
// ---------- بوت ----------
api('/me').then((u) => { me = u; start(); }).catch(showLogin);
