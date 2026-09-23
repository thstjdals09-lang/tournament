/* UI 렌더링 & 이벤트 바인딩
   탭 역할: 등록 = 등록 폼 + 좌석 번호·테이블 사용 설정 + 등록자 관리
           테이블 = 테이블·플레이어 조작 (정렬/검색/필터)
           이벤트 = 이벤트 CRUD + 현황판 + 상금 구조 + 순위표
           용지 = 템플릿·바우처·데이터 */
const App = (() => {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const h = Print.esc;
  const S = () => Store.get();
  const L = Logic;
  const money = Print.fmtMoney;

  const ui = {
    tab: (location.hash || '#reg').slice(1),
    regForm: { name: '', phone: '', buyIn: '', memo: '' },
    regSeat: null, regSearch: '',
    moveMode: null,           // { playerId }
    tblSort: 'numAsc',        // numAsc | numDesc | cntAsc | cntDesc
    tblFilter: 'all',         // all | open | empty | over | under | closed
    tblSearch: '',
    eventEdit: null,          // event id | 'new'
    eventSection: 'board',    // board | payouts | ranks
    printTab: 'confirm',
    voucherForm: { playerId: '', amount: '', note: '' },
  };
  const curEvent = () => L.eventOf(S(), S().selectedEventId) || null;

  /* ---------- 공용 위젯 ---------- */
  let toastTimer;
  function toast(msg, ms) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }
  function sheet(title, actions, bodyHtml, onBind) {
    const el = $('#sheet');
    el.innerHTML = `<div class="sheet-body"><h3>${h(title)}</h3>${bodyHtml || ''}<div class="sheet-actions">${actions.map((a, i) => `<button class="${a.cls || ''}" data-i="${i}">${a.label}</button>`).join('')}<button class="ghost" data-i="-1">닫기</button></div></div>`;
    el.classList.remove('hidden');
    el.onclick = (e) => {
      if (e.target === el) { closeSheet(); return; }
      const b = e.target.closest('button[data-i]'); if (!b) return;
      const i = +b.dataset.i; const keep = i >= 0 && actions[i].fn(el) === 'keep'; if (!keep) closeSheet();
    };
    if (onBind) onBind(el);
  }
  function closeSheet() { const el = $('#sheet'); el.classList.add('hidden'); el.innerHTML = ''; }
  const tableName = (s, id) => { const t = L.tableOf(s, id); return t ? 'T' + t.number : '-'; };
  const seatLabel = (s, p) => p.status === 'active' ? `${tableName(s, p.tableId)} S${p.seat}` : `탈락 ${p.finishRank}위`;
  function noEventHtml() { return `<div class="card"><h2>이벤트가 없습니다</h2><p class="muted">먼저 이벤트를 만들어야 등록과 테이블 관리를 할 수 있습니다.</p><button class="primary" id="btnGoEvents">이벤트 만들기</button></div>`; }
  function bindNoEvent(root) { const b = $('#btnGoEvents', root); if (b) b.addEventListener('click', () => { ui.eventEdit = 'new'; location.hash = '#events'; }); }

  /* ---------- 상단 바 ---------- */
  function renderTop() {
    const s = S(); const sel = $('#eventSelect');
    sel.innerHTML = s.events.length
      ? s.events.map(e => `<option value="${e.id}" ${e.id === s.selectedEventId ? 'selected' : ''}>${h(e.name)}${e.status === 'closed' ? ' (종료)' : ''}</option>`).join('')
      : '<option value="">이벤트를 먼저 만들어주세요</option>';
    $('#btnUndo').disabled = !Store.canUndo(); $('#btnRedo').disabled = !Store.canRedo();
    $('#btnUndo').title = Store.canUndo() ? '되돌리기: ' + Store.undoLabel() : '되돌리기';
    $('#btnRedo').title = Store.canRedo() ? '다시 실행: ' + Store.redoLabel() : '다시 실행';

    const ev = curEvent(); const bar = $('#statBar');
    if (!ev) { bar.innerHTML = '<span class="chip muted">이벤트 없음</span>'; return; }
    const all = L.eventPlayers(s, ev.id), active = L.activePlayers(s, ev.id), busted = all.length - active.length;
    const info = L.balanceInfo(s, ev.id);
    const tables = L.openTables(s, ev.id).length;
    bar.innerHTML = `
      <span class="chip">참가<b>${all.length}</b></span>
      <span class="chip">탈락<b>${busted}</b></span>
      <span class="chip ok">남은<b>${active.length}</b></span>
      <span class="chip">테이블<b>${tables}</b></span>
      ${tables ? (info.need ? `<span class="chip bad">밸런싱 필요 (${info.min}~${info.max})</span>` : `<span class="chip ok">균형 양호</span>`) : ''}
      ${info.canBreak ? `<span class="chip warn">T${info.breakTable.number} 브레이크 가능</span>` : ''}`;
  }

  function askOpenTable(eventId) {
    const s = S(); const ev = L.eventOf(s, eventId);
    const next = L.nextTableNumber(s, ev);
    const ans = prompt(`열 테이블 번호 (범위 ${ev.tableStart || 1}~${ev.tableEnd || '제한 없음'}, 비우면 자동 ${next ? 'T' + next : '없음'})`, '');
    if (ans === null) return;
    let r; Store.commit('새 테이블 오픈', st => { r = L.openTable(st, eventId, { number: +ans || 0 }); if (r.error) return false; });
    if (r.error) toast(r.error); else toast(`T${r.number} 오픈 (되돌리기 가능)`);
  }

  /* ---------- 등록 탭 ---------- */
  function ensureRegSeat() {
    const ev = curEvent(); if (!ev) { ui.regSeat = null; return; }
    if (!ui.seatPick) { ui.regSeat = null; return; }
    const s = S();
    if (ui.regSeat) {
      const t = L.tableOf(s, ui.regSeat.tableId);
      if (t && t.status === 'open' && t.eventId === ev.id && L.emptySeats(s, t).includes(ui.regSeat.seat)) return;
    }
    ui.regSeat = L.pickSeat(s, ev.id);
  }
  function viewReg() {
    const s = S(); const ev = curEvent();
    if (!ev) return noEventHtml();
    ensureRegSeat();
    const f = ui.regForm;
    const tables = L.openTables(s, ev.id);
    const all = L.eventPlayers(s, ev.id);
    const q = ui.regSearch.trim().toLowerCase();
    const list = all.filter(p => !q || p.name.toLowerCase().includes(q) || String(p.entryNo) === q || (p.phone || '').includes(q)).sort((a, b) => b.registeredAt - a.registeredAt);
    const dupe = f.name.trim() && all.some(p => p.name.trim().toLowerCase() === f.name.trim().toLowerCase());
    const offSet = new Set(ev.disabledSeats || []);
    const offTables = new Set(ev.disabledTables || []);
    const strays = L.playersOnDisabledSeats(s, ev.id);
    const manualTables = tables.filter(t => L.tableUsable(t) && L.emptySeats(s, t).length).sort((a, b) => a.number - b.number);
    const manualT = ui.regSeat ? L.tableOf(s, ui.regSeat.tableId) : manualTables[0];
    const tStart = ev.tableStart || 1;
    const lastOpen = L.openTables(s, ev.id).slice(-1)[0];
    const tEnd = ev.tableEnd || Math.max(tStart + 19, (lastOpen ? lastOpen.number : tStart) + 5);
    const numbers = []; for (let n = tStart; n <= tEnd && numbers.length < 200; n++) numbers.push(n);
    return `
    <div class="card">
      <h2>등록 <span class="muted small">${h(ev.name)}${ev.status === 'closed' ? ' · 종료된 이벤트' : ''}</span></h2>
      <form id="regForm" autocomplete="off">
        <div class="row">
          <label class="field"><span>이름 *</span><input name="name" value="${h(f.name)}" required placeholder="플레이어 이름" autofocus>${dupe ? '<span class="small warn-text">같은 이름이 이미 등록되어 있습니다. 리엔트리라면 메모에 표시하세요.</span>' : ''}</label>
          <label class="field"><span>연락처</span><input name="phone" value="${h(f.phone)}" placeholder="선택"></label>
        </div>
        <div class="row">
          <label class="field"><span>메모</span><input name="memo" value="${h(f.memo)}" placeholder="리엔트리, 애드온 등"></label>
        </div>
        <div class="assign-box">
          <label class="chk"><input type="checkbox" id="chkSeatPick" ${ui.seatPick ? 'checked' : ''} ${manualTables.length ? '' : 'disabled'}>좌석 지정</label>
          ${ui.seatPick && manualTables.length ? `
            <select id="manTable" class="sm-select">${manualTables.map(t => `<option value="${t.id}" ${manualT && manualT.id === t.id ? 'selected' : ''}>T${t.number} (${L.tablePlayers(s, t.id).length}/${L.usableSeats(s, t)})</option>`).join('')}</select>
            <select id="manSeat" class="sm-select">${(manualT ? L.emptySeats(s, manualT) : []).map(n => `<option value="${n}" ${ui.regSeat && ui.regSeat.seat === n ? 'selected' : ''}>S${n}</option>`).join('')}</select>`
            : '<span class="small muted">지정하지 않으면 빈 좌석 중 무작위로 배정됩니다</span>'}
        </div>
        <div class="row">
          <button type="submit" class="primary" data-print="1">등록 + 확인증 인쇄</button>
          <button type="submit" class="ghost" data-print="0">등록만</button>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="row tight" style="margin-bottom:6px"><h3 style="margin:0">좌석 번호 사용 설정</h3><span class="muted small">이 이벤트의 모든 테이블 공통 · 체크 해제한 번호에는 배정하지 않습니다</span></div>
      <div class="seatnums">${Array.from({ length: ev.seats }, (_, i) => i + 1).map(n => `<label class="seatnum ${offSet.has(n) ? 'off' : ''}"><input type="checkbox" ${offSet.has(n) ? '' : 'checked'} data-evseat="${n}"><span>${n}</span></label>`).join('')}</div>
      ${strays.length ? `<div class="banner warn" style="margin:10px 0 0"><span class="grow">사용 안함 좌석에 앉아있는 플레이어 ${strays.length}명: ${strays.slice(0, 5).map(p => h(p.name) + ' (' + tableName(s, p.tableId) + ' S' + p.seat + ')').join(', ')}${strays.length > 5 ? ' 외' : ''} — 테이블 탭에서 이동시켜 주세요.</span></div>` : ''}
    </div>

    <div class="card">
      <div class="row tight" style="margin-bottom:6px"><h3 style="margin:0">테이블 사용 설정</h3><span class="muted small">이 이벤트 범위 T${tStart}~${ev.tableEnd || '제한 없음'} · 체크 해제한 번호는 열리지 않습니다 · 이미 열린 테이블은 변경 불가</span><span style="flex:1"></span><button class="sm ghost" id="btnOpenTableReg">테이블 열기</button></div>
      <div class="tbl-toggle-grid">${numbers.map(n => {
        const t = tables.find(x => x.number === n);
        const other = !t && L.usedTableNumbers(s).has(n);
        const off = offTables.has(n);
        const locked = !!t || other;
        return `<label class="tbl-toggle ${off ? 'off' : ''} ${locked ? 'locked' : ''}" title="${other ? '다른 이벤트에서 사용 중' : (t ? '열려 있는 테이블입니다' : '')}">
          <input type="checkbox" ${off ? '' : 'checked'} ${locked ? 'disabled' : ''} data-evtable="${n}"><b>T${n}</b>
          <span class="muted small">${t ? L.tablePlayers(s, t.id).length + '/' + L.usableSeats(s, t) : (other ? '타 이벤트' : (off ? '사용안함' : '대기'))}</span></label>`;
      }).join('')}</div>
    </div>

    <div class="card">
      <div class="row tight" style="margin-bottom:8px"><h3 style="margin:0">등록자 <span class="muted small">${all.length}명</span></h3></div>
      <input id="regSearch" placeholder="이름 / 엔트리번호 / 연락처 검색" value="${h(ui.regSearch)}" style="margin-bottom:8px">
      <div class="list">${list.map(p => `<div class="list-item"><span class="rank">#${p.entryNo}</span><div class="grow"><div class="t">${h(p.name)} <span class="muted small">${seatLabel(s, p)}</span></div><div class="s">${Print.fmtTime(p.registeredAt)}${p.phone ? ' · ' + h(p.phone) : ''}${p.memo ? ' · ' + h(p.memo) : ''}</div></div>
        <button class="sm ghost" data-pmenu="${p.id}">관리</button></div>`).join('') || `<div class="muted">${q ? '검색 결과 없음' : '아직 등록이 없습니다.'}</div>`}</div>
    </div>`;
  }
  function bindReg(root) {
    const form = $('#regForm', root); if (!form) { bindNoEvent(root); return; }
    form.addEventListener('input', () => { const fd = new FormData(form); ['name', 'phone', 'buyIn', 'memo'].forEach(k => ui.regForm[k] = fd.get(k) || ''); });
    let printFlag = true;
    $$('button[type=submit]', form).forEach(b => b.addEventListener('click', () => printFlag = b.dataset.print === '1'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ev = curEvent(); const data = Object.assign({}, ui.regForm);
      if (!data.name.trim()) { toast('이름을 입력하세요'); return; }
      let res;
      Store.commit('등록: ' + data.name, st => { res = L.register(st, ev.id, data, ui.regSeat); if (res.error) return false; });
      if (res.error) { toast(res.error); return; }
      const p = res.player; const st = S();
      toast(`#${p.entryNo} ${p.name} → ${tableName(st, p.tableId)} S${p.seat}${res.openedTable ? ' (새 테이블 오픈)' : ''}`);
      ui.regForm = { name: '', phone: '', buyIn: '', memo: '' }; ui.regSeat = null; ui.seatPick = false;
      render();
      if (printFlag && st.settings.autoPrintOnRegister !== false) printConfirm(p.id);
      const n = $('#regForm input[name=name]'); if (n) n.focus();
    });
    $('#chkSeatPick', root).addEventListener('change', (e) => { ui.seatPick = e.target.checked; if (!ui.seatPick) ui.regSeat = null; render(); });
    const mt = $('#manTable', root), ms = $('#manSeat', root);
    if (mt) {
      mt.addEventListener('change', () => { const t = L.tableOf(S(), mt.value); const e = L.emptySeats(S(), t); ui.regSeat = e.length ? { tableId: t.id, seat: e[0] } : null; render(); });
      ms.addEventListener('change', () => { ui.regSeat = { tableId: mt.value, seat: +ms.value }; render(); });
    }
    $('#btnOpenTableReg', root).addEventListener('click', () => askOpenTable(curEvent().id));
    $$('input[data-evseat]', root).forEach(cb => cb.addEventListener('change', () => {
      Store.commit('좌석 번호 사용 변경', st => L.toggleEventSeat(st, curEvent().id, +cb.dataset.evseat));
    }));
    $$('input[data-evtable]', root).forEach(cb => cb.addEventListener('change', () => {
      Store.commit('테이블 사용 변경', st => L.toggleEventTable(st, curEvent().id, +cb.dataset.evtable));
    }));
    const search = $('#regSearch', root);
    search.addEventListener('input', () => { ui.regSearch = search.value; const pos = search.selectionStart; render(); const s2 = $('#regSearch'); s2.focus(); s2.setSelectionRange(pos, pos); });
    $$('[data-pmenu]', root).forEach(b => b.addEventListener('click', () => regPlayerSheet(b.dataset.pmenu)));
  }
  function regPlayerSheet(pid) {
    const s = S(); const p = L.playerOf(s, pid); if (!p) return;
    const actions = [
      { label: '참가확인증 재인쇄', fn: () => printConfirm(pid) },
      { label: '정보 수정 (이름 / 연락처 / 메모)', fn: () => editPlayer(pid) },
    ];
    if (p.status === 'busted') actions.push({ label: '리엔트리 (같은 정보로 새 등록)', cls: 'primary', fn: () => {
      ui.regForm = { name: p.name, phone: p.phone || '', buyIn: '', memo: '리엔트리' }; ui.regSeat = null; render();
      const n = $('#regForm input[name=name]'); if (n) n.focus(); toast('폼에 채웠습니다. 등록 버튼을 누르세요');
    } });
    actions.push({ label: '등록 취소 (삭제)', cls: 'danger', fn: () => {
      if (confirm(`#${p.entryNo} ${p.name} 등록을 취소(삭제)할까요?`)) { Store.commit('등록 취소: ' + p.name, st => L.cancelRegistration(st, p.id)); toast('등록 취소됨 (되돌리기 가능)'); }
    } });
    sheet(`#${p.entryNo} ${p.name} · ${seatLabel(s, p)}`, actions, `<div class="muted small" style="margin-bottom:10px">${p.phone ? h(p.phone) + ' · ' : ''}${p.memo ? h(p.memo) + ' · ' : ''}${Print.fmtTime(p.registeredAt)} 등록</div>`);
  }
  function editPlayer(pid) {
    const p = L.playerOf(S(), pid); if (!p) return;
    const name = prompt('이름', p.name); if (name === null) return;
    const phone = prompt('연락처', p.phone || ''); if (phone === null) return;
    const memo = prompt('메모', p.memo || ''); if (memo === null) return;
    Store.commit('정보 수정: ' + p.name, st => { const x = L.playerOf(st, pid); x.name = name.trim() || x.name; x.phone = phone.trim(); x.memo = memo.trim(); });
    toast('저장됨');
  }
  function printConfirm(playerId) {
    const s = S(); const p = L.playerOf(s, playerId); if (!p) return;
    const ev = L.eventOf(s, p.eventId); const t = L.tableOf(s, p.tableId);
    const tpl = s.templates.confirm;
    Print.print(Print.confirmHtml(tpl, { player: p, event: ev, table: t }), tpl.paper);
  }

  /* ---------- 테이블 탭 ---------- */
  function seatMapHtml(s, t, hitIds) {
    const players = L.tablePlayers(s, t.id);
    const off = L.disabledSeatSet(s, t);
    const usable = L.tableUsable(t);
    let seats = '';
    for (let i = 1; i <= t.seats; i++) {
      const p = players.find(x => x.seat === i);
      const isOff = off.has(i);
      const cls = ['seat'];
      if (isOff && !p) cls.push('off'); else if (p) cls.push('occupied'); else cls.push('empty');
      if (p && hitIds && hitIds.has(p.id)) cls.push('hit');
      if (ui.moveMode) {
        if (p && p.id === ui.moveMode.playerId) cls.push('selected');
        else if (!isOff) cls.push('pick');
      }
      seats += `<div class="${cls.join(' ')}" data-table="${t.id}" data-seat="${i}" ${p ? `data-player="${p.id}"` : ''}>
        <span class="no">${i}</span>
        ${p ? `<div class="pname">${h(p.name)}</div><div class="pmeta">#${p.entryNo}${isOff ? ' · 사용안함 좌석' : ''}</div>` : (isOff ? '사용 안함' : '빈 자리')}
      </div>`;
    }
    const open = t.status === 'open';
    return `<div class="table-card ${open ? '' : 'closed'} ${!usable && open ? 'disabled' : ''}" data-tcard="${t.id}" id="tcard-${t.number}">
      <div class="table-head"><span class="name">T${t.number}</span><span class="cnt">${players.length}/${L.usableSeats(s, t)}</span>${open ? (usable ? '' : '<span class="chip warn">사용 안함</span>') : '<span class="chip">닫힘</span>'}<span class="sp"></span>
        ${open ? `<button class="sm ghost" data-close="${t.id}">브레이크</button>` : `<button class="sm ghost" data-reopen="${t.id}">다시 열기</button><button class="sm ghost" data-deltable="${t.id}">삭제</button>`}
      </div>
      <div class="seats">${seats}</div></div>`;
  }
  function viewTables() {
    const s = S(); const ev = curEvent();
    if (!ev) return noEventHtml();
    const info = L.balanceInfo(s, ev.id);
    const avg = info.tables.length ? info.tables.reduce((n, c) => n + c.n, 0) / info.tables.length : 0;
    let tables = L.allTables(s, ev.id);
    const cnt = (t) => L.tablePlayers(s, t.id).length;
    // 필터
    const q = ui.tblSearch.trim().toLowerCase();
    let hitIds = null;
    if (q) {
      const tn = q.replace(/^t/, '');
      const isNum = /^\d+$/.test(tn);
      hitIds = new Set(L.activePlayers(s, ev.id).filter(p => p.name.toLowerCase().includes(q) || String(p.entryNo) === q).map(p => p.id));
      tables = tables.filter(t => (isNum && t.number === +tn) || L.tablePlayers(s, t.id).some(p => hitIds.has(p.id)));
    }
    if (ui.tblFilter === 'open') tables = tables.filter(t => t.status === 'open');
    else if (ui.tblFilter === 'empty') tables = tables.filter(t => t.status === 'open' && L.emptySeats(s, t).length);
    else if (ui.tblFilter === 'over') tables = tables.filter(t => t.status === 'open' && cnt(t) > Math.ceil(avg));
    else if (ui.tblFilter === 'under') tables = tables.filter(t => t.status === 'open' && cnt(t) < Math.floor(avg));
    else if (ui.tblFilter === 'closed') tables = tables.filter(t => t.status === 'closed');
    else tables = tables.filter(t => t.status === 'open');
    // 정렬
    const sorters = { numAsc: (a, b) => a.number - b.number, numDesc: (a, b) => b.number - a.number, cntAsc: (a, b) => cnt(a) - cnt(b) || a.number - b.number, cntDesc: (a, b) => cnt(b) - cnt(a) || a.number - b.number };
    tables.sort(sorters[ui.tblSort] || sorters.numAsc);

    let banner = '';
    if (ui.moveMode) {
      const p = L.playerOf(s, ui.moveMode.playerId);
      banner = `<div class="banner warn"><span class="grow"><b>${h(p ? p.name : '')}</b> 이동 중 — 목적지 좌석을 탭하거나 아래 버튼으로 테이블을 선택하세요 (플레이어가 있으면 자리 교환)</span><button class="sm" id="btnMoveSelect">테이블 선택</button><button class="sm ghost" id="btnCancelMove">취소</button></div>`;
    } else if (info.need) {
      banner = `<div class="banner bad"><span class="grow">테이블 인원 편차 ${info.max - info.min} (최소 ${info.min} / 최대 ${info.max}) — 밸런싱이 필요합니다</span><button class="sm warn" id="btnAutoBalance">자동 밸런싱</button></div>`;
    } else if (info.canBreak) {
      banner = `<div class="banner warn"><span class="grow">T${info.breakTable.number}을(를) 브레이크해도 전원 수용 가능합니다 (남은 ${info.active}명)</span><button class="sm" data-close="${info.breakTable.id}">T${info.breakTable.number} 브레이크</button></div>`;
    } else if (info.tables.length) {
      banner = `<div class="banner ok"><span class="grow">테이블 균형 양호 · 남은 ${info.active}명 / ${info.tables.length}테이블 · 평균 ${avg.toFixed(1)}명</span></div>`;
    }
    const sortLabels = { numAsc: '번호 오름차순', numDesc: '번호 내림차순', cntAsc: '인원 적은순', cntDesc: '인원 많은순' };
    const filterLabels = { all: '오픈 전체', empty: '빈 좌석 있음', over: '평균 초과', under: '평균 미만', closed: '닫힌 테이블' };
    const sortBtn = (k, lb) => `<button class="sm ${ui.tblSort === k ? 'primary' : 'ghost'}" data-sort="${k}">${lb}</button>`;
    const filtBtn = (k, lb, n) => `<button class="sm ${ui.tblFilter === k ? 'primary' : 'ghost'}" data-filter="${k}">${lb}${n != null ? ` <span class="cnt-badge">${n}</span>` : ''}</button>`;
    const allOpen = L.openTables(s, ev.id);
    const nOver = allOpen.filter(t => cnt(t) > Math.ceil(avg)).length, nUnder = allOpen.filter(t => cnt(t) < Math.floor(avg)).length;
    const nEmpty = allOpen.filter(t => L.emptySeats(s, t).length).length, nClosed = L.allTables(s, ev.id).length - allOpen.length;
    return `${banner}
    <div class="card toolbar">
      <div class="row tight">
        <button class="primary sm" id="btnOpenTable">새 테이블</button>
        <button class="sm" id="btnAutoBalance2" ${info.need ? '' : 'disabled'}>자동 밸런싱</button>
        <input id="tblSearch" placeholder="플레이어 이름 / 엔트리번호 / 테이블번호" value="${h(ui.tblSearch)}" style="flex:1;min-width:180px">
      </div>
      <div class="row tight" style="margin-top:8px">
        <button class="sm ghost" id="btnTools">정렬 · 보기 ${ui.tblToolsOpen ? '접기' : '열기'}</button>
        <span class="muted small">${sortLabels[ui.tblSort]} · ${filterLabels[ui.tblFilter]} · ${tables.length}개 표시</span>
      </div>
      <div class="${ui.tblToolsOpen ? '' : 'hidden'}">
        <div class="row tight" style="margin-top:8px">
          <span class="muted small">정렬</span>${sortBtn('numAsc', '번호 오름차순')}${sortBtn('numDesc', '번호 내림차순')}${sortBtn('cntAsc', '인원 적은순')}${sortBtn('cntDesc', '인원 많은순')}
        </div>
        <div class="row tight" style="margin-top:8px">
          <span class="muted small">보기</span>${filtBtn('all', '오픈 전체', allOpen.length)}${filtBtn('empty', '빈 좌석 있음', nEmpty)}${filtBtn('over', '평균 초과', nOver)}${filtBtn('under', '평균 미만', nUnder)}${filtBtn('closed', '닫힌 테이블', nClosed)}
        </div>
      </div>
    </div>
    <div class="tables-grid" id="tables">${tables.map(t => seatMapHtml(s, t, hitIds)).join('') || `<div class="muted card">${q ? '검색 결과가 없습니다.' : '표시할 테이블이 없습니다.'}</div>`}</div>`;
  }
  function bindTables(root) {
    if (!curEvent()) { bindNoEvent(root); return; }
    const ev = curEvent();
    $('#btnOpenTable', root).addEventListener('click', () => askOpenTable(ev.id));
    $('#btnTools', root).addEventListener('click', () => { ui.tblToolsOpen = !ui.tblToolsOpen; render(); });
    $$('[data-sort]', root).forEach(b => b.addEventListener('click', () => { ui.tblSort = b.dataset.sort; render(); }));
    $$('[data-filter]', root).forEach(b => b.addEventListener('click', () => { ui.tblFilter = b.dataset.filter; render(); }));
    const search = $('#tblSearch', root);
    search.addEventListener('input', () => { ui.tblSearch = search.value; const pos = search.selectionStart; render(); const s2 = $('#tblSearch'); s2.focus(); s2.setSelectionRange(pos, pos); });
    const cancelMove = $('#btnCancelMove', root); if (cancelMove) cancelMove.addEventListener('click', () => { ui.moveMode = null; render(); });
    const moveSel = $('#btnMoveSelect', root); if (moveSel) moveSel.addEventListener('click', () => moveSheet(ui.moveMode.playerId));
    ['#btnAutoBalance', '#btnAutoBalance2'].forEach(id => { const b = $(id, root); if (b) b.addEventListener('click', doAutoBalance); });
    $$('[data-close]', root).forEach(b => b.addEventListener('click', () => doCloseTable(b.dataset.close)));
    $$('[data-reopen]', root).forEach(b => b.addEventListener('click', () => { let r; Store.commit('테이블 다시 열기', st => { r = L.reopenTable(st, b.dataset.reopen); if (r && r.error) return false; }); toast(r && r.error ? r.error : '테이블을 다시 열었습니다'); }));
    $$('[data-deltable]', root).forEach(b => b.addEventListener('click', () => { let r; Store.commit('테이블 삭제', st => { r = L.deleteTable(st, b.dataset.deltable); if (r && r.error) return false; }); if (r && r.error) toast(r.error); }));
    $$('.seat', root).forEach(el => el.addEventListener('click', () => {
      const tid = el.dataset.table, seat = +el.dataset.seat, pid = el.dataset.player;
      if (ui.moveMode) {
        if (el.classList.contains('off')) { toast('사용 안하는 좌석입니다'); return; }
        doMove(ui.moveMode.playerId, tid, seat); return;
      }
      if (pid) tablePlayerSheet(pid);
    }));
  }
  function doMove(playerId, tid, seat) {
    const mover = L.playerOf(S(), playerId); let r;
    Store.commit('이동: ' + mover.name, st => { r = L.movePlayer(st, mover.id, tid, seat); if (r.error) return false; });
    if (r.error) { toast(r.error); return false; }
    ui.moveMode = null; render();
    toast(r.swapped ? `${mover.name} ↔ ${r.swapped.name} 자리 교환` : `${mover.name} → ${tableName(S(), tid)} S${seat}`);
    return true;
  }
  /** 테이블이 많을 때: 드롭다운으로 목적지 선택 */
  function moveSheet(pid) {
    const s = S(); const p = L.playerOf(s, pid); if (!p) return;
    const ev = L.eventOf(s, p.eventId);
    const cands = L.openTables(s, ev.id).filter(t => t.id !== p.tableId && L.tableUsable(t) && L.emptySeats(s, t).length)
      .sort((a, b) => L.tablePlayers(s, a.id).length - L.tablePlayers(s, b.id).length || a.number - b.number);
    if (!cands.length) { toast('빈 좌석이 있는 테이블이 없습니다'); return; }
    const opts = cands.map(t => `<option value="${t.id}">T${t.number} · ${L.tablePlayers(s, t.id).length}/${L.usableSeats(s, t)} · 빈 ${L.emptySeats(s, t).length}</option>`).join('');
    const body = `<div class="row"><label class="field"><span>테이블 (인원 적은 순)</span><select id="mvTable">${opts}</select></label><label class="field"><span>좌석</span><select id="mvSeat"></select></label></div>`;
    sheet(`${p.name} 이동 · 현재 ${tableName(s, p.tableId)} S${p.seat}`, [
      { label: '선택한 좌석으로 이동', cls: 'primary', fn: (el) => { const t = $('#mvTable', el).value, st = +$('#mvSeat', el).value; return doMove(pid, t, st) ? undefined : 'keep'; } },
      { label: '인원이 가장 적은 테이블로 자동 이동', fn: () => { const tgt = L.pickSeat(S(), ev.id, { excludeTableId: p.tableId }); if (tgt) doMove(pid, tgt.tableId, tgt.seat); else toast('빈 좌석 없음'); } },
    ], body, (el) => {
      const mt = $('#mvTable', el), ms = $('#mvSeat', el);
      const fill = () => { const t = L.tableOf(S(), mt.value); ms.innerHTML = L.emptySeats(S(), t).map(n => `<option value="${n}">S${n}</option>`).join(''); };
      mt.addEventListener('change', fill); fill();
    });
  }
  function tablePlayerSheet(pid) {
    const s = S(); const p = L.playerOf(s, pid); if (!p) return;
    sheet(`#${p.entryNo} ${p.name} · ${tableName(s, p.tableId)} S${p.seat}`, [
      { label: '이동 — 테이블 선택', fn: () => moveSheet(pid) },
      { label: '이동 — 화면에서 좌석 탭 (자리 교환 가능)', fn: () => { ui.moveMode = { playerId: pid }; render(); } },
      { label: '버스트아웃 (탈락 처리)', cls: 'danger', fn: () => doBust(pid) },
    ], p.memo ? `<div class="muted small" style="margin-bottom:10px">${h(p.memo)}</div>` : '');
  }
  function doBust(pid) {
    const p = L.playerOf(S(), pid); let r;
    Store.commit('탈락: ' + p.name, st => { r = L.bustOut(st, pid); if (r.error) return false; });
    if (r.error) { toast(r.error); return; }
    const ev = curEvent(); const prize = L.payoutFor(S(), ev, r.rank);
    toast(`${p.name} 탈락 · 최종 ${r.rank}위${prize ? ' · 상금 ' + money(prize) + '원' : ''} (되돌리기 가능)`, 3500);
    if (prize) setTimeout(() => sheet(`${r.rank}위 ${p.name} — 상금 ${money(prize)}원`, [
      { label: '바우처 발행 + 인쇄', cls: 'primary', fn: () => issueAndPrint(pid, prize) },
    ], '<div class="muted small" style="margin-bottom:10px">입상자입니다. 지금 바우처를 발행하거나, 이벤트 탭 순위표에서 나중에 발행할 수 있습니다.</div>'), 100);
  }
  function doCloseTable(tid) {
    const s = S(); const t = L.tableOf(s, tid); const n = L.tablePlayers(s, tid).length;
    if (!confirm(`T${t.number} 브레이크: ${n}명을 다른 테이블 빈 좌석에 무작위 배치하고 테이블을 닫습니다. 진행할까요?\n(상단 되돌리기로 취소할 수 있습니다)`)) return;
    let r; Store.commit(`T${t.number} 브레이크`, st => { r = L.closeTable(st, tid); if (r.error) return false; });
    if (r.error) { toast(r.error); return; }
    showMoves(`T${t.number} 브레이크 완료`, r.moves);
  }
  function doAutoBalance() {
    const ev = curEvent(); let moves;
    Store.commit('자동 밸런싱', st => { moves = L.autoBalance(st, ev.id); if (!moves.length) return false; });
    if (!moves || !moves.length) { toast('이동할 필요가 없습니다'); return; }
    showMoves('자동 밸런싱 완료', moves);
  }
  function showMoves(title, moves) {
    const s = S();
    const body = `<div class="list" style="margin-bottom:12px">${moves.map(m => `<div class="list-item"><div class="grow"><div class="t">${h(m.player.name)} <span class="muted small">#${m.player.entryNo}</span></div><div class="s">${tableName(s, m.from.tableId)} S${m.from.seat} → <b>${tableName(s, m.to.tableId)} S${m.to.seat}</b></div></div></div>`).join('')}</div>`;
    sheet(title + ` (${moves.length}명 이동)`, [{ label: '되돌리기', cls: 'ghost', fn: () => { Store.undo(); toast('되돌렸습니다'); } }], body);
  }

  /* ---------- 이벤트 탭 ---------- */
  const kpi = (label, val) => `<div class="kpi"><div class="k">${label}</div><div class="v">${val}</div></div>`;
  function payoutRowsHtml(rows) {
    if (!rows.length) return '<div class="muted small" style="padding:6px 0">구간 없음</div>';
    return rows.map((r, i) => `<div class="row tight payout-row" style="margin-bottom:6px">
      <input type="number" min="1" name="pfrom" value="${h(r.from)}" placeholder="부터" style="width:70px"><span class="muted">~</span>
      <input type="number" min="1" name="pto" value="${h(r.to)}" placeholder="까지" style="width:70px"><span class="muted">위</span>
      <input type="number" min="0" name="pamount" value="${h(r.amount || '')}" placeholder="금액(원)" style="width:120px">
      <input name="plabel" value="${h(r.label || '')}" placeholder="비고(티켓 등)" style="flex:1;min-width:80px">
      <button type="button" class="sm ghost" data-delrow="${i}">삭제</button></div>`).join('');
  }
  function readPayoutRows(form) {
    return $$('.payout-row', form).map(r => ({ from: r.querySelector('[name=pfrom]').value, to: r.querySelector('[name=pto]').value, amount: r.querySelector('[name=pamount]').value, label: r.querySelector('[name=plabel]').value }));
  }
  function viewEvents() {
    const s = S(); const ev = curEvent();
    const list = s.events.map(e => {
      const all = L.eventPlayers(s, e.id), act = all.filter(p => p.status === 'active');
      return `<div class="list-item ${e.id === s.selectedEventId ? 'current' : ''}">
        <div class="grow" data-selevent="${e.id}" style="cursor:pointer"><div class="t">${h(e.name)} ${e.status === 'closed' ? '<span class="chip">종료</span>' : ''}</div>
        <div class="s">바이인 ${money(e.buyIn)}원 · ${e.seats}인 · 테이블 T${e.tableStart || 1}~${e.tableEnd || '∞'} · 참가 ${all.length} / 남은 ${act.length} / 오픈 ${L.openTables(s, e.id).length}</div></div>
        <button class="sm ghost" data-editevent="${e.id}">수정</button></div>`;
    }).join('');
    const ed = ui.eventEdit ? (ui.eventEdit === 'new' ? { name: '', buyIn: '', seats: s.settings.defaultSeats, startChips: '', memo: '', status: 'open', rakePct: 0, prizePool: '', payouts: [], tableStart: 1, tableEnd: '' } : L.eventOf(s, ui.eventEdit)) : null;
    const editForm = ed ? `<div class="card"><h3>${ui.eventEdit === 'new' ? '새 이벤트' : '이벤트 수정'}</h3>
      <form id="eventForm">
        <label class="field"><span>이벤트 이름 *</span><input name="name" value="${h(ed.name)}" required placeholder="예: Main Event Day 1A"></label>
        <div class="row">
          <label class="field"><span>바이인 (원)</span><input name="buyIn" type="number" value="${h(ed.buyIn)}"></label>
          <label class="field"><span>테이블당 좌석</span><input name="seats" type="number" min="2" max="12" value="${h(ed.seats)}"></label>
          <label class="field"><span>스타팅 칩</span><input name="startChips" type="number" value="${h(ed.startChips || '')}"></label>
        </div>
        <div class="row">
          <label class="field"><span>테이블 시작 번호</span><input name="tableStart" type="number" min="1" value="${h(ed.tableStart || 1)}"></label>
          <label class="field"><span>테이블 끝 번호 (비우면 제한 없음)</span><input name="tableEnd" type="number" min="1" value="${h(ed.tableEnd || '')}"></label>
        </div>
        <div class="row">
          <label class="field"><span>수수료 (%)</span><input name="rakePct" type="number" min="0" max="100" step="0.5" value="${h(ed.rakePct || 0)}"></label>
          <label class="field"><span>상금 풀 고정 (원, 비우면 바이인 합계−수수료)</span><input name="prizePool" type="number" value="${h(ed.prizePool || '')}"></label>
        </div>
        <div class="field"><span class="small muted">상금표 (순위 구간 → 금액 · 예: 1~1위 1,000,000 / 10~20위 50,000 / 100~900위 30,000)</span>
          <div id="payoutRows">${payoutRowsHtml(ed.payouts || [])}</div>
          <button type="button" class="sm ghost" id="btnAddPayout" style="margin-top:6px">구간 추가</button>
        </div>
        <label class="field"><span>메모</span><input name="memo" value="${h(ed.memo || '')}"></label>
        ${ui.eventEdit !== 'new' ? `<label class="field"><span>상태</span><select name="status"><option value="open" ${ed.status === 'open' ? 'selected' : ''}>진행 중</option><option value="closed" ${ed.status === 'closed' ? 'selected' : ''}>종료</option></select></label>` : ''}
        <div class="row"><button type="submit" class="primary">저장</button><button type="button" class="ghost" id="btnCancelEvent">취소</button>${ui.eventEdit !== 'new' ? `<button type="button" class="danger" id="btnDeleteEvent">삭제</button>` : ''}</div>
      </form></div>` : '';

    let dash = '';
    if (ev && !ed) {
      const all = L.eventPlayers(s, ev.id), active = L.activePlayers(s, ev.id), busted = L.bustedPlayers(s, ev.id);
      const gross = all.reduce((n, p) => n + (p.buyIn || 0), 0);
      const pool = L.prizePool(s, ev), pay = L.payoutTable(s, ev);
      const info = L.balanceInfo(s, ev.id);
      const paid = (s.vouchers || []).filter(v => v.eventId === ev.id).reduce((n, v) => n + v.amount, 0);
      const secs = [['board', '현황판'], ['payouts', '상금 구조'], ['ranks', '순위표']];
      let body = '';
      if (ui.eventSection === 'board') {
        body = `<div class="kpis">
          ${kpi('참가', all.length + '명')}${kpi('남은', active.length + '명')}${kpi('탈락', busted.length + '명')}
          ${kpi('오픈 테이블', L.openTables(s, ev.id).length + '개')}${kpi('총 바이인', money(gross) + '원')}${kpi('상금 풀', money(pool) + '원')}
          ${kpi('입상 자리', pay.reduce((n, r) => n + r.to - r.from + 1, 0) + '명')}${kpi('상금표 총액', money(L.payoutTotal(s, ev)) + '원')}${kpi('바우처 지급', money(paid) + '원')}
          ${kpi('밸런스', info.tables.length ? (info.need ? '필요' : '양호') : '-')}
        </div>
        <div class="row" style="margin-top:12px"><a class="btn-link" href="#reg">등록 탭</a><a class="btn-link" href="#tables">테이블 탭</a>
        ${active.length === 1 && ev.status !== 'closed' ? `<button class="primary" id="btnFinish">${h(active[0].name)} 우승 확정 · 이벤트 종료</button>` : ''}</div>
        ${ev.memo ? `<p class="muted small" style="margin-top:10px">${h(ev.memo)}</p>` : ''}`;
      } else if (ui.eventSection === 'payouts') {
        const total = L.payoutTotal(s, ev);
        const nameAt = (rank) => { const p = busted.find(b => b.finishRank === rank) || (rank === 1 && active.length === 1 ? active[0] : null); return p ? h(p.name) : ''; };
        body = `<p class="muted small">상금 풀 ${money(pool)}원 (${ev.prizePool ? '고정' : `바이인 합계 ${money(gross)}원 − 수수료 ${ev.rakePct || 0}%`}) · 상금표 총액 ${money(total)}원 ${total > pool && pool ? '<span class="warn-text">(풀 초과)</span>' : ''} · 구간은 이벤트 수정에서 변경</p>
        ${pay.length ? `<table class="tbl"><tr><th>순위</th><th>금액</th><th>인원</th><th>확정 선수</th></tr>
        ${pay.map(r => { const n = r.to - r.from + 1; const names = []; for (let k = r.from; k <= r.to && names.length < 6; k++) { const nm = nameAt(k); if (nm) names.push(k + '위 ' + nm); } return `<tr><td>${r.from === r.to ? r.from + '위' : r.from + '~' + r.to + '위'}</td><td>${r.amount ? money(r.amount) + '원' : ''}${r.label ? ` <span class="muted small">${h(r.label)}</span>` : ''}</td><td class="muted">${n}명 · ${money(r.amount * n)}원</td><td class="small">${names.join(', ') || '<span class="muted">-</span>'}</td></tr>`; }).join('')}
        <tr><td><b>합계</b></td><td><b>${money(total)}원</b></td><td class="muted">${pay.reduce((n, r) => n + r.to - r.from + 1, 0)}명</td><td></td></tr></table>` : '<div class="muted">상금표가 없습니다. 이벤트 수정에서 구간을 추가하세요.</div>'}`;
      } else {
        const rows = [];
        if (active.length === 1) rows.push({ rank: 1, p: active[0], live: true });
        busted.forEach(b => rows.push({ rank: b.finishRank, p: b }));
        body = `<div class="list">${rows.map(({ rank, p, live }) => {
          const row = L.payoutRow(s, ev, rank); const prize = row ? row.amount : 0; const v = (s.vouchers || []).find(x => x.playerId === p.id);
          return `<div class="list-item"><span class="rank">${rank}위</span><div class="grow"><div class="t">${h(p.name)} <span class="muted small">#${p.entryNo}${live ? ' · 진행 중' : ''}</span></div><div class="s">${prize ? money(prize) + '원' : (row && row.label ? '' : '입상 없음')}${row && row.label ? ' ' + h(row.label) : ''}${v ? ` · 바우처 ${v.serial} 발행됨` : ''}${p.bustedAt ? ' · ' + Print.fmtTime(p.bustedAt) : ''}</div></div>
            ${prize && !v ? `<button class="sm primary" data-issue="${p.id}" data-amt="${prize}">바우처</button>` : ''}${v ? `<button class="sm ghost" data-revoucher="${v.id}">재인쇄</button>` : ''}${!live ? `<button class="sm ghost" data-unbust="${p.id}">복구</button>` : ''}</div>`;
        }).join('') || '<div class="muted small">아직 탈락자가 없습니다.</div>'}</div>
        ${active.length > 1 ? `<p class="muted small" style="margin-top:8px">남은 ${active.length}명은 테이블 탭에서 탈락 처리하면 여기에 순위가 쌓입니다.</p>` : ''}`;
      }
      dash = `<div class="card"><div class="row tight" style="margin-bottom:10px"><h2 style="margin:0">${h(ev.name)}</h2><span style="flex:1"></span>${secs.map(([k, lb]) => `<button class="sm ${ui.eventSection === k ? 'primary' : 'ghost'}" data-esec="${k}">${lb}</button>`).join('')}</div>${body}</div>`;
    }
    return `${dash}${editForm}
    <div class="card"><div class="row tight"><h3 style="margin:0">이벤트 목록</h3><span style="flex:1"></span><button class="primary sm" id="btnNewEvent">새 이벤트</button></div>
      <div class="list" style="margin-top:10px">${list || '<div class="muted">이벤트가 없습니다. 새 이벤트를 만들어 시작하세요.</div>'}</div></div>`;
  }
  function bindEvents(root) {
    $('#btnNewEvent', root).addEventListener('click', () => { ui.eventEdit = 'new'; render(); setTimeout(() => { const i = $('#eventForm input[name=name]'); if (i) i.focus(); }, 0); });
    $$('[data-selevent]', root).forEach(el => el.addEventListener('click', () => { Store.patch(st => st.selectedEventId = el.dataset.selevent); ui.regSeat = null; ui.moveMode = null; }));
    $$('[data-editevent]', root).forEach(b => b.addEventListener('click', () => { ui.eventEdit = b.dataset.editevent; render(); }));
    $$('[data-esec]', root).forEach(b => b.addEventListener('click', () => { ui.eventSection = b.dataset.esec; render(); }));
    $$('[data-issue]', root).forEach(b => b.addEventListener('click', () => issueAndPrint(b.dataset.issue, +b.dataset.amt)));
    $$('[data-revoucher]', root).forEach(b => b.addEventListener('click', () => printVoucher(b.dataset.revoucher)));
    $$('[data-unbust]', root).forEach(b => b.addEventListener('click', () => doUnbust(b.dataset.unbust)));
    const fin = $('#btnFinish', root); if (fin) fin.addEventListener('click', () => {
      const ev = curEvent(); const w = L.activePlayers(S(), ev.id)[0];
      if (!confirm(`${w.name}을(를) 1위로 확정하고 "${ev.name}"을(를) 종료할까요?`)) return;
      Store.commit('이벤트 종료: ' + ev.name, st => { const x = L.playerOf(st, w.id); x.status = 'busted'; x.finishRank = 1; x.bustedAt = Date.now(); x.lastSeat = { tableId: x.tableId, seat: x.seat }; x.tableId = null; x.seat = null; L.eventOf(st, ev.id).status = 'closed'; });
      ui.eventSection = 'ranks'; render(); toast('이벤트 종료 · 순위표를 확인하세요');
    });
    const form = $('#eventForm', root); if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault(); const fd = new FormData(form); const data = Object.fromEntries(fd.entries());
      ['pfrom', 'pto', 'pamount', 'plabel'].forEach(k => delete data[k]);
      data.payouts = L.normalizePayouts(readPayoutRows(form));
      data.rakePct = +data.rakePct || 0; data.prizePool = +data.prizePool || 0;
      if (data.tableEnd && +data.tableEnd < +data.tableStart) { toast('테이블 끝 번호가 시작 번호보다 작습니다'); return; }
      if (ui.eventEdit === 'new') { let ev; Store.commit('이벤트 생성: ' + data.name, st => { ev = L.createEvent(st, data); st.selectedEventId = ev.id; }); toast('이벤트 생성됨'); }
      else { Store.commit('이벤트 수정', st => L.updateEvent(st, ui.eventEdit, data)); toast('저장됨'); }
      ui.eventEdit = null; render();
    });
    const rerows = (rows) => { $('#payoutRows', form).innerHTML = payoutRowsHtml(rows); bindRows(); };
    const bindRows = () => $$('[data-delrow]', form).forEach(b => b.addEventListener('click', () => { const rows = readPayoutRows(form); rows.splice(+b.dataset.delrow, 1); rerows(rows); }));
    bindRows();
    $('#btnAddPayout', form).addEventListener('click', () => { const rows = readPayoutRows(form); const last = rows[rows.length - 1]; const next = last ? (+last.to || +last.from || 0) + 1 : 1; rows.push({ from: next, to: next, amount: '', label: '' }); rerows(rows); });
    $('#btnCancelEvent', root).addEventListener('click', () => { ui.eventEdit = null; render(); });
    const del = $('#btnDeleteEvent', root); if (del) del.addEventListener('click', () => {
      const ev = L.eventOf(S(), ui.eventEdit); const n = L.eventPlayers(S(), ev.id).length;
      if (!confirm(`"${ev.name}" 이벤트와 참가자 ${n}명, 테이블 정보를 모두 삭제할까요?\n(되돌리기 가능)`)) return;
      Store.commit('이벤트 삭제: ' + ev.name, st => L.deleteEvent(st, ev.id)); ui.eventEdit = null; render(); toast('이벤트 삭제됨');
    });
  }
  function doUnbust(pid) {
    const p = L.playerOf(S(), pid); let r;
    Store.commit('탈락 복구: ' + p.name, st => { r = L.unbust(st, p.id); if (r.error) return false; if (L.eventOf(st, p.eventId).status === 'closed') L.eventOf(st, p.eventId).status = 'open'; });
    if (r.error) toast(r.error); else toast(`${p.name} 복구 → ${tableName(S(), r.tableId)} S${r.seat}`);
  }
  function issueAndPrint(pid, amount) {
    const s = S(); const p = L.playerOf(s, pid); if (!p) return; let v;
    Store.commit('바우처 발행: ' + p.name, st => { v = L.issueVoucher(st, { eventId: p.eventId, playerId: p.id, playerName: p.name, rank: p.finishRank, amount }); });
    printVoucher(v.id);
  }

  /* ---------- 용지 탭 ---------- */
  function tplEditorHtml(kind, tpl) {
    const fields = kind === 'confirm'
      ? [['showEntryNo', '엔트리 번호'], ['showBuyIn', '바이인'], ['showPhone', '연락처'], ['showTime', '등록 시각']]
      : [['showSerial', '일련번호'], ['showRank', '최종 순위'], ['showSignature', '서명란']];
    return `<form class="tpl-form" data-kind="${kind}">
      <div class="row">
        <label class="field"><span>제목</span><input name="title" value="${h(tpl.title)}"></label>
        <label class="field"><span>부제</span><input name="subtitle" value="${h(tpl.subtitle)}" placeholder="예: 2026 Spring Series"></label>
      </div>
      <div class="row">
        <label class="field"><span>상단 로고 텍스트</span><input name="logoText" value="${h(tpl.logoText)}" placeholder="예: DANBI POKER"></label>
        <label class="field"><span>용지</span><select name="paper">${Object.keys(Print.PAPER).map(k => `<option ${tpl.paper === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>하단 문구</span><textarea name="footer" rows="2">${h(tpl.footer)}</textarea></label>
      <div class="row tight small" style="margin-bottom:10px">${fields.map(([k, lb]) => `<label class="chk"><input type="checkbox" name="${k}" ${tpl[k] ? 'checked' : ''}>${lb}</label>`).join('')}</div>
      <button type="button" class="sm" data-testprint="${kind}">테스트 인쇄</button>
    </form>`;
  }
  function previewHtml(kind) {
    const s = S(); const tpl = s.templates[kind]; const sm = Print.sample();
    return kind === 'confirm' ? Print.confirmHtml(tpl, sm) : Print.voucherHtml(tpl, sm);
  }
  function viewPrint() {
    const s = S(); const ev = curEvent();
    const tabs = [['confirm', '참가확인증'], ['voucher', '상금바우처'], ['voucher-issue', '바우처 발행'], ['data', '데이터/설정']];
    let body = '';
    if (ui.printTab === 'confirm' || ui.printTab === 'voucher') {
      body = `<div class="card">${tplEditorHtml(ui.printTab, s.templates[ui.printTab])}</div><div class="preview-wrap" id="preview">${previewHtml(ui.printTab)}</div>`;
    } else if (ui.printTab === 'voucher-issue') {
      if (!ev) body = noEventHtml();
      else {
        const busted = L.bustedPlayers(s, ev.id), active = L.activePlayers(s, ev.id);
        const opt = (p, pre) => `<option value="${p.id}" data-amt="${p.finishRank ? L.payoutFor(s, ev, p.finishRank) : ''}" ${ui.voucherForm.playerId === p.id ? 'selected' : ''}>${pre} · ${h(p.name)} (#${p.entryNo})</option>`;
        const opts = busted.map(p => opt(p, p.finishRank + '위')).join('') + active.map(p => opt(p, '진행중')).join('');
        const vs = (s.vouchers || []).filter(v => v.eventId === ev.id).sort((a, b) => b.issuedAt - a.issuedAt);
        body = `<div class="card"><h3>바우처 수동 발행 <span class="muted small">${h(ev.name)}</span></h3><p class="muted small">입상자 바우처는 이벤트 탭 &gt; 순위표에서 금액이 자동 계산됩니다. 여기서는 딜·특별상 등 임의 금액을 발행합니다.</p>
          <form id="voucherForm">
            <label class="field"><span>수령인</span><select name="playerId"><option value="">직접 입력</option>${opts}</select></label>
            <label class="field" id="manualNameWrap" style="${ui.voucherForm.playerId ? 'display:none' : ''}"><span>이름 (직접 입력)</span><input name="manualName" placeholder="수령인 이름"></label>
            <div class="row"><label class="field"><span>상금 (원) *</span><input name="amount" type="number" required value="${h(ui.voucherForm.amount)}"></label><label class="field"><span>비고</span><input name="note" value="${h(ui.voucherForm.note)}" placeholder="예: 딜 합의"></label></div>
            <button type="submit" class="primary">발행 + 인쇄</button>
          </form></div>
          <div class="card"><h3>발행 내역 (${vs.length}) <span class="muted small">합계 ${money(vs.reduce((n, v) => n + v.amount, 0))}원</span></h3><div class="list">${vs.map(v => `<div class="list-item"><span class="rank">${v.serial}</span><div class="grow"><div class="t">${h(v.playerName)} ${v.rank ? `<span class="muted small">${v.rank}위</span>` : ''}</div><div class="s">${money(v.amount)}원 · ${Print.fmtTime(v.issuedAt)}${v.note ? ' · ' + h(v.note) : ''}</div></div><button class="sm ghost" data-revoucher="${v.id}">재인쇄</button><button class="sm ghost" data-delvoucher="${v.id}">취소</button></div>`).join('') || '<div class="muted small">발행된 바우처가 없습니다.</div>'}</div></div>`;
      }
    } else {
      body = `<div class="card"><h3>설정</h3>
        <label class="chk" style="margin-bottom:8px"><input type="checkbox" id="setAutoPrint" ${s.settings.autoPrintOnRegister !== false ? 'checked' : ''}>등록 시 참가확인증 자동 인쇄</label>
        <label class="chk" style="margin-bottom:8px"><input type="checkbox" id="setAutoOpen" ${s.settings.autoOpenTable !== false ? 'checked' : ''}>빈 좌석이 없으면 새 테이블 자동 오픈</label>
        <label class="field"><span>새 이벤트 기본 좌석 수</span><input type="number" id="setSeats" value="${s.settings.defaultSeats}" min="2" max="12"></label></div>
        <div class="card"><h3>데이터</h3><p class="muted small">데이터는 이 브라우저(localStorage)에만 저장됩니다. 다른 기기로 옮기려면 내보내기/가져오기를 사용하세요.</p>
        <div class="row"><button id="btnExport">내보내기 (JSON)</button><button id="btnImport">가져오기</button><button id="btnCsv">참가자 CSV</button><input type="file" id="importFile" accept="application/json" class="hidden"></div>
        <div style="margin-top:10px"><button class="danger sm" id="btnReset">전체 초기화</button></div></div>`;
    }
    return `<div class="row tight" style="margin-bottom:12px">${tabs.map(([k, lb]) => `<button class="sm ${ui.printTab === k ? 'primary' : 'ghost'}" data-ptab="${k}">${lb}</button>`).join('')}</div>${body}`;
  }
  function bindPrint(root) {
    $$('[data-ptab]', root).forEach(b => b.addEventListener('click', () => { ui.printTab = b.dataset.ptab; render(); }));
    bindNoEvent(root);
    const tf = $('.tpl-form', root);
    if (tf) {
      const kind = tf.dataset.kind;
      const read = () => { const fd = new FormData(tf); const o = {}; ['title', 'subtitle', 'logoText', 'paper', 'footer'].forEach(k => o[k] = fd.get(k) || ''); $$('input[type=checkbox]', tf).forEach(c => o[c.name] = c.checked); return o; };
      tf.addEventListener('input', () => { Object.assign(S().templates[kind], read()); $('#preview').innerHTML = previewHtml(kind); });
      tf.addEventListener('change', () => { Store.patch(st => Object.assign(st.templates[kind], read())); });
      $('[data-testprint]', tf).addEventListener('click', () => { const tpl = S().templates[kind]; Print.print(previewHtml(kind), tpl.paper); });
    }
    const vf = $('#voucherForm', root);
    if (vf) {
      vf.playerId.addEventListener('change', () => {
        $('#manualNameWrap').style.display = vf.playerId.value ? 'none' : '';
        const amt = vf.playerId.selectedOptions[0] && vf.playerId.selectedOptions[0].dataset.amt; if (amt) vf.amount.value = amt;
      });
      vf.addEventListener('submit', (e) => {
        e.preventDefault(); const s = S(); const ev = curEvent();
        const p = vf.playerId.value ? L.playerOf(s, vf.playerId.value) : null;
        const name = p ? p.name : vf.manualName.value.trim();
        if (!name) { toast('수령인을 선택하거나 입력하세요'); return; }
        let v; Store.commit('바우처 발행: ' + name, st => { v = L.issueVoucher(st, { eventId: ev.id, playerId: p ? p.id : null, playerName: name, rank: p ? p.finishRank : null, amount: vf.amount.value, note: vf.note.value }); });
        ui.voucherForm = { playerId: '', amount: '', note: '' }; render();
        printVoucher(v.id);
      });
      $$('[data-revoucher]', root).forEach(b => b.addEventListener('click', () => printVoucher(b.dataset.revoucher)));
      $$('[data-delvoucher]', root).forEach(b => b.addEventListener('click', () => { if (confirm('이 바우처 발행 기록을 취소할까요?')) Store.commit('바우처 취소', st => { st.vouchers = st.vouchers.filter(v => v.id !== b.dataset.delvoucher); }); }));
    }
    const ap = $('#setAutoPrint', root);
    if (ap) {
      ap.addEventListener('change', () => Store.patch(st => st.settings.autoPrintOnRegister = ap.checked));
      $('#setAutoOpen', root).addEventListener('change', (e) => Store.patch(st => st.settings.autoOpenTable = e.target.checked));
      $('#setSeats', root).addEventListener('change', (e) => Store.patch(st => st.settings.defaultSeats = +e.target.value || 9));
      const download = (text, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); };
      $('#btnExport', root).addEventListener('click', () => download(Store.exportJSON(), 'holdem-td-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json'));
      $('#btnCsv', root).addEventListener('click', () => {
        const s = S(); const ev = curEvent(); if (!ev) { toast('이벤트를 선택하세요'); return; }
        const rows = [['entryNo', 'name', 'phone', 'buyIn', 'memo', 'status', 'table', 'seat', 'finishRank', 'registeredAt']];
        L.eventPlayers(s, ev.id).sort((a, b) => a.entryNo - b.entryNo).forEach(p => rows.push([p.entryNo, p.name, p.phone, p.buyIn, p.memo, p.status, tableName(s, p.tableId), p.seat || '', p.finishRank || '', Print.fmtTime(p.registeredAt)]));
        download('﻿' + rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\n'), ev.name + '-players.csv', 'text/csv');
      });
      $('#btnImport', root).addEventListener('click', () => $('#importFile').click());
      $('#importFile', root).addEventListener('change', (e) => {
        const f = e.target.files[0]; if (!f) return; const r = new FileReader();
        r.onload = () => { try { Store.importJSON(r.result); toast('가져오기 완료'); } catch (err) { toast('가져오기 실패: ' + err.message); } };
        r.readAsText(f);
      });
      $('#btnReset', root).addEventListener('click', () => { if (confirm('모든 이벤트/참가자/테이블/바우처를 삭제합니다. 계속할까요?') && confirm('정말로 초기화할까요? (되돌리기 1회 가능)')) { Store.reset(); toast('초기화됨'); } });
    }
  }
  function printVoucher(id) {
    const s = S(); const v = (s.vouchers || []).find(x => x.id === id); if (!v) return;
    const tpl = s.templates.voucher; Print.print(Print.voucherHtml(tpl, { voucher: v, event: L.eventOf(s, v.eventId) }), tpl.paper);
  }

  /* ---------- 렌더 루프 ---------- */
  const VIEWS = { reg: [viewReg, bindReg], tables: [viewTables, bindTables], events: [viewEvents, bindEvents], print: [viewPrint, bindPrint] };
  /** 데스크톱에서 탭바를 상단바 바로 아래에 고정하기 위한 높이 측정 */
  function syncTopbarHeight() {
    const tb = $('#topbar'); if (!tb) return;
    document.documentElement.style.setProperty('--topbarH', tb.offsetHeight + 'px');
  }
  function render() {
    renderTop();
    const v = VIEWS[ui.tab] || VIEWS.reg;
    const root = $('#view'); root.innerHTML = v[0](); v[1](root);
    $$('#tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === ui.tab));
    syncTopbarHeight();
  }
  function init() {
    Store.subscribe(render);
    window.addEventListener('hashchange', () => { ui.tab = (location.hash || '#reg').slice(1); ui.moveMode = null; render(); });
    $('#eventSelect').addEventListener('change', (e) => { Store.patch(st => st.selectedEventId = e.target.value || null); ui.regSeat = null; ui.moveMode = null; });
    $('#btnUndo').addEventListener('click', () => { const l = Store.undo(); if (l) toast('되돌림: ' + l); });
    $('#btnRedo').addEventListener('click', () => { const l = Store.redo(); if (l) toast('다시 실행: ' + l); });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { e.preventDefault(); e.shiftKey ? Store.redo() : Store.undo(); }
    });
    window.addEventListener('resize', syncTopbarHeight);
    if (!S().selectedEventId && S().events.length) Store.patch(st => st.selectedEventId = st.events[0].id);
    render();
  }
  return { init, ui };
})();
document.addEventListener('DOMContentLoaded', App.init);
