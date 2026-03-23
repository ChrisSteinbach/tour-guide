# App (PWA Frontend)

This is the Vite root (`vite.config.ts` sets `root: "src/app"`). Loads pre-computed tile data and performs nearest-neighbor queries at runtime.

## Browser Verification

After any UI change, verify visually in the browser before committing:

1. Start the dev server: `npm run dev`
2. Navigate to `https://localhost:5173/` using Playwright MCP
3. Walk through the affected flows (use "Pick a spot on the map" to test without GPS)
4. Take screenshots at both desktop and mobile (375×667) widths
5. Check for interaction issues — dropdowns, focus states, transitions

**SSL note:** The dev server uses HTTPS via Vite's `basicSsl()` plugin with a self-signed certificate. The project `.mcp.json` configures Playwright MCP with `--ignore-https-errors` so this works automatically. If you still get `ERR_CERT_AUTHORITY_INVALID`, verify `.mcp.json` is present at the project root and the Playwright MCP server was restarted after any config changes.

## DOM Update Behavior

The app avoids full DOM rebuilds on GPS updates through two layers:

1. **State machine effects** — When a position update doesn't change the article list, the state machine emits `updateDistances` (which patches only distance badges via `updateNearbyDistances` in `render.ts`) instead of `renderBrowsingList` (which triggers a full list render).
2. **Title-keyed reconciliation** — When the article list does change, `renderNearbyList` in `render.ts` calls `reconcileListItems`, which reuses existing `<li>` nodes matched by article title and only creates nodes for new articles. Scroll position and focus are saved and restored across re-renders.
