# AAP-27 app actions preamble

Problem: the plain preamble in src/api.ts buildPrompt says "This is a text-only API request. Do not use tools, ..." and codex refuses apps' JSON-action prompts ("I can't use tools in this text-only request").

Plan (branch AAP-27_app-actions-preamble):
1. src/api.ts: plain preamble becomes "This is an API request[ with text and images]. Do not use your own environment: no shell commands, no file access, no web access, no permission requests. If the conversation describes actions, functions or a JSON format for you to produce, produce them as text exactly as asked: the calling application executes them. Respond with the answer only." The extra provider line stays appended. Tools (native tool calls) path uses toolsPreamble, untouched, so no contradiction; web-search/image preambles untouched.
2. Update tests that pin the old string (antigravity, image-generation, images, mcp-servers, tool-calling, web-search).
3. README/ROADMAP: AAP-27 entry.
4. typecheck, test, build; live A/B 5+5 codex/gpt-5.6-luna on 7461 (old) vs 7471 (new); stop 7471.
5. Commit with Co-Authored-By: Claude Opus 5.5 trailer, no push.
