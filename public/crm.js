'use strict';
// مشتریان (CRM): لیست و برد کانبان، بخش‌های هوشمند، برچسب، مسئول پیگیری، پروفایل، صورت‌حساب، ورود از فایل
// (بعد از app.js و features.js بارگذاری می‌شود)

const CS = { view: 'list', status: '', segment: '', tag: '', assignee: '', sort: 'recent' };
try { CS.view = localStorage.getItem('crmView') === 'board' ? 'board' : 'list'; } catch {}
let team = [], crmTags = [];
const SEGS = [['', 'همه'], ['followup', '🔔 پیگیری'], ['due', '💰 بدهکار'], ['stale', '😴 بدون ارتباط'], ['new', '🆕 جدید'], ['mine', '👤 مال من']];
const SORTS = { recent: 'آخرین تغییر', followup: 'نزدیک‌ترین پیگیری', due: 'بیشترین بدهی', revenue: 'بیشترین خرید', contact: 'قدیمی‌ترین ارتباط', name: 'نام' };
const BOARD_COLS = ['lead', 'active', 'vip', 'inactive'];

const ago = (ts) => {
  if (!ts) return '—'; const d = Math.round((Date.parse(todayIso() + 'T00:00:00Z') - Date.parse(String(ts).slice(0, 10) + 'T00:00:00Z')) / 864e5);
  return d <= 0 ? 'امروز' : d === 1 ? 'دیروز' : d < 30 ? `${fa(d)} روز پیش` : d < 365 ? `${fa(Math.floor(d / 30))} ماه پیش` : `${fa(Math.floor(d / 365))} سال پیش`;
};
const tagChips = (tags, max = 99) => (tags ? tags.split(',').slice(0, max).map((t) => `<span class="tagchip">${esc(t)}</span>`).join('') : '');
const waLink = (p) => { let d = latin(p).replace(/\D/g, ''); if (!d) return ''; if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = '98' + d.slice(1); else if (d.length === 10 && !d.startsWith('98')) d = '98' + d; return 'https://wa.me/' + d; };
const plusDays = (n) => new Date(Date.parse(todayIso() + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const fuBadge = (d, note) => {
  if (!d) return '<span class="muted">—</span>'; const t = todayIso();
  return `<span class="status ${d < t ? 'late' : d === t ? 'today' : 'later'}">${d < t ? 'عقب‌افتاده · ' : d === t ? 'امروز · ' : ''}${showDate(d)}</span>${note ? `<small class="muted" style="display:block;margin-top:2px">${esc(note)}</small>` : ''}`;
};
const asgOptions = (sel, withAll) => (withAll ? '<option value="">همه مسئول‌ها</option>' : '<option value="">— بدون مسئول —</option>') + team.map((u) => `<option value="${u.id}" ${u.id == sel ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
const QUICK_FU = [['فردا', 1], ['۳ روز دیگر', 3], ['هفتهٔ دیگر', 7], ['۲ هفته دیگر', 14], ['ماه دیگر', 30]];
const quickFuHtml = (cls = '') => `<div class="chips ${cls}" data-quick>${QUICK_FU.map(([l, n]) => `<button type="button" data-days="${n}">${l}</button>`).join('')}</div>`;

// ---------- صفحه اصلی مشتریان ----------
const loadCrm = guard(async () => {
  if (!team.length) team = await api('/team');
  const params = { q: $('#cq').value.trim(), status: CS.view === 'board' ? '' : CS.status, segment: CS.segment, tag: CS.tag, assignee: CS.assignee, sort: CS.sort, today: todayIso() };
  const [r, ov] = await Promise.all([api('/customers' + qs(params)), api('/crm/overview?today=' + todayIso())]);
  const canW = me.role !== 'partner', f = r.facets; crmTags = Object.keys(f.tags);
  // آمار
  const st = ov.stats;
  $('#crmKpis').innerHTML = `<div class="kpi"><span>کل مشتریان</span><b>${fa(st.total)}</b><small>${fa(st.new30)} جدید در ۳۰ روز</small></div>
    <button class="kpi ${st.outstanding ? 'warn' : ''}" data-seg="due"><span>مطالبات معوق</span><b>${fa(st.outstanding)}</b><small>تومان</small></button>
    <button class="kpi ${st.followupsDue ? 'late' : ''}" data-seg="followup"><span>پیگیری امروز و عقب‌افتاده</span><b>${fa(st.followupsDue)}</b><small>مشتری</small></button>
    <button class="kpi" data-seg="stale"><span>بدون ارتباط ۳۰+ روز</span><b>${fa(st.stale)}</b><small>مشتری</small></button>`;
  $$('[data-seg]', $('#crmKpis')).forEach((b) => (b.onclick = () => { CS.segment = CS.segment === b.dataset.seg ? '' : b.dataset.seg; loadCrm(); }));
  // کنترل‌ها
  $$('#crmView button').forEach((b) => b.classList.toggle('active', b.dataset.v === CS.view));
  $('#crmSegs').innerHTML = SEGS.map(([k, v]) => `<button data-s="${k}" class="${k === CS.segment ? 'active' : ''}">${v}${k ? `<em>${fa(f.segments[k] || 0)}</em>` : ''}</button>`).join('');
  $('#cAsg').innerHTML = asgOptions(CS.assignee, true); $('#cSort').innerHTML = Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === CS.sort ? 'selected' : ''}>مرتب‌سازی: ${v}</option>`).join('');
  const tg = $('#crmTags'), tags = Object.entries(f.tags).sort((a, b) => b[1] - a[1]).slice(0, 14);
  tg.classList.toggle('hidden', !tags.length); tg.innerHTML = '<span class="muted" style="padding:0 8px;font-size:12px">برچسب:</span>' + tags.map(([t, n]) => `<button data-t="${esc(t)}" class="${t === CS.tag ? 'active' : ''}">${esc(t)}<em>${fa(n)}</em></button>`).join('');
  const sc = $('#cStatus'), total = Object.values(f.counts).reduce((a, b) => a + b, 0);
  sc.classList.toggle('hidden', CS.view === 'board');
  sc.innerHTML = [['', 'همه وضعیت‌ها', total], ...Object.entries(STATUS).map(([k, v]) => [k, v, f.counts[k] || 0])].map(([k, v, n]) => `<button data-s="${k}" class="${k === CS.status ? 'active' : ''}">${v}<em>${fa(n)}</em></button>`).join('');
  // بدنه
  $('#crmBody').innerHTML = CS.view === 'board' ? boardHtml(r.rows, canW) : listHtml(r.rows, canW);
  bindCrmBody(r.rows, canW);
});
$('#crmSegs').onclick = (e) => { const b = e.target.closest('button'); if (b) { CS.segment = b.dataset.s; loadCrm(); } };
$('#crmTags').onclick = (e) => { const b = e.target.closest('button'); if (b) { CS.tag = CS.tag === b.dataset.t ? '' : b.dataset.t; loadCrm(); } };
$('#cStatus').onclick = (e) => { const b = e.target.closest('button'); if (b) { CS.status = b.dataset.s; loadCrm(); } };
$('#crmView').onclick = (e) => { const b = e.target.closest('button'); if (b) { CS.view = b.dataset.v; try { localStorage.setItem('crmView', CS.view); } catch {} loadCrm(); } };
$('#crmMore').onclick = (e) => { $('#tab-crm').classList.toggle('more'); e.currentTarget.classList.toggle('on'); };
$('#cAsg').onchange = (e) => { CS.assignee = e.target.value; loadCrm(); };
$('#cSort').onchange = (e) => { CS.sort = e.target.value; loadCrm(); };
let cDeb; $('#cq').oninput = () => { clearTimeout(cDeb); cDeb = setTimeout(loadCrm, 300); };
$('#newCust').onclick = () => custModal();
$('#impCust').onclick = () => custImportModal();
const refreshCrm = () => { if (tab === 'crm') loadCrm(); if (tab === 'dash') loadDash(); };

const isMob = () => matchMedia('(max-width:900px)').matches;
function listHtml(rows, canW) {
  if (!rows.length) return `<div class="card"><div class="empty">${CS.status || CS.segment || CS.tag || CS.assignee || $('#cq').value ? 'مشتری‌ای با این فیلتر پیدا نشد' : 'هنوز مشتری ثبت نشده. اولین مشتری را اضافه کنید.'}</div></div>`;
  if (isMob()) return `<div class="clist">${rows.map((c, i) => `<div class="kcard" data-id="${c.id}" style="animation-delay:${Math.min(i, 12) * 25}ms"><div class="kt"><span class="avatar">${esc(initial(c.name))}</span><div class="grow"><b>${esc(c.name)}</b><small>${esc(c.company || c.phone || '')}</small></div><span class="status st-${c.status}">${STATUS[c.status]}</span></div>
    ${c.tags ? `<div class="tagrow2">${tagChips(c.tags, 4)}</div>` : ''}${c.follow_up ? `<div class="kfu">${fuBadge(c.follow_up, c.follow_up_note)}</div>` : ''}
    <div class="kf"><span class="muted">${ago(c.last_contact || c.created_at)}</span>${c.due ? `<span class="amt expense">بدهی ${fa(c.due)}</span>` : c.paid ? `<span class="amt income">${fa(c.paid)}</span>` : ''}${c.assignee_name ? `<span class="avatar xs" title="${esc(c.assignee_name)}">${esc(initial(c.assignee_name))}</span>` : ''}</div></div>`).join('')}</div>`;
  return `<div class="card nopad"><div class="tablewrap"><table id="custTable"><thead><tr><th>مشتری</th><th>وضعیت</th><th>مسئول</th><th>خرید (پرداخت‌شده)</th><th>مانده بدهی</th><th>آخرین ارتباط</th><th>پیگیری بعدی</th><th></th></tr></thead><tbody>${rows.map((c, i) => `
    <tr class="click" data-open="${c.id}" style="animation-delay:${Math.min(i, 15) * 28}ms"><td><div class="cname"><span class="avatar">${esc(initial(c.name))}</span><div><b>${esc(c.name)}</b><small>${esc(c.company || c.phone || '')}</small>${c.tags ? `<div class="tagrow2">${tagChips(c.tags, 3)}</div>` : ''}</div></div></td>
    <td><span class="status st-${c.status}">${STATUS[c.status]}</span></td><td>${c.assignee_name ? esc(c.assignee_name) : '<span class="muted">—</span>'}</td>
    <td class="amt">${c.paid ? fa(c.paid) : '—'}</td><td class="amt ${c.due ? 'expense' : ''}">${c.due ? fa(c.due) : '—'}</td>
    <td>${ago(c.last_contact || c.created_at)}</td><td>${fuBadge(c.follow_up, c.follow_up_note)}</td>
    <td class="act">${canW ? `<button data-ec="${c.id}" title="ویرایش">✎</button>` : ''}${me.role === 'owner' ? `<button class="del" data-dc="${c.id}" title="حذف">🗑</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
}
function boardHtml(rows, canW) {
  return `<div class="board">${BOARD_COLS.map((st) => { const items = rows.filter((x) => x.status === st), sum = items.reduce((a, x) => a + x.due, 0);
    return `<div class="kcol" data-st="${st}"><div class="kh"><span class="status st-${st}">${STATUS[st]}</span><b>${fa(items.length)}</b>${sum ? `<small>${fa(sum)} بدهی</small>` : ''}</div>
      <div class="kbody">${items.map((c) => `<div class="kcard" ${canW ? 'draggable="true"' : ''} data-id="${c.id}"><div class="kt"><span class="avatar">${esc(initial(c.name))}</span><div class="grow"><b>${esc(c.name)}</b><small>${esc(c.company || c.phone || '')}</small></div></div>
        ${c.tags ? `<div class="tagrow2">${tagChips(c.tags, 3)}</div>` : ''}${c.follow_up ? `<div class="kfu">${fuBadge(c.follow_up, c.follow_up_note)}</div>` : ''}
        <div class="kf"><span class="muted">${ago(c.last_contact || c.created_at)}</span>${c.due ? `<span class="amt expense">${fa(c.due)}</span>` : c.paid ? `<span class="amt income">${fa(c.paid)}</span>` : ''}${c.assignee_name ? `<span class="avatar xs" title="${esc(c.assignee_name)}">${esc(initial(c.assignee_name))}</span>` : ''}</div></div>`).join('') || '<div class="kempty">خالی</div>'}</div></div>`; }).join('')}</div>${canW ? '<p class="muted" style="font-size:12px;margin:8px 0 0">برای تغییر وضعیت، کارت را به ستون دیگر بکشید (در موبایل: وارد پروفایل شوید).</p>' : ''}`;
}
function bindCrmBody(rows, canW) {
  const B = $('#crmBody'), byId = (id) => rows.find((x) => x.id == id);
  $$('[data-open]', B).forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest('.act')) openCustomer(tr.dataset.open); }));
  $$('[data-ec]', B).forEach((b) => (b.onclick = () => custModal(byId(b.dataset.ec))));
  $$('[data-dc]', B).forEach((b) => (b.onclick = guard(async () => { if (!confirm('مشتری به سطل بازیافت منتقل شود؟ (فاکتورها باقی می‌مانند)')) return; await api('/customers/' + b.dataset.dc, { method: 'DELETE' }); toast('به سطل بازیافت منتقل شد'); loadCrm(); })));
  $$('.kcard', B).forEach((k) => {
    k.onclick = () => openCustomer(k.dataset.id);
    k.ondragstart = (e) => { e.dataTransfer.setData('text/plain', k.dataset.id); e.dataTransfer.effectAllowed = 'move'; k.classList.add('drag'); };
    k.ondragend = () => { k.classList.remove('drag'); $$('.kcol', B).forEach((c) => c.classList.remove('over')); };
  });
  if (canW) $$('.kcol', B).forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); };
    col.ondrop = guard(async (e) => { e.preventDefault(); col.classList.remove('over'); const id = e.dataTransfer.getData('text/plain'), c = byId(id);
      if (!c || c.status === col.dataset.st) return; await api('/customers/' + id, { method: 'PUT', body: { status: col.dataset.st } }); toast(`«${c.name}» به «${STATUS[col.dataset.st]}» منتقل شد`); loadCrm(); });
  });
}

// ---------- فرم مشتری ----------
const custModal = guard(async (c) => {
  if (!team.length) team = await api('/team');
  modal(`<h2>${c ? 'ویرایش مشتری' : 'مشتری جدید'}</h2><form class="form" id="custForm">
    <label>نام و نام خانوادگی<input name="name" required maxlength="120" value="${esc(c?.name)}"></label>
    <label>شرکت / برند<input name="company" maxlength="120" value="${esc(c?.company)}"></label>
    <label>تلفن<input name="phone" dir="ltr" maxlength="40" inputmode="tel" value="${esc(c?.phone)}"></label>
    <label>ایمیل<input name="email" dir="ltr" maxlength="120" value="${esc(c?.email)}"></label>
    <label>وضعیت<select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(c?.status || 'lead') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>مسئول پیگیری<select name="assignee">${asgOptions(c ? c.assignee : me.id)}</select></label>
    <label>نحوه آشنایی<input name="source" list="srcs" maxlength="60" placeholder="معرفی، اینستاگرام، سایت…" value="${esc(c?.source)}"><datalist id="srcs"><option>معرفی دوستان</option><option>اینستاگرام</option><option>وب‌سایت</option><option>تماس تلفنی</option><option>نمایشگاه</option></datalist></label>
    <label>برچسب‌ها (با کاما جدا کنید)<input name="tags" maxlength="200" placeholder="عمده, VIP, بدحساب" value="${esc(c?.tags)}"></label>
    ${crmTags.length ? `<div class="full tagpick" id="tagPick">${crmTags.map((t) => `<button type="button" class="tagchip" data-tg="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    <label class="full">آدرس<input name="address" maxlength="300" value="${esc(c?.address)}"></label>
    <label class="full">پیگیری بعدی (اختیاری)<div class="jdate" id="cfu"></div></label>
    <div class="full" id="cfuQ"></div>
    <label class="full" id="cfuN">موضوع پیگیری<input name="follow_up_note" maxlength="200" placeholder="مثلاً: ارسال پیش‌فاکتور" value="${esc(c?.follow_up_note)}"></label>
    <label class="full">توضیحات<textarea name="note" rows="2" maxlength="1000">${esc(c?.note)}</textarea></label>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">${c ? 'ذخیره' : 'افزودن مشتری'}</button></div></form>`,
  (s) => {
    const f = $('#custForm', s), dp = $('#cfu', s); datePicker(dp, c?.follow_up || '');
    $('#cfuQ', s).innerHTML = quickFuHtml(); $('#cfuQ', s).onclick = (e) => { const b = e.target.closest('button'); if (b) dp.set(plusDays(+b.dataset.days)); };
    const tp = $('#tagPick', s); if (tp) tp.onclick = (e) => { const b = e.target.closest('[data-tg]'); if (!b) return; const cur = f.tags.value.split(/[,،]/).map((x) => x.trim()).filter(Boolean); const i = cur.indexOf(b.dataset.tg); i >= 0 ? cur.splice(i, 1) : cur.push(b.dataset.tg); f.tags.value = cur.join(', '); };
    f.onsubmit = guard(async (e) => {
      e.preventDefault(); const body = Object.fromEntries(new FormData(f)); body.follow_up = dp.get(); body.assignee = body.assignee || null;
      let r;
      try { r = await api(c ? '/customers/' + c.id : '/customers', { method: c ? 'PUT' : 'POST', body }); }
      catch (er) { if (er.status === 409 && er.data?.duplicate_id) { if (confirm(er.message + '\n\nباز هم مشتری جدید ثبت شود؟ (انصراف = باز کردن مشتری موجود)')) r = await api('/customers', { method: 'POST', body: { ...body, force: true } }); else { closeModal(); return openCustomer(er.data.duplicate_id); } } else throw er; }
      toast(c ? 'ذخیره شد' : 'مشتری اضافه شد'); refreshCrm(); openCustomer(c ? c.id : r.id);
    });
  });
});

// ---------- پروفایل مشتری ----------
const openCustomer = guard(async (id) => {
  const c = await api('/customers/' + id), canW = me.role !== 'partner', td = todayIso(), wa = waLink(c.phone);
  const pending = c.dues.filter((d) => d.status === 'pending');
  const events = [
    ...c.notes.map((n) => ({ k: n.created_at.slice(0, 10) + ' ' + n.created_at.slice(11), html: `<div class="ev ${n.kind}"><div class="t"><b>${KINDS[n.kind]}</b> · ${showDate(n.created_at.slice(0, 10))} · ${esc(n.author || '')}${canW && (me.role === 'owner' || n.created_by === me.id) ? `<button data-dn="${n.id}" title="حذف">✕</button>` : ''}</div><p>${esc(n.text)}</p></div>` })),
    ...c.invoices.map((v) => ({ k: v.date + ' 00', html: `<div class="ev inv"><div class="t"><b>🧾 فاکتور ${fa(v.number).replace(/٬/g, '')}</b> · ${showDate(v.date)}</div><p>${fa(v.total)} تومان — <span class="status ${v.status}">${v.status === 'paid' ? 'پرداخت شده' : 'پرداخت نشده'}</span> <button class="btn ghost sm" data-vi="${v.id}">مشاهده</button></p></div>` })),
    ...c.invoices.filter((v) => v.paid_date).map((v) => ({ k: v.paid_date + ' 01', html: `<div class="ev pay"><div class="t"><b>💵 دریافت وجه</b> · ${showDate(v.paid_date)}</div><p>${fa(v.total)} تومان بابت فاکتور ${fa(v.number).replace(/٬/g, '')}</p></div>` })),
    ...c.dues.map((d) => ({ k: (d.done_date || d.due_date) + ' 00', html: `<div class="ev due"><div class="t"><b>${d.kind === 'cheque' ? '🧾 چک' : '📆 قسط'} ${d.direction === 'in' ? 'دریافتی' : 'پرداختی'}</b> · سررسید ${showDate(d.due_date)}</div><p>${fa(d.amount)} تومان${d.number ? ' — شماره ' + esc(d.number) : ''} — ${esc(DST[d.status])}</p></div>` })),
  ].sort((a, b) => (a.k < b.k ? 1 : a.k > b.k ? -1 : 0));
  const avg = c.count ? Math.round(c.invoiced / c.count) : 0, lastInv = c.invoices[0];
  modal(`<button class="btn ghost sm xbtn" data-close aria-label="بستن">✕</button><div class="cust-head"><span class="avatar">${esc(initial(c.name))}</span><div class="grow"><h2>${esc(c.name)}</h2><small class="muted">${[c.company && esc(c.company), c.assignee_name && 'مسئول: ' + esc(c.assignee_name)].filter(Boolean).join(' · ')}</small>${c.tags ? `<div class="tagrow2" style="margin-top:6px">${tagChips(c.tags)}</div>` : ''}</div></div>
    <div class="qa">${canW ? `<select id="cst" class="qsel">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${c.status === k ? 'selected' : ''}>وضعیت: ${v}</option>`).join('')}</select>` : `<span class="status st-${c.status}">${STATUS[c.status]}</span>`}${c.phone ? `<a class="btn sm" href="tel:${esc(c.phone)}">📞 تماس</a>` : ''}${wa ? `<a class="btn sm" href="${esc(wa)}" target="_blank" rel="noopener">💬 واتساپ</a>` : ''}${c.phone ? `<a class="btn sm" href="sms:${esc(c.phone)}">✉️ پیامک</a>` : ''}${c.email ? `<a class="btn sm" href="mailto:${esc(c.email)}">📧 ایمیل</a>` : ''}${c.phone ? '<button class="btn sm" id="cpPhone" type="button">📋 کپی</button>' : ''}
      <span class="grow"></span>${canW ? '<button class="btn sm" id="cInv">＋ فاکتور</button><button class="btn sm" id="cEdit">✎ ویرایش</button>' : ''}<button class="btn sm" id="cStmt">🧾 صورت‌حساب</button></div>
    <div class="info">${c.phone ? `<div><span>تلفن</span><a href="tel:${esc(c.phone)}" dir="ltr">${esc(c.phone)}</a></div>` : ''}${c.email ? `<div><span>ایمیل</span><a href="mailto:${esc(c.email)}" dir="ltr">${esc(c.email)}</a></div>` : ''}${c.address ? `<div style="grid-column:1/-1"><span>آدرس</span>${esc(c.address)}</div>` : ''}${c.source ? `<div><span>نحوه آشنایی</span>${esc(c.source)}</div>` : ''}<div><span>مشتری از</span>${showDate(c.created_at.slice(0, 10))}</div>${c.note ? `<div style="grid-column:1/-1"><span>توضیحات</span>${esc(c.note)}</div>` : ''}</div>
    <div class="tiles"><div><b>${fa(c.invoiced)}</b><span>کل فاکتورها</span></div><div><b style="color:var(--in)">${fa(c.paid)}</b><span>پرداخت‌شده</span></div><div><b style="color:${c.due ? 'var(--out)' : 'inherit'}">${fa(c.due)}</b><span>مانده بدهی</span></div>
      <div><b>${fa(c.count)}</b><span>تعداد فاکتور</span></div><div><b>${fa(avg)}</b><span>میانگین فاکتور</span></div><div><b>${lastInv ? showDate(lastInv.date) : '—'}</b><span>آخرین فاکتور</span></div></div>
    ${pending.length ? `<div class="pend">⏳ ${fa(pending.length)} چک/قسط در انتظار: ${pending.slice(0, 3).map((d) => `${fa(d.amount)} (${showDate(d.due_date)})`).join(' — ')}${pending.length > 3 ? ' …' : ''}</div>` : ''}
    <div class="fu2"><div class="fu2h">🔔 پیگیری بعدی ${fuBadge(c.follow_up, c.follow_up_note)}</div>
      ${canW ? `<div class="fu2b">${quickFuHtml()}<div class="row" style="align-items:center"><span class="jdate" id="fuPick"></span><input id="fuNote" maxlength="200" placeholder="موضوع پیگیری" value="${esc(c.follow_up_note)}" style="flex:1;min-width:140px"><button class="btn sm" id="fuSave">ذخیره</button>${c.follow_up ? '<button class="btn sm primary" id="fuDone">✔ انجام شد</button><button class="btn ghost sm" id="fuClear">حذف</button>' : ''}</div></div>` : ''}</div>
    ${canW ? `<form class="notef" id="noteForm"><textarea name="text" rows="2" maxlength="1000" placeholder="یادداشت، خلاصهٔ تماس یا جلسه…" required></textarea><div class="r"><select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><button class="btn primary sm">ثبت در تاریخچه</button></div></form>` : ''}
    <h3 class="muted" style="font-size:14px;margin:6px 0 12px">تاریخچه (${fa(events.length)})</h3>
    <div class="timeline">${events.map((e, i) => e.html.replace('class="ev', `style="animation-delay:${Math.min(i, 10) * 35}ms" class="ev`)).join('') || '<div class="empty">هنوز سابقه‌ای ثبت نشده</div>'}</div>`,
  (s) => {
    $('#sheet').classList.add('wide'); const done = () => { refreshCrm(); openCustomer(id); }, put = (body) => api('/customers/' + id, { method: 'PUT', body });
    const cp = $('#cpPhone', s); if (cp) cp.onclick = () => copyText(c.phone);
    $('#cStmt', s).onclick = guard(async () => { biz = await api('/settings'); statementView(c); });
    if (canW) {
      $('#cst', s).onchange = guard(async (e) => { await put({ status: e.target.value }); toast('وضعیت تغییر کرد'); done(); });
      $('#cEdit', s).onclick = () => custModal(c);
      $('#cInv', s).onclick = guard(() => { closeModal(); return invModal(null, c); });
      const fp = $('#fuPick', s); datePicker(fp, c.follow_up || '');
      $('[data-quick]', s).onclick = (e) => { const b = e.target.closest('button'); if (b) fp.set(plusDays(+b.dataset.days)); };
      $('#fuSave', s).onclick = guard(async () => { if (!fp.get()) throw new Error('تاریخ را انتخاب کنید (یا یکی از دکمه‌های سریع)'); await put({ follow_up: fp.get(), follow_up_note: $('#fuNote', s).value }); toast('پیگیری ثبت شد'); done(); });
      const fc = $('#fuClear', s); if (fc) fc.onclick = guard(async () => { await put({ follow_up: '' }); toast('پیگیری حذف شد'); done(); });
      const fd = $('#fuDone', s); if (fd) fd.onclick = () => followupDone(c, done);
      $('#noteForm', s).onsubmit = guard(async (e) => { e.preventDefault(); const f = e.target; await api(`/customers/${id}/notes`, { method: 'POST', body: { text: f.text.value, kind: f.kind.value } }); toast('ثبت شد'); done(); });
    }
    $$('[data-dn]', s).forEach((b) => (b.onclick = guard(async () => { if (!confirm('این یادداشت حذف شود؟')) return; await api('/notes/' + b.dataset.dn, { method: 'DELETE' }); done(); })));
    $$('[data-vi]', s).forEach((b) => (b.onclick = guard(async () => { biz = await api('/settings'); invView(c.invoices.find((x) => x.id == b.dataset.vi)); })));
  });
});
// تکمیل پیگیری: ثبت نتیجه + تعیین پیگیری بعدی (اختیاری)
function followupDone(c, back) {
  let next = '';
  modal(`<h2>پیگیری انجام شد</h2><p class="muted" style="margin-top:-8px">${esc(c.name)}${c.follow_up_note ? ' — ' + esc(c.follow_up_note) : ''}</p><form class="form" id="fdForm">
    <label class="full">نتیجه چه شد؟<textarea name="text" rows="3" maxlength="900" placeholder="مثلاً: پیش‌فاکتور فرستاده شد، منتظر جواب است"></textarea></label>
    <label>نوع ارتباط<select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === 'call' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <div class="full"><div class="lbl">پیگیری بعدی (اختیاری)</div>${quickFuHtml()}<div class="muted" id="fdNext" style="font-size:12px;margin-top:6px">تعیین نشده</div></div>
    <div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary">ثبت و بستن پیگیری</button></div></form>`,
  (s) => {
    $('[data-quick]', s).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; next = plusDays(+b.dataset.days); $$('[data-quick] button', s).forEach((x) => x.classList.toggle('active', x === b)); $('#fdNext', s).textContent = 'پیگیری بعدی: ' + showDate(next); };
    $('#fdForm', s).onsubmit = guard(async (e) => { e.preventDefault(); const f = e.target;
      await api(`/customers/${c.id}/notes`, { method: 'POST', body: { text: f.text.value.trim() || 'پیگیری انجام شد', kind: f.kind.value } });
      await api('/customers/' + c.id, { method: 'PUT', body: { follow_up: next || '', follow_up_note: '' } }); toast(next ? 'ثبت شد؛ پیگیری بعدی تنظیم شد' : 'پیگیری بسته شد'); back(); });
  });
}
// صورت‌حساب مشتری (چاپ/PDF)
function statementHtml(c) {
  const rows = c.invoices.slice().sort((a, b) => (a.date < b.date ? -1 : 1)), pend = c.dues.filter((d) => d.status === 'pending');
  return `<div class="paper"><div class="hd"><div><h1>${esc(biz.business_name || 'کاتالیزور')}</h1><div>صورت‌حساب مشتری</div><div style="color:#667">${esc(biz.business_phone || '')}</div></div><div class="meta"><b>${esc(c.name)}</b><br>${esc(c.company || '')}<br>تاریخ تهیه: ${showDate(todayIso())}</div></div>
    <table><thead><tr><th>#</th><th>شماره فاکتور</th><th>تاریخ</th><th>مبلغ (تومان)</th><th>وضعیت</th><th>تاریخ دریافت</th></tr></thead><tbody>${rows.map((v, i) => `<tr><td>${fa(i + 1)}</td><td>${fa(v.number).replace(/٬/g, '')}</td><td>${showDate(v.date)}</td><td>${fa(v.total)}</td><td>${v.status === 'paid' ? 'پرداخت شده' : 'پرداخت نشده'}</td><td>${v.paid_date ? showDate(v.paid_date) : '—'}</td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#667">فاکتوری ثبت نشده</td></tr>'}</tbody></table>
    <div class="sum"><div><span>جمع کل فاکتورها</span><span>${fa(c.invoiced)}</span></div><div><span>پرداخت‌شده</span><span>${fa(c.paid)}</span></div><div class="g"><span>مانده بدهی</span><span>${fa(c.due)} تومان</span></div></div>
    ${pend.length ? `<h3 style="margin:18px 0 6px;font-size:14px">چک و اقساط در انتظار</h3><table><thead><tr><th>نوع</th><th>سررسید</th><th>مبلغ (تومان)</th></tr></thead><tbody>${pend.map((d) => `<tr><td>${d.kind === 'cheque' ? 'چک' : 'قسط'} ${d.direction === 'in' ? 'دریافتی' : 'پرداختی'}${d.number ? ' — ' + esc(d.number) : ''}</td><td>${showDate(d.due_date)}</td><td>${fa(d.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${biz.business_note ? `<div class="foot">${esc(biz.business_note).replace(/\n/g, '<br>')}</div>` : ''}</div>`;
}
function statementView(c) {
  modal(`${statementHtml(c)}<div class="form-actions"><button class="btn ghost" data-close>بستن</button><button class="btn primary" id="stPrint">🖨 چاپ / ذخیره PDF</button></div>`, (s) => { s.classList.add('wide'); $('#stPrint', s).onclick = () => { $('#printArea').innerHTML = statementHtml(c); window.print(); }; });
}

// ---------- ورود مشتریان از فایل ----------
const CH = { name: /نام|name|مشتری|customer/i, company: /شرکت|برند|company|org/i, phone: /تلفن|موبایل|همراه|شماره|phone|mobile|tel/i, email: /ایمیل|email|mail/i, address: /آدرس|address/i, source: /منبع|آشنایی|source/i, tags: /برچسب|دسته|tag|group/i, note: /توضیح|یادداشت|note|desc/i };
const CF = { name: 'نام (الزامی)', company: 'شرکت', phone: 'تلفن', email: 'ایمیل', address: 'آدرس', source: 'نحوه آشنایی', tags: 'برچسب‌ها', note: 'توضیحات' };
function custImportModal() {
  modal(`<h2>ورود مشتریان از اکسل / CSV</h2><div id="ciBody"><p class="muted" style="line-height:1.9">فایل اکسل (xlsx) یا CSV را انتخاب کنید. مشتری‌هایی که شمارهٔ تلفنشان قبلاً ثبت شده، تکراری حساب می‌شوند و نادیده گرفته می‌شوند.</p>
    <div class="row"><label class="btn primary" style="cursor:pointer">انتخاب فایل<input type="file" id="ciFile" accept=".xlsx,.csv,.txt,.tsv" hidden></label><button class="btn ghost" id="ciTpl" type="button">⬇ دانلود قالب نمونه</button></div><div class="err" id="ciErr"></div></div>`,
  (s) => {
    s.classList.add('wide');
    $('#ciTpl', s).onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿نام,شرکت,تلفن,ایمیل,آدرس,نحوه آشنایی,برچسب‌ها,توضیحات\nسارا احمدی,استودیو نور,09121234567,sara@example.com,تهران,اینستاگرام,"عمده,VIP",مشتری قدیمی\n'], { type: 'text/csv;charset=utf-8' })); a.download = 'customers-template.csv'; a.click(); URL.revokeObjectURL(a.href); };
    $('#ciFile', s).onchange = async (e) => { const file = e.target.files[0]; if (!file) return; $('#ciErr', s).textContent = '';
      try { if (file.size > 8 * 1024 * 1024) throw new Error('حجم فایل بیش از ۸ مگابایت است');
        const tbl = /\.xlsx$/i.test(file.name) ? await parseXlsx(await file.arrayBuffer()) : parseCsv(await file.text()); if (tbl.length < 2) throw new Error('فایل ردیف داده کافی ندارد'); mapStep(s, tbl); }
      catch (er) { $('#ciErr', s).textContent = er.message; } };
  });
  function mapStep(s, tbl) {
    const heads = tbl[0].map((h) => String(h).trim()), guess = {}; for (const [k, re] of Object.entries(CH)) { const i = heads.findIndex((h, ix) => re.test(h) && !Object.values(guess).includes(ix)); if (i >= 0) guess[k] = i; }
    $('#ciBody', s).innerHTML = `<form class="form" id="ciForm">${Object.entries(CF).map(([k, v]) => `<label>${v}<select name="${k}"><option value="">— ندارد —</option>${heads.map((h, i) => `<option value="${i}" ${guess[k] === i ? 'selected' : ''}>${esc(h || 'ستون ' + (i + 1))}</option>`).join('')}</select></label>`).join('')}
      <label class="full">وضعیت مشتریان واردشده<select name="status"><option value="lead">سرنخ</option><option value="active">فعال</option></select></label><div class="full" id="ciPrev"></div><div class="form-actions full"><button type="button" class="btn ghost" data-close>انصراف</button><button class="btn primary" id="ciGo">ورود مشتریان</button></div></form>`;
    $$('[data-close]', s).forEach((b) => (b.onclick = closeModal)); const f = $('#ciForm', s); let rows = [];
    const build = () => { rows = tbl.slice(1).map((r) => { const o = {}; for (const k of Object.keys(CF)) o[k] = f[k].value === '' ? '' : String(r[+f[k].value] ?? '').trim(); return o; }).filter((o) => o.name);
      $('#ciPrev', s).innerHTML = `<div class="totals"><div><span>مشتری معتبر برای ورود</span><b>${fa(rows.length)}</b></div></div>${rows.length ? `<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>نام</th><th>شرکت</th><th>تلفن</th><th>برچسب</th></tr></thead><tbody>${rows.slice(0, 5).map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.company || '—')}</td><td>${esc(o.phone || '—')}</td><td>${esc(o.tags || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">ستون «نام» را انتخاب کنید</p>'}`; $('#ciGo', s).disabled = !rows.length; };
    f.oninput = f.onchange = build; build();
    f.onsubmit = guard(async (e) => { e.preventDefault(); if (!confirm(`${fa(rows.length)} مشتری وارد شود؟`)) return; const r = await api('/customers/import', { method: 'POST', body: { rows, status: f.status.value } });
      closeModal(); toast(`${fa(r.imported)} مشتری وارد شد${r.skipped ? ` — ${fa(r.skipped)} تکراری` : ''}${r.bad ? ` — ${fa(r.bad)} ردیف نامعتبر` : ''}`, 'good', 5000); loadCrm(); });
  }
}
