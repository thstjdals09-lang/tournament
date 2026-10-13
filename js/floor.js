/* 플로어 운영 로직: 토너먼트 클락(이벤트별 블라인드 구조) + 딜러 관리(현장 공통) */
const Floor = (() => {
  /* ---------- 블라인드 구조 / 클락 ---------- */
  const DEF = [[100,200,200],[200,300,300],[200,400,400],[300,600,600],[400,800,800],'B',[500,1000,1000],[600,1200,1200],[800,1600,1600],[1000,2000,2000],[1200,2400,2400],'B',[1500,3000,3000],[2000,4000,4000],[2500,5000,5000],[3000,6000,6000],[4000,8000,8000],'B',[5000,10000,10000],[6000,12000,12000],[8000,16000,16000],[10000,20000,20000],[15000,30000,30000],[20000,40000,40000],[25000,50000,50000],[30000,60000,60000]];
  const defaultLevels = () => DEF.map(l => l === 'B' ? { brk: true, min: 10 } : { sb: l[0], bb: l[1], ante: l[2], min: 20 });

  const levels = (ev) => (ev.levels && ev.levels.length) ? ev.levels : defaultLevels();
  /** 저장된 클락이 없으면 레벨 1 정지 상태 */
  const clockOf = (ev) => ev.clock || { idx: 0, running: false, remain: levels(ev)[0].min * 60000, anchor: null };
  /** 클락을 바꾸기 전에 호출: 이벤트에 levels/clock 필드를 실제로 만든다 */
  function ensure(ev) {
    if (!ev.levels || !ev.levels.length) ev.levels = defaultLevels();
    if (!ev.clock) ev.clock = clockOf(ev);
    return ev.clock;
  }
  const remain = (c) => c.running ? c.remain - (Date.now() - c.anchor) : c.remain;

  /** 브레이크를 뺀 레벨 번호 (브레이크 중이면 직전 레벨 번호) */
  function levelNo(ev, i) { const lv = levels(ev); let n = 0; for (let k = 0; k <= i && k < lv.length; k++) if (!lv[k].brk) n++; return n; }
  const levelLabel = (ev, i) => levels(ev)[i] && levels(ev)[i].brk ? '브레이크' : '레벨 ' + levelNo(ev, i);
  const fmt = (n) => (n || 0).toLocaleString('ko-KR');
  const blindText = (l) => !l ? '-' : l.brk ? '휴식 ' + l.min + '분' : `${fmt(l.sb)} / ${fmt(l.bb)}` + (l.ante ? ` (${fmt(l.ante)})` : '');
  function mmss(ms) {
    ms = Math.max(0, ms); const s = Math.ceil(ms / 1000);
    const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60, z = (n) => String(n).padStart(2, '0');
    return (hh ? hh + ':' + z(m) : z(m)) + ':' + z(ss);
  }
  /** 현재(또는 직전) 플레이 레벨의 빅블라인드 */
  function currentBB(ev) { const lv = levels(ev); for (let i = clockOf(ev).idx; i >= 0; i--) if (!lv[i].brk) return lv[i].bb; return 1; }
  /** 다음 브레이크까지 남은 ms (브레이크 중이거나 남은 브레이크가 없으면 null) */
  function breakIn(ev) {
    const lv = levels(ev), c = clockOf(ev);
    if (lv[c.idx] && lv[c.idx].brk) return null;
    let ms = remain(c);
    for (let i = c.idx + 1; i < lv.length; i++) { if (lv[i].brk) return ms; ms += lv[i].min * 60000; }
    return null;
  }
  /** 레이트 레지: lateRegLevel(레벨 번호) 이 끝날 때 마감. 0 이면 설정 안 함 */
  function lateRegOpen(ev) { if (!ev.lateRegLevel) return null; return levelNo(ev, clockOf(ev).idx) <= ev.lateRegLevel; }

  function start(ev) { const c = ensure(ev); if (c.running) return; c.running = true; c.anchor = Date.now(); }
  function pause(ev) { const c = ensure(ev); if (!c.running) return; c.remain = remain(c); c.running = false; c.anchor = null; }
  function setLevel(ev, idx) {
    const c = ensure(ev); idx = Math.max(0, Math.min(ev.levels.length - 1, idx));
    c.idx = idx; c.remain = ev.levels[idx].min * 60000; c.anchor = c.running ? Date.now() : null;
  }
  function addTime(ev, ms) { const c = ensure(ev); c.remain = Math.max(0, remain(c) + ms); if (c.running) c.anchor = Date.now(); }
  /** 시간이 다 된 레벨을 넘긴다. 레벨이 바뀌었으면 true */
  function advance(ev) {
    const c = ev.clock; if (!c || !c.running) return false;
    let r = remain(c), changed = false;
    while (r <= 0 && c.idx < ev.levels.length - 1) {
      const over = -r; c.idx++; c.remain = ev.levels[c.idx].min * 60000 - over; c.anchor = Date.now(); r = c.remain; changed = true;
    }
    if (r <= 0) { c.remain = 0; c.running = false; c.anchor = null; changed = true; }
    return changed;
  }

  /* ---------- 딜러 (현장 공통, 테이블 id 로 배정) ---------- */
  const dealers = (s) => s.dealers || (s.dealers = []);
  const cfg = (s) => s.dealerCfg || (s.dealerCfg = { pushMin: 30, lastPush: null, autoAssign: true });
  const dealerAt = (s, tableId) => (s.dealers || []).find(d => d.status === 'working' && d.tableId === tableId) || null;
  /** 현장의 모든 오픈 테이블 (이벤트 무관, 번호순) */
  const floorTables = (s) => s.tables.filter(t => t.status === 'open').sort((a, b) => a.number - b.number);
  const workedMs = (d) => (d.workMs || 0) + (d.status === 'working' ? Date.now() - d.workStart : 0);

  function addDealer(s, name) { const d = { id: Store.uid(), name, status: 'break', tableId: null, since: Date.now(), workMs: 0, workStart: null }; dealers(s).push(d); return d; }
  function assign(s, d, tableId) {
    const cur = dealerAt(s, tableId); if (cur && cur !== d) release(s, cur, 'break');
    if (d.status !== 'working') d.workStart = Date.now();
    d.status = 'working'; d.tableId = tableId; d.since = Date.now();
  }
  function release(s, d, status) {
    if (d.status === 'working') d.workMs = (d.workMs || 0) + (Date.now() - d.workStart);
    d.status = status; d.tableId = null; d.since = Date.now();
  }
  /** 닫힌 테이블에 남은 딜러는 휴식으로 */
  function releaseClosed(s) { (s.dealers || []).forEach(d => { if (d.status === 'working') { const t = s.tables.find(x => x.id === d.tableId); if (!t || t.status !== 'open') release(s, d, 'break'); } }); }
  /**
   * 푸시: 가장 오래 쉰 딜러부터 첫 테이블에 들어가고, 앉아 있던 딜러는 한 테이블씩 뒤로 밀린다.
   * 테이블 수보다 남는 딜러(맨 뒤 테이블에서 밀려난 딜러)는 휴식.
   */
  function push(s) {
    releaseClosed(s);
    const ts = floorTables(s);
    const rested = dealers(s).filter(d => d.status === 'break').sort((a, b) => a.since - b.since);
    const seq = rested.concat(ts.map(t => dealerAt(s, t.id)).filter(Boolean));
    const moves = [];
    seq.slice(ts.length).forEach(d => { release(s, d, 'break'); moves.push({ dealer: d, to: null }); });
    ts.forEach((t, i) => { const d = seq[i]; if (d) { assign(s, d, t.id); moves.push({ dealer: d, to: t }); } });
    cfg(s).lastPush = Date.now();
    return moves;
  }
  /**
   * 테이블이 열릴 때 딜러 자동 배치: 그 테이블에 딜러가 없으면 가장 오래 쉰 딜러를 앉힌다.
   * dealer-director(DD) 의 배치 규칙으로 바꿀 때는 이 함수만 교체하면 된다.
   */
  function autoAssign(s, table) {
    if (cfg(s).autoAssign === false || !table || table.status !== 'open' || dealerAt(s, table.id)) return null;
    const d = dealers(s).filter(x => x.status === 'break').sort((a, b) => a.since - b.since)[0];
    if (!d) return null;
    assign(s, d, table.id); return d;
  }
  const nextPushIn = (s) => cfg(s).lastPush ? cfg(s).lastPush + cfg(s).pushMin * 60000 - Date.now() : null;

  return { defaultLevels, levels, clockOf, ensure, remain, levelNo, levelLabel, blindText, mmss, currentBB, breakIn, lateRegOpen, start, pause, setLevel, addTime, advance,
    dealers, cfg, dealerAt, floorTables, workedMs, addDealer, assign, release, releaseClosed, push, nextPushIn, autoAssign };
})();
