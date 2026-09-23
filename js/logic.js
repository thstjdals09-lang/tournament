/* 도메인 로직: 이벤트/플레이어/테이블/좌석 배정/밸런싱 (모두 Store.commit 안에서 호출) */
const Logic = (() => {
  const rand = (n) => Math.floor(Math.random() * n);
  const pick = (arr) => arr[rand(arr.length)];
  const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); const tmp = a[i]; a[i] = a[j]; a[j] = tmp; } return a; };

  /* ---------- 조회 ---------- */
  const eventOf = (s, id) => s.events.find(e => e.id === id);
  const tableOf = (s, id) => s.tables.find(t => t.id === id);
  const playerOf = (s, id) => s.players.find(p => p.id === id);
  const openTables = (s, eventId) => s.tables.filter(t => t.eventId === eventId && t.status === 'open').sort((a, b) => a.number - b.number);
  const allTables = (s, eventId) => s.tables.filter(t => t.eventId === eventId).sort((a, b) => a.number - b.number);
  const eventPlayers = (s, eventId) => s.players.filter(p => p.eventId === eventId);
  const activePlayers = (s, eventId) => eventPlayers(s, eventId).filter(p => p.status === 'active');
  const bustedPlayers = (s, eventId) => eventPlayers(s, eventId).filter(p => p.status === 'busted').sort((a, b) => a.finishRank - b.finishRank);
  const tablePlayers = (s, tableId) => s.players.filter(p => p.tableId === tableId && p.status === 'active');
  const seatPlayer = (s, tableId, seat) => s.players.find(p => p.tableId === tableId && p.seat === seat && p.status === 'active');

  function emptySeats(s, table) {
    const taken = new Set(tablePlayers(s, table.id).map(p => p.seat));
    const off = new Set(table.disabledSeats || []);
    const out = [];
    for (let i = 1; i <= table.seats; i++) if (!taken.has(i) && !off.has(i)) out.push(i);
    return out;
  }
  const usableSeats = (t) => t.seats - (t.disabledSeats || []).length;

  /* ---------- 이벤트 ---------- */
  function createEvent(s, data) {
    const ev = {
      id: Store.uid(), name: data.name || '새 이벤트', buyIn: +data.buyIn || 0,
      seats: +data.seats || s.settings.defaultSeats || 9, startChips: +data.startChips || 0,
      status: 'open', createdAt: Date.now(), nextEntryNo: 1, memo: data.memo || '',
      tableStart: +data.tableStart || 1, tableEnd: +data.tableEnd || 0, rakePct: +data.rakePct || 0, prizePool: +data.prizePool || 0, payouts: Array.isArray(data.payouts) ? data.payouts : []
    };
    s.events.push(ev);
    if (!s.selectedEventId) s.selectedEventId = ev.id;
    return ev;
  }
  function updateEvent(s, id, data) {
    const ev = eventOf(s, id); if (!ev) return false;
    Object.assign(ev, data);
    if (data.seats !== undefined) ev.seats = +data.seats;
    if (data.buyIn !== undefined) ev.buyIn = +data.buyIn;
    if (data.startChips !== undefined) ev.startChips = +data.startChips;
    if (data.tableStart !== undefined) ev.tableStart = +data.tableStart || 1;
    if (data.tableEnd !== undefined) ev.tableEnd = +data.tableEnd || 0;
    if (data.rakePct !== undefined) ev.rakePct = +data.rakePct || 0;
    if (data.prizePool !== undefined) ev.prizePool = +data.prizePool || 0;
  }
  function deleteEvent(s, id) {
    s.events = s.events.filter(e => e.id !== id);
    s.players = s.players.filter(p => p.eventId !== id);
    s.tables = s.tables.filter(t => t.eventId !== id);
    if (s.selectedEventId === id) s.selectedEventId = s.events.length ? s.events[0].id : null;
  }

  /* ---------- 테이블 ---------- */
  /** 현장 전체에서 오픈 상태인 테이블 번호(이벤트 무관, 물리 테이블 충돌 방지) */
  const usedTableNumbers = (s) => new Set(s.tables.filter(t => t.status === 'open').map(t => t.number));
  /** 이벤트 범위(tableStart~tableEnd) 안에서 비어있는 가장 작은 번호 */
  function nextTableNumber(s, ev) {
    const used = usedTableNumbers(s);
    const start = ev.tableStart || 1, end = ev.tableEnd || 999;
    for (let n = start; n <= end; n++) if (!used.has(n)) return n;
    return null;
  }
  function openTable(s, eventId, opts) {
    opts = opts || {};
    const ev = eventOf(s, eventId); if (!ev) return { error: '이벤트 없음' };
    let number = +opts.number || 0;
    if (number) { if (usedTableNumbers(s).has(number)) return { error: 'T' + number + '은(는) 이미 사용 중입니다' }; }
    else { number = nextTableNumber(s, ev); if (!number) return { error: '테이블 번호 범위(' + (ev.tableStart || 1) + '~' + (ev.tableEnd || '∞') + ')에 빈 번호가 없습니다' }; }
    const t = { id: Store.uid(), eventId, number, seats: +opts.seats || ev.seats, disabledSeats: [], enabled: true, status: 'open', openedAt: Date.now() };
    s.tables.push(t); return t;
  }
  /** 테이블 사용/미사용: 미사용이면 새 배정 대상에서 제외(앉아있는 사람은 유지) */
  function toggleTable(s, tableId) { const t = tableOf(s, tableId); if (!t) return false; t.enabled = t.enabled === false; }
  const tableUsable = (t) => t.status === 'open' && t.enabled !== false;
  function toggleSeat(s, tableId, seat) {
    const t = tableOf(s, tableId); if (!t) return false;
    if (seatPlayer(s, tableId, seat)) return { error: '플레이어가 앉아있는 좌석은 비활성화할 수 없습니다' };
    const set = new Set(t.disabledSeats || []);
    if (set.has(seat)) set.delete(seat); else set.add(seat);
    t.disabledSeats = Array.from(set).sort((a, b) => a - b);
  }
  /** 테이블 브레이크: 앉아있던 플레이어를 다른 오픈 테이블 빈 좌석에 무작위·균형 분산 */
  function closeTable(s, tableId) {
    const t = tableOf(s, tableId); if (!t || t.status !== 'open') return { error: '이미 닫힌 테이블' };
    const movers = shuffle(tablePlayers(s, tableId));
    const others = openTables(s, t.eventId).filter(x => x.id !== tableId && tableUsable(x));
    const capacity = others.reduce((n, x) => n + emptySeats(s, x).length, 0);
    if (movers.length > capacity) return { error: '빈 좌석 부족 (이동 ' + movers.length + '명 / 빈좌석 ' + capacity + ')' };
    const moves = [];
    for (const p of movers) {
      const target = pickSeat(s, t.eventId, { excludeTableId: tableId });
      if (!target) return { error: '좌석 배정 실패' };
      moves.push({ player: p, from: { tableId: p.tableId, seat: p.seat }, to: target });
      p.tableId = target.tableId; p.seat = target.seat;
    }
    t.status = 'closed'; t.closedAt = Date.now();
    return { moves };
  }
  function reopenTable(s, tableId) { const t = tableOf(s, tableId); if (!t) return false; if (usedTableNumbers(s).has(t.number)) return { error: 'T' + t.number + ' 번호가 이미 사용 중입니다' }; t.status = 'open'; delete t.closedAt; }
  function deleteTable(s, tableId) {
    if (tablePlayers(s, tableId).length) return { error: '플레이어가 있는 테이블은 삭제할 수 없습니다' };
    s.tables = s.tables.filter(t => t.id !== tableId);
  }

  /* ---------- 좌석 배정 ---------- */
  /** 오픈 테이블 중 인원이 가장 적은 테이블들 가운데 무작위 → 그 테이블의 빈 좌석 중 무작위 */
  function pickSeat(s, eventId, opts) {
    opts = opts || {};
    let cands = openTables(s, eventId)
      .filter(t => t.id !== opts.excludeTableId && tableUsable(t))
      .map(t => ({ t, empty: emptySeats(s, t), n: tablePlayers(s, t.id).length }))
      .filter(c => c.empty.length);
    if (!cands.length) return null;
    const min = Math.min.apply(null, cands.map(c => c.n));
    cands = cands.filter(c => c.n === min);
    const c = pick(cands);
    return { tableId: c.t.id, seat: pick(c.empty) };
  }

  function register(s, eventId, data, seatChoice) {
    const ev = eventOf(s, eventId); if (!ev) return { error: '이벤트 없음' };
    let target = seatChoice || null;
    if (target) {
      const t = tableOf(s, target.tableId);
      if (!t || t.status !== 'open' || !emptySeats(s, t).includes(target.seat)) target = null;
    }
    let openedTable = null;
    if (!target) target = pickSeat(s, eventId);
    if (!target) {
      if (!s.settings.autoOpenTable) return { error: '빈 좌석이 없습니다. 새 테이블을 열어주세요' };
      openedTable = openTable(s, eventId);
      if (openedTable.error) return { error: openedTable.error };
      target = pickSeat(s, eventId);
    }
    const p = {
      id: Store.uid(), eventId, entryNo: ev.nextEntryNo++, name: (data.name || '').trim() || '이름없음',
      phone: (data.phone || '').trim(), memo: (data.memo || '').trim(), buyIn: data.buyIn === '' || data.buyIn === undefined ? ev.buyIn : +data.buyIn,
      status: 'active', tableId: target.tableId, seat: target.seat, registeredAt: Date.now(), finishRank: null, bustedAt: null
    };
    s.players.push(p);
    return { player: p, openedTable };
  }
  function cancelRegistration(s, playerId) { s.players = s.players.filter(p => p.id !== playerId); }

  /* ---------- 플레이어 ---------- */
  function movePlayer(s, playerId, tableId, seat) {
    const p = playerOf(s, playerId); const t = tableOf(s, tableId);
    if (!p || !t || t.status !== 'open') return { error: '이동 불가' };
    if ((t.disabledSeats || []).includes(seat)) return { error: '비활성 좌석' };
    const other = seatPlayer(s, tableId, seat);
    if (other && other.id === p.id) return { error: '같은 좌석' };
    if (other) { other.tableId = p.tableId; other.seat = p.seat; }
    p.tableId = tableId; p.seat = seat;
    return { swapped: other || null };
  }
  function bustOut(s, playerId) {
    const p = playerOf(s, playerId); if (!p || p.status !== 'active') return { error: '이미 탈락' };
    const remaining = activePlayers(s, p.eventId).length; // 탈락 시점 남은 인원 = 최종 순위
    p.status = 'busted'; p.finishRank = remaining; p.bustedAt = Date.now();
    p.lastSeat = { tableId: p.tableId, seat: p.seat };
    p.tableId = null; p.seat = null;
    return { rank: remaining };
  }
  /** 실수 탈락 복구: 이전 좌석이 비어있으면 그 자리, 아니면 무작위 */
  function unbust(s, playerId) {
    const p = playerOf(s, playerId); if (!p || p.status !== 'busted') return { error: '탈락 상태가 아님' };
    let target = null;
    if (p.lastSeat) {
      const t = tableOf(s, p.lastSeat.tableId);
      if (t && t.status === 'open' && emptySeats(s, t).includes(p.lastSeat.seat)) target = p.lastSeat;
    }
    if (!target) target = pickSeat(s, p.eventId);
    if (!target) {
      if (!s.settings.autoOpenTable) return { error: '빈 좌석 없음' };
      const ot = openTable(s, p.eventId); if (ot.error) return { error: ot.error }; target = pickSeat(s, p.eventId);
    }
    p.status = 'active'; p.tableId = target.tableId; p.seat = target.seat; p.finishRank = null; p.bustedAt = null;
    return target;
  }

  /* ---------- 밸런싱 ---------- */
  function balanceInfo(s, eventId) {
    const tables = openTables(s, eventId);
    const counts = tables.map(t => ({ table: t, n: tablePlayers(s, t.id).length, cap: usableSeats(t) }));
    const active = activePlayers(s, eventId).length;
    if (!tables.length) return { tables: counts, need: false, canBreak: false, active, max: 0, min: 0 };
    const max = Math.max.apply(null, counts.map(c => c.n)), min = Math.min.apply(null, counts.map(c => c.n));
    const need = max - min >= 2;
    // 가장 적은 테이블을 빼도 나머지에 전원 수용 가능하면 브레이크 권장
    const smallest = counts.slice().sort((a, b) => a.n - b.n)[0];
    const capWithout = counts.filter(c => c !== smallest).reduce((n, c) => n + c.cap, 0);
    const canBreak = tables.length > 1 && active <= capWithout;
    return { tables: counts, max, min, need, canBreak, breakTable: canBreak ? smallest.table : null, active };
  }
  /** 큰 테이블 → 작은 테이블로 한 명씩 무작위 이동, 편차가 1 이하가 될 때까지 */
  function autoBalance(s, eventId) {
    const moves = [];
    for (let guard = 0; guard < 200; guard++) {
      const info = balanceInfo(s, eventId);
      if (!info.need) break;
      const sorted = info.tables.slice().sort((a, b) => b.n - a.n);
      const big = sorted[0];
      const small = sorted.filter(c => tableUsable(c.table) && emptySeats(s, c.table).length).sort((a, b) => a.n - b.n)[0];
      if (!small || small.n >= big.n - 1) break;
      const p = pick(tablePlayers(s, big.table.id));
      const seat = pick(emptySeats(s, small.table));
      moves.push({ player: p, from: { tableId: p.tableId, seat: p.seat }, to: { tableId: small.table.id, seat } });
      p.tableId = small.table.id; p.seat = seat;
    }
    return moves;
  }

  /* ---------- 상금 구조: 순위 구간 → 금액 행 [{from,to,amount,label}] ---------- */
  function prizePool(s, ev) {
    if (ev.prizePool) return +ev.prizePool;
    const gross = eventPlayers(s, ev.id).reduce((n, p) => n + (p.buyIn || 0), 0);
    return Math.round(gross * (1 - (+ev.rakePct || 0) / 100));
  }
  function normalizePayouts(rows) {
    return (rows || []).map(r => ({ from: Math.max(1, +r.from || 1), to: Math.max(+r.from || 1, +r.to || +r.from || 1), amount: +r.amount || 0, label: (r.label || '').trim() }))
      .filter(r => r.amount > 0 || r.label).sort((a, b) => a.from - b.from);
  }
  const payoutTable = (s, ev) => normalizePayouts(ev.payouts);
  function payoutRow(s, ev, rank) { return payoutTable(s, ev).find(r => rank >= r.from && rank <= r.to) || null; }
  function payoutFor(s, ev, rank) { const r = payoutRow(s, ev, rank); return r ? r.amount : 0; }
  /** 상금표 총액 (구간 인원 × 금액) */
  const payoutTotal = (s, ev) => payoutTable(s, ev).reduce((n, r) => n + r.amount * (r.to - r.from + 1), 0);

  /* ---------- 바우처 ---------- */
  function issueVoucher(s, data) {
    s.vouchers = s.vouchers || [];
    const serial = 'V' + String(s.vouchers.length + 1).padStart(4, '0');
    const v = { id: Store.uid(), serial, eventId: data.eventId, playerId: data.playerId || null, playerName: data.playerName, rank: data.rank || null, amount: +data.amount || 0, note: data.note || '', issuedAt: Date.now() };
    s.vouchers.push(v); return v;
  }

  return { rand, pick, shuffle, eventOf, tableOf, playerOf, openTables, allTables, eventPlayers, activePlayers, bustedPlayers, tablePlayers, seatPlayer, emptySeats, usableSeats,
    createEvent, updateEvent, deleteEvent, openTable, toggleSeat, closeTable, reopenTable, deleteTable, pickSeat, register, cancelRegistration, movePlayer, bustOut, unbust, balanceInfo, autoBalance, issueVoucher, prizePool, normalizePayouts, payoutTable, payoutRow, payoutFor, payoutTotal, toggleTable, tableUsable, nextTableNumber, usedTableNumbers };
})();
