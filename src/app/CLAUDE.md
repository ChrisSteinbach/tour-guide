# App (PWA Frontend)

This is the Vite root (`vite.config.ts` sets `root: "src/app"`). Loads pre-computed tile data and performs nearest-neighbor queries at runtime.

## Browser Verification

After any UI change, verify visually in the browser before committing:

1. Start the dev server: `npm run dev`
2. Navigate to `https://localhost:5173/` using Playwright MCP
3. Walk through the affected flows (use "Or try with demo data" for quick testing)
4. Take screenshots at both desktop and mobile (375×667) widths
5. Check for interaction issues — dropdowns, focus states, transitions

**SSL note:** The dev server uses HTTPS via Vite's `basicSsl()` plugin with a self-signed certificate. The project `.mcp.json` configures Playwright MCP with `--ignore-https-errors` so this works automatically. If you still get `ERR_CERT_AUTHORITY_INVALID`, verify `.mcp.json` is present at the project root and the Playwright MCP server was restarted after any config changes.

## DOM Rebuild Behavior

The app does full DOM rebuilds on GPS position updates, so interactive elements (dropdowns, inputs) in the list view must survive re-renders. The `render()` function in `main.ts` skips re-rendering when the article list is unchanged to avoid this.
