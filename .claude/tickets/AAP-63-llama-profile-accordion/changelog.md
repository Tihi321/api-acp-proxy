# AAP-63: llama.cpp profile cards are accordions

- Each profile card shows only its header (chevron, label, badge, Start/Restart/Remove) and its warnings when collapsed; clicking the header (not its buttons) or pressing Enter/Space on the toggle button opens the fields.
- Cards start collapsed. A profile added with "Add profile" or "Create profile" opens. Open state is kept per profile id in localStorage (`llama.openProfiles`), so it survives re-renders and a window reopen.
- A failed save whose error path points at a profile (`providers.llama.profiles.N...`) opens that card (`revealErrors`, called from settings.ts `showErrors`).
- Files: src/renderer/llama-view.ts, src/renderer/settings.ts, src/renderer/settings.css.
