'use strict';
/**
 * Self-contained HTML report (ctxray Pro).
 *
 * One file, no network, no build step. Charts are hand-rolled inline SVG rather
 * than a charting library so the output stays under ~200KB and opens instantly
 * from a file:// URL, an email attachment, or a CI artifact.
 */

const { CATEGORY_LABEL } = require('./classify');
const { defaults, inputCost, PRICES_CHECKED } = require('./models');
const { gradeFor } = require('./report-terminal');

const PALETTE = ['#e5484d', '#f76b15', '#ffb224', '#46a758', '#0090ff', '#8e4ec6', '#d6409f', '#12a594', '#8da4ef', '#a18072'];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Kept identical to src/ui.js `num` so the terminal and the HTML never disagree
// about the same figure.
function num(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function usd(n) {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function bytesFmt(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/** Donut chart of waste categories. */
function donut(categories, total) {
  const size = 220;
  const r = 82;
  const stroke = 30;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = [];

  categories.forEach((cat, i) => {
    const frac = cat.tokens / total;
    const len = frac * circ;
    arcs.push(
      `<circle class="arc" cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${PALETTE[i % PALETTE.length]}" stroke-width="${stroke}"
        stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})"><title>${esc(CATEGORY_LABEL[cat.category] || cat.category)}: ${num(cat.tokens)} tokens</title></circle>`
    );
    offset += len;
  });

  const rest = total - categories.reduce((s, c) => s + c.tokens, 0);
  if (rest > 0.5) {
    const len = (rest / total) * circ;
    arcs.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${stroke}"
        stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"></circle>`
    );
  }

  return `<svg viewBox="0 0 ${size} ${size}" class="donut" role="img" aria-label="Waste by category">
    ${arcs.join('\n')}
  </svg>`;
}

/** Horizontal bar list. */
function barList(rows, opts = {}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="barlist">${rows.map((r) => `
    <div class="barrow">
      <div class="barlabel" title="${esc(r.label)}">${esc(r.label)}</div>
      <div class="bartrack"><div class="barfill" style="width:${((r.value / max) * 100).toFixed(1)}%;background:${r.color || 'var(--accent)'}"></div></div>
      <div class="barvalue">${esc(r.display !== undefined ? r.display : num(r.value))}</div>
      ${opts.meta ? `<div class="barmeta">${esc(r.meta || '')}</div>` : ''}
    </div>`).join('')}</div>`;
}

/** Treemap of the heaviest files, squarified-ish. */
function treemap(files, width = 720, height = 260) {
  const total = files.reduce((s, f) => s + f.tokens, 0) || 1;
  const rects = [];
  // Simple slice-and-dice alternating layout; good enough visually and stable.
  let x = 0, y = 0, w = width, h = height;
  let remaining = total;
  let horizontal = true;

  files.forEach((f, i) => {
    const frac = f.tokens / remaining;
    let rw, rh;
    if (i === files.length - 1) {
      rw = w; rh = h;
    } else if (horizontal) {
      rw = Math.max(2, w * frac); rh = h;
    } else {
      rw = w; rh = Math.max(2, h * frac);
    }
    const color = f.waste ? '#e5484d' : '#0090ff';
    const opacity = 0.25 + 0.6 * (f.tokens / (files[0].tokens || 1));
    const name = f.path.split('/').pop();
    rects.push(`<g class="tmcell"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, rw - 2).toFixed(1)}" height="${Math.max(0, rh - 2).toFixed(1)}"
      fill="${color}" fill-opacity="${opacity.toFixed(2)}" rx="3"><title>${esc(f.path)}
${num(f.tokens)} tokens${f.waste ? ` — ${esc(f.waste.reason)}` : ''}</title></rect>
      ${rw > 62 && rh > 22 ? `<text x="${(x + 6).toFixed(1)}" y="${(y + 16).toFixed(1)}" class="tmlabel">${esc(name.slice(0, Math.floor(rw / 7)))}</text>` : ''}
      ${rw > 62 && rh > 36 ? `<text x="${(x + 6).toFixed(1)}" y="${(y + 30).toFixed(1)}" class="tmsub">${num(f.tokens)}</text>` : ''}
    </g>`);

    if (horizontal) { x += rw; w -= rw; } else { y += rh; h -= rh; }
    remaining -= f.tokens;
    horizontal = !horizontal;
  });

  return `<svg viewBox="0 0 ${width} ${height}" class="treemap" role="img" aria-label="Heaviest files">${rects.join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function build(report, opts = {}) {
  const t = report.totals;
  const models = opts.models && opts.models.length ? opts.models : defaults();
  const primary = models[0];
  const runsPerDay = opts.runsPerDay || 20;
  const wastePct = t.tokens ? t.wasteTokens / t.tokens : 0;
  const grade = gradeFor(wastePct);
  const gradeColor = { A: '#46a758', B: '#46a758', C: '#ffb224', D: '#f76b15', F: '#e5484d' }[grade.letter];
  const repoName = report.root.split(/[/\\]/).filter(Boolean).pop() || report.root;

  const dailyWaste = inputCost(primary, t.wasteTokens) * runsPerDay;

  const catRows = report.wasteCategories.slice(0, 10).map((cat, i) => ({
    label: CATEGORY_LABEL[cat.category] || cat.category,
    value: cat.tokens,
    color: PALETTE[i % PALETTE.length],
    display: num(cat.tokens),
    meta: `${cat.files} files`,
  }));

  const dirRows = report.directories.slice(0, 12).map((d) => ({
    label: d.dir,
    value: d.tokens,
    color: d.wasteTokens / (d.tokens || 1) > 0.5 ? '#e5484d' : '#0090ff',
    display: num(d.tokens),
    meta: `${((d.wasteTokens / (d.tokens || 1)) * 100).toFixed(0)}% waste`,
  }));

  const langRows = report.languages.slice(0, 10).map((l, i) => ({
    label: l.language,
    value: l.tokens,
    color: PALETTE[(i + 3) % PALETTE.length],
    display: num(l.tokens),
    meta: `${l.files} files`,
  }));

  const tableRows = [...report.files]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 400);

  const costRows = models.map((m) => {
    const full = inputCost(m, t.tokens);
    const lean = inputCost(m, t.signalTokens);
    const over = t.tokens / m.context;
    return `<tr>
      <td><strong>${esc(m.label)}</strong><span class="vendor">${esc(m.vendor)}</span></td>
      <td class="n">${usd(full)}</td>
      <td class="n good">${usd(lean)}</td>
      <td class="n save">−${usd(full - lean)}</td>
      <td class="n">${over > 1 ? `<span class="pill bad">${over.toFixed(1)}× over</span>` : `<span class="pill ${over > 0.5 ? 'warn' : 'ok'}">${(over * 100).toFixed(0)}% of window</span>`}</td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ctxray — ${esc(repoName)}</title>
<style>
:root{
  --bg:#fbfbfd; --panel:#ffffff; --ink:#16161a; --muted:#6b6b78; --line:#e6e6ec;
  --accent:#0090ff; --good:#46a758; --bad:#e5484d; --warn:#ffb224; --track:#ececeF;
  --shadow:0 1px 2px rgba(16,16,24,.05),0 8px 24px rgba(16,16,24,.05);
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0d0d11; --panel:#16161b; --ink:#f2f2f5; --muted:#9a9aa8; --line:#26262e;
    --track:#26262e; --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.3);
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 16px;font-weight:600}
.sub{color:var(--muted);font-size:13px;margin:0}
code,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}

header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:32px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.02em;font-size:14px;color:var(--muted);margin-bottom:10px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
.grade{display:flex;align-items:center;gap:14px;background:var(--panel);border:1px solid var(--line);
  border-radius:14px;padding:14px 18px;box-shadow:var(--shadow)}
.gradeletter{font-size:40px;font-weight:800;line-height:1;letter-spacing:-.04em}
.gradetext{font-size:13px;color:var(--muted);max-width:230px}

.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:var(--shadow);margin-bottom:20px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
@media(max-width:820px){.grid2,.grid3{grid-template-columns:1fr}}

.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid var(--line);
  border-radius:14px;overflow:hidden;background:var(--panel);box-shadow:var(--shadow);margin-bottom:20px}
.kpi{padding:20px 22px;border-right:1px solid var(--line)}
.kpi:last-child{border-right:0}
.kpi .v{font-size:28px;font-weight:750;letter-spacing:-.03em;line-height:1.1}
.kpi .k{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-top:6px}
@media(max-width:820px){.kpis{grid-template-columns:1fr 1fr}.kpi{border-bottom:1px solid var(--line)}}

.split{height:34px;border-radius:8px;overflow:hidden;display:flex;margin:6px 0 12px}
.split .s{background:var(--good)}
.split .w{background:var(--bad)}
.legend{display:flex;gap:22px;font-size:13px;color:var(--muted);flex-wrap:wrap}
.legend b{color:var(--ink)}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:7px;vertical-align:middle}

table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  font-weight:600;padding:0 10px 10px;border-bottom:1px solid var(--line)}
td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.vendor{display:block;font-size:11px;color:var(--muted);font-weight:400}
.good{color:var(--good)}.save{color:var(--good);font-weight:600}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600}
.pill.ok{background:color-mix(in srgb,var(--good) 14%,transparent);color:var(--good)}
.pill.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:#a86800}
.pill.bad{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
@media (prefers-color-scheme:dark){.pill.warn{color:var(--warn)}}

.barlist{display:flex;flex-direction:column;gap:9px}
.barrow{display:grid;grid-template-columns:150px 1fr 62px 78px;align-items:center;gap:12px;font-size:13px}
.barrow:has(.barmeta:empty){grid-template-columns:150px 1fr 62px}
.barlabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
.bartrack{background:var(--track);height:9px;border-radius:99px;overflow:hidden}
.barfill{height:100%;border-radius:99px}
.barvalue{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.barmeta{color:var(--muted);font-size:12px;text-align:right}
@media(max-width:640px){.barrow{grid-template-columns:110px 1fr 56px}.barmeta{display:none}}

.donutwrap{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.donut{width:200px;height:200px;flex:0 0 auto}
.arc{transition:opacity .15s}
.donut:hover .arc{opacity:.45}
.donut .arc:hover{opacity:1}
.donutlegend{flex:1;min-width:220px;display:flex;flex-direction:column;gap:7px;font-size:13px}
.donutlegend div{display:flex;align-items:center;justify-content:space-between;gap:10px}
.donutlegend span.nm{display:flex;align-items:center;min-width:0}
.donutlegend b{font-variant-numeric:tabular-nums}

.treemap{width:100%;height:auto;display:block;border-radius:10px}
.tmlabel{font:600 11px ui-monospace,monospace;fill:var(--ink);pointer-events:none}
.tmsub{font:400 10px ui-monospace,monospace;fill:var(--muted);pointer-events:none}
.tmcell rect{transition:fill-opacity .12s;cursor:default}
.tmcell:hover rect{fill-opacity:.95}

.callout{border-left:3px solid var(--bad);background:color-mix(in srgb,var(--bad) 6%,transparent);
  padding:16px 20px;border-radius:0 10px 10px 0;margin-bottom:20px}
.callout .big{font-size:24px;font-weight:750;letter-spacing:-.02em}
.callout.green{border-color:var(--good);background:color-mix(in srgb,var(--good) 7%,transparent)}

.filter{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg);
  color:var(--ink);font-size:13px;margin-bottom:14px;font-family:inherit}
.filter:focus{outline:2px solid color-mix(in srgb,var(--accent) 40%,transparent);outline-offset:1px;border-color:var(--accent)}
.scroll{max-height:520px;overflow:auto;border-radius:10px}
.flag{font-size:11px;color:var(--bad)}
.path{font-family:ui-monospace,monospace;font-size:12.5px;word-break:break-all}
.dim{color:var(--muted)}
footer{margin-top:36px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
footer a{color:var(--accent)}
.cmd{background:var(--track);padding:2px 7px;border-radius:5px;font-family:ui-monospace,monospace;font-size:12.5px}
ol.next{margin:0;padding-left:20px;line-height:2}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div>
    <div class="brand"><span class="dot"></span> ctxray</div>
    <h1>${esc(repoName)}</h1>
    <p class="sub mono">${esc(report.root)}</p>
    <p class="sub">${t.files.toLocaleString()} files · ${bytesFmt(t.bytes)} · scanned ${new Date(report.generatedAt).toLocaleString()} · ${esc(report.tokenizer)}</p>
    ${t.binary && t.binary.files ? `<p class="sub">${t.binary.files} binary file${t.binary.files === 1 ? '' : 's'} (${bytesFmt(t.binary.bytes)}) counted as zero tokens — agents skip them.</p>` : ''}
  </div>
  <div class="grade">
    <div class="gradeletter" style="color:${gradeColor}">${grade.letter}</div>
    <div class="gradetext">${esc(grade.label)}</div>
  </div>
</header>

<div class="kpis">
  <div class="kpi"><div class="v">${num(t.tokens)}</div><div class="k">Tokens in repo</div></div>
  <div class="kpi"><div class="v" style="color:var(--bad)">${(wastePct * 100).toFixed(0)}%</div><div class="k">Is waste</div></div>
  <div class="kpi"><div class="v" style="color:var(--good)">${num(t.reclaimableTokens)}</div><div class="k">Reclaimable</div></div>
  <div class="kpi"><div class="v">${usd(inputCost(primary, t.tokens))}</div><div class="k">Per full pass · ${esc(primary.label)}</div></div>
</div>

<div class="panel">
  <h2>Signal vs. waste</h2>
  <div class="split">
    <div class="s" style="width:${((1 - wastePct) * 100).toFixed(2)}%"></div>
    <div class="w" style="width:${(wastePct * 100).toFixed(2)}%"></div>
  </div>
  <div class="legend">
    <span><i class="swatch" style="background:var(--good)"></i><b>${num(t.signalTokens)}</b> signal — ${t.signalFiles.toLocaleString()} files</span>
    <span><i class="swatch" style="background:var(--bad)"></i><b>${num(t.wasteTokens)}</b> waste — ${t.wasteFiles.toLocaleString()} files</span>
    ${t.duplicateTokens ? `<span><b>${num(t.duplicateTokens)}</b> tokens are duplicate content</span>` : ''}
  </div>
</div>

${t.wasteTokens > 0 ? `<div class="callout">
  <div class="big">${usd(dailyWaste * 30)} / month burned on tokens the agent cannot use</div>
  <div class="sub" style="margin-top:6px">Assuming ${runsPerDay} full-context ${esc(primary.label)} calls per day at ${usd(primary.input)}/M input tokens.
  That is ${usd(dailyWaste)}/day and ${usd(dailyWaste * 365)}/year, before output tokens.</div>
</div>` : ''}

<div class="panel">
  <h2>Cost per full-context pass</h2>
  <table>
    <thead><tr><th>Model</th><th class="n">As-is</th><th class="n">After cleanup</th><th class="n">Saved</th><th class="n">Window fit</th></tr></thead>
    <tbody>${costRows}</tbody>
  </table>
  <p class="sub" style="margin-top:14px">Input-token prices checked ${PRICES_CHECKED}. Override with <span class="cmd">--pricing models.json</span>.</p>
</div>

<div class="grid2">
  <div class="panel">
    <h2>Waste by category</h2>
    <div class="donutwrap">
      ${donut(report.wasteCategories.slice(0, 8), t.tokens)}
      <div class="donutlegend">
        ${report.wasteCategories.slice(0, 8).map((cat, i) => `<div>
          <span class="nm"><i class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(CATEGORY_LABEL[cat.category] || cat.category)}</span>
          <b>${num(cat.tokens)}</b></div>`).join('')}
        <div><span class="nm"><i class="swatch" style="background:var(--track)"></i>Signal</span><b>${num(t.signalTokens)}</b></div>
      </div>
    </div>
  </div>
  <div class="panel">
    <h2>Heaviest directories</h2>
    ${barList(dirRows, { meta: true })}
  </div>
</div>

<div class="panel">
  <h2>Where the tokens live</h2>
  ${treemap(report.heaviest.slice(0, 30))}
  <p class="sub" style="margin-top:12px"><i class="swatch" style="background:#0090ff"></i>signal &nbsp;
  <i class="swatch" style="background:#e5484d"></i>waste &nbsp; — area is proportional to token count. Hover for details.</p>
</div>

<div class="grid2">
  <div class="panel">
    <h2>By language</h2>
    ${barList(langRows, { meta: true })}
  </div>
  <div class="panel">
    <h2>Worst individual offenders</h2>
    <table>
      <tbody>
      ${report.heaviest.filter((f) => f.waste).slice(0, 10).map((f) => `<tr>
        <td class="path">${esc(f.path)}<div class="flag">${esc(f.waste.reason)}</div></td>
        <td class="n"><strong>${num(f.tokens)}</strong><div class="dim" style="font-size:11px">${usd(inputCost(primary, f.tokens))}</div></td>
      </tr>`).join('') || '<tr><td class="dim">Nothing flagged. Nice repo.</td></tr>'}
      </tbody>
    </table>
  </div>
</div>

${report.duplicateGroups.length ? `<div class="panel">
  <h2>Duplicate content — ${num(t.duplicateTokens)} tokens paid for more than once</h2>
  <table>
    <thead><tr><th>Content</th><th class="n">Copies</th><th class="n">Wasted</th></tr></thead>
    <tbody>${report.duplicateGroups.slice(0, 10).map((g) => `<tr>
      <td class="path">${esc(g.paths[0])}<div class="dim" style="font-size:11.5px">${esc(g.paths.slice(1, 4).join(' · '))}${g.paths.length > 4 ? ` · +${g.paths.length - 4} more` : ''}</div></td>
      <td class="n">${g.copies}</td><td class="n">${num(g.wasted)}</td></tr>`).join('')}</tbody>
  </table>
</div>` : ''}

<div class="panel">
  <h2>Every file</h2>
  <input class="filter" id="q" placeholder="Filter by path, language, or reason…" autocomplete="off">
  <div class="scroll">
  <table id="files">
    <thead><tr><th>Path</th><th>Language</th><th class="n">Tokens</th><th class="n">Size</th><th>Status</th></tr></thead>
    <tbody>
    ${tableRows.map((f) => `<tr data-s="${esc((f.path + ' ' + f.language + ' ' + (f.waste ? f.waste.reason : 'signal')).toLowerCase())}">
      <td class="path">${esc(f.path)}</td>
      <td class="dim">${esc(f.language)}</td>
      <td class="n">${f.tokens.toLocaleString()}</td>
      <td class="n dim">${bytesFmt(f.bytes)}</td>
      <td>${f.waste ? `<span class="pill bad">waste</span><div class="flag">${esc(f.waste.reason)}</div>` : '<span class="pill ok">signal</span>'}</td>
    </tr>`).join('')}
    </tbody>
  </table>
  </div>
  ${report.files.length > tableRows.length ? `<p class="sub" style="margin-top:12px">Showing the ${tableRows.length} heaviest of ${report.files.length.toLocaleString()} files. Full data: <span class="cmd">ctxray --json</span></p>` : ''}
</div>

<div class="callout green">
  <div class="big">Next steps</div>
  <ol class="next">
    <li>Run <span class="cmd">ctxray init</span> to write a tuned <span class="cmd">.agentignore</span> and an <span class="cmd">AGENTS.md</span> scaffold.</li>
    <li>Run <span class="cmd">ctxray budget 100k</span> to pick the highest-value files that fit a focused window.</li>
    <li>Add <span class="cmd">ctxray --ci --max-waste ${Math.max(5, Math.round(wastePct * 100) - 10)}</span> to CI so this does not regress.</li>
  </ol>
</div>

<footer>
  Generated by <a href="https://github.com/geraltbhai/ctxray">ctxray</a> in ${report.durationMs}ms ·
  ${esc(report.tokenizer)} ·
  Token counts are estimates within a few percent; run with <span class="cmd">--exact</span> after
  <span class="cmd">npm i gpt-tokenizer</span> for exact BPE counts.
</footer>

</div>
<script>
(function(){
  var q=document.getElementById('q');
  if(!q) return;
  var rows=[].slice.call(document.querySelectorAll('#files tbody tr'));
  var timer;
  q.addEventListener('input',function(){
    clearTimeout(timer);
    timer=setTimeout(function(){
      var v=q.value.trim().toLowerCase();
      rows.forEach(function(r){
        r.style.display = !v || r.dataset.s.indexOf(v)!==-1 ? '' : 'none';
      });
    },90);
  });
})();
</script>
</body>
</html>`;
}

module.exports = { build };
