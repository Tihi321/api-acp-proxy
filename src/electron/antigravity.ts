// Single integration point with the Antigravity provider and installer (Phase 4). Nothing else under
// src/electron may import from ../providers/antigravity*.
export { antigravityRegistration } from "../providers/antigravity.js";
export { installAntigravity, readInstallInfo } from "../providers/antigravity-installer.js";
export type { InstallInfo, InstallProgress } from "../providers/antigravity-installer.js";
