# AAP-61 changelog

- Version check (`probeLlamaVersion`) and `--help` flag lookup run the llama-server exe with `llamaChildEnv` (ROCm PATH fix); the help cache key includes the PATH fix.
- `checkBuild`: a parsed build below 100 (self-compiled fork prints "build 1") is unknown, not too old.
- Tests: build<100 rule; version probe passes the env. README line.
