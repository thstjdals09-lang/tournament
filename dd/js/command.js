/*
 * 명령 입력칸 — 디렉터가 적은 말을 알아듣고 할 일 목록으로 바꾼다 (AI 없이 정해진 말투, 2026-10-24 사용자 요청).
 *   "3시부터 15분 간격으로 로테 돌게 해줘" · "1시에 7번 열어" · "7-9번 1시 사용" · "2번 1시 깨기" · "3번 2시 대기"
 *   "김민수 6시 출근" · "김민수, 이영희 퇴근" · "일시정지" · "재개" — 여러 개는 쉼표·줄바꿈으로
 *
 * parse(text, state, now) → { steps: [{desc, run(s, now) → s}], problems: [글], notes: [글] }
 *   steps는 앞에서부터 차례로 적용해 보며 설명을 만든다 (간격을 바꾼 뒤의 교대 시각으로 테이블 예약 시각을 보여 주게).
 *   앱은 [실행]을 누를 때 지금 state로 다시 parse 해서 steps.run을 차례로 적용한다 — 엔진 함수만 쓰므로 되돌리기도 된다.
 *   교대 때 하는 일은 '그 시각 이후 첫 교대'로 정한다 (run 할 때 다시 계산 — 그 사이 교대가 지나가도 시각 기준 그대로)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.DealerCommand = factory(root.DealerEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const MIN = E.MIN;
  const SLACK = 10 * MIN; // '3시'라고 3시 5분에 말해도 방금 지난 3시로 본다
  const hhmm = t => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const EXAMPLES = ['3시부터 15분 간격', '1시에 7번 열어', '7-9번 1시 사용', '2번 1시 깨기', '3번 2시 대기',
    '김민수 6시 출근', '김민수 쉬러 나오면 퇴근', '김민수 퇴근', '김민수가 5번을 잘못 바꿔줬어', '3번 교대 안 했어', '다음 교대 5분 늦춰', '13:20 교대 13:25로', '일시정지', '재개'];

  // ---------- 시각 ----------
  // '15:00' · '3시' · '3시 반' · '3시 30분' · '오후 3시' · '오전 10시 30분' → {at, rest}. 오전·오후가 없으면 가장 가까운 앞으로의 시각
  const TIME_RE = /(오전|오후|아침|저녁|밤|낮|새벽)?\s*(?:(\d{1,2}):(\d{2})|(\d{1,2})\s*시(?:\s*(반|(\d{1,2})\s*분))?)/;
  function findTime(text, now) {
    const m = text.match(TIME_RE);
    if (!m) return null;
    const ampm = m[1] || '';
    const colon = m[2] != null;
    const h = Number(colon ? m[2] : m[4]);
    const min = colon ? Number(m[3]) : m[5] === '반' ? 30 : m[6] != null ? Number(m[6]) : 0;
    if (h > 24 || min > 59) return null;
    let hours;
    if (h >= 13 || (colon && /^0/.test(m[2]))) hours = [h % 24];          // 24시간제로 적은 것
    else if (/오후|저녁|밤|낮/.test(ampm)) hours = [h === 12 ? 12 : h + 12];
    else if (/오전|아침|새벽/.test(ampm)) hours = [h === 12 ? 0 : h];
    else hours = h === 12 ? [12, 0] : [h, h + 12];
    let best = null;
    for (const hh of hours) {
      const d = new Date(now);
      d.setHours(hh, min, 0, 0);
      let t = d.getTime();
      while (t < now - SLACK) t += 24 * 60 * MIN;
      if (best == null || t < best) best = t;
    }
    return { at: best, rest: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
  }

  // ---------- 조각 나누기 ----------
  const VERB_RE = /출근|퇴근|간격|마다|번|일시\s*정지|멈춰|정지|재개|다시\s*시작|교대|취소/;
  function splitClauses(text) {
    // 쉼표마다 나눈다. 숫자만 있는 조각('7, 8, 9번 열어')은 뒤와 합치고, 이름만 있는 조각('김민수, 이영희 6시 출근')은
    // 뒤 조각이 출근·퇴근이면 합친다 — 질문('김민수 어디야?, 7번 누구야?')은 따로 둔다
    const parts = String(text || '').split(/\n|;|그리고|,/).map(x => x.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      let p = parts[i];
      while (i + 1 < parts.length && (/^[\d\s,~-]+$/.test(p)
        || (!VERB_RE.test(p) && !Q_RE.test(p) && /출근|퇴근/.test(parts[i + 1]) && p.split(/\s+/).length <= 2))) {
        p = `${p}, ${parts[++i]}`;
      }
      out.push(p);
    }
    return out;
  }

  // 이름 목록: '김민수, 이영희' · '김민수님 이영희는' — 호칭·조사는 뗀다. '이·가'는 떼고 나서 아는 이름일 때만
  // (이름이 '…이'로 끝나는 사람도 있으므로 — 예: 김하이)
  function names(text, s) {
    const known = new Set(s.dealers.map(d => d.name).concat((s.roster || []).map(r => r.name)));
    return text.split(/[,\s]+/).map(w => {
      let x = w.trim().replace(/(님|씨)$/, '').replace(/(은|는|을|를|도)$/, '');
      if (!known.has(x) && /(이|가)$/.test(x) && known.has(x.slice(0, -1))) x = x.slice(0, -1);
      return x.replace(/(님|씨)$/, '');
    }).filter(w => w && !/^(오늘|지금|바로|좀|딜러|다시)$/.test(w));
  }

  const tableByNo = (s, no) => s.tables.find(t => t.no === no) || null;

  // 두 상태의 자리 차이 ('김민수 3번 → 5번', '박철수 5번 → 휴식') — 바로잡기 확인 창에 보여 준다
  function placeDiff(a, b) {
    const sa = E.snapshot(a);
    const sb = E.snapshot(b);
    const short = (v, d) => (v === undefined ? (d && d.status === 'off' ? '퇴근' : '없음') : v === 0 ? '휴식' : v === -2 ? '업무' : `${v}번`);
    return [...new Set(Object.keys(sa).concat(Object.keys(sb)))].filter(id => sa[id] !== sb[id])
      .map(id => `${(E.dealerOf(b, id) || E.dealerOf(a, id)).name} ${short(sa[id], E.dealerOf(a, id))} → ${short(sb[id], E.dealerOf(b, id))}`);
  }
  const isOpen = (s, no) => { const t = tableByNo(s, no); return !!t && t.status === 'open'; };

  // 그 시각 이후 첫 교대가 앞으로 몇 번째인지 (예정 표와 같은 계산). 없으면 null
  function slotOf(s, at, now) {
    if (!s.clock.running) return null;
    const slots = E.project(s, 40, now);
    const i = slots.findIndex(p => p.at >= at - 30000);
    return i < 0 ? null : { n: i + 1, at: slots[i].at };
  }

  // ---------- 질문에 답하기 ----------
  // 아무것도 바꾸지 않고 지금 상태·예정 표(project)로 답한다. 사실인 숫자만 — 형평(누가 몇 분 더 일했나) 같은 비교는 하지 않는다 (사용자 규칙)
  const Q_RE = /\?|？|언제|누구|누가|몇|어디|뭐\s*해|뭐야|뭐\s*있|무엇|있어|있나|있니|알려|보여|얼마|어때|순서|목록|일정|스케줄|현황|상태|했어|했나|어떻게|될까|되나|생겨|생기|바뀌|괜찮|문제|필요|모자|부족해|충분|같이\s*쉬|남았/;
  const QUESTION_EXAMPLES = ['김민수 어디야?', '김민수 언제 쉬어?', '김민수 일정', '7번 누구야?', '다음 교대 언제?', '1시에 누가 들어가?',
    '지금 쉬는 사람', '출근 예정 누구?', '공석 있어?', '몇 명 출근했어?', '예약 뭐 있어?',
    '김민수 지금 퇴근하면 어떻게 돼?', '7번 깨면 누가 쉬어?', '문제 있어?', '3시까지 김민수 몇 번 쉬어?', '김민수 다음 휴식까지 몇 분?',
    '1시부터 2시 사이에 쉬는 사람', '김민수랑 이영희 같이 쉬는 때', '테이블 2개 더 열면 몇 명 필요해?'];
  const mins = ms => Math.max(0, Math.floor(ms / MIN)); // 화면(minutes)과 같게 내림
  const placeText = v => (v === undefined ? '없음 (퇴근·출근 전)' : v === 0 ? '휴식' : v === -2 ? '다른 업무' : `${v}번 테이블`);

  // 문장 속 딜러 이름들 — 낱말이 이름 그대로거나 이름 + 조사일 때만 ('가' 같은 한 글자가 아무 데나 걸리지 않게,
  // '로테에서'·'나와서' 같은 말을 이름으로 읽지 않게 실제 딜러 이름만)
  const PARTICLE = /^(은|는|이|가|의|도|를|을|씨|님|한테|에게|이랑|랑|은요|는요|이는|이가|가요|이요|씨는|님은|님이|이면|면|이도)$/;
  function dealersIn(text, s) {
    const tokens = text.split(/[\s,?？.!~]+/).filter(Boolean);
    const list = s.dealers.slice().sort((a, b) => b.name.length - a.name.length);
    const out = [];
    for (const tok of tokens) {
      const d = list.find(x => tok === x.name || (tok.startsWith(x.name) && PARTICLE.test(tok.slice(x.name.length))));
      if (!d) continue;
      const pick = s.dealers.find(x => x.name === d.name && x.status !== 'off') || d;
      if (!out.includes(pick)) out.push(pick);
    }
    return out;
  }
  const findDealer = (text, s) => dealersIn(text, s)[0] || null;

  // 문장 속 시각 전부 (앞에서부터) — '1시부터 2시 사이' · '3시까지'
  function findTimes(text, now) {
    const times = [];
    let rest = text;
    for (let k = 0; k < 3; k++) {
      const t = findTime(rest, now);
      if (!t) break;
      let at = t.at;
      if (times.length && at < times[times.length - 1]) at += 24 * 60 * MIN; // '11시부터 1시까지'
      times.push(at);
      rest = t.rest;
    }
    return { times, rest };
  }

  // ---------- 가정 질문 ('…하면 어떻게 돼?') ----------
  // 조건 부분을 명령으로 알아듣고 복사본에만 적용해, 지금·앞으로의 교대가 어떻게 달라지는지 견준다. 실제로는 아무것도 바꾸지 않는다
  const WHATIF_RE = /^(.*\S)(하면|되면|시키면|보내면|이면|면)\s*(.*)$/;
  const WHATIF_ASK = /어떻게|어때|누가|누구|뭐가|몇|어디|될까|돼|되나|생겨|생기|문제|바뀌|달라|괜찮|영향|\?|？/;
  let inWhatIf = false;
  function whatIf(cond, s, now) {
    if (inWhatIf) return null;
    inWhatIf = true;
    let r;
    try { r = parse(cond.replace(/(하|되|시키|이)$/, '').trim(), s, now); } finally { inWhatIf = false; }
    if (!r.steps.length) return null;
    let alt = s;
    for (const st of r.steps) alt = st.run(alt, now);
    const H = 6;
    const base = s.clock.running ? E.project(s, H, now) : [];
    const after = alt.clock.running ? E.project(alt, H, now) : [];
    const name = id => ((E.dealerOf(alt, id) || E.dealerOf(s, id) || {}).name || '?');
    const short = (v, id, st) => (v === undefined ? ((E.dealerOf(st, id) || {}).status === 'off' ? '퇴근' : '출근 전') : v === 0 ? '휴식' : v === -2 ? '업무' : `${v}번`);
    const diff = (a, b) => [...new Set(Object.keys(a).concat(Object.keys(b)))]
      .filter(id => a[id] !== b[id]).map(id => `${name(id)} ${short(a[id], id, s)} → ${short(b[id], id, alt)}`);
    const lines = [`가정: ${r.steps.map(x => x.desc).join(' · ')} — 실제로는 바꾸지 않았습니다`];
    const now0 = diff(E.snapshot(s), E.snapshot(alt));
    if (now0.length) lines.push(`지금 바로: ${now0.join(', ')}`);
    // 교대마다 달라지는 자리 — 바로 앞 교대와 같은 차이면 되풀이하지 않는다 ('그 뒤로도 같음')
    let prevKey = '';
    let same = false;
    for (let i = 0; i < after.length; i++) {
      const a = base[i];
      const b = after[i];
      const ch = diff(a ? a.a : {}, b.a);
      const key = ch.join('|');
      if (key && key === prevKey) { same = true; continue; }
      if (same) { lines[lines.length - 1] += ' (그 뒤 교대에도 같음)'; same = false; }
      prevKey = key;
      if (!ch.length) continue;
      const when = a && a.at !== b.at ? `${hhmm(a.at)} → ${hhmm(b.at)}` : hhmm(b.at);
      lines.push(`${when} 교대: ${ch.slice(0, 8).join(', ')}${ch.length > 8 ? ` 외 ${ch.length - 8}명` : ''}`);
    }
    if (same) lines[lines.length - 1] += ' (그 뒤 교대에도 같음)';
    // 한 사람이 빠지면 뒤 교대가 줄줄이 바뀐다 — 교대별 변화는 앞의 3번만 자세히, 나머지는 몇 번인지만
    const head = lines.findIndex(l => / 교대: /.test(l));
    const pushLines = lines.filter(l => / 교대: /.test(l));
    if (pushLines.length > 3) lines.splice(head + 3, pushLines.length - 3, `그 뒤로도 ${pushLines.length - 3}번 교대에서 자리가 달라집니다 (로테이션 표에서 확인)`);
    // 새로 생기는 주의 — 같은 주의는 처음 생기는 교대만 ('13:00부터')
    const seen = new Map();
    for (const p of after) for (const w of p.plan.warnings) if (!base.some(q => q.plan.warnings.includes(w)) && !seen.has(w)) seen.set(w, p.at);
    if (seen.size) lines.push(`새로 생기는 주의: ${[...seen].slice(0, 4).map(([w, at]) => `${hhmm(at)}부터 ${w}`).join(' / ')}`);
    if (lines.length === 1) lines.push(`앞으로 ${after.length}번 교대 동안 달라지는 자리는 없습니다`);
    return lines.join('\n');
  }

  function answer(clause, s, now) {
    // 0) 가정 질문: '김민준 지금 퇴근하면 어떻게 돼?' · '7번 깨면 누가 쉬어?' · '3시부터 10분 간격이면 어때?'
    const wi = clause.match(WHATIF_RE);
    if (wi && WHATIF_ASK.test(wi[3] || clause)) {
      const r = whatIf(wi[1], s, now);
      if (r) return r;
    }
    const cache = {};
    const proj = (n = 8) => {
      if (!s.clock.running) return [];
      if (!cache.p || cache.p.length < n) cache.p = E.project(s, Math.min(40, Math.max(n, 8)), now);
      return cache.p.slice(0, Math.max(n, 8));
    };
    const until = T => { // T 시각까지 덮는 예정 (최대 40번 교대)
      let n = 8;
      let c = proj(n);
      while (c.length && c[c.length - 1].at < T && n < 40) { n = Math.min(40, n * 2); c = proj(n); }
      return c;
    };
    const snap = E.snapshot(s);
    const nameOf = id => ((E.dealerOf(s, id) || {}).name || '?');
    const cn = E.clockNow(s, now);
    const pool = E.breakPool(s, now);
    const pushLine = p => {
      const ins = p.plan.moves.filter(m => m.toDealerId).map(m => `${nameOf(m.toDealerId)} → ${m.tableNo}번`);
      const outs = p.plan.moves.filter(m => m.fromDealerId && !p.plan.moves.some(x => x.toDealerId === m.fromDealerId)).map(m => `${nameOf(m.fromDealerId)}`);
      return `${hhmm(p.at)} 교대 — ${ins.length ? ins.join(', ') : '바뀌는 테이블 없음'}${outs.length ? ` · 휴식: ${outs.join(', ')}` : ''}`;
    };
    const { times, rest } = findTimes(clause, now);
    const tm = times.length ? { at: times[0] } : null;
    const ds = dealersIn(rest, s);
    const d = ds[0] || null;
    const inMin = t => `${Math.max(0, Math.round((t - now) / MIN))}분 뒤`;

    // A) 문제 찾기: '문제 있어?' · '연속 두 번 쉬는 사람?' · '공석 생겨?' · '휴식 부족 있어?' · '연장 근무 걸려?'
    if (!d && /문제|주의|경고|연속\s*(?:두|2)\s*번|두\s*번\s*연속|공석\s*(?:생|나|될)|휴식\s*부족|연장|꼬여|꼬이/.test(rest)) {
      if (!s.clock.running) return '로테이션 시작 전입니다';
      const cols = proj(8);
      const out = [];
      for (const p of cols) for (const w of p.plan.warnings) out.push(`${hhmm(p.at)} ${w}`);
      const seq = [snap].concat(cols.map(p => p.a));
      const doubles = [];
      for (const x of s.dealers) {
        for (let i = 1; i < seq.length; i++) {
          if (seq[i - 1][x.id] === 0 && seq[i][x.id] === 0) { doubles.push(`${x.name}(${hhmm(cols[i - 1].at)})`); break; }
        }
      }
      if (doubles.length) out.push(`연속 두 번 휴식: ${doubles.join(', ')}`);
      return out.length ? `앞으로 ${cols.length}번 교대에서 —\n${out.join('\n')}`
        : `앞으로 ${cols.length}번 교대 동안 공석·휴식 부족·연장 근무·연속 두 번 휴식 없습니다`;
    }

    // B) 인원 계산: '딜러 몇 명 더 필요해?' · '테이블 2개 더 열면 몇 명 필요해?'
    if (/필요|모자|부족해|충분|더\s*있어야/.test(rest) && /명|딜러|인원/.test(rest)) {
      const st = E.staffing(s);
      const more = Number((rest.match(/(\d+)\s*개\s*(?:더|추가)/) || [])[1] || 0);
      const tables = st.tables + more;
      const k = Math.max(1, Math.floor(s.settings.maxWorkMinutes / s.settings.pushMinutes));
      const need = st.limited ? tables + Math.ceil(tables / k) : tables;
      const have = st.available;
      const gap = have - need;
      const basis = st.limited ? `최대 연속 근무 ${s.settings.maxWorkMinutes}분 기준` : '최대 근무 제한 없음 — 테이블 수만큼이면 됨';
      return `${more ? `테이블 ${st.tables}개 + ${more}개 = ${tables}개면` : `테이블 ${tables}개에`} 필요 ${need}명 (${basis}) · 지금 넣을 수 있는 딜러 ${have}명`
        + ` → ${gap >= 0 ? `${gap}명 여유 (쉴 수 있는 인원)` : `${-gap}명 더 필요`}${st.planned ? ` · 출근 예정 ${st.planned}명` : ''}${st.onTask ? ` · 다른 업무 ${st.onTask}명 제외` : ''}`;
    }

    // C) 딜러
    if (d) {
      const v = snap[d.id];
      const cols = proj();
      const nowText = (d.status === 'working' ? `${E.tableOf(s, d.tableId).no}번 테이블 근무 중 (이 자리 ${mins(cn - d.since)}분째, 연속 근무 ${mins(E.workedMs(s, d, now))}분)`
        : d.status === 'break' ? `휴식 중 (${mins(E.restedMs(d, now))}분째)${d.hold ? ' · 투입 보류' : ` · 들어갈 순서 ${pool.findIndex(x => x.id === d.id) + 1}번째`}`
          : d.status === 'duty' ? `다른 업무 — ${d.task} (${mins(cn - d.since)}분째)`
            : d.status === 'planned' ? `출근 전 — ${d.planAt != null ? `${hhmm(d.planAt)} 출근 예정` : '예정 시각 없음'}${d.checkAt != null ? ' (출근 체크함)' : ' (아직 체크 안 함)'}`
              : '퇴근') + (d.leaveOnRest ? ' · 쉬러 나오면 퇴근 (예약)' : '');

      // 두 사람: '김민수랑 이영희 같이 쉬는 때' · '둘 다 일하는 때'
      if (ds.length >= 2 && /같이|함께|동시|둘\s*다|모두|다\s*같이/.test(rest)) {
        const [a, b] = ds;
        const c = proj(12);
        const rest2 = /쉬|휴식/.test(rest);
        const hit = c.filter(p => (rest2 ? p.a[a.id] === 0 && p.a[b.id] === 0 : p.a[a.id] > 0 && p.a[b.id] > 0)).map(p => hhmm(p.at));
        return hit.length ? `${a.name}·${b.name} 같이 ${rest2 ? '쉬는' : '일하는'} 교대 — ${hit.join(', ')}`
          : `앞으로 ${c.length}번 교대 안에는 ${a.name}·${b.name} 둘이 같이 ${rest2 ? '쉬는' : '일하는'} 때가 없습니다`;
      }
      // 그 시각까지 몇 번 쉬나: '3시까지 김민수 몇 번 쉬어?'
      if (tm && /까지/.test(clause) && /몇\s*번|횟수/.test(rest)) {
        const c = until(tm.at).filter(p => p.at <= tm.at);
        const r = c.filter(p => p.a[d.id] === 0).map(p => hhmm(p.at));
        return `${d.name}: ${hhmm(tm.at)}까지 교대 ${c.length}번 중 휴식 ${r.length}번${r.length ? ` (${r.join(', ')})` : ''} · 지금 ${nowText}`;
      }
      // 남은 시간: '김민수 다음 휴식까지 몇 분?' · '김민수 언제까지 일해?'
      if (/까지\s*(?:몇|얼마)|몇\s*분\s*(?:남|뒤|후)|얼마나\s*(?:남|더)|언제까지/.test(rest)) {
        const wantRest = /쉬|휴식|빠|언제까지/.test(rest) && v !== 0;
        const i = cols.findIndex(p => (wantRest ? p.a[d.id] === 0 || p.a[d.id] === undefined : p.a[d.id] !== v));
        if (i < 0) return `${d.name}: 앞으로 ${cols.length}번 교대 안에는 ${wantRest ? '쉬는' : '바뀌는'} 예정이 없습니다 — 지금 ${nowText}`;
        return `${d.name}: ${hhmm(cols[i].at)} 교대 (${inMin(cols[i].at)})에 ${placeText(cols[i].a[d.id])} — 지금 ${nowText}`;
      }
      // 그 시각에 어디: '3시에 김민수 어디야?'
      if (tm && !/까지|부터|사이/.test(clause)) {
        const p = until(tm.at).find(x => x.at >= tm.at - 30000);
        if (!p) return `${hhmm(tm.at)}은(는) 앞으로 40번 교대 안에 없습니다`;
        const prev = until(tm.at).filter(x => x.at < p.at).pop();
        const was = prev ? prev.a[d.id] : v;
        return `${d.name}: ${hhmm(p.at)} 교대 뒤 ${placeText(p.a[d.id])}${was !== p.a[d.id] ? ` (그 전에는 ${placeText(was)})` : ''}`;
      }
      if (/일정|스케줄|순서|표/.test(rest)) {
        if (!cols.length) return `${d.name}: ${nowText} (로테이션 시작 전이라 예정이 없습니다)`;
        return `${d.name} 앞으로 — ${cols.map(p => `${hhmm(p.at)} ${placeText(p.a[d.id])}`).join(' · ')}`;
      }
      if (/몇\s*분|얼마|시간|오늘/.test(rest) && /일|근무|딜링|쉬|휴식/.test(rest)) {
        const dealing = d.totalWorkMs + (d.status === 'working' && s.clock.running ? Math.max(0, cn - d.since) : 0);
        const rested = d.totalRestMs + (d.status === 'break' && s.clock.running ? E.restedMs(d, now) : 0);
        const onDuty = (d.sessions || []).reduce((sum, x) => sum + ((x.out == null ? now : x.out) - x.in), 0);
        return `${d.name} 오늘 — 근무시간 ${mins(onDuty)}분 · 딜링 ${mins(dealing)}분 · 휴식 ${mins(rested)}분${d.totalDutyMs ? ` · 다른 업무 ${mins(d.totalDutyMs)}분` : ''} · 지금 ${nowText}`;
      }
      if (/언제/.test(rest) && /쉬|휴식|빠/.test(rest)) {
        if (v === 0) return `${d.name}: 지금 ${nowText}`;
        const i = cols.findIndex(p => p.a[d.id] === 0);
        return i < 0 ? `${d.name}: 앞으로 ${cols.length}번 교대 안에는 쉬는 예정이 없습니다 — 지금 ${nowText}` : `${d.name}: ${hhmm(cols[i].at)} 교대에 휴식 (${inMin(cols[i].at)}, 지금 ${nowText})`;
      }
      if (/언제/.test(rest) && /들어|투입|앉|근무|일해/.test(rest)) {
        const tn = rest.match(/(\d{1,3})\s*번/); // '김민수 7번에 언제 들어가?'
        if (tn) {
          const i = proj(12).findIndex(p => p.a[d.id] === Number(tn[1]));
          return i < 0 ? `${d.name}: 앞으로 ${proj(12).length}번 교대 안에 ${tn[1]}번 테이블에 들어가는 예정이 없습니다` : `${d.name}: ${hhmm(proj(12)[i].at)} 교대에 ${tn[1]}번 테이블`;
        }
        if (v > 0) return `${d.name}: 지금 ${nowText}`;
        const i = cols.findIndex(p => p.a[d.id] > 0);
        return i < 0 ? `${d.name}: 앞으로 ${cols.length}번 교대 안에는 들어가는 예정이 없습니다 — 지금 ${nowText}` : `${d.name}: ${hhmm(cols[i].at)} 교대에 ${cols[i].a[d.id]}번 테이블 (${inMin(cols[i].at)}, 지금 ${nowText})`;
      }
      const i = cols.findIndex(p => p.a[d.id] !== v);
      const stay = cols.length && d.status !== 'planned' && d.status !== 'off' ? ` · 앞으로 ${cols.length}번 교대 동안 그대로` : '';
      return `${d.name}: ${nowText}${i < 0 ? stay : ` · 다음: ${hhmm(cols[i].at)}에 ${placeText(cols[i].a[d.id])}`}`;
    }

    // D) 테이블: '7번 누구야?' · '7번 다음 누구?' · '3시에 7번 누구야?'
    const tb = rest.match(/(\d{1,3})\s*번/);
    if (tb) {
      const t = s.tables.find(x => x.no === Number(tb[1]));
      if (tm && s.clock.running) {
        const p = until(tm.at).find(x => x.at >= tm.at - 30000);
        if (!p) return `${hhmm(tm.at)}은(는) 앞으로 40번 교대 안에 없습니다`;
        const who = Object.keys(p.a).find(id => p.a[id] === Number(tb[1]));
        return `${hhmm(p.at)} 교대 뒤 ${tb[1]}번 테이블: ${who ? nameOf(who) : (t && t.status === 'open' ? '딜러 없음 (대기·공석)' : '열려 있지 않음')}`;
      }
      if (!t || t.status !== 'open') return `${tb[1]}번 테이블은 열려 있지 않습니다`;
      const sched = t.sched ? ` · 예약: ${(proj()[t.sched.n - 1] ? hhmm(proj()[t.sched.n - 1].at) : `${t.sched.n}번째`)} 교대에 ${{ use: '사용 시작', idle: '대기로', close: '깨기' }[t.sched.act]}` : '';
      const who = t.dealerId ? E.dealerOf(s, t.dealerId) : null;
      const nowText = t.use === false ? '대기 (딜러 없음)' : who ? `${who.name} (이 자리 ${mins(cn - who.since)}분째)` : '공석';
      const cols = proj();
      const i = cols.findIndex(p => Object.keys(p.a).find(id => p.a[id] === t.no) !== (who ? who.id : undefined));
      const nextWho = i < 0 ? null : Object.keys(cols[i].a).find(id => cols[i].a[id] === t.no);
      const next = i < 0 ? (cols.length ? ` · 앞으로 ${cols.length}번 교대 동안 그대로` : '') : ` · 다음: ${hhmm(cols[i].at)}에 ${nextWho ? nameOf(nextWho) : '딜러 없음'}`;
      return `${t.no}번 테이블: ${nowText}${next}${sched}`;
    }

    // E) 구간: '1시부터 2시 사이에 쉬는 사람' · '3시까지 쉬는 사람'
    if (tm && s.clock.running && (times.length >= 2 || /까지|사이/.test(clause)) && /쉬|휴식|들어|투입/.test(rest)) {
      const from = times.length >= 2 ? times[0] : now;
      const to = times.length >= 2 ? times[1] : times[0];
      const c = until(to).filter(p => p.at >= from - 30000 && p.at <= to);
      if (!c.length) return `${hhmm(from)}~${hhmm(to)} 사이에 교대가 없습니다`;
      const resting = /쉬|휴식/.test(rest);
      const lines = c.map(p => {
        const ids = Object.keys(p.a).filter(id => (resting ? p.a[id] === 0 : p.plan.moves.some(m => m.toDealerId === id)));
        return `${hhmm(p.at)} ${ids.length ? ids.map(nameOf).join(', ') : '없음'}`;
      });
      return `${hhmm(from)}~${hhmm(to)} ${resting ? '쉬는 딜러' : '들어가는 딜러'} —\n${lines.join('\n')}`;
    }
    // F) 그 시각의 교대: '1시에 누가 들어가?' · '13:15 교대'
    if (tm && s.clock.running) {
      const p = until(tm.at).find(x => x.at >= tm.at - 30000);
      return p ? pushLine(p) : `${hhmm(tm.at)}은(는) 앞으로 40번 교대 안에 없습니다`;
    }
    // G) 다음 교대 (몇 분 남았나도)
    if (/다음\s*교대|교대\s*언제|언제\s*교대|교대까지/.test(rest)) {
      if (!s.clock.running) return '로테이션 시작 전입니다';
      const p = proj()[0];
      if (!p) return '예정된 교대가 없습니다';
      if (/몇\s*분|얼마|남/.test(rest)) return `다음 교대 ${hhmm(p.at)} — ${s.clock.paused ? '일시정지 중' : inMin(p.at)}`;
      return `${pushLine(p)}${s.clock.paused ? ' (지금 일시정지 중)' : ` (${inMin(p.at)})`}`;
    }
    // H) 쉬는 사람 · 들어갈 순서
    if (/쉬는|휴식|들어갈\s*순서|대기\s*딜러/.test(rest)) {
      if (!pool.length) return '지금 쉬는 딜러가 없습니다';
      return `쉬는 딜러 (들어갈 순서) — ${pool.map((x, k) => `${k + 1}. ${x.name} ${mins(E.restedMs(x, now))}분${x.hold ? ' 보류' : ''}`).join(' · ')}`;
    }
    // I) 출근 예정
    if (/출근\s*예정|안\s*온|아직\s*안|체크\s*안/.test(rest)) {
      const list = s.dealers.filter(x => x.status === 'planned').sort((a, b) => (a.planAt || Infinity) - (b.planAt || Infinity));
      if (!list.length) return '출근 예정인 딜러가 없습니다';
      return `출근 예정 ${list.length}명 — ${list.map(x => `${x.name} ${x.planAt != null ? hhmm(x.planAt) : '시각 없음'}${x.checkAt != null ? ' ✓체크' : x.planAt != null && x.planAt <= now ? ' 체크 안 함' : ''}`).join(' · ')}`;
    }
    // J) 공석 (지금 + 앞으로) · 대기 테이블
    if (/공석|빈\s*자리|빈\s*테이블/.test(rest)) {
      const v = E.usedTables(s).filter(t => !t.dealerId).map(t => t.no);
      const later = proj(8).flatMap(p => p.plan.warnings.filter(w => /공석/.test(w)).map(w => `${hhmm(p.at)} ${w}`));
      return `${v.length ? `지금 공석 ${E.rangeText(v)}번` : '지금 공석 없습니다'}${later.length ? ` · 앞으로: ${later.join(' / ')}` : ''}`;
    }
    if (/대기\s*테이블|대기\s*중인\s*테이블|대기\s*몇/.test(rest)) {
      const v = E.idleTables(s).map(t => t.no);
      return v.length ? `대기 테이블 ${E.rangeText(v)}번` : '대기 테이블이 없습니다';
    }
    // K) 퇴근 희망
    if (/퇴근\s*희망/.test(rest)) {
      const list = E.eoOrder(s);
      return list.length ? `퇴근 희망 ${list.length}명 (말한 순서) — ${list.map((x, k) => `${k + 1}. ${x.name}`).join(' · ')}` : '퇴근 희망자가 없습니다';
    }
    // L) 예약 · 간격 · 버튼
    if (/예약/.test(rest)) {
      const out = [];
      const ip = s.clock.intervalPlan;
      if (ip) out.push(`${hhmm(ip.at)}부터 교대 간격 ${ip.minutes}분`);
      for (const t of s.tables.filter(x => x.status === 'open' && x.sched)) {
        const p = proj()[t.sched.n - 1];
        out.push(`${p ? hhmm(p.at) : `${t.sched.n}번째`} 교대에 ${t.no}번 ${{ use: '사용 시작', idle: '대기로', close: '깨기' }[t.sched.act]}`);
      }
      for (const x of s.dealers.filter(y => y.leaveOnRest && y.status !== 'off')) out.push(`${x.name} 쉬러 나오면 퇴근`);
      const np = E.planCount(s);
      if (np) out.push(`표에서 직접 정한 교대 ${np}건`);
      return out.length ? `예약 — ${out.join(' · ')}` : '예약이 없습니다';
    }
    if (/간격/.test(rest)) {
      const ip = s.clock.intervalPlan;
      return `교대 간격 ${s.settings.pushMinutes}분${ip ? ` · ${hhmm(ip.at)}부터 ${ip.minutes}분 (예약)` : ''}`;
    }
    if (/버튼/.test(rest)) return s.button ? `오늘 버튼 ${s.button.no}번` : '오늘 버튼을 아직 안 뽑았습니다';
    // M) 인원 · 업무 · 오래 앉은 사람 · 테이블 수
    if (/업무/.test(rest)) {
      const list = s.dealers.filter(x => x.status === 'duty');
      return list.length ? `다른 업무 — ${list.map(x => `${x.name} (${x.task}, ${mins(cn - x.since)}분째)`).join(' · ')}` : '다른 업무 중인 딜러가 없습니다';
    }
    if (/오래|제일|가장/.test(rest)) {
      const list = E.working(s).sort((a, b) => a.since - b.since).slice(0, 3);
      return list.length ? `이 자리에 오래 앉은 순 — ${list.map(x => `${x.name} ${E.tableOf(s, x.tableId).no}번 ${mins(cn - x.since)}분`).join(' · ')}` : '근무 중인 딜러가 없습니다';
    }
    if (/몇\s*명|인원|출근(한|했)|다\s*왔/.test(rest)) {
      const st = E.staffing(s);
      return `출근 ${st.active}명 — 근무 ${st.working} · 휴식 ${st.onBreak}${st.onTask ? ` · 다른 업무 ${st.onTask}` : ''}${st.planned ? ` · 출근 예정 ${st.planned}명` : ''} · 테이블 ${st.tables}개${st.idle ? ` (대기 ${st.idle})` : ''}`;
    }
    if (/테이블/.test(rest)) {
      const used = E.usedTables(s).map(t => t.no);
      const idle = E.idleTables(s).map(t => t.no);
      return `열린 테이블 — 사용 ${used.length ? E.rangeText(used) + '번' : '없음'}${idle.length ? ` · 대기 ${E.rangeText(idle)}번` : ''}`;
    }
    return null;
  }

  // 교대 바로잡기 말 — 질문 말('했어')이 섞여 있어도 바로잡기로 먼저 본다
  const FIX_RE = /잘못|실수|대신|틀리|엉뚱|안\s*했|안\s*바뀌|안\s*들어|안\s*나갔|안\s*갔|바꿔\s*앉|자리\s*(?:가\s*)?바뀌|바뀌어\s*앉/;

  // ---------- 교대 시각 바꾸기 (이번만) ----------
  // 이 문장이 교대 하나의 시각을 옮기라는 뜻인가 → null(아님) · {problem} · {reset, ns} · {n, to(지금 시각) → 새 시각}
  //  어느 교대: '다음/이번 교대' = 1 · 'N번째 교대' = N · 앞의 시각이 예정 교대 시각과 같으면 그 교대 · 아니면 다음 교대
  //  새 시각: 'N분 늦춰/미뤄'(+) · 'N분 당겨'(−) · 시각 둘이면 뒤의 것 · '다음 교대 13:25로'처럼 하나면 그것
  const PT_WHO = /(다음|이번|(\d{1,2})\s*번째)\s*(?:교대|로테|푸시)/;
  const PT_SHIFT = /(\d{1,3})\s*분\s*(?:만\s*)?(늦|미뤄|미루|뒤로|연기|당겨|당기|앞당|일찍|빨리|앞으로)/;
  function pushTimeIntent(clause, s, now) {
    if (!/교대|로테|푸시/.test(clause) || /간격|마다|주기|출근|퇴근/.test(clause)) return null;
    if (/\d\s*번(?!\s*째)/.test(clause) || dealersIn(clause, s).length) return null; // 테이블·딜러 일은 다른 갈래
    const times = [];
    let rest = clause;
    for (let k = 0; k < 2; k++) { // findTimes와 달리 뒤 시각이 앞보다 일러도 다음 날로 넘기지 않는다 ('13:25 교대 13:20으로')
      const t = findTime(rest, now);
      if (!t) break;
      times.push(t.at);
      rest = t.rest;
    }
    const who = clause.match(PT_WHO);
    const shift = rest.match(PT_SHIFT);
    const reset = /원래대로|원래\s*시각|되돌|돌려/.test(rest);
    const change = /바꿔|바꾸|옮겨|옮기|변경|으로|로\s*(?:해|하자|바꿔)?\s*$|에\s*(?:해|하자|해줘)?\s*$|시각/.test(rest);
    if (!shift && !reset && times.length < 2 && !(times.length === 1 && who && change)) return null;
    if (!s.clock.running) return { problem: '로테이션이 돌 때만 교대 시각을 바꿉니다' };
    let n = who ? (who[2] ? Number(who[2]) : 1) : null;
    if (n == null && times.length && (times.length >= 2 || shift || reset)) {
      const i = E.project(s, 40, now).findIndex(p => p.at === times[0]);
      if (i < 0) return { problem: `${hhmm(times[0])}에는 예정된 교대가 없습니다 (로테이션 표 머리의 시각을 적어 주세요)` };
      n = i + 1;
    }
    if (reset) {
      const ns = n != null ? [n] : Array.from({ length: 40 }, (_, i) => i + 1).filter(k => E.pushTimeChanged(s, k));
      return { reset: true, ns };
    }
    if (n == null) n = 1;
    if (!(n >= 1 && n <= 40)) return { problem: '앞으로 40번째 교대까지만 바꿀 수 있습니다' };
    if (shift) {
      const m = Number(shift[1]) * (/늦|미뤄|미루|뒤로|연기/.test(shift[2]) ? 1 : -1);
      if (!m) return null;
      return { n, to: at => at + m * MIN };
    }
    const target = times[times.length - 1];
    return { n, to: () => target };
  }

  // ---------- 해석 ----------
  function parse(text, state, now) {
    const steps = [];
    const problems = [];
    const notes = [];
    const answers = [];
    let cur = state;
    const add = (desc, run, kind) => {
      const next = run(cur, now);
      if (!next || next === cur) return false;
      steps.push({ desc, run, kind: kind || '' });
      cur = next;
      return true;
    };

    for (const clause of splitClauses(text)) {
      // 질문처럼 보이면 먼저 답해 본다 (아무것도 바꾸지 않는다)
      if (Q_RE.test(clause) && !FIX_RE.test(clause)) {
        const a = answer(clause, cur, now);
        if (a) { answers.push({ q: clause, a }); continue; }
      }
      const tm = findTime(clause, now);
      const at = tm ? tm.at : null;
      const rest = tm ? tm.rest : clause;

      // 0) 예약 취소: '간격 예약 취소' · '7번 예약 취소'
      if (/취소/.test(rest)) {
        const tn = rest.match(/((?:\d+\s*(?:[-~]\s*\d+)?\s*,?\s*)+)\s*번(?!\s*째)/);
        if (/시각|시간/.test(rest) && /교대|로테/.test(rest) && !tn) { // '교대 시각 변경 취소' — 이번만 바꾼 시각을 모두 원래대로
          const ns = Array.from({ length: 40 }, (_, i) => i + 1).filter(k => E.pushTimeChanged(cur, k));
          ns.forEach(k => add(`${k}번째 교대 시각 원래대로`, (s, t) => E.clearPushTime(s, k, t)));
          if (!ns.length) notes.push('이번만 바꾼 교대 시각이 없습니다');
          continue;
        }
        if (tn) {
          const nos = E.parseNos(tn[1]);
          add(`${E.rangeText(nos)}번 테이블 예약 취소`, (s, t) => nos.reduce((x, no) => {
            const y = tableByNo(x, no);
            return y && y.sched ? E.unscheduleTable(x, y.id, t) : x;
          }, s)) || notes.push(`${E.rangeText(nos)}번에는 예약이 없습니다`);
        } else if (/간격/.test(rest)) {
          add('교대 간격 예약 취소', (s, t) => E.cancelIntervalPlan(s, t)) || notes.push('교대 간격 예약이 없습니다');
        } else if (/퇴근/.test(rest) && dealersIn(rest, cur).length) { // '김민준 퇴근 예약 취소'
          for (const d of dealersIn(rest, cur)) {
            add(`${d.name} 퇴근 예약 취소`, (s, t) => E.setLeaveOnRest(s, d.id, false, t)) || notes.push(`${d.name}에게는 퇴근 예약이 없습니다`);
          }
        } else {
          problems.push(`'${clause}' — 무엇을 취소할지 적어 주세요 (간격 예약 취소 · 7번 예약 취소 · 김민수 퇴근 예약 취소)`);
        }
        continue;
      }

      // 0-0) 교대 바로잡기 — 실제 앉은 대로 로테를 고친다 (2026-10-24 사용자 요청)
      //   '김민수가 5번을 잘못 바꿔줬어' · '김민수가 3번 대신 5번에 들어갔어' · '3번 교대 안 했어' · '김민수 안 들어갔어' · '김민수랑 이영희 자리 바뀌었어'
      if (FIX_RE.test(rest)) {
        const who = dealersIn(rest, cur);
        const nos = [...rest.matchAll(/(\d{1,3})\s*번/g)].map(m => Number(m[1]));
        const fixDesc = (head, next) => `${head} — ${placeDiff(cur, next).join(', ') || '바뀌는 자리 없음'}`;
        // 두 사람 자리가 바뀌어 있었다 (둘 다 근무 중)
        if (who.length >= 2 && /바뀌|바꿔/.test(rest) && !/안\s/.test(rest)) {
          const [a, b] = who;
          if (a.status !== 'working' || b.status !== 'working') { problems.push(`'${clause}' — 두 사람 다 근무 중일 때만 자리를 맞바꿉니다`); continue; }
          const run = (s, t) => E.fixSeat(s, E.dealerOf(s, b.id).tableId, a.id, t);
          const next = run(cur, now);
          if (!add(fixDesc(`바로잡기: ${a.name} ↔ ${b.name} 자리가 바뀌어 있었음`, next), run)) problems.push(`'${clause}' — 고칠 수 없습니다`);
          continue;
        }
        // 교대를 안 했다 (미투입): '3번 교대 안 했어' · '김민수 안 들어갔어'
        if (/안\s*했|안\s*바뀌|안\s*들어|안\s*나갔|안\s*갔/.test(rest)) {
          const t = nos.length ? tableByNo(cur, nos[0]) : who[0] && who[0].status === 'working' ? E.tableOf(cur, who[0].tableId) : null;
          if (!t) { problems.push(`'${clause}' — 몇 번 테이블인지(또는 누가 안 들어갔는지) 적어 주세요`); continue; }
          if (!E.undoInfo(cur, t.id, now)) { problems.push(`'${clause}' — ${t.no}번은 방금 교대한 자리가 아닙니다 (교대 직후 구간만 — 지난 일은 테이블 칸의 [바로잡기])`); continue; }
          const run = (s, x) => E.undoSeat(s, t.id, x, {});
          add(fixDesc(`바로잡기: ${t.no}번 교대 안 함 (미투입)`, run(cur, now)), run);
          continue;
        }
        // 잘못 간 자리: 화면에 있는 번호가 원래 갈 자리, 다른 번호가 실제로 앉은 자리
        if (who.length === 1 && nos.length) {
          const x = who[0];
          const shown = x.status === 'working' ? E.tableOf(cur, x.tableId).no : null;
          const actual = nos.find(no => no !== shown);
          if (actual == null) { problems.push(`'${clause}' — ${x.name}은(는) 화면에도 ${shown}번입니다. 실제로 앉은 테이블 번호를 적어 주세요 (예: ${x.name}가 ${shown}번 대신 5번에 들어갔어)`); continue; }
          const t = tableByNo(cur, actual);
          const check = t ? E.misSeatCheck(cur, x.id, t.id) : { why: `${actual}번 테이블이 열려 있지 않습니다` };
          if (!check.kind) { problems.push(`'${clause}' — ${check.why}`); continue; }
          const run = (s, y) => E.misSeat(s, x.id, t.id, y);
          const label = { swap: `↔ ${check.z ? check.z.name : ''} 서로 바꿔 앉음`, wrong: `${shown}번이 아니라 ${actual}번에 들어감`, enter: `${actual}번에 잘못 들어감` }[check.kind];
          add(fixDesc(`바로잡기: ${x.name} ${label}`, run(cur, now)), run);
          continue;
        }
        problems.push(`'${clause}' — 누가 몇 번에 잘못 갔는지 적어 주세요 (예: 김민수가 3번 대신 5번에 들어갔어 · 3번 교대 안 했어)`);
        continue;
      }

      // 0-1) 쉬러 나오면 퇴근: '김민준이 로테에서 나와서 휴식이면 퇴근시켜줘' · '김민준 쉬러 나오면 퇴근' · '김민준 다음 휴식 때 퇴근'
      //   지금 쉬는 중이면 바로 퇴근, 앉아 있거나 다른 업무 중이면 '쉬러 나오면 퇴근' 예약 (그 교대에 퇴근 — 예정 표에도 보인다)
      if (/퇴근|보내|집에/.test(rest) && /휴식|쉬|나오|나와|빠지|빠져|끝나|끝내|교대\s*(?:때|후|뒤|하고|되면)/.test(rest)) {
        const who = dealersIn(rest, cur);
        if (!who.length) { problems.push(`'${clause}' — 누구인지 출근해 있는 딜러 이름을 적어 주세요`); continue; }
        for (const d0 of who) {
          const d = E.dealerOf(cur, d0.id);
          if (!d || d.status === 'off' || d.status === 'planned') { problems.push(`${d0.name} — 출근해 있는 딜러가 아닙니다`); continue; }
          if (d.status === 'break') {
            add(`${d.name} — 지금 휴식 중이라 바로 퇴근`, (s, t) => {
              const x = E.dealerOf(s, d.id);
              return x && x.status === 'break' ? E.sendHome(s, d.id, t) : E.setLeaveOnRest(s, d.id, true, t);
            });
            continue;
          }
          const where = d.status === 'working' ? `지금 ${E.tableOf(cur, d.tableId).no}번 근무 중` : `지금 다른 업무 — 끝나고 쉬러 나오면`;
          if (!add(`${d.name} — 쉬러 나오면 퇴근`, (s, t) => E.setLeaveOnRest(s, d.id, true, t))) {
            notes.push(`${d.name}은(는) 이미 쉬러 나오면 퇴근으로 예약돼 있습니다`);
            continue;
          }
          const when = cur.clock.running ? E.project(cur, 12, now).find(p => p.a[d.id] === undefined) : null; // 예정 표로 언제 나오는지
          steps[steps.length - 1].desc += ` (${where}${when ? ` → ${hhmm(when.at)} 교대에 퇴근 예정` : ''})`;
        }
        continue;
      }

      // 0-2) 교대 시각 바꾸기 (이번만): '다음 교대 5분 늦춰' · '13:20 교대 13:25로' · '다음 교대 13:25에' · '2번째 교대 10분 당겨' · '다음 교대 원래대로'
      //   그 교대 하나만 옮기고 뒤 교대는 원래 시각대로 (2026-10-25 사용자 요청). 5분 눈금, 앞뒤 교대 사이로만 — 간격 갈래보다 먼저
      const pt = pushTimeIntent(clause, cur, now);
      if (pt) {
        if (pt.problem) { problems.push(`'${clause}' — ${pt.problem}`); continue; }
        if (pt.reset) {
          let any = false;
          for (const n of pt.ns) {
            const at0 = (E.project(cur, n, now)[n - 1] || {}).at;
            if (add(`${at0 ? hhmm(at0) : `${n}번째`} 교대 시각 원래대로`, (s, t) => E.clearPushTime(s, n, t))) any = true;
          }
          if (!any) notes.push('이번만 바꾼 교대 시각이 없습니다');
          continue;
        }
        const r = E.pushTimeRange(cur, pt.n, now);
        if (!r) { problems.push(`'${clause}' — ${pt.n}번째 교대가 예정 표에 없습니다`); continue; }
        const to = Math.round(pt.to(r.at) / (5 * MIN)) * 5 * MIN;
        if (to === r.at) { notes.push(`${hhmm(r.at)} 교대는 이미 그 시각입니다`); continue; }
        if (!(to > r.prev && to < r.after)) {
          problems.push(`'${clause}' — ${hhmm(r.at)} 교대는 ${pt.n === 1 ? '지금(또는 방금 교대)' : `앞 교대 ${hhmm(r.prev)}`} 뒤, 다음 교대 ${hhmm(r.after)} 전으로만 옮길 수 있습니다 (5분 눈금)`);
          continue;
        }
        const n = pt.n;
        add(`${hhmm(r.at)} 교대 → ${hhmm(to)} (이번만 — 뒤 교대는 원래 시각대로)`, (s, t) => E.setPushTime(s, n, to, t))
          || problems.push(`'${clause}' — 그 시각으로는 바꿀 수 없습니다`);
        continue;
      }

      // 1) 교대 간격: '15분 간격' · '15분마다' · '교대 간격 15분' · '3시부터 15분 간격으로 로테 돌게'
      const iv = rest.match(/(\d{1,3})\s*분\s*(?:간격|마다|씩|주기)/) || (/간격|교대|로테/.test(rest) ? rest.match(/(\d{1,3})\s*분/) : null);
      if (iv) {
        const m = Number(iv[1]);
        if (!(m >= 5 && m <= 120)) { problems.push(`'${clause}' — 교대 간격은 5~120분입니다`); continue; }
        if (!cur.clock.running) {
          add(`교대 간격 ${m}분 (설정 — 되돌리기 대상 아님)`, (s, t) => E.updateSettings(s, { pushMinutes: m }, t), 'setting') || notes.push(`교대 간격은 이미 ${m}분입니다`);
          if (at != null) notes.push(`로테이션 시작 전입니다 — ${hhmm(at)}에 [로테이션 시작]을 누르세요 (시작 시각을 적어도 됩니다)`);
          continue;
        }
        if (at == null && cur.settings.pushMinutes === m) { notes.push(`교대 간격은 이미 ${m}분입니다`); continue; }
        if (at != null && at > now + 60000) {
          const ok = add(`${hhmm(Math.round(at / (5 * MIN)) * 5 * MIN)}부터 교대 간격 ${m}분 — 그 시각에 교대하고 그 뒤 ${m}분마다`,
            (s, t) => E.scheduleInterval(s, at, m, t));
          if (!ok) problems.push(`'${clause}' — 그 시각으로는 간격을 예약할 수 없습니다`);
        } else {
          // 위쪽 교대 간격 칸에 숫자를 넣은 것과 같다 — 설정은 되돌리기 대상이 아니다 (CLAUDE.md 사용자 규칙)
          const ok = add(`지금부터 교대 간격 ${m}분 (설정 — 되돌리기 대상 아님, 숫자를 다시 넣으면 됩니다)`, (s, t) => E.updateSettings(s, { pushMinutes: m }, t), 'setting');
          if (!ok) notes.push(`교대 간격은 이미 ${m}분입니다`);
        }
        continue;
      }

      // 2) 일시정지 · 재개 (시각을 정한 일시정지는 하지 않는다 — 사용자가 '대회 브레이크 예약'은 원하지 않음)
      if (/일시\s*정지|멈춰|멈추|정지/.test(rest) || /재개|다시\s*시작|다시\s*돌/.test(rest)) {
        if (at != null) { problems.push(`'${clause}' — 시각을 정한 일시정지·재개는 하지 않습니다. 그때 [일시정지]를 눌러 주세요`); continue; }
        const resume = /재개|다시\s*시작|다시\s*돌/.test(rest);
        const ok = resume ? add('재개', (s, t) => E.resumeClock(s, t)) : add('일시정지', (s, t) => E.pauseClock(s, t));
        if (!ok) notes.push(resume ? '일시정지 중이 아닙니다' : '로테이션이 돌고 있지 않거나 이미 일시정지입니다');
        continue;
      }

      // 3) 테이블: '7번 열어' · '7-9번 1시 사용' · '2번 1시 깨기' · '3번 대기'
      const tb = rest.match(/((?:\d+\s*(?:[-~]\s*\d+)?\s*,?\s*)+)\s*번/);
      if (tb) {
        const nos = E.parseNos(tb[1]);
        const what = /깨|닫|폐쇄|클로즈/.test(rest) ? 'close' : /대기|사용\s*안|안\s*써|쉬게/.test(rest) ? 'idle'
          : /열|오픈|사용|시작|추가|투입/.test(rest) ? 'use' : null;
        if (!nos.length || !what) { problems.push(`'${clause}' — 테이블을 어떻게 할지 모르겠습니다 (열어 · 깨기 · 대기)`); continue; }
        const range = E.rangeText(nos);
        if (at == null) { // 지금 바로
          if (what === 'use') {
            add(`지금 ${range}번 테이블 사용 — 바로 딜러 투입`, (s, t) => {
              let x = s;
              const shut = nos.filter(no => !isOpen(x, no));
              if (shut.length) x = E.openTable(x, shut, t, { use: true });
              const idle = nos.map(no => tableByNo(x, no)).filter(y => y && y.status === 'open' && y.use === false).map(y => y.id);
              return idle.length ? E.setTableUse(x, idle, true, t) : x;
            }) || notes.push(`${range}번은 이미 사용 중입니다`);
          } else if (what === 'idle') {
            add(`지금 ${range}번 테이블 대기로 — 앉아 있던 딜러는 휴식`, (s, t) => {
              const ids = nos.map(no => tableByNo(s, no)).filter(y => y && y.status === 'open' && y.use !== false).map(y => y.id);
              return ids.length ? E.setTableUse(s, ids, false, t) : s;
            }) || notes.push(`${range}번은 사용 중인 테이블이 아닙니다`);
          } else {
            add(`지금 ${range}번 테이블 깨기`, (s, t) => nos.reduce((x, no) => (isOpen(x, no) ? E.closeTable(x, tableByNo(x, no).id, t) : x), s))
              || notes.push(`${range}번은 열린 테이블이 아닙니다`);
          }
          continue;
        }
        if (!cur.clock.running) { problems.push(`'${clause}' — 로테이션을 시작한 뒤에 교대 때로 예약할 수 있습니다`); continue; }
        const slot = slotOf(cur, at, now);
        if (!slot) { problems.push(`'${clause}' — 너무 먼 시각입니다 (앞으로 40번 교대 안)`); continue; }
        const when = `${hhmm(slot.at)} 교대${Math.abs(slot.at - at) > 60000 ? ` (${hhmm(at)} 뒤 첫 교대)` : ''}`;
        const run = (s, t) => {
          const sl = slotOf(s, at, t);
          if (!sl) return s;
          let x = s;
          if (what === 'use') {
            const shut = nos.filter(no => !isOpen(x, no));
            if (shut.length) x = E.openTable(x, shut, t, { use: false }); // 지금은 대기로 열어 두고 그 교대에 사용 시작
          }
          for (const no of nos) {
            const y = tableByNo(x, no);
            if (y && y.status === 'open') x = E.scheduleTable(x, y.id, sl.n, what, t);
          }
          return x;
        };
        const label = { use: '사용 시작', idle: '대기로', close: '깨기' }[what];
        const shutNow = what === 'use' ? nos.filter(no => !isOpen(cur, no)) : [];
        const ok = add(`${when}에 ${range}번 테이블 ${label}${shutNow.length ? ` (${E.rangeText(shutNow)}번은 지금 대기로 열어 둠)` : ''}`, run);
        if (!ok) problems.push(`'${clause}' — ${range}번은 ${what === 'use' ? '이미 사용 중입니다' : '열린 테이블이 아니거나 이미 그렇게 됩니다'}`);
        continue;
      }

      // 4) 출근 · 퇴근: '김민수 6시 출근' · '김민수, 이영희 퇴근'
      const ci = rest.match(/^(.*?)\s*(출근|퇴근)/);
      if (ci) {
        // 퇴근은 실제 딜러 이름만 (문장 속 다른 말을 이름으로 읽지 않게), 출근은 새 이름도 된다
        const who = ci[2] === '퇴근' ? dealersIn(ci[1], cur).map(d => d.name) : names(ci[1], cur);
        if (!who.length) { problems.push(`'${clause}' — 누구인지 ${ci[2] === '퇴근' ? '출근해 있는 딜러 ' : ''}이름을 적어 주세요`); continue; }
        if (ci[2] === '퇴근') {
          if (at != null && at > now + SLACK) { problems.push(`'${clause}' — 시각을 정한 퇴근 예약은 아직 없습니다. '${who[0]} 쉬러 나오면 퇴근'은 됩니다`); continue; }
          for (const name of who) {
            add(`${name} 퇴근`, (s, t) => {
              const d = s.dealers.find(x => x.name === name && x.status !== 'off');
              if (!d) return s;
              return d.status === 'planned' ? E.removePlanned(s, d.id, t) : E.sendHome(s, d.id, t);
            }) || problems.push(`${name} — 출근해 있는 딜러가 아닙니다`);
          }
          continue;
        }
        for (const name of who) {
          const later = at != null && at > now;
          add(later ? `${name} ${hhmm(at)} 출근 예정` : `${name} 출근${at != null ? ` (${hhmm(at)})` : ''}`, (s, t) => {
            const d = s.dealers.find(x => x.name === name && x.status !== 'off') || s.dealers.find(x => x.name === name);
            const soon = at != null && at > t;
            if (d && d.status === 'planned') return soon ? E.setPlanAt(s, d.id, at, t) : E.checkInDealer(s, d.id, t, t);
            if (d && d.status !== 'off') return s;
            if (d) return soon ? E.setPlanAt(s, d.id, at, t) : E.checkBack(s, d.id, t);
            const r = (s.roster || []).find(x => x.name === name);
            return E.addDealers(s, [{ name, grade: (r && r.grade) || 'B', at }], t);
          }) || notes.push(`${name}은(는) 이미 출근해 있습니다`);
        }
        continue;
      }

      // 명령으로 못 알아들은 말도 질문으로 한 번 더 ('지금 쉬는 사람' · '출근 예정')
      const a = answer(clause, cur, now);
      if (a) { answers.push({ q: clause, a }); continue; }
      problems.push(`'${clause}' — 알아듣지 못했습니다`);
    }
    return { steps, problems, notes, answers, examples: EXAMPLES, questions: QUESTION_EXAMPLES };
  }

  // 같은 말을 지금 state에 실행 (실행 직전에 다시 parse — 그 사이 교대가 지나가도 시각 기준으로 다시 정한다)
  function run(text, state, now) {
    const res = parse(text, state, now);
    let s = state;
    for (const st of res.steps) s = st.run(s, now);
    return { state: s, res };
  }

  return { parse, run, findTime, splitClauses, answer, EXAMPLES, QUESTION_EXAMPLES };
});
