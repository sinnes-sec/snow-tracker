#!/usr/bin/env node
// Snow tracker: scores Alpine resorts using the Open-Meteo forecast API (main forecast + 3 cross-check models).
// Usage: node snow.js            (FORCE_SEND=true to send even with nothing to report)
// Writes: email.html, telegram.html, GitHub step summary, data/history.csv, and step outputs send/subject.
const fs = require('fs');
const { execFileSync } = require('child_process');

const { settings: C, resorts } = JSON.parse(fs.readFileSync(`${__dirname}/config.json`, 'utf8'));
const force = process.env.FORCE_SEND === 'true';
const PAST = 3;                                                     // days of history pulled
const MODELS = ['ecmwf_ifs025', 'icon_seamless', 'meteofrance_seamless']; // cross-check models

// ---- fetch ----
const p = k => resorts.map(r => r[k]).join(',');
const base = 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${p('lat')}&longitude=${p('lon')}&elevation=${p('elev')}`
  + `&past_days=${PAST}&forecast_days=7&timezone=Europe%2FParis`;
const get = url => {
  let data = JSON.parse(execFileSync('curl', ['-sSf', '--max-time', '60', '--retry', '4', '--retry-all-errors', url]).toString());
  if (!Array.isArray(data)) data = [data];
  if (data.length !== resorts.length) throw new Error(`Expected ${resorts.length} locations, got ${data.length}`);
  return data;
};
const data = get(base + '&daily=snowfall_sum,rain_sum,temperature_2m_max,wind_speed_10m_max,weather_code&hourly=snow_depth');
let models = null;
try { models = get(base + `&daily=snowfall_sum&models=${MODELS.join(',')}`); }
catch (e) { console.error('Cross-check models unavailable, using main forecast only:', e.message); }

// ---- helpers ----
const sum = a => a.reduce((s, v) => s + (v ?? 0), 0);
const icon = c => c <= 1 ? '☀️' : c <= 3 ? '⛅' : c <= 48 ? '🌫️'
  : (c >= 71 && c <= 77) || c === 85 || c === 86 ? '🌨️' : c >= 95 ? '⛈️' : '🌧️';
const dow = s => new Date(s + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const today = data[0].daily.time[PAST];
const link = r => r.url || `https://www.google.com/search?q=${encodeURIComponent(r.name + ' ski lift status webcam')}`;

// Snow over days [i-2, i-1] (or any window) according to each cross-check model.
// Returns { agree, total } = how many models with data show at least `need` cm.
const crossCheck = (k, from, to, need) => {
  if (!models) return { agree: 0, total: 0 };
  const d = models[k].daily;
  let agree = 0, total = 0;
  for (const m of MODELS) {
    const s = d[`snowfall_sum_${m}`];
    if (!s) continue;
    const win = s.slice(from, to + 1);
    if (win.some(v => v == null)) continue;            // model doesn't reach that far ahead
    total++;
    if (sum(win) >= need) agree++;
  }
  return { agree, total };
};
const confirmed = ({ agree, total }) => total === 0 || agree >= Math.ceil(total / 2);
const confTxt = ({ agree, total }) => total ? `${agree}/${total} models agree` : 'single model';

// ---- score ----
const results = resorts.map((r, k) => {
  const f = data[k], d = f.daily;
  const snow = d.snowfall_sum.map(v => v ?? 0);
  const rain = (d.rain_sum ?? []).map(v => v ?? 0);
  const depthOn = date => {
    const v = f.hourly.snow_depth.filter((x, i) => x != null && f.hourly.time[i].startsWith(date));
    return v.length ? Math.round(Math.max(...v) * 100) : 0;
  };
  const isOpen = date => r.glacier || date >= r.opens;

  // Best ski day in the next 7 days
  let best = null;
  for (let i = PAST; i < d.time.length; i++) {
    const date = d.time[i];
    if (!isOpen(date)) continue;
    const depth = depthOn(date);
    if (!r.glacier && depth < C.minDepthCm) continue;
    const fresh48 = Math.round(snow[i - 1] + snow[i - 2]);
    const code = d.weather_code[i], wind = d.wind_speed_10m_max[i], tmax = d.temperature_2m_max[i];
    const sunny = code <= 2, windy = wind > C.windLimitKmh;
    const warm = tmax > C.warmLimitC;                              // heavy / slushy snow
    const rainy = (rain[i] ?? 0) + (rain[i - 1] ?? 0) > C.rainLimitMm; // rain on or just before the day
    const score = fresh48 + (sunny ? 8 : 0) - (windy ? 10 : 0) - (snow[i] > 20 ? 5 : 0)
      - (warm ? 8 : 0) - (rainy ? 12 : 0) + Math.min(depth, 150) / 10;
    if (!best || score > best.score) best = { i, date, fresh48, depth, code, wind: Math.round(wind), tmax: Math.round(tmax), sunny, windy, warm, rainy, score };
  }

  // Heads-up: big snowfall forecast 2+ days out, on a day the resort is open
  let heads = null;
  for (let i = PAST + 2; i < d.time.length; i++) {
    if (!isOpen(d.time[i])) continue;
    const amt = Math.round(snow[i - 1] + snow[i]);
    if (amt >= C.bigSnowCm && (!heads || amt > heads.amt)) heads = { date: d.time[i], amt, check: crossCheck(k, i - 1, i, C.bigSnowCm * 0.6) };
  }
  if (heads && !confirmed(heads.check)) heads = null;

  const recent = Math.round(sum(snow.slice(0, PAST)));
  const next3 = Math.round(sum(snow.slice(PAST, PAST + 3)));
  const depthToday = depthOn(today);
  const openNow = isOpen(today);

  let verdict, check = null;
  if (best) {
    const powder = best.fresh48 >= C.goFreshCm && !best.windy && !best.warm && !best.rainy;
    if (powder && best.i > PAST + C.goWithinDays) verdict = 'SOON';  // powder later in the week: heads-up territory
    else if (powder) {
      check = crossCheck(k, best.i - 2, best.i - 1, C.goFreshCm * 0.6);
      verdict = confirmed(check) ? 'GO' : 'MAYBE';   // MAYBE = main forecast says powder, other models don't
    } else verdict = best.sunny && !best.windy && !best.rainy ? 'GOOD' : 'OK';
  } else if (recent + next3 >= 30) verdict = 'WATCH';
  else verdict = openNow ? 'THIN' : 'CLOSED';

  const rank = (best ? best.score : -100) - C.drivePenaltyPerH * r.driveH;
  return { ...r, recent, next3, depthToday, openNow, best, verdict, check, heads, rank };
}).filter(r => r.driveH <= C.maxDriveH);
const PRIORITY = ['GO', 'MAYBE', 'SOON', 'GOOD', 'OK', 'WATCH', 'THIN', 'CLOSED'];
results.sort((a, b) => PRIORITY.indexOf(a.verdict) - PRIORITY.indexOf(b.verdict) || b.rank - a.rank);

const go = results.filter(r => r.verdict === 'GO');
const heads = results.filter(r => r.heads && r.verdict !== 'GO').sort((a, b) => b.heads.amt - a.heads.amt);
const send = go.length > 0 || heads.length > 0 || C.alwaysSend || force;
const subject = go.length
  ? `❄️ ${go.length} GO: ${go[0].name} ${dow(go[0].best.date)} (${go[0].best.fresh48} cm fresh)`
  : heads.length
    ? `📅 Big snow coming: ${heads[0].name} ${dow(heads[0].heads.date)} (${heads[0].heads.amt} cm forecast)`
    : `Snow digest: no powder days. Top pick ${results[0].name} (${results[0].verdict})`;
const flags = b => [b.warm && `🌡️ ${b.tmax}°C`, b.rainy && '🌧️ rain'].filter(Boolean).join(' ');
const bestTxt = r => r.best
  ? `${dow(r.best.date)} ${icon(r.best.code)} · ${r.best.fresh48} cm fresh · ${r.best.wind} km/h ${flags(r.best)}`.trim() : '—';

// ---- outputs ----
// 1. Email HTML
const colour = { GO: '#1a7f37', MAYBE: '#d1242f', SOON: '#8250df', GOOD: '#2f81f7', OK: '#6e7781', WATCH: '#bf8700', THIN: '#cf222e', CLOSED: '#8c959f' };
const rows = results.map(r => `<tr><td><a href="${link(r)}"><b>${r.name}</b></a> <small>${r.country ?? ''}</small></td><td>${r.driveH}h</td>
<td>${r.glacier ? 'glacier' : r.depthToday + ' cm'}</td><td>${r.recent} cm</td><td>${r.next3} cm</td><td>${bestTxt(r)}</td>
<td style="color:${colour[r.verdict]};font-weight:bold">${r.verdict}${r.check ? `<br><small>${confTxt(r.check)}</small>` : ''}</td></tr>`).join('\n');
const legend = `GO = powder day within ${C.goWithinDays} days: ≥${C.goFreshCm} cm fresh in the 48h before the day, ≥${C.minDepthCm} cm base, wind &lt; ${C.windLimitKmh} km/h, `
  + `max ≤ ${C.warmLimitC}°C, no rain, and most cross-check models agree. MAYBE = only the main forecast shows powder. SOON = powder day later this week. `
  + `GOOD = sunny with base. WATCH = big snow but not open yet. 📅 Heads-up = ≥${C.bigSnowCm} cm forecast in 48h, 2+ days out. `
  + 'Depth is modelled (Open-Meteo), not the resort report. Check lift status before driving.';
const headsHtml = heads.length ? `<h3>📅 Heads-up</h3><ul>${heads.map(r => `<li><a href="${link(r)}">${r.name}</a>: ${r.heads.amt} cm by ${dow(r.heads.date)} (${confTxt(r.heads.check)})</li>`).join('')}</ul>` : '';
fs.writeFileSync('email.html', `<div style="font-family:system-ui,sans-serif">
<h2 style="margin:0 0 8px">${subject}</h2>${headsHtml}
<table cellpadding="6" style="border-collapse:collapse;font-size:14px" border="1">
<tr style="background:#f0f3f6"><th>Resort</th><th>Drive</th><th>Depth</th><th>Last 72h</th><th>Next 72h</th><th>Best day (7d)</th><th>Verdict</th></tr>
${rows}</table><p style="font-size:12px;color:#57606a">${legend}</p></div>`);

// 2. Markdown summary (shown on the Actions run page)
const md = [`## ${subject}`, '',
  ...(heads.length ? ['### 📅 Heads-up', ...heads.map(r => `- [${r.name}](${link(r)}): ${r.heads.amt} cm by ${dow(r.heads.date)} (${confTxt(r.heads.check)})`), ''] : []),
  '| Resort | Drive | Depth | Last 72h | Next 72h | Best day (7d) | Verdict |', '|---|---|---|---|---|---|---|',
  ...results.map(r => `| [${r.name}](${link(r)}) (${r.country ?? ''}) | ${r.driveH}h | ${r.glacier ? 'glacier' : r.depthToday + ' cm'} | ${r.recent} cm | ${r.next3} cm | ${bestTxt(r)} | **${r.verdict}**${r.check ? ` (${confTxt(r.check)})` : ''} |`),
  '', legend.replace('&lt;', '<')].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');

// 3. History log (one row per resort per day; re-runs on the same day replace that day)
fs.mkdirSync('data', { recursive: true });
const hist = 'data/history.csv', header = 'date,resort,depth_cm,last72_cm,next72_cm,verdict,best_day';
const old = fs.existsSync(hist) ? fs.readFileSync(hist, 'utf8').trim().split('\n').slice(1).filter(l => l && !l.startsWith(today)) : [];
const fresh = results.map(r => [today, `"${r.name}"`, r.depthToday, r.recent, r.next3, r.verdict, r.best?.date ?? ''].join(','));
fs.writeFileSync(hist, [header, ...old, ...fresh].join('\n') + '\n');

// 4. Telegram message (HTML parse mode: no tables, so one line per interesting resort)
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const emoji = { GO: '🟢', MAYBE: '🟠', SOON: '🟣', GOOD: '🔵', OK: '⚪', WATCH: '🟡' };
const flag = { FR: '🇫🇷', IT: '🇮🇹', CH: '🇨🇭', AT: '🇦🇹', DE: '🇩🇪' };
const MAX_LINES = 12, MAX_HEADS = 5;
const nameTag = r => `${flag[r.country] ?? ''} <a href="${esc(link(r))}">${esc(r.name)}</a> (${r.driveH}h)`;
const shown = results.filter(r => emoji[r.verdict]);
const lines = shown.slice(0, MAX_LINES).map(r => r.best
  ? `${emoji[r.verdict]} ${nameTag(r)}: ${dow(r.best.date)} ${icon(r.best.code)} ${r.best.fresh48} cm fresh, ${r.glacier ? 'glacier' : r.best.depth + ' cm base'}, ${[`${r.best.wind} km/h`, flags(r.best)].filter(Boolean).join(' ')}${r.check ? ` · ${confTxt(r.check)}` : ''}`
  : `${emoji[r.verdict]} ${nameTag(r)}: ${r.recent + r.next3} cm falling, not open yet`);
if (shown.length > MAX_LINES) lines.push(`…and ${shown.length - MAX_LINES} more`);
const headLines = heads.slice(0, MAX_HEADS).map(r => `📅 ${nameTag(r)}: ${r.heads.amt} cm by ${dow(r.heads.date)} · ${confTxt(r.heads.check)}`);
if (heads.length > MAX_HEADS) headLines.push(`…and ${heads.length - MAX_HEADS} more`);
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
fs.writeFileSync('telegram.html', [`<b>${esc(subject)}</b>`, '',
  ...(lines.length ? lines : ['Nothing skiable right now.']),
  ...(headLines.length ? ['', '<b>Heads-up</b>', ...headLines] : []),
  '', `<i>Modelled depth, tap a resort for lift status and webcams.</i>`, runUrl ? `<a href="${runUrl}">Full table</a>` : ''].join('\n').trim());

// 5. Step outputs
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `send=${send}\nsubject=${subject}\n`);
console.log(md);
console.log(`\nsend=${send}`);
