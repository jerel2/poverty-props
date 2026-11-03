# Poverty Props

NBA and NFL player prop analyzer: value board, team head-to-head history, player-vs-opponent history and a player deep dive.

Live site: https://jerel2.github.io/poverty-props/

## How it updates
`.github/workflows/update.yml` runs at about 10:23 AM, 3:23 PM and 6:23 PM Eastern. It:
1. Downloads NBA box scores and schedules (ESPN data via sportsdataverse) and NFL stats, schedules and injury reports (nflverse).
2. Reads ESPN's injury feed and scoreboards for injuries, game lines and a score check.
3. Checks the data (recent games present, scores match, player points add up, injury names matched to real rosters).
4. Models every prop and publishes the site. If a league fails, the previous site stays up.

Nothing is stored in the repo: each run publishes a fresh copy and replaces the last one.
To run an update now: Actions tab → "Update data and publish site" → Run workflow.

## Limits
- No sportsbook prop odds feed, so lines and prices are estimates (EST) unless you enter your book's odds on a player's page.
- ESPN's feeds are public but undocumented and can change.
- GitHub pauses scheduled jobs in a repo with no activity for 60 days; it emails you first, and one click re-enables it.

## Files
- `index.html`: the app (also runs inside Claude as an artifact)
- `engine.js`: the projection and pricing model, shared by the app and the pipeline
- `pipeline.js`: download, checks, model and output (`node pipeline.js --help` style usage at the top of the file)
