# AAP-57 changelog

- Llama.cpp page: the card of the running, starting, ready or failed profile shows a Restart button (the disabled Start is hidden while the profile runs). Restart saves unsaved edits like Start, stops llama-server (`stopLocalServer("llama")`), then starts the profile again via the existing start IPC. No new IPC or main-process change.
- New pure helper `profileButtons` (src/renderer/llama-models.ts) with a small test.
- README: one line.
- Speed after a request is already on the Monitor page; not added to the card.
