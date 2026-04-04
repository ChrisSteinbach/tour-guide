# Browser Testing Strategy

Browser tests are run by the agent using Playwright MCP — they are not an automated suite. The agent drives the browser interactively, observes results, and reports findings. This keeps tests adaptive to UI changes without maintenance overhead.

## When to test

- After any UI change (layout, interactions, styling)
- After changes to the state machine or rendering logic
- After changes to tile loading or data fetching

## Setup

Start the dev server (`npm run dev`) and use Playwright MCP to navigate to the app. Use "Pick a spot on the map" for flows that need a location — this avoids GPS mocking. See `src/app/CLAUDE.md` for SSL and dev server details.

Tile data is pipeline-generated and not in git. Check that `data/tiles/` has content before testing language switching or data-dependent flows.

## What to verify

### Core flows

- Welcome screen renders with language selector, both entry buttons, and about link
- "Pick a spot on the map" → map picker → click → confirm → article list appears
- "Use my location" → article list appears (requires geolocation permission)
- Clicking an article → detail view with title, description, thumbnail, Wikipedia link
- Back navigation returns to the article list

### Interactions

- Language switching (welcome dropdown and browsing header) persists to localStorage
- About dialog opens/closes, traps focus, returns focus to trigger on close
- Map drawer: auto-opens on desktop (>=1024px), toggle via handle on mobile
- GPS mode: pause/resume, mode toggle between GPS and picked location
- Keyboard: Tab reaches all interactive elements, Enter activates articles and buttons

### Responsive layout

- Desktop (1280px): map drawer visible alongside article list
- Mobile (375x667): full-width layout, drawer collapsed behind handle
- Resize between breakpoints triggers correct layout changes

### Error states

- GPS permission denied → error message with "Pick on map" fallback
- Tile data unavailable (404) → "No data available" with language selector
- Wikipedia API failure → retry button and fallback Wikipedia link on detail view

### Edge cases

- Browser back/forward navigation between views
- Only one marker at a time in map picker
- Confirm button in map picker works at all zoom levels

## How thorough

Not every PR needs the full checklist. Match depth to risk:

- **Styling-only change:** Spot-check the affected component at desktop and mobile widths.
- **Single-feature change:** Test the changed flow end-to-end plus one adjacent flow.
- **State machine or rendering change:** Run core flows, interactions, and responsive checks.
- **Data format or tile loading change:** Run everything — these affect the whole app.

Take screenshots at key steps for the PR record. Flag anything broken rather than trying to fix it silently.
