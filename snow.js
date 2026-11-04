#!/usr/bin/env node
// Snow tracker: scores Alpine resorts reachable from Monaco using the Open-Meteo forecast API.
// Usage: node snow.js            (FORCE_SEND=true to send even with no GO resorts)
// Writes: email.html, GitHub step summary, data/history.csv, and step outputs send/subject.
const fs = require('fs');
const { execFileSync } = require('child_process');

const { settings: C, resorts } = JSON.parse(fs.readFileSync(`${__dirname}/config.json`, 'utf8'));
const force = process.env.FORCE_SEND === 'true';
const PAST = 3; // days of history pulled

// ---- fetch ----
const p = k => resorts.map(r => r[k]).join(',');
const url = 'https://api.open-meteo.com/v1/forecast'
  + `?latitude=${p('lat')}&longitude=${p('lon')}&elevation=${p('elev')}`
  + '&daily=snowfall_sum,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,weather_code'
  + `&hourly=snow_depth&past_days=${PAST}&forecast_days=7&timezone=Europe%2FParis`;
const raw = execFileSync('curl', ['-sSf', '--max-time', '30', '--retry', '3', '--retry-all-errors', url]).toString();
let data = JSON.parse(raw);
if (!Array.isArray(data)) data = [data];
if (data.length !== resorts.length) throw new Error(`Expected ${resorts.length} locations, got ${data.length}`);

// ---- score ----
const sum = a => a.reduce((s, v) => s + (v ?? 0), 0);
const icon = c => c <= 1 ? '☀️' : c <= 3 ? '⛅' : c <= 48 ? '🌫️'
  : (c >= 71 && c <= 77) || c === 85 || c === 86 ? '🌨️' : c >= 95 ? '⛈️' : '🌧️';
const dow = s => new Date(s + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const today = data[0].daily.time[PAST];

const results = resorts.map((r, k) => {
  const f = data[k], d = f.daily;
  const snow = d.snowfall_sum.map(v => v ?? 0);
  const depthOn = date => {
    const v = f.hourly.snow_depth.filter((x, i) => x != null && f.hourly.time[i].startsWith(date));
    return v.length ? Math.round(Math.max(...v) * 100) : 0;
  };

  let best = null;
  for (let i = PAST; i < d.time.length; i++) {
    const date = d.time[i];
    if (!(r.glacier || date >= r.opens)) continue;           // not open that day
    const depth = depthOn(date);
    if (!r.glacier && depth < C.minDepthCm) continue;       // not enough base
    const fresh48 = Math.round(snow[i - 1] + snow[i - 2]);
    const code = d.weather_code[i], wind = d.wind_speed_10m_max[i];
    const sunny = code <= 2, windy = wind > C.windLimitKmh;
    const score = fresh48 + (sunny ? 8 : 0) - (windy ? 10 : 0) - (snow[i] > 20 ? 5 : 0) + Math.min(depth, 150) / 10;
    if (!best || score > best.score) best = { date, fresh48, depth, code, wind: Math.round(wind), sunny, windy, score };
  }

  const recent = Math.round(sum(snow.slice(0, PAST)));
  const next3 = Math.round(sum(snow.slice(PAST, PAST + 3)));
  const depthToday = depthOn(today);
  const openNow = r.glacier || today >= r.opens;

  let verdict;
  if (best) verdict = best.fresh48 >= C.goFreshCm && !best.windy ? 'GO' : best.sunny && !best.windy ? 'GOOD' : 'OK';
  else if (recent + next3 >= 30) verdict = 'WATCH';
  else verdict = openNow ? 'THIN' : 'CLOSED';

  const rank = (best ? best.score : -100) - C.drivePenaltyPerH * r.driveH;
  return { ...r, recent, next3, depthToday, openNow, best, verdict, rank };
}).filter(r => r.driveH <= C.maxDriveH).sort((a, b) => b.rank - a.rank);

const go = results.filter(r => r.verdict === 'GO');
const send = go.length > 0 || C.alwaysSend || force;
const top = go[0] || results[0];
const subject = go.length
  ? `❄️ ${go.length} GO: ${top.name} ${dow(top.best.date)} (${top.best.fresh48} cm fresh, ${top.driveH}h drive)`
  : `Snow digest: no powder days. Top pick ${top.name} (${top.verdict})`;
const bestTxt = r => r.best ? `${dow(r.best.date)} ${icon(r.best.code)} · ${r.best.fresh48} cm fresh · ${r.best.wind} km/h` : '—';

// ---- outputs ----
// 1. Email HTML
const colour = { GO: '#1a7f37', GOOD: '#2f81f7', OK: '#6e7781', WATCH: '#bf8700', THIN: '#cf222e', CLOSED: '#8c959f' };
const rows = results.map(r => `<tr><td><b>${r.name}</b> <small>${r.country ?? ''}</small></td><td>${r.driveH}h</td><td>${r.glacier ? 'glacier' : r.depthToday + ' cm'}</td>
<td>${r.recent} cm</td><td>${r.next3} cm</td><td>${bestTxt(r)}</td>
<td style="color:${colour[r.verdict]};font-weight:bold">${r.verdict}</td></tr>`).join('\n');
const legend = `GO = ≥${C.goFreshCm} cm fresh in the 48h before the day, ≥${C.minDepthCm} cm base, wind &lt; ${C.windLimitKmh} km/h. `
  + 'GOOD = sunny with base. WATCH = big snow but not open yet. Depth is modelled (Open-Meteo), not the resort report. Check lift status before driving.';
fs.writeFileSync('email.html', `<div style="font-family:system-ui,sans-serif">
<h2 style="margin:0 0 8px">${subject}</h2>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px" border="1">
<tr style="background:#f0f3f6"><th>Resort</th><th>Drive</th><th>Depth</th><th>Last 72h</th><th>Next 72h</th><th>Best day (7d)</th><th>Verdict</th></tr>
${rows}</table><p style="font-size:12px;color:#57606a">${legend}</p></div>`);

// 2. Markdown summary (shown on the Actions run page)
const md = [`## ${subject}`, '', '| Resort | Drive | Depth | Last 72h | Next 72h | Best day (7d) | Verdict |', '|---|---|---|---|---|---|---|',
  ...results.map(r => `| ${r.name} (${r.country ?? ''}) | ${r.driveH}h | ${r.glacier ? 'glacier' : r.depthToday + ' cm'} | ${r.recent} cm | ${r.next3} cm | ${bestTxt(r)} | **${r.verdict}** |`),
  '', legend.replace('&lt;', '<')].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');

// 3. History log (one row per resort per day; re-runs on the same day replace that day)
fs.mkdirSync('data', { recursive: true });
const hist = 'data/history.csv', header = 'date,resort,depth_cm,last72_cm,next72_cm,verdict,best_day';
const old = fs.existsSync(hist) ? fs.readFileSync(hist, 'utf8').trim().split('\n').slice(1).filter(l => l && !l.startsWith(today)) : [];
const fresh = results.map(r => [today, `"${r.name}"`, r.depthToday, r.recent, r.next3, r.verdict, r.best?.date ?? ''].join(','));
fs.writeFileSync(hist, [header, ...old, ...fresh].join('\n') + '\n');

// 4. Telegram message (HTML parse mode: no tables, so one line per interesting resort)
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const emoji = { GO: '🟢', GOOD: '🔵', OK: '⚪', WATCH: '🟡' };
const flag = { FR: '🇫🇷', IT: '🇮🇹', CH: '🇨🇭', AT: '🇦🇹', DE: '🇩🇪' };
const MAX_LINES = 12; // keep the phone message short; the full table is on the run page
const shown = results.filter(r => emoji[r.verdict]);
const lines = shown.slice(0, MAX_LINES).map(r => r.best
  ? `${emoji[r.verdict]} ${flag[r.country] ?? ''} <b>${esc(r.name)}</b> (${r.driveH}h): ${dow(r.best.date)} ${icon(r.best.code)} ${r.best.fresh48} cm fresh, ${r.glacier ? 'glacier' : r.best.depth + ' cm base'}, ${r.best.wind} km/h`
  : `${emoji[r.verdict]} ${flag[r.country] ?? ''} <b>${esc(r.name)}</b> (${r.driveH}h): ${r.recent + r.next3} cm falling, not open yet`);
if (shown.length > MAX_LINES) lines.push(`…and ${shown.length - MAX_LINES} more`);
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
fs.writeFileSync('telegram.html', [`<b>${esc(subject)}</b>`, '',
  ...(lines.length ? lines : ['Nothing skiable in range.']),
  '', `<i>Modelled depth, check lift status before driving.</i>`, runUrl ? `<a href="${runUrl}">Full table</a>` : ''].join('\n').trim());

// 5. Step outputs
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `send=${send}\nsubject=${subject}\n`);
console.log(md);
console.log(`\nsend=${send}`);
