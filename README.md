# ❄️ snow-tracker

Every morning, GitHub Actions pulls a 7-day forecast for 50 resorts across the French, Swiss, Italian, Austrian and German Alps. It scores each resort on base depth, fresh snow, sun, wind and drive time, and alerts me when one is worth the trip.

No server and no API keys. It runs on free GitHub-hosted runners and the free [Open-Meteo](https://open-meteo.com/) API.

## How it works

```
cron 05:43 UTC ─▶ snow.js ─▶ Open-Meteo (one multi-location request)
                    │
                    ├─▶ score & rank every resort ─▶ verdict
                    ├─▶ job summary table (Actions run page)
                    ├─▶ data/history.csv (committed daily)
                    └─▶ if any GO: Telegram, email and/or ntfy push
```

For each resort, the script looks at the last 3 days and the next 7. It finds the best open day in the next week and ranks resorts by that day's score.

| Verdict | Meaning |
|---|---|
| **GO** | Open, ≥40 cm base, ≥15 cm fresh in the 48 h before, wind < 50 km/h |
| **GOOD** | Open, enough base, sunny |
| **OK** | Open, enough base |
| **WATCH** | Not open yet, but ≥30 cm over the last 3 + next 3 days |
| **THIN / CLOSED** | Not enough snow / out of season |

Alerts only go out when at least one resort is **GO** (set `alwaysSend: true` in `config.json` for a daily digest).

## Setup

1. **Notifications** (Settings → Secrets and variables → Actions → New repository secret). Set up any combination:
   - **Telegram:** create a bot with [@BotFather](https://t.me/BotFather) and save its token as `TELEGRAM_BOT_TOKEN`. Send your bot any message, open `https://api.telegram.org/bot<TOKEN>/getUpdates`, and save `message.chat.id` as `TELEGRAM_CHAT_ID`.
   - **Email:** `SMTP_USERNAME` = your Gmail address, `SMTP_PASSWORD` = a [Gmail app password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification), and optionally `MAIL_TO` if alerts should go to a different address.
   - **Phone push:** `NTFY_TOPIC` = a long random string. Install the [ntfy](https://ntfy.sh) app and subscribe to the same topic. Anyone who knows the topic can read it, so make it unguessable.
2. **Test:** Actions → Snow tracker → Run workflow → tick *force send*.

## Tuning

Everything lives in `config.json`: thresholds, the resort list, coordinates, forecast elevation, drive times and season opening dates. **Opening dates are typical estimates. Check them each season.**

## Limitations

- Snow depth is **modelled** by the weather model, not taken from the resort's snow report. Glaciers skip the depth check.
- There's no live lift-status data. Check the resort site before you drive.
- Scheduled runs can start a little late when GitHub is busy.
