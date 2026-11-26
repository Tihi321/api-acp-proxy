# AAP-66 research: PrismML fork HIP build on gfx1151 (2026-11-26)

## Release
- Latest: tag `prism-b12232-f702476` (build 12232, commit f70247610), PrismML-Eng/llama.cpp.
- Windows zips: cpu-x64, cpu-arm64, cuda-12.4/13.3/13.4-arm64, hip-radeon-x64 (387,893,302 B), sycl-x64, **vulkan-x64 present** (28.9 MB, not downloaded).
- Extracted to D:\LlamaCpp\bin\prism-b12232-f702476-hip-radeon (zip kept in .claude/temp/dl). Nothing run besides llama-server.exe --version/--help.

## GPU targets
- Workflow .github/workflows/release-prism.yml windows-hip gpu_targets: gfx1150;gfx1151;gfx1200;gfx1201;gfx1100;gfx1101;gfx1102;gfx1030;gfx1031;gfx1032;gfx1035;gfx1103. **gfx1151 included: yes.**
- ggml-hip.dll contains the strings gfx1151/1150/1100-1102/1200/1201 (no gfx900/906). hipblaslt/library has gfx1151 files; rocblas/library has 96 files matching 1151.
- Bundled: libhipblas.dll, libhipblaslt.dll, rocblas.dll, rocblas/ and hipblaslt/ library folders. Other HIP runtime DLLs (amdhip64, etc.) are not in the zip, so the ROCm SDK bin on PATH is still probably needed (same as the ggml-org rocm builds; verify in phase 2).
- Windows HIP built with HIP SDK 26.Q1 (not ROCm 7.2).

## Version / options
- `llama-server --version`: version 0.7.0-dev (build 12232, commit f70247610), Clang 21.0.0 Windows AMD64.
- `--spec-type` lists: none, draft-simple, draft-eagle3, draft-mtp, draft-dflash, draft-dspark, ngram-*. draft-mtp present.
- Zip also has llama-mtp-export.exe, llama-bench.exe.

## Files (HF tree API sizes)
D:\LlamaCpp\models\prism-ml\Ternary-Bonsai-2.5-27B-GGUF\
- Ternary-Bonsai-2.5-27B-PTQ1_0.gguf 5,993,834,848
- Ternary-Bonsai-2.5-27B-PTQ1_0-mtp.gguf 6,232,818,944

## HF presets/llama.cpp (mtp-cuda.json, mtp-hexagon.json, mtp-metal.json, mtp-sycl.json; no HIP/Vulkan file)
- CUDA preset: file PTQ1_0-mtp, `-ngl 99 -fa on -c 16384 -np 1 --spec-type draft-mtp --spec-draft-n-min 0 --spec-draft-n-max 3 --spec-draft-p-min 0.1`. PTQ1_0 "fastest packing on CUDA; needs the PrismML fork".
- Metal: PQ2_0-mtp, n-max 1, p-min 0.6. SYCL: PTQ1_0-mtp, n-max 8, p-min 0.6, env GGML_SYCL_PTQ1_T2=all, GGML_SYCL_FA_DEC_DPAS=1; f16 KV (4-bit KV breaks drafting on SYCL).
- Note: --spec-draft-p-min is a new knob not in the AAP-64 bench (it used n only).
