/* 용지 렌더링: 참가확인증 / 상금바우처. 미리보기(화면)와 인쇄(#print-root) 공용 */
const Print = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtMoney = (n) => (n || 0).toLocaleString('ko-KR');
  const fmtTime = (ts) => { const d = new Date(ts || Date.now()); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };

  const PAPER = {
    '80mm': { width: '72mm', page: '80mm auto', margin: '4mm', font: 12 },
    'A5': { width: '138mm', page: 'A5 portrait', margin: '10mm', font: 14 },
    'A4': { width: '190mm', page: 'A4 portrait', margin: '10mm', font: 16 },
  };

  function head(tpl, sizeKey) {
    const pz = PAPER[sizeKey] || PAPER.A5;
    return `
      ${tpl.logoText ? `<div style="font-size:${pz.font * 0.9}px;letter-spacing:.2em;font-weight:700;color:#444">${esc(tpl.logoText)}</div>` : ''}
      <div style="font-size:${pz.font * 1.7}px;font-weight:900;margin:4px 0 2px">${esc(tpl.title)}</div>
      ${tpl.subtitle ? `<div style="font-size:${pz.font}px;color:#555">${esc(tpl.subtitle)}</div>` : ''}
      <div style="border-top:2px solid #000;margin:10px 0"></div>`;
  }
  function rowsHtml(rows, font) {
    return `<table style="width:100%;border-collapse:collapse;font-size:${font}px">` +
      rows.filter(Boolean).map(([k, v, big]) => `<tr><td style="padding:4px 0;color:#555;width:38%">${esc(k)}</td><td style="padding:4px 0;font-weight:${big ? 900 : 600};font-size:${big ? font * 1.6 : font}px;text-align:right">${v}</td></tr>`).join('') +
      '</table>';
  }
  function wrap(inner, sizeKey) {
    const pz = PAPER[sizeKey] || PAPER.A5;
    return `<div class="paper" style="width:${pz.width};padding:${pz.margin};font-size:${pz.font}px;text-align:center">${inner}</div>`;
  }

  /** 참가 확인증 */
  function confirmHtml(tpl, ctx) {
    const { player, event, table } = ctx;
    const pz = PAPER[tpl.paper] || PAPER.A5;
    const rows = [
      ['이벤트', esc(event.name)],
      tpl.showEntryNo && ['엔트리 번호', '#' + player.entryNo],
      ['플레이어', esc(player.name)],
      ['테이블 / 좌석', `<span style="font-size:${pz.font * 1.6}px;font-weight:900">T${table ? table.number : '-'} &nbsp;S${player.seat || '-'}</span>`],
      tpl.showBuyIn && ['바이인', fmtMoney(player.buyIn) + '원'],
      event.startChips ? ['스타팅 칩', fmtMoney(event.startChips)] : null,
      tpl.showPhone && player.phone && ['연락처', esc(player.phone)],
      tpl.showTime && ['등록 시각', fmtTime(player.registeredAt)],
    ];
    const inner = head(tpl, tpl.paper) + rowsHtml(rows, pz.font) +
      `<div style="border-top:1px dashed #000;margin:10px 0"></div>` +
      (tpl.footer ? `<div style="font-size:${pz.font * 0.85}px;color:#444;white-space:pre-wrap">${esc(tpl.footer)}</div>` : '');
    return wrap(inner, tpl.paper);
  }

  /** 상금 바우처 */
  function voucherHtml(tpl, ctx) {
    const { voucher, event } = ctx;
    const pz = PAPER[tpl.paper] || PAPER.A5;
    const rows = [
      tpl.showSerial && ['일련번호', esc(voucher.serial)],
      ['이벤트', esc(event ? event.name : '')],
      ['수령인', esc(voucher.playerName)],
      tpl.showRank && voucher.rank && ['최종 순위', voucher.rank + '위'],
      ['상금', fmtMoney(voucher.amount) + '원', true],
      voucher.note && ['비고', esc(voucher.note)],
      ['발행 시각', fmtTime(voucher.issuedAt)],
    ];
    const sig = tpl.showSignature ? `
      <div style="display:flex;justify-content:space-between;margin-top:${pz.font * 1.6}px;font-size:${pz.font * 0.9}px">
        <div style="flex:1;text-align:left">수령인 서명<div style="border-bottom:1px solid #000;height:${pz.font * 1.8}px;margin-right:12px"></div></div>
        <div style="flex:1;text-align:left">담당자 서명<div style="border-bottom:1px solid #000;height:${pz.font * 1.8}px"></div></div>
      </div>` : '';
    const inner = head(tpl, tpl.paper) + rowsHtml(rows, pz.font) + sig +
      `<div style="border-top:1px dashed #000;margin:10px 0"></div>` +
      (tpl.footer ? `<div style="font-size:${pz.font * 0.85}px;color:#444;white-space:pre-wrap">${esc(tpl.footer)}</div>` : '');
    return wrap(inner, tpl.paper);
  }

  /** 실제 인쇄 */
  function print(html, sizeKey) {
    const pz = PAPER[sizeKey] || PAPER.A5;
    const root = document.getElementById('print-root');
    let style = document.getElementById('print-page-style');
    if (!style) { style = document.createElement('style'); style.id = 'print-page-style'; document.head.appendChild(style); }
    style.textContent = `@page{size:${pz.page};margin:0} @media print{ #print-root .paper{box-shadow:none;margin:0} }`;
    root.innerHTML = html;
    const cleanup = () => { root.innerHTML = ''; window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => window.print(), 50);
  }

  const sample = () => ({
    player: { entryNo: 17, name: '홍길동', seat: 5, buyIn: 100000, phone: '010-1234-5678', registeredAt: Date.now() },
    event: { name: 'Main Event Day 1A', startChips: 30000 },
    table: { number: 3 },
    voucher: { serial: 'V0007', playerName: '홍길동', rank: 2, amount: 1250000, note: '', issuedAt: Date.now() },
  });

  return { confirmHtml, voucherHtml, print, sample, fmtMoney, fmtTime, esc, PAPER };
})();
