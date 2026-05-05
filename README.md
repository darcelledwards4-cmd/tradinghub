# ⚡ Trading Hub — Darcell's Setup Guide

A personal trading dashboard with live charts, news, options flow resources, trader activity feeds, AI-powered trade analysis, and a trade journal.

---

## Step 1 — Add Your Claude API Key

1. Open the `config.js` file in any text editor (Notepad, TextEdit, VS Code, etc.)
2. Replace `paste-your-key-here` with your actual Claude API key:
   ```js
   const CLAUDE_API_KEY = 'sk-ant-api03-...your key here...';
   ```
3. Save the file.

> ⚠️ **Never paste your API key into a chat or commit it to GitHub.** The `.gitignore` file already excludes `config.js` from being pushed, so you're protected as long as you don't manually add it.

---

## Step 2 — Open the Dashboard

Just open `index.html` in your browser. No server needed — double-click the file and it opens directly.

For the best experience, use **Google Chrome** or **Arc**.

---

## Step 3 — Connect to GitHub

This lets you version-control the project so every update is tracked and you can work on it from your terminal.

### One-time setup (do this once):

1. **Install Git** if you don't have it: https://git-scm.com/downloads
2. **Install GitHub Desktop** (easier than terminal for now): https://desktop.github.com
3. Open **GitHub Desktop** → File → Add Local Repository → select this `trading-hub` folder
4. It will prompt you to create a new repo — name it `trading-hub`, set it to **Private**
5. Click **Publish Repository** → this pushes it to your GitHub account (`darcelledwards4-cmd`)

### Making updates via terminal:

Once connected, any time you (or I) make changes to the files, you can push them to GitHub with:

```bash
cd path/to/trading-hub
git add .
git commit -m "your update message"
git push
```

Or just use GitHub Desktop — it's a visual interface for the same thing.

---

## Dashboard Tabs

| Tab | What's in it |
|-----|-------------|
| **Dashboard** | Live NVDA chart + market overview + latest news |
| **Charts** | Full-screen chart, switch between NVDA/SPY/QQQ/AAPL/MSFT/META/AMD/GOOGL/ARM/PLTR |
| **News & Flow** | Financial news feed + options flow resource links |
| **Trader Activity** | Stocktwits, Reddit, Twitter feeds + institutional/insider data links |
| **AI Analysis** | Describe a setup → get entry zone, stop loss, targets, R:R, options guidance |
| **Journal** | Log every trade with thesis, track P&L and win rate over time |

---

## Roadmap (coming next)

- [ ] Live options flow data piped directly in (Unusual Whales API)
- [ ] Price alerts for watchlist tickers
- [ ] Earnings calendar widget
- [ ] Auto-save journal to Google Sheets or Notion

---

## Notes

- **Trade Journal** data is saved in your browser's local storage — it persists between sessions on the same computer/browser.
- **AI Analysis** uses the Claude API directly. Cost is minimal (~$0.01–0.03 per analysis).
- Charts are powered by TradingView's free embed widgets — no account needed.
