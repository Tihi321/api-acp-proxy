# Research: why "Inkling 2 Mini (Q4_0, vision)" could not start after AAP-54

## Question
Why does Start fail for the llama profile `inkling-2-mini` after the AAP-54 merge?

## Answer
Cause (confirmed): the profile's saved `extraArgs` contains `--no-mmap` (added by AAP-54). The installed llama-server b12651 (and every other build in D:\LlamaCpp\bin) no longer has that flag and exits with code 1.

Evidence, `%APPDATA%\api-acp-proxy\logs\proxy.log` lines 17026, 17059, 17074, 17091 (4 start attempts, 10:59:27Z to 11:00:16Z on 2026-11-24):
`WARN [local] llama: exited with code 1: error: invalid argument: --no-mmap`

Fix: code change in the presets (AAP-54 research-flags.md assumed `--no-mmap` exists; it does not in these builds). User workaround: remove `--no-mmap` from the profile's extra args.

## Path through the code
- **confirmed** `src/llama-args.ts:31-53` `buildLlamaArgs` appends `profile.extraArgs` verbatim at the end. Nothing validates flags.
- **confirmed** `src/settings.ts:133-134` `STRIX_HALO_ROCM = "--no-mmap -ub 1024 -np 1 -t 16"`, used in the preset extraArgs (`:141`) and in the flagPresets (settings.json shows 3 of the 4 flag presets contain `--no-mmap`).
- The app logs a child exit as `[local] llama: exited with code N: <last output line>` (log lines above). The UI showed "Saved. The server was restarted." only; the exit message was not shown there (inferred from the screenshot description; the exit reason is only in proxy.log).

## Saved settings (read-only; no secrets printed)
providers.llama: enabled, port 8082, modelsDir D:\LlamaCpp\models, binary mode managed, installed = ggml-org b12651 rocm, command `D:\LlamaCpp\bin\ggml-org-b12651-rocm\llama-server.exe`.
Profile inkling-2-mini (confirmed in settings.json): model IQ4_NL.gguf + mmproj Q8_0, ctx 32768, gpuLayers all, flashAttn auto, spec none, requires minBuild 12607 / sources unsloth (b12651 >= 12607, so the build gate passes),
`extraArgs = "--no-mmap -ub 1024 -np 1 -t 16 --temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0"`.
The profile was edited, so it was not left as the stored old one: the extra args were applied from a flag preset (same string as flag preset "strix-halo-rocm").

## Reconstructed command (inferred from buildLlamaArgs, not executed)
```
D:\LlamaCpp\bin\ggml-org-b12651-rocm\llama-server.exe -m "D:\LlamaCpp\models\ggml-org\Inkling-2-Mini-GGUF\Inkling-2-Mini-IQ4_NL.gguf" --host 127.0.0.1 --port 8082 --alias inkling-2-mini --metrics -c 32768 -ngl all -fa auto --mmproj "D:\LlamaCpp\models\ggml-org\Inkling-2-Mini-GGUF\mmproj-Inkling-2-Mini-Q8_0.gguf" --no-mmap -ub 1024 -np 1 -t 16 --temp 1.0 --top-p 1.0 --top-k 0 --min-p 0.0
```
(port per settings; the actual port is chosen by the launcher's `{port}`.)

## Flag check against `llama-server.exe --help` (b12651; the same in b12613 and both unsloth builds, confirmed by running --help only)
- `-m`, `--alias`, `--metrics` (line 647), `-c`, `-ngl` (139), `-fa [on|off|auto]` (39), `--mmproj` (485), `-ub` (31), `-np` (479), `-t` (7), `--temp`, `--top-p`, `--top-k`, `--min-p` (267-273): present.
- `--no-mmap`: **absent**. `--help` has no `--mmap`, `--no-mmap`, `--mlock`; they were replaced by `-lm, --load-mode MODE` (auto | none | mmap | mlock | mmap+mlock | dio), help lines 87-102. `grep -c -- "--no-mmap"` returns 0 for all four installed builds.
- Also relevant: `--spec-draft-sampling {greedy,probabilistic}` (385), `-ctk/-ctv` (75/80), `--spec-type` list incl. draft-dspark (401) exist. So the "dspark-probabilistic" and "kv-q8" flag presets are valid apart from their `--no-mmap`.

## Other checks
- Port: `netstat -ano` LISTENING shows only 127.0.0.1:8083 (embedding server, pid 17160) among 8080-8090. Nothing on 8082 and no Strata on 8080. Not the cause (confirmed).
- Files exist (confirmed `ls`): Inkling-2-Mini-IQ4_NL.gguf and mmproj-Inkling-2-Mini-Q8_0.gguf in D:\LlamaCpp\models\ggml-org\Inkling-2-Mini-GGUF\. Not the cause.
- No VRAM/RAM/OOM message in the log; the process exits immediately at argument parsing.
- Earlier runs worked (log lines 16556-16897 on 2026-11-23, before the flags were added).
- App build: dist/ compiled 2026-11-24 11:41, release installer 11:42, portable exe 11:48, merge commit 11:40:14. Both are after the merge, so the packaged app contains AAP-54. Which of Setup/Portable/dev run was used is unknown (the failures at 10:59-11:00 UTC = 11:59-12:00 local, after the builds, so it is the new code). (confirmed timestamps; which exe was launched is inferred.)

## What the plan needs
Options:
1. Replace `--no-mmap` with `-lm none` (or drop it; the AAP-54 research said no-mmap affects load time only and its benefit is disputed) in `STRIX_HALO_ROCM` (`src/settings.ts:134`), the flagPresets (seeded presets in settings.ts), and tests/plan docs that assert the string (tests/llama-args.test.ts per plan.md:204). Caveat: `-lm none` semantics ("no special loading mode") vs the old `--no-mmap` should be verified on a real load; not run here.
2. Because stored profiles and the seeded flagPresets are not rewritten (changelog), existing users need a migration, or the user edits the profile and the 3 flag presets by hand.
3. Surface the exit reason: the Llama page / save message only said "Saved. The server was restarted."; show the `exited with code 1: ...` line as an error (src/local-servers.ts / local-host.ts, not read in detail).
4. Optional: warn when extraArgs contains a flag missing from `--help` of the active build.

User workaround now: in the profile (and flag preset) delete `--no-mmap`, keep `-ub 1024 -np 1 -t 16 ...`, then Start.

## Risks
- The same `--no-mmap` is in 3 flag presets and in the DSpark preset on a different profile (settings.json shows `extraArgs` of dspark without it, because it holds the old string); any newly created profile from the preset fails the same way.
- Unsloth builds also lack `--no-mmap`, so switching build does not help.

## Open questions
- What `-lm none` does on ROCm/Strix Halo vs the old `--no-mmap` (not run).
- Whether the UI shows the exit reason anywhere (not read; the screenshot showed none).
- Which exe the user ran (Setup, Portable, dev).

Reproduction: not re-run (starting the server is not allowed here); the log shows the failure 4 times and `--help` confirms the flag is gone.
