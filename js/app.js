/* UI 렌더링 & 이벤트 바인딩 */
const App = (() => {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const h = Print.esc;
  const S = () => Store.get();
  const L = Logic;

  const ui = {
    tab: (location.hash || '#reg').slice(1),
    regForm: { name: '', phone: '', buyIn: '', memo: '' },
    regSeat: null, regPick: false,
    moveMode: null,           // { playerId }
    showClosed: false, showBusted: true,
    eventEdit: null,          // event id being edited or 'new'
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
  function sheet(title, actions, bodyHtml) {
    const el = $('#sheet');
    el.innerHTML = `<div class="sheet-body"><h3>${h(title)}</h3>${bodyHtml || ''}<div class="sheet-actions">${actions.map((a, i) => `<button class="${a.cls || ''}" data-i="${i}">${a.label}</button>`).join('')}<button class="ghost" data-i="-1">닫기</button></div></div>`;
    el.classList.remove('hidden');
    el.onclick = (e) => {
      if (e.target === el) { closeSheet(); return; }
      const b = e.target.closest('button[data-i]'); if (!b) return;
      const i = +b.dataset.i; closeSheet(); if (i >= 0) actions[i].fn();
    };
  }
  function closeSheet() { const el = $('#sheet'); el.classList.add('hidden'); el.innerHTML = ''; }
  const tableName = (s, id) => { const t = L.tableOf(s, id); return t ? 'T' + t.number : '-'; };

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
      ${tables ? (info.need ? `<span class="chip bad">⚖ 밸런싱 필요 (${info.min}~${info.max})</span>` : `<span class="chip ok">⚖ 균형 양호</span>`) : ''}
      ${info.canBreak ? `<span class="chip warn">T${info.breakTable.number} 브레이크 가능</span>` : ''}`;
  }

  /* ---------- 좌석 맵(공용) ---------- */
  /** mode: 'reg'(빈좌석 선택 가능) | 'tables'(플레이어 액션/이동) */
  function seatMapHtml(s, t, mode) {
    const players = L.tablePlayers(s, t.id);
    const off = new Set(t.disabledSeats || []);
    let seats = '';
    for (let i = 1; i <= t.seats; i++) {
      const p = players.find(x => x.seat === i);
      const isOff = off.has(i);
      const cls = ['seat'];
      if (isOff) cls.push('off'); else if (p) cls.push('occupied'); else cls.push('empty');
      if (mode === 'reg' && ui.regSeat && ui.regSeat.tableId === t.id && ui.regSeat.seat === i) cls.push('assigned');
      if (mode === 'reg' && ui.regPick && !p && !isOff) cls.push('pick');
      if (mode === 'tables' && ui.moveMode) {
        if (p && p.id === ui.moveMode.playerId) cls.push('selected');
        else if (!isOff) cls.push('pick');
      }
      seats += `<div class="${cls.join(' ')}" data-table="${t.id}" data-seat="${i}" ${p ? `data-player="${p.id}"` : ''}>
        <span class="no">${i}</span>
        <input type="checkbox" ${isOff ? '' : 'checked'} ${p ? 'disabled' : ''} title="좌석 사용" data-toggle="${t.id}:${i}">
        ${p ? `<div class="pname">${h(p.name)}</div><div class="pmeta">#${p.entryNo}</div>` : (isOff ? '사용 안함' : '빈 자리')}
      </div>`;
    }
    const canClose = t.status === 'open';
    return `<div class="table-card ${t.status === 'closed' ? 'closed' : ''} ${mode === 'reg' && ui.regSeat && ui.regSeat.tableId === t.id ? 'target' : ''}" data-tcard="${t.id}">
      <div class="table-head"><span class="name">T${t.number}</span><span class="cnt">${players.length}/${L.usableSeats(t)}</span>${t.status === 'closed' ? '<span class="chip">닫힘</span>' : ''}<span class="sp"></span>
        ${mode === 'tables' ? (canClose ? `<button class="sm ghost" data-close="${t.id}">브레이크</button>` : `<button class="sm ghost" data-reopen="${t.id}">다시 열기</button><button class="sm ghost" data-deltable="${t.id}">삭제</button>`) : ''}
      </div>
      <div class="seats">${seats}</div></div>`;
  }
  function bindSeatToggles(root) {
    $$('input[data-toggle]', root).forEach(cb => cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const [tid, seat] = cb.dataset.toggle.split(':');
      const r = Store.commit('좌석 사용 변경', st => L.toggleSeat(st, tid, +seat));
      if (r && r.error) toast(r.error);
      if (ui.regSeat && ui.regSeat.tableId === tid && ui.regSeat.seat === +seat) { ui.regSeat = L.pickSeat(S(), S().selectedEventId); render(); }
    }));
  }

  /* ---------- 등록 탭 ---------- */
  function ensureRegSeat() {
    const ev = curEvent(); if (!ev) { ui.regSeat = null; return; }
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
    const recent = L.eventPlayers(s, ev.id).sort((a, b) => b.registeredAt - a.registeredAt).slice(0, 15);
    const seatTxt = ui.regSeat ? `T${tableName(s, ui.regSeat.tableId).slice(1)} · S${ui.regSeat.seat}` : (s.settings.autoOpenTable ? '새 테이블 자동 오픈' : '빈 좌석 없음');
    return `
    <div class="card">
      <h2>등록 · ${h(ev.name)} <span class="muted small">바이인 ${Print.fmtMoney(ev.buyIn)}원</span></h2>
      <form id="regForm" autocomplete="off">
        <div class="row">
          <label class="field"><span>이름 *</span><input name="name" value="${h(f.name)}" required placeholder="플레이어 이름" autofocus></label>
          <label class="field"><span>연락처</span><input name="phone" value="${h(f.phone)}" placeholder="선택"></label>
        </div>
        <div class="row">
          <label class="field"><span>바이인 (원)</span><input name="buyIn" type="number" value="${h(f.buyIn)}" placeholder="${ev.buyIn}"></label>
          <label class="field"><span>메모</span><input name="memo" value="${h(f.memo)}" placeholder="리엔트리, 애드온 등"></label>
        </div>
        <div class="assign-box">
          <div><div class="small muted">배정 좌석 (무작위)</div><div class="big">${seatTxt}</div></div>
          <span style="flex:1"></span>
          <button type="button" class="sm" id="btnReroll" ${tables.length ? '' : 'disabled'}>🎲 다시 뽑기</button>
          <button type="button" class="sm ${ui.regPick ? 'warn' : 'ghost'}" id="btnPick" ${tables.length ? '' : 'disabled'}>${ui.regPick ? '선택 중… (아래 좌석 탭)' : '직접 선택'}</button>
        </div>
        <div class="row">
          <button type="submit" class="primary" data-print="1">등록 + 확인증 인쇄</button>
          <button type="submit" class="ghost" data-print="0">등록만</button>
        </div>
      </form>
    </div>
    <div class="card flat" style="padding:0">
      <div class="row tight" style="margin-bottom:8px"><h3 style="margin:0">테이블 현황</h3><span class="muted small">체크박스 = 좌석 사용 여부</span><span style="flex:1"></span><button class="sm ghost" id="btnOpenTableReg">＋ 새 테이블</button></div>
      <div class="tables-grid" id="regTables">${tables.map(t => seatMapHtml(s, t, 'reg')).join('') || '<div class="muted">오픈된 테이블이 없습니다. 첫 등록 시 자동으로 열립니다.</div>'}</div>
    </div>
    <div class="card">
      <h3>최근 등록 <span class="muted small">(${L.eventPlayers(s, ev.id).length}명)</span></h3>
      <div class="list">${recent.map(p => `<div class="list-item"><span class="rank">#${p.entryNo}</span><div class="grow"><div class="t">${h(p.name)} ${p.status === 'busted' ? `<span class="muted small">탈락 ${p.finishRank}위</span>` : `<span class="muted small">${tableName(s, p.tableId)} S${p.seat}</span>`}</div><div class="s">${Print.fmtTime(p.registeredAt)} · ${Print.fmtMoney(p.buyIn)}원${p.memo ? ' · ' + h(p.memo) : ''}</div></div>
        <button class="sm ghost" data-reprint="${p.id}">⎙</button><button class="sm ghost" data-cancelreg="${p.id}">취소</button></div>`).join('') || '<div class="muted">아직 등록이 없습니다.</div>'}</div>
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
      ui.regForm = { name: '', phone: '', buyIn: '', memo: '' }; ui.regSeat = null; ui.regPick = false;
      render();
      if (printFlag && st.settings.autoPrintOnRegister !== false) printConfirm(p.id);
      const n = $('#regForm input[name=name]'); if (n) n.focus();
    });
    $('#btnReroll', root).addEventListener('click', () => { ui.regSeat = L.pickSeat(S(), curEvent().id); ui.regPick = false; render(); });
    $('#btnPick', root).addEventListener('click', () => { ui.regPick = !ui.regPick; render(); });
    $('#btnOpenTableReg', root).addEventListener('click', () => { Store.commit('새 테이블 오픈', st => { L.openTable(st, curEvent().id); }); toast('새 테이블을 열었습니다'); });
    $$('.seat.pick', root).forEach(el => el.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      ui.regSeat = { tableId: el.dataset.table, seat: +el.dataset.seat }; ui.regPick = false; render();
    }));
    $$('[data-reprint]', root).forEach(b => b.addEventListener('click', () => printConfirm(b.dataset.reprint)));
    $$('[data-cancelreg]', root).forEach(b => b.addEventListener('click', () => {
      const p = L.playerOf(S(), b.dataset.cancelreg);
      if (confirm(`#${p.entryNo} ${p.name} 등록을 취소(삭제)할까요?`)) { Store.commit('등록 취소: ' + p.name, st => L.cancelRegistration(st, p.id)); toast('등록 취소됨 (되돌리기 가능)'); }
    }));
    bindSeatToggles(root);
  }
  function printConfirm(playerId) {
    const s = S(); const p = L.playerOf(s, playerId); if (!p) return;
    const ev = L.eventOf(s, p.eventId); const t = L.tableOf(s, p.tableId);
    const tpl = s.templates.confirm;
    Print.print(Print.confirmHtml(tpl, { player: p, event: ev, table: t }), tpl.paper);
  }

  /* ---------- 테이블 탭 ---------- */
  function viewTables() {
    const s = S(); const ev = curEvent();
    if (!ev) return noEventHtml();
    const info = L.balanceInfo(s, ev.id);
    const tables = (ui.showClosed ? L.allTables(s, ev.id) : L.openTables(s, ev.id));
    const busted = L.bustedPlayers(s, ev.id);
    let banner = '';
    if (ui.moveMode) {
      const p = L.playerOf(s, ui.moveMode.playerId);
      banner = `<div class="banner warn"><span class="grow">🔀 <b>${h(p ? p.name : '')}</b> 이동 중 — 목적지 좌석을 탭하세요 (플레이어가 있으면 자리 교환)</span><button class="sm" id="btnCancelMove">취소</button></div>`;
    } else if (info.need) {
      banner = `<div class="banner bad"><span class="grow">⚖ 테이블 인원 편차 ${info.max - info.min} (최소 ${info.min} / 최대 ${info.max}) — 밸런싱이 필요합니다</span><button class="sm warn" id="btnAutoBalance">자동 밸런싱</button></div>`;
    } else if (info.canBreak) {
      banner = `<div class="banner warn"><span class="grow">T${info.breakTable.number}을(를) 브레이크해도 전원 수용 가능합니다 (남은 ${info.active}명)</span><button class="sm" data-close="${info.breakTable.id}">T${info.breakTable.number} 브레이크</button></div>`;
    } else if (tables.length) {
      banner = `<div class="banner ok"><span class="grow">테이블 균형 양호 · 남은 ${info.active}명 / ${L.openTables(s, ev.id).length}테이블</span></div>`;
    }
    return `${banner}
    <div class="row tight" style="margin-bottom:12px">
      <button class="primary sm" id="btnOpenTable">＋ 새 테이블</button>
      <button class="sm" id="btnAutoBalance2" ${info.need ? '' : 'disabled'}>⚖ 자동 밸런싱</button>
      <label class="small muted" style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="chkClosed" ${ui.showClosed ? 'checked' : ''} style="width:auto">닫힌 테이블 표시</label>
    </div>
    <div class="tables-grid" id="tables">${tables.map(t => seatMapHtml(s, t, 'tables')).join('') || '<div class="muted card">테이블이 없습니다. 새 테이블을 열어주세요.</div>'}</div>
    <div class="card" style="margin-top:12px">
      <div class="row tight"><h3 style="margin:0">탈락자 (${busted.length})</h3><span style="flex:1"></span><button class="sm ghost" id="btnToggleBusted">${ui.showBusted ? '접기' : '펼치기'}</button></div>
      ${ui.showBusted ? `<div class="list" style="margin-top:8px">${busted.map(p => `<div class="list-item"><span class="rank">${p.finishRank}위</span><div class="grow"><div class="t">${h(p.name)} <span class="muted small">#${p.entryNo}</span></div><div class="s">${Print.fmtTime(p.bustedAt)}</div></div><button class="sm ghost" data-voucher="${p.id}">바우처</button><button class="sm ghost" data-unbust="${p.id}">복구</button></div>`).join('') || '<div class="muted small">아직 탈락자가 없습니다.</div>'}</div>` : ''}
    </div>`;
  }
  function bindTables(root) {
    if (!curEvent()) { bindNoEvent(root); return; }
    const ev = curEvent();
    $('#btnOpenTable', root).addEventListener('click', () => { Store.commit('새 테이블 오픈', st => { L.openTable(st, ev.id); }); toast('새 테이블을 열었습니다 (되돌리기 가능)'); });
    $('#chkClosed', root).addEventListener('change', (e) => { ui.showClosed = e.target.checked; render(); });
    $('#btnToggleBusted', root).addEventListener('click', () => { ui.showBusted = !ui.showBusted; render(); });
    const cancelMove = $('#btnCancelMove', root); if (cancelMove) cancelMove.addEventListener('click', () => { ui.moveMode = null; render(); });
    ['#btnAutoBalance', '#btnAutoBalance2'].forEach(id => { const b = $(id, root); if (b) b.addEventListener('click', doAutoBalance); });
    $$('[data-close]', root).forEach(b => b.addEventListener('click', () => doCloseTable(b.dataset.close)));
    $$('[data-reopen]', root).forEach(b => b.addEventListener('click', () => { Store.commit('테이블 다시 열기', st => L.reopenTable(st, b.dataset.reopen)); toast('테이블을 다시 열었습니다'); }));
    $$('[data-deltable]', root).forEach(b => b.addEventListener('click', () => { const r = Store.commit('테이블 삭제', st => L.deleteTable(st, b.dataset.deltable)); if (r && r.error) toast(r.error); }));
    $$('[data-unbust]', root).forEach(b => b.addEventListener('click', () => {
      const p = L.playerOf(S(), b.dataset.unbust); let r;
      Store.commit('탈락 복구: ' + p.name, st => { r = L.unbust(st, p.id); if (r.error) return false; });
      if (r.error) toast(r.error); else toast(`${p.name} 복구 → ${tableName(S(), r.tableId)} S${r.seat}`);
    }));
    $$('[data-voucher]', root).forEach(b => b.addEventListener('click', () => { ui.voucherForm = { playerId: b.dataset.voucher, amount: '', note: '' }; ui.printTab = 'voucher-issue'; location.hash = '#print'; }));
    $$('.seat', root).forEach(el => el.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const tid = el.dataset.table, seat = +el.dataset.seat, pid = el.dataset.player;
      if (ui.moveMode) {
        if (el.classList.contains('off')) { toast('사용 안하는 좌석입니다'); return; }
        const mover = L.playerOf(S(), ui.moveMode.playerId); let r;
        Store.commit('이동: ' + mover.name, st => { r = L.movePlayer(st, mover.id, tid, seat); if (r.error) return false; });
        if (r.error) { toast(r.error); return; }
        ui.moveMode = null; render();
        toast(r.swapped ? `${mover.name} ↔ ${r.swapped.name} 자리 교환` : `${mover.name} → ${tableName(S(), tid)} S${seat}`);
        return;
      }
      if (pid) playerSheet(pid);
    }));
    bindSeatToggles(root);
  }
  function playerSheet(pid) {
    const s = S(); const p = L.playerOf(s, pid); if (!p) return;
    sheet(`#${p.entryNo} ${p.name} · ${tableName(s, p.tableId)} S${p.seat}`, [
      { label: '🔀 이동 / 자리 교환', fn: () => { ui.moveMode = { playerId: pid }; render(); } },
      { label: '💀 버스트아웃 (탈락 처리)', cls: 'danger', fn: () => {
          let r; Store.commit('탈락: ' + p.name, st => { r = L.bustOut(st, pid); if (r.error) return false; });
          if (r.error) toast(r.error); else toast(`${p.name} 탈락 · 최종 ${r.rank}위 (되돌리기 가능)`);
        } },
      { label: '⎙ 참가확인증 재인쇄', fn: () => printConfirm(pid) },
      { label: '✎ 이름/메모 수정', fn: () => {
          const name = prompt('이름', p.name); if (name === null) return;
          const memo = prompt('메모', p.memo || ''); if (memo === null) return;
          Store.commit('정보 수정: ' + p.name, st => { const x = L.playerOf(st, pid); x.name = name.trim() || x.name; x.memo = memo.trim(); });
        } },
    ], `<div class="muted small" style="margin-bottom:10px">바이인 ${Print.fmtMoney(p.buyIn)}원${p.phone ? ' · ' + h(p.phone) : ''}${p.memo ? ' · ' + h(p.memo) : ''} · ${Print.fmtTime(p.registeredAt)} 등록</div>`);
  }
  function doCloseTable(tid) {
    const s = S(); const t = L.tableOf(s, tid); const n = L.tablePlayers(s, tid).length;
    if (!confirm(`T${t.number} 브레이크: ${n}명을 다른 테이블 빈 좌석에 무작위 배치하고 테이블을 닫습니다. 진행할까요?\n(상단 ↶ 로 되돌릴 수 있습니다)`)) return;
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
    const body = `<div class="list" style="margin-bottom:12px">${moves.map(m => `<div class="list-item"><div class="grow"><div class="t">${h(m.player.name)}</div><div class="s">${tableName(s, m.from.tableId)} S${m.from.seat} → <b>${tableName(s, m.to.tableId)} S${m.to.seat}</b></div></div></div>`).join('')}</div>`;
    sheet(title + ` (${moves.length}명 이동)`, [{ label: '↶ 되돌리기', cls: 'ghost', fn: () => { Store.undo(); toast('되돌렸습니다'); } }], body);
  }

  /* ---------- 이벤트 탭 ---------- */
  function viewEvents() {
    const s = S();
    const list = s.events.map(e => {
      const all = L.eventPlayers(s, e.id), act = all.filter(p => p.status === 'active');
      const pool = all.reduce((n, p) => n + (p.buyIn || 0), 0);
      return `<div class="list-item ${e.id === s.selectedEventId ? 'selected' : ''}" style="${e.id === s.selectedEventId ? 'outline:2px solid var(--accent)' : ''}">
        <div class="grow" data-selevent="${e.id}" style="cursor:pointer"><div class="t">${h(e.name)} ${e.status === 'closed' ? '<span class="chip">종료</span>' : ''}</div>
        <div class="s">바이인 ${Print.fmtMoney(e.buyIn)}원 · ${e.seats}인 테이블 · 참가 ${all.length} / 남은 ${act.length} / 테이블 ${L.openTables(s, e.id).length} · 총 바이인 ${Print.fmtMoney(pool)}원</div></div>
        <button class="sm ghost" data-editevent="${e.id}">수정</button></div>`;
    }).join('');
    const ed = ui.eventEdit ? (ui.eventEdit === 'new' ? { name: '', buyIn: '', seats: s.settings.defaultSeats, startChips: '', memo: '', status: 'open' } : L.eventOf(s, ui.eventEdit)) : null;
    return `
    <div class="card"><div class="row tight"><h2 style="margin:0">이벤트</h2><span style="flex:1"></span><button class="primary sm" id="btnNewEvent">＋ 새 이벤트</button></div>
      <div class="list" style="margin-top:10px">${list || '<div class="muted">이벤트가 없습니다. 새 이벤트를 만들어 시작하세요.</div>'}</div></div>
    ${ed ? `<div class="card"><h3>${ui.eventEdit === 'new' ? '새 이벤트' : '이벤트 수정'}</h3>
      <form id="eventForm">
        <label class="field"><span>이벤트 이름 *</span><input name="name" value="${h(ed.name)}" required placeholder="예: Main Event Day 1A"></label>
        <div class="row">
          <label class="field"><span>바이인 (원)</span><input name="buyIn" type="number" value="${h(ed.buyIn)}"></label>
          <label class="field"><span>테이블당 좌석</span><input name="seats" type="number" min="2" max="12" value="${h(ed.seats)}"></label>
          <label class="field"><span>스타팅 칩</span><input name="startChips" type="number" value="${h(ed.startChips || '')}"></label>
        </div>
        <label class="field"><span>메모</span><input name="memo" value="${h(ed.memo || '')}"></label>
        ${ui.eventEdit !== 'new' ? `<label class="field"><span>상태</span><select name="status"><option value="open" ${ed.status === 'open' ? 'selected' : ''}>진행 중</option><option value="closed" ${ed.status === 'closed' ? 'selected' : ''}>종료</option></select></label>` : ''}
        <div class="row"><button type="submit" class="primary">저장</button><button type="button" class="ghost" id="btnCancelEvent">취소</button>${ui.eventEdit !== 'new' ? `<button type="button" class="danger" id="btnDeleteEvent">삭제</button>` : ''}</div>
      </form></div>` : ''}`;
  }
  function bindEvents(root) {
    $('#btnNewEvent', root).addEventListener('click', () => { ui.eventEdit = 'new'; render(); setTimeout(() => { const i = $('#eventForm input[name=name]'); if (i) i.focus(); }, 0); });
    $$('[data-selevent]', root).forEach(el => el.addEventListener('click', () => { Store.patch(st => st.selectedEventId = el.dataset.selevent); ui.regSeat = null; ui.moveMode = null; }));
    $$('[data-editevent]', root).forEach(b => b.addEventListener('click', () => { ui.eventEdit = b.dataset.editevent; render(); }));
    const form = $('#eventForm', root); if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault(); const fd = new FormData(form); const data = Object.fromEntries(fd.entries());
      if (ui.eventEdit === 'new') { let ev; Store.commit('이벤트 생성: ' + data.name, st => { ev = L.createEvent(st, data); st.selectedEventId = ev.id; }); toast('이벤트 생성됨'); }
      else { Store.commit('이벤트 수정', st => L.updateEvent(st, ui.eventEdit, data)); toast('저장됨'); }
      ui.eventEdit = null; render();
    });
    $('#btnCancelEvent', root).addEventListener('click', () => { ui.eventEdit = null; render(); });
    const del = $('#btnDeleteEvent', root); if (del) del.addEventListener('click', () => {
      const ev = L.eventOf(S(), ui.eventEdit); const n = L.eventPlayers(S(), ev.id).length;
      if (!confirm(`"${ev.name}" 이벤트와 참가자 ${n}명, 테이블 정보를 모두 삭제할까요?\n(↶ 되돌리기 가능)`)) return;
      Store.commit('이벤트 삭제: ' + ev.name, st => L.deleteEvent(st, ev.id)); ui.eventEdit = null; render(); toast('이벤트 삭제됨');
    });
  }
  function noEventHtml() { return `<div class="card"><h2>이벤트가 없습니다</h2><p class="muted">먼저 이벤트를 만들어야 등록과 테이블 관리를 할 수 있습니다.</p><button class="primary" id="btnGoEvents">이벤트 만들기</button></div>`; }
  function bindNoEvent(root) { const b = $('#btnGoEvents', root); if (b) b.addEventListener('click', () => { ui.eventEdit = 'new'; location.hash = '#events'; }); }

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
      <div class="row tight small" style="margin-bottom:10px">${fields.map(([k, lb]) => `<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" name="${k}" ${tpl[k] ? 'checked' : ''} style="width:auto">${lb}</label>`).join('')}</div>
      <button type="button" class="sm" data-testprint="${kind}">⎙ 테스트 인쇄</button>
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
        const opts = busted.map(p => `<option value="${p.id}" ${ui.voucherForm.playerId === p.id ? 'selected' : ''}>${p.finishRank}위 · ${h(p.name)} (#${p.entryNo})</option>`).join('') +
          active.map(p => `<option value="${p.id}" ${ui.voucherForm.playerId === p.id ? 'selected' : ''}>진행중 · ${h(p.name)} (#${p.entryNo})</option>`).join('');
        const vs = (s.vouchers || []).filter(v => v.eventId === ev.id).sort((a, b) => b.issuedAt - a.issuedAt);
        body = `<div class="card"><h3>바우처 발행 · ${h(ev.name)}</h3>
          <form id="voucherForm">
            <label class="field"><span>수령인</span><select name="playerId"><option value="">직접 입력</option>${opts}</select></label>
            <label class="field" id="manualNameWrap" style="${ui.voucherForm.playerId ? 'display:none' : ''}"><span>이름 (직접 입력)</span><input name="manualName" placeholder="수령인 이름"></label>
            <div class="row"><label class="field"><span>상금 (원) *</span><input name="amount" type="number" required value="${h(ui.voucherForm.amount)}"></label><label class="field"><span>비고</span><input name="note" value="${h(ui.voucherForm.note)}" placeholder="예: 딜 합의"></label></div>
            <button type="submit" class="primary">발행 + 인쇄</button>
          </form></div>
          <div class="card"><h3>발행 내역 (${vs.length})</h3><div class="list">${vs.map(v => `<div class="list-item"><span class="rank">${v.serial}</span><div class="grow"><div class="t">${h(v.playerName)} ${v.rank ? `<span class="muted small">${v.rank}위</span>` : ''}</div><div class="s">${Print.fmtMoney(v.amount)}원 · ${Print.fmtTime(v.issuedAt)}</div></div><button class="sm ghost" data-revoucher="${v.id}">⎙</button></div>`).join('') || '<div class="muted small">발행된 바우처가 없습니다.</div>'}</div></div>`;
      }
    } else {
      body = `<div class="card"><h3>설정</h3>
        <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input type="checkbox" id="setAutoPrint" ${s.settings.autoPrintOnRegister !== false ? 'checked' : ''} style="width:auto">등록 시 참가확인증 자동 인쇄</label>
        <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input type="checkbox" id="setAutoOpen" ${s.settings.autoOpenTable !== false ? 'checked' : ''} style="width:auto">빈 좌석이 없으면 새 테이블 자동 오픈</label>
        <label class="field"><span>새 이벤트 기본 좌석 수</span><input type="number" id="setSeats" value="${s.settings.defaultSeats}" min="2" max="12"></label></div>
        <div class="card"><h3>데이터</h3><p class="muted small">데이터는 이 브라우저(localStorage)에만 저장됩니다. 다른 기기로 옮기려면 내보내기/가져오기를 사용하세요.</p>
        <div class="row"><button id="btnExport">⬇ 내보내기 (JSON)</button><button id="btnImport">⬆ 가져오기</button><input type="file" id="importFile" accept="application/json" class="hidden"></div>
        <div style="margin-top:10px"><button class="danger sm" id="btnReset">전체 초기화</button></div></div>`;
    }
    return `<div class="row tight" style="margin-bottom:12px">${tabs.map(([k, lb]) => `<button class="sm ${ui.printTab === k ? 'primary' : 'ghost'}" data-ptab="${k}">${lb}</button>`).join('')}</div>${body}`;
  }
  function bindPrint(root) {
    $$('[data-ptab]', root).forEach(b => b.addEventListener('click', () => { ui.printTab = b.dataset.ptab; render(); }));
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
      vf.playerId.addEventListener('change', () => { $('#manualNameWrap').style.display = vf.playerId.value ? 'none' : ''; });
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
    }
    const ap = $('#setAutoPrint', root);
    if (ap) {
      ap.addEventListener('change', () => Store.patch(st => st.settings.autoPrintOnRegister = ap.checked));
      $('#setAutoOpen', root).addEventListener('change', (e) => Store.patch(st => st.settings.autoOpenTable = e.target.checked));
      $('#setSeats', root).addEventListener('change', (e) => Store.patch(st => st.settings.defaultSeats = +e.target.value || 9));
      $('#btnExport', root).addEventListener('click', () => {
        const blob = new Blob([Store.exportJSON()], { type: 'application/json' }); const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'holdem-td-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
      });
      $('#btnImport', root).addEventListener('click', () => $('#importFile').click());
      $('#importFile', root).addEventListener('change', (e) => {
        const f = e.target.files[0]; if (!f) return; const r = new FileReader();
        r.onload = () => { try { Store.importJSON(r.result); toast('가져오기 완료'); } catch (err) { toast('가져오기 실패: ' + err.message); } };
        r.readAsText(f);
      });
      $('#btnReset', root).addEventListener('click', () => { if (confirm('모든 이벤트/참가자/테이블/바우처를 삭제합니다. 계속할까요?') && confirm('정말로 초기화할까요? (↶ 로 1회 되돌리기 가능)')) { Store.reset(); toast('초기화됨'); } });
    }
  }
  function printVoucher(id) {
    const s = S(); const v = (s.vouchers || []).find(x => x.id === id); if (!v) return;
    const tpl = s.templates.voucher; Print.print(Print.voucherHtml(tpl, { voucher: v, event: L.eventOf(s, v.eventId) }), tpl.paper);
  }

  /* ---------- 렌더 루프 ---------- */
  const VIEWS = { reg: [viewReg, bindReg], tables: [viewTables, bindTables], events: [viewEvents, bindEvents], print: [viewPrint, bindPrint] };
  function render() {
    renderTop();
    const v = VIEWS[ui.tab] || VIEWS.reg;
    const root = $('#view'); root.innerHTML = v[0](); v[1](root);
    $$('#tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === ui.tab));
  }
  function init() {
    Store.subscribe(render);
    window.addEventListener('hashchange', () => { ui.tab = (location.hash || '#reg').slice(1); ui.moveMode = null; render(); });
    $('#eventSelect').addEventListener('change', (e) => { Store.patch(st => st.selectedEventId = e.target.value || null); ui.regSeat = null; ui.moveMode = null; });
    $('#btnUndo').addEventListener('click', () => { const l = Store.undo(); if (l) toast('되돌림: ' + l); });
    $('#btnRedo').addEventListener('click', () => { const l = Store.redo(); if (l) toast('다시 실행: ' + l); });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); e.shiftKey ? Store.redo() : Store.undo(); }
    });
    if (!S().selectedEventId && S().events.length) Store.patch(st => st.selectedEventId = st.events[0].id);
    render();
  }
  return { init, ui };
})();
document.addEventListener('DOMContentLoaded', App.init);
