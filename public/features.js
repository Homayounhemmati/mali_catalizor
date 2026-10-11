'use strict';
// ویژگی‌های تکمیلی: حساب‌ها، پیوست رسید، چک و اقساط، گزارش، ورود از اکسل، امنیت حساب
// (بعد از app.js بارگذاری می‌شود و از توابع/متغیرهای سراسری آن استفاده می‌کند)

const KINDS_ACC = { bank: 'حساب بانکی', cash: 'صندوق', card: 'کارت', other: 'سایر' };
const numIn = (el) => { el.oninput = () => { const n = el.value.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^\d-]/g, ''); el.value = n && n !== '-' ? Number(n).toLocaleString('en') : n; }; };
const raw = (v) => Number(String(v).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^\d.-]/g, '')) || 0;
const dayDiff = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(todayIso() + 'T00:00:00Z')) / 864e5);
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); toast('کپی شد'); } catch { toast('کپی ممکن نشد', 'bad'); } };

// ================= حساب‌ها =================
let accounts = [];
const loadAccounts = async () => {
  accounts = await api('/accounts');
  $('#facc').innerHTML = '<option value="">همه حساب‌ها</option>' + accounts.filter((a) => a.active).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
};
const lastAccount = () => { let v = ''; try { v = localStorage.getItem('lastAcc') || ''; } catch {} return accounts.some((a) => a.active && String(a.id) === v) ? +v : (accounts.find((a) => a.active) || {}).id || ''; };
const rememberAccount = (id) => { try { localStorage.setItem('lastAcc', String(id)); } catch {} };
const accountOptions = (sel) => '<option value="">— بدون حساب —</option>' + accounts.filter((a) => a.active || a.id == sel).map((a) => `<option value="${a.id}" ${a.id == sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('');

const loadAccountsPanel = guard(async () => {
  await loadAccounts();
  const tr = await api('/transfers'), canW = P('finance', 'edit'), total = accounts.filter((a) => a.active).reduce((s, a) => s + a.balance, 0);
  $('#accCard').innerHTML = `<div class="head" style="margin-bottom:14px"><div><h3 style="margin:0">حساب‌ها و موجودی</h3><p class="muted sub">جمع موجودی حساب‌های فعال: <b style="color:var(--text)">${fa(total)}</b> تومان</p></div>
    <div class="row">${canW ? '<button class="btn ghost" id="trfBtn">⇄ انتقال بین حساب‌ها</button>' : ''}${me.role === 'owner' ? '<button class="btn primary" id="accNew"><svg class="ic"><use href="#i-plus"/></svg> حساب جدید</button>' : ''}</div></div>
    <div class="mini">${accounts.map((a, i) => `<div class="mrow" style="animation-delay:${i * 40}ms;cursor:default;${a.active ? '' : 'opacity:.55'}"><span class="avatar">${a.kind === 'cash' ? '💵' : a.kind === 'card' ? '💳' : '🏦'}</span><div class="grow"><b>${esc(a.name)}${a.active ? '' : ' (غیرفعال)'}</b><small>${KINDS_ACC[a.kind]} · موجودی اولیه ${fa(a.opening)}</small></div>
      <span class="amt ${a.balance < 0 ? 'expense' : 'income'}">${fa(a.balance)}</span>${me.role === 'owner' ? `<button class="btn ghost sm" data-ea="${a.id}">ویرایش</button>` : ''}</div>`).join('') || '<div class="empty">حسابی تعریف نشده</div>'}</div>
    <h3 style="margin:20px 0 10px">آخرین انتقال‌ها</h3><div class="mini">${tr.slice(0, 10).map((t) => `<div class="mrow" style="cursor:default"><div class="grow"><b>${esc(t.from_name)} ← ${esc(t.to_name)}</b><small>${showDate(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</small></div><span class="amt">${fa(t.amount)}</span>${me.role === 'owner' ? `<button class="btn ghost sm danger" data-dt="${t.id}">✕</button>` : ''}</div>`).join('') || '<div class="empty">انتقالی ثبت نشده</div>'}</div>`;
  const nb = $('#accNew'); if (nb) nb.onclick = () => accountModal2();
  const tb = $('#trfBtn'); if (tb) tb.onclick = () => transferModal();
  $$('[data-ea]').forEach((b) => (b.onclick = () => accountModal2(accounts.find((a) => a.id == b.dataset.ea))));
  $$('[data-dt]').forEach((b) => (b.onclick = guard(async () => { if (!confirm('این انتقال حذف شود؟ (قابل بازگشت نیست)')) return; await api('/transfers/' + b.dataset.dt, { method: 'DELETE' }); toast('حذف شد'); loadAccountsPanel(); })));
});
function accountModal2(a) {
  modal(`<h2>${a ? 'ویرایش حساب' : 'حساب جدید'}</h2><form class="form" id="accForm">
    <label class="full">نام حساب<input name="name" required maxlength="60" placeholder="مثلاً: بانک ملی — ۱۲۳۴" value="${esc(a?.name)}"></label>
    <label>نوع<select name="kind">${Object.entries(KINDS_ACC).map(([k, v]) => `<option value="${k}" ${a?.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>موجودی اولیه (تومان)<input name="opening" inputmode="numeric" dir="ltr" value="${a ? a.opening.toLocaleString('en') : '0'}"></label>
    ${a ? `<label class="chk full"><input type="checkbox" name="active" ${a.active ? 'checked' : ''}> حساب فعال باشد (حساب غیرفعال در فرم‌ها نمایش داده نمی‌شود)</label>` : ''}
    <div class="form-actions full">${a ? '<button type="button" class="btn ghost danger" id="accDel">حذف</button>' : ''}<button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">ذخیره</button></div></form>`,
  (s) => {
    const f = $('#accForm', s); numIn(f.opening);
    f.onsubmit = guard(async (e) => { e.preventDefault(); const body = { name: f.name.value, kind: f.kind.value, opening: raw(f.opening.value) }; if (a) body.active = f.active.checked;
      await api(a ? '/accounts/' + a.id : '/accounts', { method: a ? 'PUT' : 'POST', body }); closeModal(); toast('ذخیره شد'); loadAccountsPanel(); });
    const d = $('#accDel', s); if (d) d.onclick = guard(async () => { if (!confirm('حساب حذف شود؟')) return; await api('/accounts/' + a.id, { method: 'DELETE' }); closeModal(); toast('حذف شد'); loadAccountsPanel(); });
  });
}
function transferModal() {
  const act = accounts.filter((a) => a.active);
  if (act.length < 2) return toast('برای انتقال حداقل دو حساب فعال لازم است', 'bad');
  const opts = (sel) => act.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  modal(`<h2>انتقال بین حساب‌ها</h2><form class="form" id="trfForm">
    <label>از حساب<select name="from_account">${opts(act[0].id)}</select></label><label>به حساب<select name="to_account">${opts(act[1].id)}</select></label>
    <label>مبلغ (تومان)<input name="amount" inputmode="numeric" dir="ltr" required></label><label>تاریخ<div class="jdate" id="trfDate"></div></label>
    <label class="full">توضیحات<input name="note" maxlength="300"></label>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">ثبت انتقال</button></div></form>`,
  (s) => { const f = $('#trfForm', s), dp = $('#trfDate', s); numIn(f.amount); datePicker(dp, todayIso());
    f.onsubmit = guard(async (e) => { e.preventDefault(); if (!dp.get()) throw new Error('تاریخ را کامل انتخاب کنید');
      await api('/transfers', { method: 'POST', body: { from_account: f.from_account.value, to_account: f.to_account.value, amount: raw(f.amount.value), date: dp.get(), note: f.note.value } }); closeModal(); toast('انتقال ثبت شد'); loadAccountsPanel(); }); });
}

// ================= داشبورد: حساب‌ها، سررسیدها، هشدارها =================
const renderDashExtra = guard(async () => {
  const [accs, ov] = await Promise.all([P('finance') ? api('/accounts') : [], P('dues') ? api('/dues/overview?today=' + todayIso()) : null]); accounts = accs;
  const act = accs.filter((a) => a.active), total = act.reduce((s, a) => s + a.balance, 0);
  $('#accStrip').innerHTML = act.length ? `<div class="acc-card total"><span>جمع موجودی</span><b>${fa(total)}</b></div>` + act.map((a) => `<div class="acc-card"><span>${a.kind === 'cash' ? '💵' : a.kind === 'card' ? '💳' : '🏦'} ${esc(a.name)}</span><b class="${a.balance < 0 ? 'late' : ''}">${fa(a.balance)}</b></div>`).join('') : '';
  const lbl = (d) => { const n = dayDiff(d.due_date); return n < 0 ? `<span class="status late">${fa(-n)} روز دیرکرد</span>` : n === 0 ? '<span class="status today">امروز</span>' : `<span class="status ${n <= 3 ? 'today' : 'later'}">${fa(n)} روز دیگر</span>`; };
  $('#dDues').closest('.card').classList.toggle('hidden', !ov);
  if (ov) $('#dDues').innerHTML = ov.upcoming.length ? ov.upcoming.map((d, i) => `<div class="mrow" data-gotodues style="animation-delay:${i * 40}ms"><span class="avatar">${d.direction === 'in' ? '⬇' : '⬆'}</span><div class="grow"><b>${d.kind === 'cheque' ? 'چک' : 'قسط'} ${d.direction === 'in' ? 'دریافتی' : 'پرداختی'} — ${esc(d.party || d.customer_name || '—')}</b><small>${showDate(d.due_date)}${d.number ? ' · شماره ' + esc(d.number) : ''}</small></div><span class="amt ${d.direction === 'in' ? 'income' : 'expense'}">${fa(d.amount)}</span>${lbl(d)}</div>`).join('') : '<div class="empty">سررسید نزدیکی وجود ندارد ✨</div>';
  $$('[data-gotodues]').forEach((el) => (el.onclick = () => goTab('dues')));
  const bn = [];
  if (ov && ov.overdue) bn.push(`<div class="b warn">⚠️ ${fa(ov.overdue)} چک/قسط سررسید گذشته و تسویه‌نشده دارید <button class="btn sm" data-bgo="dues">مشاهده</button></div>`);
  if (me.role === 'owner' && !me.totp_enabled) bn.push('<div class="b sec">🔐 ورود دومرحله‌ای برای حساب مدیر فعال نیست. برای امنیت داده‌های مالی فعالش کنید. <button class="btn sm" data-bgo="2fa">فعال‌سازی</button></div>');
  const el = $('#secBanner'); el.innerHTML = bn.join(''); el.classList.toggle('hidden', !bn.length);
  $$('[data-bgo]', el).forEach((b) => (b.onclick = () => (b.dataset.bgo === '2fa' ? accountModal() : goTab(b.dataset.bgo))));
});

// ================= پیوست رسید =================
const MAXB = 4 * 1024 * 1024;
async function prepFile(file) {
  if (file.type === 'application/pdf') { if (file.size > MAXB) throw new Error('حجم PDF بیش از ۴ مگابایت است'); return { blob: file, name: file.name }; }
  if (!file.type.startsWith('image/')) throw new Error('فقط تصویر یا PDF مجاز است');
  const bmp = file.type === 'image/gif' ? null : await createImageBitmap(file).catch(() => null);
  if (!bmp) { if (file.size > MAXB) throw new Error('حجم تصویر زیاد است'); return { blob: file, name: file.name }; }
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82)); if (!blob || blob.size > MAXB) throw new Error('حجم تصویر زیاد است');
  return { blob, name: file.name.replace(/\.\w+$/, '') + '.jpg' };
}
async function uploadAtt(entity, id, blob, name) {
  const r = await fetch(`/api/attachments?entity=${entity}&id=${id}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob, credentials: 'same-origin' }).catch(() => { throw new Error('اتصال اینترنت برقرار نیست'); });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'خطا در بارگذاری'); return d;
}
function attachWidget(box, entity, id, canW) {
  const pending = []; let list = [];
  const render = async () => {
    if (id) list = await api(`/attachments?entity=${entity}&id=${id}`).catch(() => []);
    const x = (attr) => (canW ? `<button type="button" ${attr} title="حذف">✕</button>` : '');
    box.innerHTML = `<div class="atts">${list.map((a) => a.mime.startsWith('image/')
      ? `<div class="att"><a href="/api/attachments/${a.id}" target="_blank" rel="noopener"><img src="/api/attachments/${a.id}" alt="${esc(a.name)}" loading="lazy"></a>${x(`data-da="${a.id}"`)}</div>`
      : `<div class="att pdf"><a href="/api/attachments/${a.id}" target="_blank" rel="noopener">📄<small>${esc(a.name)}</small></a>${x(`data-da="${a.id}"`)}</div>`).join('')}
      ${pending.map((p, i) => `<div class="att">${p.blob.type.startsWith('image/') ? `<img src="${p.url}" alt="">` : '<span>📄</span>'}${x(`data-dp="${i}"`)}</div>`).join('')}
      ${canW ? '<label class="att add"><svg class="ic"><use href="#i-clip"/></svg><small>افزودن</small><input type="file" accept="image/*,application/pdf" multiple hidden></label>' : ''}</div>
      ${!list.length && !pending.length && !canW ? '<div class="muted">پیوستی ندارد</div>' : ''}`;
    $$('[data-da]', box).forEach((b) => (b.onclick = guard(async () => { if (!confirm('این پیوست حذف شود؟')) return; await api('/attachments/' + b.dataset.da, { method: 'DELETE' }); render(); })));
    $$('[data-dp]', box).forEach((b) => (b.onclick = () => { URL.revokeObjectURL(pending[b.dataset.dp].url); pending.splice(b.dataset.dp, 1); render(); }));
    const inp = $('input[type=file]', box);
    if (inp) inp.onchange = guard(async () => {
      for (const file of inp.files) {
        if (list.length + pending.length >= 6) throw new Error('حداکثر ۶ پیوست مجاز است');
        const p = await prepFile(file);
        if (id) await uploadAtt(entity, id, p.blob, p.name); else pending.push({ ...p, url: URL.createObjectURL(p.blob) });
      }
      inp.value = ''; await render();
    });
  };
  render();
  return { uploadPending: async (newId) => { for (const p of pending) await uploadAtt(entity, newId, p.blob, p.name); pending.length = 0; } };
}
function viewAtts(entity, id, title = 'پیوست‌ها') {
  modal(`<h2>${esc(title)}</h2><div id="vAtt"></div><div class="form-actions"><button class="btn ghost" data-close>بستن</button></div>`, (s) => attachWidget($('#vAtt', s), entity, id, false));
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-att]'); if (b) { const [en, id] = b.dataset.att.split(':'); viewAtts(en, +id, 'رسید / پیوست‌ها'); } });

// ================= چک‌ها و اقساط =================
const DST = { pending: 'در انتظار', done: 'انجام‌شده', bounced: 'برگشت‌خورده', cancelled: 'لغوشده' };
let dStat = 'pending';
const dueBadge = (d) => {
  if (d.status !== 'pending') return `<span class="status ${d.status === 'done' ? 'st-active' : d.status === 'bounced' ? 'late' : 'st-inactive'}">${DST[d.status]}</span>`;
  const n = dayDiff(d.due_date); return n < 0 ? `<span class="status late">${fa(-n)} روز دیرکرد</span>` : n === 0 ? '<span class="status today">امروز</span>' : n <= 7 ? `<span class="status today">${fa(n)} روز دیگر</span>` : '<span class="status unpaid">در انتظار</span>';
};
const loadDues = guard(async () => {
  const [ov, rows] = await Promise.all([api('/dues/overview?today=' + todayIso()), api('/dues' + qs({ status: dStat === 'all' ? '' : dStat, direction: $('#dDir').value, kind: $('#dKind').value }))]);
  $('#dueStats').innerHTML = `<div class="card stat in"><span class="sico"><svg class="ic"><use href="#i-down"/></svg></span><span class="sl">دریافتی‌های در راه (${fa(ov.in.n)})</span><b>${fa(ov.in.total)}</b><small>تومان</small></div>
    <div class="card stat out"><span class="sico"><svg class="ic"><use href="#i-up"/></svg></span><span class="sl">پرداختی‌های در راه (${fa(ov.out.n)})</span><b>${fa(ov.out.total)}</b><small>تومان</small></div>
    <div class="card stat due"><span class="sico"><svg class="ic"><use href="#i-cheque"/></svg></span><span class="sl">سررسید گذشته</span><b>${fa(ov.overdue)}</b><small>مورد</small></div>`;
  $('#dStatus').innerHTML = [['pending', 'در انتظار'], ['done', 'انجام‌شده'], ['bounced', 'برگشتی'], ['cancelled', 'لغوشده'], ['all', 'همه']].map(([k, v]) => `<button data-s="${k}" class="${k === dStat ? 'active' : ''}">${v}</button>`).join('');
  const canW = P('dues', 'edit');
  $('#dueTable').innerHTML = rows.length ? `<thead><tr><th>سررسید</th><th>نوع</th><th>طرف حساب / شرح</th><th>مبلغ (تومان)</th><th>وضعیت</th><th></th></tr></thead><tbody>${rows.map((d, i) => `
    <tr style="animation-delay:${Math.min(i, 15) * 30}ms"><td>${showDate(d.due_date)}</td><td><span class="tag">${d.kind === 'cheque' ? '🧾 چک' : '📆 قسط'} ${d.direction === 'in' ? 'دریافتی' : 'پرداختی'}</span></td>
    <td><b>${esc(d.party || d.customer_name || '—')}</b><small class="muted" style="display:block">${d.kind === 'cheque' ? [d.number && 'شماره ' + esc(d.number), esc(d.bank)].filter(Boolean).join(' · ') : esc(d.title)}${d.att ? ` <button class="clip" data-att="due:${d.id}">📎 ${fa(d.att)}</button>` : ''}</small></td>
    <td class="amt ${d.direction === 'in' ? 'income' : 'expense'}">${d.direction === 'in' ? '+' : '−'}${fa(d.amount)}</td><td>${dueBadge(d)}${d.status === 'done' && d.done_date ? `<small class="muted" style="display:block">${showDate(d.done_date)}${d.account ? ' · ' + esc(d.account) : ''}</small>` : ''}</td>
    <td class="act">${canW && d.status === 'pending' ? `<button data-settle="${d.id}" title="تعیین تکلیف">✔</button><button data-editdue="${d.id}" title="ویرایش">✎</button>` : ''}${me.role === 'owner' && d.status !== 'pending' ? `<button data-reopen="${d.id}" title="بازگشایی">↺</button>` : ''}${me.role === 'owner' ? `<button class="del" data-deldue="${d.id}" title="حذف">🗑</button>` : ''}</td></tr>`).join('')}</tbody>` : '<tbody><tr><td><div class="empty">موردی وجود ندارد</div></td></tr></tbody>';
  const byId = (id) => rows.find((x) => x.id == id), T = $('#dueTable');
  $$('[data-settle]', T).forEach((b) => (b.onclick = () => settleModal(byId(b.dataset.settle))));
  $$('[data-editdue]', T).forEach((b) => (b.onclick = () => chequeModal(byId(b.dataset.editdue))));
  $$('[data-reopen]', T).forEach((b) => (b.onclick = guard(async () => { if (!confirm('به حالت «در انتظار» برگردد؟ تراکنش مالی مرتبط به سطل بازیافت می‌رود.')) return; await api(`/dues/${b.dataset.reopen}/reopen`, { method: 'POST', body: {} }); toast('بازگشایی شد'); loadDues(); })));
  $$('[data-deldue]', T).forEach((b) => (b.onclick = guard(async () => { if (!confirm('به سطل بازیافت منتقل شود؟')) return; await api('/dues/' + b.dataset.deldue, { method: 'DELETE' }); toast('به سطل بازیافت منتقل شد'); loadDues(); })));
});
$('#dStatus').onclick = (e) => { const b = e.target.closest('button'); if (b) { dStat = b.dataset.s; loadDues(); } };
$('#dDir').onchange = $('#dKind').onchange = () => loadDues();
$('#newCheque').onclick = () => chequeModal(); $('#newInst').onclick = () => instModal();

let custCache = null;
const customerOptions = async (sel) => { custCache = await api('/customers/lookup'); return '<option value="">— بدون مشتری —</option>' + custCache.map((c) => `<option value="${c.id}" ${c.id == sel ? 'selected' : ''}>${esc(c.name)}${c.company ? ' — ' + esc(c.company) : ''}</option>`).join(''); };
const dirSeg = (dir) => `<div class="seg2 full ${dir === 'out' ? 'out' : ''}" id="dseg"><span class="pill"></span><button type="button" data-d="in" class="${dir === 'out' ? '' : 'on'}">⬇ دریافتی (از مشتری)</button><button type="button" data-d="out" class="${dir === 'out' ? 'on' : ''}">⬆ پرداختی (به دیگران)</button></div>`;
function bindSeg(s, get, set) { const seg = $('#dseg', s); seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; set(b.dataset.d); seg.classList.toggle('out', get() === 'out'); $$('button', seg).forEach((x) => x.classList.toggle('on', x.dataset.d === get())); }; }

const chequeModal = guard(async (d) => {
  let dir = d ? d.direction : 'in'; const co = await customerOptions(d?.customer_id);
  modal(`<h2>${d ? 'ویرایش' : 'ثبت'} ${d && d.kind === 'installment' ? 'قسط' : 'چک'}</h2><form class="form" id="chForm">
    ${dirSeg(dir)}
    <label>${d && d.kind === 'installment' ? 'شرح' : 'شماره چک'}<input name="number" maxlength="40" dir="ltr" value="${esc(d?.number)}" ${d && d.kind === 'installment' ? 'disabled' : ''}></label>
    <label>بانک<input name="bank" maxlength="60" value="${esc(d?.bank)}" ${d && d.kind === 'installment' ? 'disabled' : ''}></label>
    <label>مشتری (اختیاری)<select name="customer_id">${co}</select></label>
    <label>طرف حساب<input name="party" maxlength="120" placeholder="نام صاحب چک / دریافت‌کننده" value="${esc(d?.party)}"></label>
    <label>مبلغ (تومان)<input name="amount" inputmode="numeric" dir="ltr" required value="${d ? d.amount.toLocaleString('en') : ''}"></label>
    <label>تاریخ سررسید<div class="jdate" id="chDate"></div></label>
    <label class="full">توضیحات<input name="note" maxlength="500" value="${esc(d?.note)}"></label>
    <div class="full"><div class="lbl">عکس چک / پیوست</div><div id="chAtt"></div></div>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">${d ? 'ذخیره' : 'ثبت چک'}</button></div></form>`,
  (s) => {
    const f = $('#chForm', s), dp = $('#chDate', s); numIn(f.amount); datePicker(dp, d ? d.due_date : todayIso());
    const aw = attachWidget($('#chAtt', s), 'due', d ? d.id : null, true); bindSeg(s, () => dir, (v) => (dir = v));
    f.customer_id.onchange = () => { const c = (custCache || []).find((x) => x.id == f.customer_id.value); if (c && !f.party.value) f.party.value = c.name; };
    f.onsubmit = guard(async (e) => {
      e.preventDefault(); if (!dp.get()) throw new Error('تاریخ سررسید را کامل انتخاب کنید');
      const body = { direction: dir, number: f.number.value, bank: f.bank.value, customer_id: f.customer_id.value || null, party: f.party.value, amount: raw(f.amount.value), due_date: dp.get(), note: f.note.value };
      if (d && d.kind === 'installment') { delete body.number; delete body.bank; }
      const r = await api(d ? '/dues/' + d.id : '/dues', { method: d ? 'PUT' : 'POST', body });
      if (!d) await aw.uploadPending(r.id).catch((er) => toast(er.message, 'bad'));
      closeModal(); toast('ذخیره شد'); loadDues();
    });
  });
});
const addJMonths = (iso, k) => { const [y, m, d] = jOf(iso); const t = (m - 1) + k, ny = y + Math.floor(t / 12), nm = (t % 12 + 12) % 12 + 1; return isoOf(ny, nm, Math.min(d, daysIn(ny, nm))); };
const instModal = guard(async () => {
  let dir = 'in'; const co = await customerOptions('');
  modal(`<h2>قسط‌بندی</h2><form class="form" id="inForm">
    ${dirSeg(dir)}
    <label>مشتری (اختیاری)<select name="customer_id">${co}</select></label><label>طرف حساب<input name="party" maxlength="120"></label>
    <label>عنوان<input name="title" maxlength="80" placeholder="مثلاً: قسط فاکتور ۱۰۰۱" value="قسط"></label><label>مبلغ کل (تومان)<input name="total" inputmode="numeric" dir="ltr" required></label>
    <label>تعداد اقساط<input name="count" inputmode="numeric" dir="ltr" value="3" required></label><label>فاصله (ماه)<input name="gap" inputmode="numeric" dir="ltr" value="1" required></label>
    <label class="full">تاریخ قسط اول<div class="jdate" id="inDate"></div></label>
    <div class="full"><div class="lbl">پیش‌نمایش جدول اقساط</div><div class="totals" id="inPrev"></div></div>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">ایجاد اقساط</button></div></form>`,
  (s) => {
    const f = $('#inForm', s), dp = $('#inDate', s); numIn(f.total); datePicker(dp, addJMonths(todayIso(), 1)); bindSeg(s, () => dir, (v) => (dir = v));
    const plan = () => { const n = Math.max(1, Math.min(60, Math.round(raw(f.count.value)))), gap = Math.max(1, Math.min(12, Math.round(raw(f.gap.value)))), total = raw(f.total.value), first = dp.get();
      if (!first || total <= 0) return []; const base = Math.floor(total / n); return Array.from({ length: n }, (_, i) => ({ due_date: addJMonths(first, i * gap), amount: i === n - 1 ? total - base * (n - 1) : base })); };
    const draw = () => { const p = plan(); $('#inPrev', s).innerHTML = p.length ? p.map((x, i) => `<div><span>قسط ${fa(i + 1)} — ${showDate(x.due_date)}</span><b>${fa(x.amount)}</b></div>`).join('') : '<div class="muted">مبلغ کل و تاریخ را وارد کنید</div>'; };
    f.oninput = draw; dp.addEventListener('change', draw); draw();
    f.customer_id.onchange = () => { const c = (custCache || []).find((x) => x.id == f.customer_id.value); if (c && !f.party.value) f.party.value = c.name; };
    f.onsubmit = guard(async (e) => { e.preventDefault(); const items = plan(); if (!items.length) throw new Error('اطلاعات اقساط کامل نیست');
      await api('/dues', { method: 'POST', body: { direction: dir, customer_id: f.customer_id.value || null, party: f.party.value, title: f.title.value, items } }); closeModal(); toast(`${fa(items.length)} قسط ثبت شد`); loadDues(); });
  });
});
function settleModal(d) {
  let outcome = 'done';
  modal(`<h2>تعیین تکلیف ${d.kind === 'cheque' ? 'چک' : 'قسط'}</h2><p class="muted" style="margin-top:-8px">${d.direction === 'in' ? 'دریافتی' : 'پرداختی'} ${fa(d.amount)} تومان — ${esc(d.party || '')} — سررسید ${showDate(d.due_date)}</p><form class="form" id="stForm">
    <div class="chips full" id="stOut"><button type="button" data-o="done" class="active">${d.direction === 'in' ? 'وصول شد' : 'پرداخت شد'}</button>${d.kind === 'cheque' ? '<button type="button" data-o="bounced">برگشت خورد</button>' : ''}<button type="button" data-o="cancelled">لغو شد</button></div>
    <label>تاریخ<div class="jdate" id="stDate"></div></label>
    <label id="stAcc">حساب<select name="account_id">${accountOptions(lastAccount())}</select></label>
    ${d.kind === 'installment' ? `<label id="stMeth">روش<select name="method"><option value="transfer">انتقال بانکی</option><option value="cash">نقد</option><option value="card">کارت</option><option value="other">سایر</option></select></label>` : ''}
    <p class="muted full" id="stNote" style="margin:0">با تأیید، یک ${d.direction === 'in' ? 'ورودی' : 'خروجی'} مالی در تراکنش‌ها و موجودی حساب ثبت می‌شود.</p>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">تأیید</button></div></form>`,
  (s) => {
    const f = $('#stForm', s), dp = $('#stDate', s); datePicker(dp, todayIso());
    $('#stOut', s).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; outcome = b.dataset.o; $$('#stOut button', s).forEach((x) => x.classList.toggle('active', x === b)); const done = outcome === 'done'; $('#stAcc', s).classList.toggle('hidden', !done); const m = $('#stMeth', s); if (m) m.classList.toggle('hidden', !done); $('#stNote', s).classList.toggle('hidden', !done); };
    f.onsubmit = guard(async (e) => { e.preventDefault(); if (!dp.get()) throw new Error('تاریخ را کامل انتخاب کنید');
      await api(`/dues/${d.id}/settle`, { method: 'POST', body: { outcome, date: dp.get(), account_id: f.account_id.value || null, method: f.method ? f.method.value : undefined } });
      if (f.account_id.value) rememberAccount(f.account_id.value); closeModal(); toast('ثبت شد'); loadDues(); });
  });
}

// ================= گزارش ماهانه چاپی =================
$('#reportBtn').onclick = guard(async () => {
  const [jy, jm] = jOf(todayIso());
  modal(`<h2>گزارش مالی</h2><form class="form" id="rpForm"><label>سال<select name="y">${[jy, jy - 1, jy - 2, jy - 3].map((y) => `<option value="${y}">${fa(y).replace(/٬/g, '')}</option>`).join('')}</select></label>
    <label>دوره<select name="m"><option value="0">کل سال</option>${MONTHS.map((n, i) => `<option value="${i + 1}" ${i + 1 === jm ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>بستن</button><button class="btn primary">ساخت گزارش</button></div></form></div>`,
  (s) => { $('#rpForm', s).onsubmit = guard(async (e) => { e.preventDefault(); const y = +e.target.y.value, m = +e.target.m.value;
    const from = isoOf(y, m || 1, 1), to = isoOf(y, m || 12, m ? daysIn(y, m) : daysIn(y, 12)), title = m ? `${MONTHS[m - 1]} ${fa(y).replace(/٬/g, '')}` : `سال ${fa(y).replace(/٬/g, '')}`;
    const [rep, biz2] = await Promise.all([api('/report' + qs({ from, to })), api('/settings')]); biz = biz2; reportView(rep, title); }); });
});
const delta = (c, p) => (!p ? '<span class="muted">—</span>' : `<span>${c >= p ? '▲' : '▼'} ${fa(Math.abs(Math.round((c - p) / Math.abs(p) * 100)))}٪</span>`);
function reportHtml(r, title) {
  const catTable = (type, label) => { const rows = r.cats.filter((c) => c.type === type), tot = rows.reduce((a, c) => a + c.total, 0);
    return `<h3>${label}</h3>${rows.length ? `<table><thead><tr><th>علت</th><th>تعداد</th><th>مبلغ (تومان)</th><th>سهم</th></tr></thead><tbody>${rows.map((c) => `<tr><td>${esc(c.name)}</td><td>${fa(c.n)}</td><td>${fa(c.total)}</td><td><div class="rbar"><i style="width:${Math.round(c.total / tot * 100)}%"></i><span>${fa(Math.round(c.total / tot * 100))}٪</span></div></td></tr>`).join('')}</tbody></table>` : '<p class="muted">موردی ثبت نشده</p>'}`; };
  return `<div class="paper report"><div class="hd"><div><h1>${esc(biz.business_name || 'کاتالیزور')}</h1><div>گزارش مالی — ${esc(title)}</div><div class="muted2">از ${showDate(r.from)} تا ${showDate(r.to)}</div></div><div class="meta">تاریخ تهیه: ${showDate(todayIso())}</div></div>
    <div class="kpis"><div><span>مجموع ورودی</span><b class="g">${fa(r.income)}</b><small>نسبت به دوره قبل ${delta(r.income, r.prev.income)}</small></div><div><span>مجموع خروجی</span><b class="r">${fa(r.expense)}</b><small>نسبت به دوره قبل ${delta(r.expense, r.prev.expense)}</small></div><div><span>سود / زیان خالص</span><b class="${r.net >= 0 ? 'g' : 'r'}">${fa(r.net)}</b><small>نسبت به دوره قبل ${delta(r.net, r.prev.net)}</small></div></div>
    <div class="cols2"><div>${catTable('income', 'درآمد به تفکیک علت')}</div><div>${catTable('expense', 'هزینه‌ها به تفکیک علت')}</div></div>
    <h3>فاکتورهای صادرشده در این دوره</h3><p>${fa(r.invoices.count)} فاکتور به مبلغ ${fa(r.invoices.total)} تومان (دریافت‌شده: ${fa(r.invoices.paid)} — باقی‌مانده: ${fa(r.invoices.total - r.invoices.paid)})</p>
    <h3>مانده مشتریان (کل مطالبات معوق: ${fa(r.totalDue)} تومان)</h3>${r.debtors.length ? `<table><thead><tr><th>مشتری</th><th>مانده بدهی (تومان)</th></tr></thead><tbody>${r.debtors.map((d) => `<tr><td>${esc(d.name)}${d.company ? ' — ' + esc(d.company) : ''}</td><td>${fa(d.due)}</td></tr>`).join('')}${r.unlinkedDue ? `<tr><td>فاکتورهای بدون مشتری ثبت‌شده</td><td>${fa(r.unlinkedDue)}</td></tr>` : ''}</tbody></table>` : '<p class="muted">مطالبات معوقی وجود ندارد</p>'}
    <div class="cols2"><div><h3>موجودی حساب‌ها (تا امروز)</h3><table><tbody>${r.accounts.map((a) => `<tr><td>${esc(a.name)}</td><td>${fa(a.balance)}</td></tr>`).join('')}<tr class="tot"><td>جمع</td><td>${fa(r.accounts.reduce((s, a) => s + a.balance, 0))}</td></tr></tbody></table></div>
    <div><h3>چک و اقساط در انتظار</h3><table><tbody><tr><td>دریافتی (${fa(r.dues.in.n)} مورد)</td><td>${fa(r.dues.in.total)}</td></tr><tr><td>پرداختی (${fa(r.dues.out.n)} مورد)</td><td>${fa(r.dues.out.total)}</td></tr></tbody></table></div></div>
    <div class="foot">این گزارش به‌صورت خودکار از «حسابداری کاتالیزور» تولید شده است.</div></div>`;
}
function reportView(r, title) {
  modal(`${reportHtml(r, title)}<div class="form-actions"><button class="btn ghost" data-close>بستن</button><button class="btn primary" id="rpPrint">🖨 چاپ / ذخیره PDF</button></div>`, (s) => { s.classList.add('wide'); $('#rpPrint', s).onclick = () => { $('#printArea').innerHTML = reportHtml(r, title); window.print(); }; });
}

// ================= ورود از اکسل / CSV =================
async function readZip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf); let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('فایل اکسل معتبر نیست'); const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = new Map(), td = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true), name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), data = u8.subarray(ds, ds + csize);
    if (/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml|workbook\.xml)$/.test(name)) {
      if (method === 0) out.set(name, td.decode(data));
      else if (method === 8) out.set(name, td.decode(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
    }
    p += 46 + nl + el + cl;
  }
  return out;
}
async function parseXlsx(buf) {
  const files = await readZip(buf), dom = (x) => new DOMParser().parseFromString(x, 'application/xml');
  const sst = files.has('xl/sharedStrings.xml') ? [...dom(files.get('xl/sharedStrings.xml')).getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent).join('')) : [];
  const sheetName = [...files.keys()].filter((k) => k.startsWith('xl/worksheets/')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw new Error('برگه‌ای در فایل پیدا نشد');
  const rows = [];
  for (const row of dom(files.get(sheetName)).getElementsByTagName('row')) {
    const arr = [];
    for (const c of row.getElementsByTagName('c')) {
      const ref = c.getAttribute('r') || '', letters = ref.replace(/\d/g, ''); let ci = 0; for (const ch of letters) ci = ci * 26 + (ch.charCodeAt(0) - 64); ci--;
      const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0], is = c.getElementsByTagName('is')[0];
      arr[ci] = t === 's' ? sst[+v.textContent] : t === 'inlineStr' && is ? [...is.getElementsByTagName('t')].map((x) => x.textContent).join('') : v ? v.textContent : '';
    }
    rows.push(Array.from(arr, (x) => (x === undefined ? '' : x)));
  }
  return rows;
}
function parseCsv(text) {
  text = text.replace(/^﻿/, ''); const first = text.split(/\r?\n/)[0] || '', delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let cur = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === delim) { cur.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; cur.push(cell); cell = ''; if (cur.some((x) => x.trim() !== '')) rows.push(cur); cur = []; }
    else cell += c;
  }
  cur.push(cell); if (cur.some((x) => x.trim() !== '')) rows.push(cur); return rows;
}
const latin = (s) => String(s ?? '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
function parseAmount(v) { let s = latin(v).trim(); if (!s) return NaN; let neg = false; if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); } s = s.replace(/[,٬،\s]/g, '').replace(/[^\d.\-+]/g, ''); if (s.startsWith('-')) neg = !neg; const n = Math.abs(parseFloat(s.replace(/^[-+]/, ''))); return Number.isFinite(n) ? (neg ? -n : n) : NaN; }
function parseDate(v) {
  let s = latin(v).trim(); if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s) && +s > 20000 && +s < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5); return d.toISOString().slice(0, 10); }
  let m = s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); if (!m) { m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/); if (m) m = [m[0], m[3], m[2], m[1]]; }
  if (!m) return null; let [y, mo, d] = [+m[1], +m[2], +m[3]]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y < 1700) { if (d > daysIn(y, mo)) return null; return isoOf(y, mo, d); } return `${y}-${pad(mo)}-${pad(d)}`;
}
const IN_W = /(ورودی|دریافت|درآمد|واریز|بستانکار|فروش|income|^in$|credit|deposit|\+)/i, OUT_W = /(خروجی|پرداخت|هزینه|برداشت|بدهکار|خرید|expense|^out$|debit|withdraw|-)/i;
const HEADS = { date: /تاریخ|date/i, amount: /مبلغ|amount|مقدار/i, type: /نوع|type|وضعیت تراکنش/i, income: /ورودی|دریافت|بستانکار|income|credit/i, expense: /خروجی|پرداخت|بدهکار|expense|debit/i, category: /دسته|علت|بابت|category|عنوان/i, party: /طرف|نام|شخص|party|مشتری/i, note: /توضیح|شرح|note|desc/i, ref: /سند|فاکتور|شماره|ref|پیگیری/i };
function importModal() {
  let table = [], head = true;
  modal(`<h2>ورود تراکنش‌ها از اکسل / CSV</h2><div id="imBody"><p class="muted" style="line-height:1.9">فایل اکسل (xlsx) یا CSV را انتخاب کنید. ستون‌ها را در مرحله بعد به فیلدها وصل می‌کنید. تاریخ شمسی (مثل ۱۴۰۵/۰۷/۱۸) و میلادی هر دو پشتیبانی می‌شود. ردیف‌های تکراری به‌صورت پیش‌فرض نادیده گرفته می‌شوند.</p>
    <div class="row"><label class="btn primary" style="cursor:pointer">انتخاب فایل<input type="file" id="imFile" accept=".xlsx,.csv,.txt,.tsv" hidden></label><button class="btn ghost" id="imTpl" type="button">⬇ دانلود قالب نمونه</button></div><div class="err" id="imErr"></div></div>`,
  (s) => {
    s.classList.add('wide');
    $('#imTpl', s).onclick = () => { const csv = '﻿تاریخ,نوع,مبلغ,دسته,طرف حساب,توضیحات,شماره سند\n1405/07/18,ورودی,5000000,فروش,شرکت نمونه,بابت پروژه,1001\n1405/07/19,خروجی,1200000,اجاره,مالک,اجاره ماهانه,\n'; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'import-template.csv'; a.click(); URL.revokeObjectURL(a.href); };
    $('#imFile', s).onchange = async (e) => { const file = e.target.files[0]; if (!file) return; $('#imErr', s).textContent = '';
      try { if (file.size > 8 * 1024 * 1024) throw new Error('حجم فایل بیش از ۸ مگابایت است');
        table = /\.xlsx$/i.test(file.name) ? await parseXlsx(await file.arrayBuffer()) : parseCsv(await file.text());
        if (table.length < 2) throw new Error('فایل ردیف داده کافی ندارد'); mapStep(s, table); }
      catch (er) { $('#imErr', s).textContent = er.message; } };
  });
  function mapStep(s, tbl) {
    const heads = tbl[0].map((h) => String(h).trim()), guess = {}; for (const [k, re] of Object.entries(HEADS)) { const i = heads.findIndex((h, ix) => re.test(h) && !Object.values(guess).includes(ix)); if (i >= 0) guess[k] = i; }
    const colOpts = (k) => `<option value="">— ندارد —</option>${heads.map((h, i) => `<option value="${i}" ${guess[k] === i ? 'selected' : ''}>${esc(h || 'ستون ' + (i + 1))}</option>`).join('')}`;
    const mode0 = guess.income !== undefined && guess.expense !== undefined && guess.amount === undefined ? 'two' : guess.type !== undefined ? 'type' : 'sign';
    $('#imBody', s).innerHTML = `<form class="form" id="imForm"><label class="full">نوع تراکنش از کجا تعیین شود؟<select name="mode"><option value="type" ${mode0 === 'type' ? 'selected' : ''}>ستون «نوع» (ورودی/خروجی)</option><option value="sign" ${mode0 === 'sign' ? 'selected' : ''}>علامت مبلغ (منفی = خروجی)</option><option value="two" ${mode0 === 'two' ? 'selected' : ''}>دو ستون جدا: ورودی و خروجی</option><option value="allin">همه ورودی</option><option value="allout">همه خروجی</option></select></label>
      <label>ستون تاریخ<select name="date">${colOpts('date')}</select></label><label data-m="type sign allin allout">ستون مبلغ<select name="amount">${colOpts('amount')}</select></label>
      <label data-m="type">ستون نوع<select name="type">${colOpts('type')}</select></label><label data-m="two">ستون ورودی<select name="income">${colOpts('income')}</select></label><label data-m="two">ستون خروجی<select name="expense">${colOpts('expense')}</select></label>
      <label>ستون دسته/علت<select name="category">${colOpts('category')}</select></label><label>ستون طرف حساب<select name="party">${colOpts('party')}</select></label>
      <label>ستون توضیحات<select name="note">${colOpts('note')}</select></label><label>ستون شماره سند<select name="ref">${colOpts('ref')}</select></label>
      <label>حساب مقصد<select name="account_id">${accountOptions(lastAccount())}</select></label><label class="chk"><input type="checkbox" name="skip" checked> ردیف‌های تکراری نادیده گرفته شود</label>
      <div class="full" id="imPrev"></div><div class="err full" id="imErr2"></div>
      <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary" id="imGo">ورود تراکنش‌ها</button></div></form>`;
    $$('[data-close]', s).forEach((b) => (b.onclick = closeModal));
    const f = $('#imForm', s); let good = [], bad = 0;
    const build = () => {
      const mode = f.mode.value; $$('[data-m]', f).forEach((l) => l.classList.toggle('hidden', !l.dataset.m.split(' ').includes(mode)));
      const g = (r, k) => (f[k].value === '' ? '' : r[+f[k].value] ?? ''); good = []; bad = 0;
      for (const r of tbl.slice(1)) {
        const date = parseDate(g(r, 'date')); let type, amount;
        if (mode === 'two') { const a = parseAmount(g(r, 'income')), b = parseAmount(g(r, 'expense')); if (a > 0) { type = 'income'; amount = a; } else if (b > 0) { type = 'expense'; amount = b; } }
        else { const a = parseAmount(g(r, 'amount')); if (Number.isFinite(a) && a !== 0) { if (mode === 'allin') { type = 'income'; amount = Math.abs(a); } else if (mode === 'allout') { type = 'expense'; amount = Math.abs(a); } else if (mode === 'sign') { type = a < 0 ? 'expense' : 'income'; amount = Math.abs(a); } else { const t = String(g(r, 'type')); type = OUT_W.test(t) && !IN_W.test(t) ? 'expense' : IN_W.test(t) ? 'income' : undefined; amount = Math.abs(a); } } }
        if (!date || !type || !(amount > 0)) { if (r.some((x) => String(x).trim() !== '')) bad++; continue; }
        good.push({ type, amount: Math.round(amount), date, category: String(g(r, 'category')).trim(), party: String(g(r, 'party')).trim(), note: String(g(r, 'note')).trim(), ref: latin(g(r, 'ref')).trim() });
      }
      const inc = good.filter((x) => x.type === 'income'), exp = good.filter((x) => x.type === 'expense');
      $('#imPrev', s).innerHTML = `<div class="totals"><div><span>ردیف معتبر</span><b>${fa(good.length)}</b></div><div><span>ردیف نامعتبر (نادیده گرفته می‌شود)</span><b>${fa(bad)}</b></div><div><span>جمع ورودی</span><b>${fa(inc.reduce((a, x) => a + x.amount, 0))}</b></div><div><span>جمع خروجی</span><b>${fa(exp.reduce((a, x) => a + x.amount, 0))}</b></div></div>
        ${good.length ? `<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>تاریخ</th><th>نوع</th><th>مبلغ</th><th>دسته</th><th>طرف حساب</th></tr></thead><tbody>${good.slice(0, 5).map((x) => `<tr><td>${showDate(x.date)}</td><td>${x.type === 'income' ? 'ورودی' : 'خروجی'}</td><td>${fa(x.amount)}</td><td>${esc(x.category || '—')}</td><td>${esc(x.party || '—')}</td></tr>`).join('')}</tbody></table></div><p class="muted">پیش‌نمایش ${fa(Math.min(5, good.length))} ردیف اول</p>` : ''}`;
      $('#imGo', s).disabled = !good.length;
    };
    f.oninput = f.onchange = build; build();
    f.onsubmit = guard(async (e) => { e.preventDefault(); if (!good.length) return; if (!confirm(`${fa(good.length)} تراکنش وارد شود؟`)) return;
      const r = await api('/import', { method: 'POST', body: { rows: good, account_id: f.account_id.value || null, skip_duplicates: f.skip.checked } });
      closeModal(); toast(`${fa(r.imported)} تراکنش وارد شد${r.skipped ? ` — ${fa(r.skipped)} تکراری نادیده گرفته شد` : ''}${r.errorCount ? ` — ${fa(r.errorCount)} ردیف خطا` : ''}`, 'good', 5000); await loadCats(); loadTx(true); });
  }
}
$('#impBtn').onclick = () => importModal();

// ================= امنیت حساب: رمز، ۲FA =================
const pwHint = 'حداقل ۱۰ کاراکتر، نه فقط عدد و بدون نام کاربری';
function accountModal() {
  modal(`<h2>حساب من</h2><div class="info"><div><span>نام</span>${esc(me.name)}</div><div><span>نام کاربری</span><span dir="ltr">${esc(me.username)}</span></div><div><span>نقش</span>${ROLES[me.role]}</div></div>
    <h3 class="muted" style="font-size:14px;margin:6px 0 10px">تغییر رمز عبور</h3>${pwForm()}
    <h3 class="muted" style="font-size:14px;margin:18px 0 10px">ورود دومرحله‌ای (2FA)</h3><div id="tfBox"></div>
    <div class="form-actions"><button class="btn ghost" data-close>بستن</button></div>`,
  (s) => { bindPwForm(s, () => toast('رمز تغییر کرد؛ سایر دستگاه‌ها خارج شدند')); renderTf(s); });
}
const pwForm = () => `<form class="form" id="pwForm"><label class="full">رمز فعلی<input name="old" type="password" dir="ltr" autocomplete="current-password" required></label>
  <label>رمز جدید<input name="new" type="password" dir="ltr" autocomplete="new-password" minlength="10" required></label><label>تکرار رمز جدید<input name="new2" type="password" dir="ltr" autocomplete="new-password" minlength="10" required></label>
  <p class="muted full" style="margin:0;font-size:12px">${pwHint}</p><div class="err full" id="pwErr"></div><div class="form-actions full" style="margin-top:0"><button class="btn primary" id="pwGo">ذخیره رمز</button></div></form>`;
function bindPwForm(s, done) {
  const f = $('#pwForm', s); f.onsubmit = async (e) => { e.preventDefault(); $('#pwErr', s).textContent = '';
    if (f.new.value !== f.new2.value) return ($('#pwErr', s).textContent = 'تکرار رمز با رمز جدید یکی نیست');
    try { await api('/password', { method: 'POST', body: { old: f.old.value, new: f.new.value } }); f.reset(); done(); } catch (er) { $('#pwErr', s).textContent = er.message; } };
}
function renderTf(s) {
  const box = $('#tfBox', s);
  box.innerHTML = me.totp_enabled ? `<p style="margin:0 0 10px">✅ فعال است. هنگام ورود، علاوه بر رمز، کد برنامه احراز هویت لازم است.</p><button class="btn ghost danger" id="tfOff">غیرفعال‌سازی</button>`
    : `<p class="muted" style="margin:0 0 10px;line-height:1.9">با برنامه‌هایی مثل Google Authenticator، Microsoft Authenticator یا Aegis، حتی اگر رمز لو برود کسی نمی‌تواند وارد شود.</p><button class="btn primary" id="tfOn">فعال‌سازی ورود دومرحله‌ای</button>`;
  const on = $('#tfOn', box), off = $('#tfOff', box);
  if (on) on.onclick = () => tfSetup(false);
  if (off) off.onclick = () => modal(`<h2>غیرفعال‌سازی ورود دومرحله‌ای</h2><form class="form" id="tfDis"><label class="full">رمز عبور<input name="password" type="password" dir="ltr" required></label><label class="full">کد برنامه احراز هویت (یا کد بازیابی)<input name="code" dir="ltr" required inputmode="numeric"></label><div class="err full" id="tfErr"></div><div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn danger">غیرفعال‌سازی</button></div></form>`,
    (s2) => { $('#tfDis', s2).onsubmit = async (e) => { e.preventDefault(); try { await api('/2fa/disable', { method: 'POST', body: { password: e.target.password.value, code: e.target.code.value } }); me.totp_enabled = false; closeModal(); toast('غیرفعال شد'); } catch (er) { $('#tfErr', s2).textContent = er.message; } }; });
}
function tfSetup(locked) {
  modal(`<h2>فعال‌سازی ورود دومرحله‌ای</h2><div id="tfStep"><form class="form" id="tf1"><label class="full">برای ادامه، رمز عبور خود را وارد کنید<input name="password" type="password" dir="ltr" autocomplete="current-password" required></label><div class="err full" id="tfErr"></div><div class="form-actions full">${locked ? '<button type="button" class="btn ghost" id="lkOut">خروج</button>' : '<button type="button" class="btn ghost" data-close>انصراف</button>'}<button class="btn primary">ادامه</button></div></form></div>`,
  (s) => {
    const lo = $('#lkOut', s); if (lo) lo.onclick = async () => { await api('/logout', { method: 'POST', body: {} }); closeModal(true); me = null; showLogin(); };
    $('#tf1', s).onsubmit = async (e) => { e.preventDefault();
      try { const r = await api('/2fa/setup', { method: 'POST', body: { password: e.target.password.value } }), grp = r.secret.match(/.{1,4}/g).join(' ');
        $('#tfStep', s).innerHTML = `<ol class="steps"><li>در گوشی، برنامه احراز هویت را باز کنید و «افزودن حساب» ← «وارد کردن کلید» را بزنید (یا روی دکمه زیر بزنید).</li><li>این کلید را وارد کنید:<div class="secret" dir="ltr">${grp}</div><div class="row"><button class="btn sm" type="button" id="cpSec">کپی کلید</button><a class="btn sm" href="${esc(r.uri)}">باز کردن در برنامه احراز هویت</a></div></li><li>کد ۶ رقمی نمایش‌داده‌شده را اینجا وارد کنید:</li></ol>
          <form class="form" id="tf2"><label class="full"><input name="code" inputmode="numeric" dir="ltr" maxlength="6" placeholder="123456" required autocomplete="one-time-code"></label><div class="err full" id="tfErr"></div><div class="form-actions full"><button class="btn primary">تأیید و فعال‌سازی</button></div></form>`;
        $('#cpSec', s).onclick = () => copyText(r.secret);
        $('#tf2', s).onsubmit = async (e2) => { e2.preventDefault();
          try { const d = await api('/2fa/enable', { method: 'POST', body: { code: e2.target.code.value } }); me.totp_enabled = true; me.need_2fa_setup = false;
            $('#tfStep', s).innerHTML = `<p style="line-height:1.9">✅ فعال شد. این <b>کدهای بازیابی</b> را الان در جای امنی ذخیره کنید؛ اگر گوشی را گم کنید فقط با آن‌ها می‌توانید وارد شوید. هر کد یک بار مصرف است و دیگر نمایش داده نمی‌شود.</p><div class="codes" dir="ltr">${d.recovery.map((c) => `<code>${c}</code>`).join('')}</div>
              <div class="row" style="margin:12px 0"><button class="btn sm" id="cpCodes" type="button">کپی همه</button></div><label class="chk"><input type="checkbox" id="savedCodes"> کدها را ذخیره کردم</label><div class="form-actions"><button class="btn primary" id="tfDone" disabled>تمام</button></div>`;
            $('#cpCodes', s).onclick = () => copyText(d.recovery.join('\n')); $('#savedCodes', s).onchange = (ev) => ($('#tfDone', s).disabled = !ev.target.checked);
            $('#tfDone', s).onclick = () => { closeModal(true); if (locked) start(); else toast('ورود دومرحله‌ای فعال شد'); }; }
          catch (er) { $('#tfErr', s).textContent = er.message; } };
      } catch (er) { $('#tfErr', s).textContent = er.message; } };
  }, { locked });
}
function enforceSecurity() {
  if (me.must_change) {
    modal(`<h2>انتخاب رمز عبور جدید</h2><p class="muted" style="margin-top:-8px;line-height:1.9">رمز فعلی موقت است. برای ادامه، رمز دلخواه و قوی خود را انتخاب کنید.</p>${pwForm().replace('رمز فعلی', 'رمز فعلی (موقت)').replace('<button class="btn primary" id="pwGo">ذخیره رمز</button>', '<button type="button" class="btn ghost" id="lkOut">خروج</button><button class="btn primary" id="pwGo">ذخیره رمز</button>')}`,
    (s) => { $('#lkOut', s).onclick = async () => { await api('/logout', { method: 'POST', body: {} }); closeModal(true); me = null; showLogin(); };
      bindPwForm(s, async () => { closeModal(true); me = await api('/me'); toast('رمز جدید ذخیره شد'); start(); }); }, { locked: true });
  } else if (me.need_2fa_setup) tfSetup(true);
}


// ================= تنظیم دسترسی کاربران (فقط مدیر) =================
const PRESET_PERMS = {
  accountant: { finance: 'edit', invoices: 'edit', dues: 'edit', crm: 'none' },
  sales: { finance: 'none', invoices: 'none', dues: 'none', crm: 'edit' },
  partner: { finance: 'view', invoices: 'view', dues: 'view', crm: 'view' },
};
function permModal(u) {
  const cur = { ...u.perms };
  modal(`<h2>دسترسی‌های ${esc(u.name)}</h2><p class="muted" style="margin-top:-8px;line-height:1.9">نقش فعلی: <b>${ROLES[u.role]}</b>. برای هر بخش سطح دسترسی را جدا تعیین کنید. مدیریت کاربران، بکاپ، سطل بازیافت و حذف همیشه فقط برای مدیر است.</p>
    <div class="chips" id="pmPre" style="margin-bottom:12px">${Object.entries(PRESET_PERMS).map(([k]) => `<button type="button" data-pre="${k}">${ROLES[k]}</button>`).join('')}</div>
    <form class="form" id="pmForm">${Object.entries(MODS).map(([m, l]) => `<label class="full">${l}<select name="${m}">${Object.entries(LVF).map(([k, v]) => `<option value="${k}" ${cur[m] === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`).join('')}
      <p class="muted full" style="margin:0;font-size:12.5px;line-height:1.9">• «ثبت دریافت وجه» و «تسویهٔ چک/قسط» علاوه بر بخش خودشان، دسترسی «مالی – ثبت» هم می‌خواهند.<br>• کاربر بدون دسترسی به «فاکتورها»، اعداد مالی مشتریان (خرید و بدهی) را هم نمی‌بیند.</p>
      <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">ذخیره دسترسی‌ها</button></div></form>`,
  (s) => {
    const f = $('#pmForm', s);
    $('#pmPre', s).onclick = (e) => { const b = e.target.closest('[data-pre]'); if (!b) return; for (const [m, v] of Object.entries(PRESET_PERMS[b.dataset.pre])) f[m].value = v; };
    f.onsubmit = guard(async (e) => { e.preventDefault(); const perms = {}; for (const m of Object.keys(MODS)) perms[m] = f[m].value;
      await api('/users/' + u.id, { method: 'PUT', body: { perms } }); closeModal(); toast('دسترسی‌ها ذخیره شد؛ از همین لحظه اعمال می‌شود'); loadUsers(); });
  });
}
