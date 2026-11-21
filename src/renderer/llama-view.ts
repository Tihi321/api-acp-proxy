import type {
  Failure, HfFileGroupView, HfListResult, LlamaBinarySettingsView, LlamaLayersView, LlamaProfileView, LlamaProgressView, LlamaProviderSettingsView,
  LlamaReleaseView, LlamaSourceView, LlamaStatusView, LocalServerStatusView, ProxyApi,
} from "../shared/ipc.js";

/** Page logic of the Llama.cpp settings page (build install, Hugging Face downloads, profiles). The shared save/dirty plumbing stays in settings.ts. */
export interface LlamaViewDeps {
  api: ProxyApi;
  markDirty(value: boolean): void;
  isDirty(): boolean;
  /** Saves the page like the Save button; resolves true when nothing unsaved is left. */
  save(): Promise<boolean>;
  refresh(): Promise<void>;
  setBadge(node: HTMLElement, value: string): void;
}
export interface LlamaViewCollected {
  binary: LlamaBinarySettingsView;
  profiles: LlamaProfileView[];
  switchWaitMs?: number;
  errors: Array<{ path: string; message: string }>;
}
export interface LlamaViewHandle {
  /** The page became visible: load the release list and the status. */
  shown(): void;
  /** Replaces the draft with the saved settings (only call while there are no unsaved edits). */
  load(settings: LlamaProviderSettingsView): void;
  collect(): LlamaViewCollected;
  setLauncher(server: LocalServerStatusView): void;
}

const SPEC_TYPES = ["none", "draft-simple", "draft-eagle3", "draft-mtp", "draft-dflash", "draft-dspark", "draft-dflash2",
  "draft-lilicorr", "ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache"] as const;
const defaultBackend = (source: LlamaSourceView): string => source === "unsloth" ? "rocm-gfx1151" : "rocm";

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const showError = (node: HTMLElement, text: string | undefined): void => { node.textContent = text ?? ""; node.hidden = !text; };
const flash = (node: HTMLElement, text: string, bad = false): void => { node.textContent = text; node.classList.toggle("bad", bad); };
const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(2)} GB`;
const bytesText = (bytes: number): string => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;
const minutesText = (ms: number | undefined): string => ms === undefined ? "" : String(Math.round(ms / 6000) / 10);
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "model";
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The failure message plus a hint for the codes that have a fix the user can make. */
export function failureText(failure: Failure): string {
  const hint = failure.code === "hf_auth_required" ? " Add a token in the Hugging Face token field and save."
    : failure.code === "hf_terms_required" ? " Accept the model's terms on huggingface.co, then try again."
    : failure.code === "download_disk_space" ? " Free some disk space or pick another folder."
    : "";
  return `${failure.message}${hint}`;
}

export function initLlamaView(deps: LlamaViewDeps): LlamaViewHandle {
  const { api } = deps;

  let binary: LlamaBinarySettingsView = { mode: "managed", dir: "", source: "ggml-org", backend: "rocm", arch: "x64" };
  let profiles: LlamaProfileView[] = [];
  let status: LlamaStatusView | undefined;
  let launcher: LocalServerStatusView | undefined;
  let releases: LlamaReleaseView[] | undefined;
  let releasesSource: LlamaSourceView | undefined;
  let releasesLoading = false;
  let selectedTag: string | undefined;
  let binaryBusy = false;
  let modelBusy = false;
  /** True while this page itself runs the job (the status poll must not reset the flag then). */
  let ownBinary = false;
  let ownModel = false;
  let profileJob: string | undefined;
  let loadToken = 0;
  const startingProfiles = new Set<string>();

  const dirty = (): void => deps.markDirty(true);
  const modeInput = (mode: string): HTMLInputElement => el<HTMLInputElement>(`llama-mode-${mode}`);
  const sourceSelect = el<HTMLSelectElement>("llama-source");
  const versionSelect = el<HTMLSelectElement>("llama-version");
  const backendSelect = el<HTMLSelectElement>("llama-backend");
  const archSelect = el<HTMLSelectElement>("llama-arch");
  const dirInput = el<HTMLInputElement>("llama-dir");
  const exeInput = el<HTMLInputElement>("llama-exe");

  // ---- Build card ----------------------------------------------------------------------------------------------------

  const selectedRelease = (): LlamaReleaseView | undefined => releases?.find((release) => release.tag === versionSelect.value);
  const assetsFor = (release: LlamaReleaseView) => release.assets.filter((asset) => asset.arch === binary.arch);

  function fillBackends(): void {
    const wanted = backendSelect.value || binary.backend;
    const release = selectedRelease();
    const names = release ? [...new Set(assetsFor(release).map((asset) => asset.backend))] : [];
    if (!names.length) names.push(wanted);
    backendSelect.replaceChildren(...names.map((name) => new Option(name, name)));
    backendSelect.value = names.includes(wanted) ? wanted : names.includes(defaultBackend(sourceSelect.value as LlamaSourceView)) ? defaultBackend(sourceSelect.value as LlamaSourceView) : names[0]!;
    updateBuildButtons();
  }

  function fillVersions(): void {
    if (!releases?.length) {
      versionSelect.replaceChildren(new Option(releasesLoading ? "Loading…" : "(no versions loaded)", ""));
      fillBackends();
      return;
    }
    const backend = backendSelect.value || binary.backend;
    const hasBackend = (release: LlamaReleaseView): boolean => assetsFor(release).some((asset) => asset.backend === backend);
    versionSelect.replaceChildren(...releases.map((release) => new Option(`${release.tag} (${release.publishedAt.slice(0, 10)})${hasBackend(release) ? "" : " - no " + backend}`, release.tag)));
    const keep = selectedTag && releases.some((release) => release.tag === selectedTag) ? selectedTag : undefined;
    versionSelect.value = keep ?? (releases.find(hasBackend) ?? releases[0]!).tag;
    selectedTag = versionSelect.value;
    fillBackends();
  }

  async function loadReleases(refresh = false): Promise<void> {
    const source = sourceSelect.value as LlamaSourceView;
    const token = ++loadToken;
    releasesLoading = true; releases = undefined; releasesSource = source;
    showError(el("llama-install-error"), undefined);
    fillVersions();
    let result;
    try { result = await api.llamaReleases(source, refresh); } catch (error) { result = { ok: false as const, message: errorText(error) } as Failure; }
    if (token !== loadToken) return;
    releasesLoading = false;
    if (result.ok) releases = result.releases; else { releases = undefined; showError(el("llama-install-error"), failureText(result)); }
    fillVersions();
  }

  function renderInstalled(): void {
    const info = binary.installed;
    el("llama-installed").textContent = info ? `${info.source} ${info.tag} ${info.backend} - ${info.dir}` : "Nothing downloaded yet.";
    const exe = status?.binary;
    el("llama-exe-info").textContent = binary.customBuild !== undefined ? `Detected build b${binary.customBuild}.` : binary.customPath ? "Build unknown until checked." : "";
    if (exe && !exe.exists && exe.command) el("llama-exe-info").textContent += ` llama-server.exe not found at ${exe.command}.`;
  }

  function renderMode(): void {
    const custom = modeInput("custom").checked;
    el("llama-managed").hidden = custom;
    el("llama-custom").hidden = !custom;
  }

  function updateBuildButtons(): void {
    el<HTMLButtonElement>("llama-install").disabled = binaryBusy || !selectedRelease();
    el<HTMLButtonElement>("llama-install").textContent = binary.installed ? "Download / update" : "Download";
    el("llama-install-cancel").hidden = !binaryBusy;
    el<HTMLButtonElement>("llama-releases-refresh").disabled = binaryBusy || releasesLoading;
    el<HTMLButtonElement>("llama-exe-check").disabled = binaryBusy;
  }

  async function install(): Promise<void> {
    const release = selectedRelease();
    if (!release || binaryBusy) return;
    const request = { source: sourceSelect.value as LlamaSourceView, tag: release.tag, backend: backendSelect.value, arch: binary.arch };
    showError(el("llama-install-error"), undefined);
    binaryBusy = true; ownBinary = true; updateBuildButtons();
    try {
      if (deps.isDirty() && !await deps.save()) return;
      el("llama-install-text").textContent = "Starting…";
      const result = await api.installLlama(request);
      if (result.ok) {
        binary = { ...binary, mode: "managed", source: request.source, backend: request.backend, arch: request.arch, installed: result.info };
        modeInput("managed").checked = true; renderMode(); renderInstalled();
        el("llama-install-text").textContent = `Installed ${result.info.tag}.`;
        await deps.refresh();
      } else { el("llama-install-text").textContent = ""; showError(el("llama-install-error"), failureText(result)); }
    } catch (error) { showError(el("llama-install-error"), errorText(error)); }
    finally { binaryBusy = false; ownBinary = false; el<HTMLProgressElement>("llama-install-progress").hidden = true; updateBuildButtons(); void refreshStatus(); }
  }

  async function checkExe(): Promise<void> {
    const path = exeInput.value.trim();
    const info = el("llama-exe-info");
    showError(el("llama-exe-error"), undefined);
    if (!path) { showError(el("llama-exe-error"), "Pick llama-server.exe first."); return; }
    info.textContent = "Checking…";
    try {
      if (deps.isDirty() && !await deps.save()) { info.textContent = ""; return; }
      const result = await api.checkLlamaExecutable(path);
      if (result.ok) {
        binary = { ...binary, mode: "custom", customPath: path, customBuild: result.build };
        modeInput("custom").checked = true; renderMode(); renderInstalled();
        info.textContent = result.build !== undefined ? `${result.version} (build b${result.build}).` : `${result.version} (build unknown).`;
        await deps.refresh();
      } else { renderInstalled(); showError(el("llama-exe-error"), failureText(result)); }
    } catch (error) { renderInstalled(); showError(el("llama-exe-error"), errorText(error)); }
    void refreshStatus();
  }

  // ---- Progress (both jobs) --------------------------------------------------------------------------------------------

  function progressLine(progress: LlamaProgressView): string {
    const labels: Record<string, string> = { release: "Reading release…", download: "Downloading…", verify: "Verifying…", extract: "Extracting…", done: "Done.", cancelled: "Cancelled." };
    if (progress.phase === "error") return progress.message ?? "Failed.";
    const file = progress.file ? `${baseName(progress.file)}: ` : "";
    if (progress.phase === "download" && progress.total) return `${file}${bytesText(progress.received ?? 0)} / ${bytesText(progress.total)}`;
    return progress.message ?? `${file}${labels[progress.phase] ?? progress.phase}`;
  }

  function applyProgress(progress: LlamaProgressView): void {
    const binaryJob = progress.job === "binary";
    const bar = el<HTMLProgressElement>(binaryJob ? "llama-install-progress" : "llama-hf-progress");
    const ended = progress.phase === "done" || progress.phase === "error" || progress.phase === "cancelled";
    bar.hidden = ended;
    if (progress.phase === "download" && progress.total) { bar.max = progress.total; bar.value = progress.received ?? 0; } else bar.removeAttribute("value");
    const line = progressLine(progress);
    el(binaryJob ? "llama-install-text" : "llama-hf-text").textContent = line;
    if (!binaryJob && profileJob) flash(el("llama-profiles-msg"), `${profileJob}: ${line}`, progress.phase === "error");
  }

  // ---- Models card ---------------------------------------------------------------------------------------------------------

  let listing: { repo: string; revision: string; quant?: string; groups: HfFileGroupView[] } | undefined;
  let modelGroup: number | undefined;
  const extraGroups = new Set<number>();
  let downloaded: { paths: string[]; groups: HfFileGroupView[] } | undefined;

  const chosenGroups = (): HfFileGroupView[] => {
    if (!listing) return [];
    const groups: HfFileGroupView[] = [];
    if (modelGroup !== undefined && listing.groups[modelGroup]) groups.push(listing.groups[modelGroup]!);
    for (const index of [...extraGroups].sort((a, b) => a - b)) if (listing.groups[index]) groups.push(listing.groups[index]!);
    return groups;
  };

  function updateModelButtons(): void {
    el<HTMLButtonElement>("llama-hf-download").disabled = modelBusy || chosenGroups().length === 0;
    // Any model job (a listing download or a profile's "Download model files") shows its progress and Cancel here, with or without a listing.
    el("llama-hf-actions").hidden = !listing && !modelBusy;
    el("llama-hf-download").hidden = !listing;
    el("llama-hf-cancel").hidden = !modelBusy;
    el<HTMLButtonElement>("llama-hf-list").disabled = modelBusy;
    el("llama-hf-create").hidden = !downloaded || !downloaded.groups.some((group) => group.kind === "model");
    updateProfileButtons();
  }

  function renderListing(): void {
    el("llama-hf-wrap").hidden = !listing;
    const body = el("llama-hf-body");
    if (!listing) { body.replaceChildren(); return; }
    const info = listing;
    body.replaceChildren(...info.groups.map((group, index) => {
      const row = make("tr");
      const input = make("input");
      input.type = group.kind === "model" ? "radio" : "checkbox";
      if (group.kind === "model") { input.name = "llama-hf-model"; input.checked = modelGroup === index; } else input.checked = extraGroups.has(index);
      input.disabled = !group.selectable;
      input.onchange = () => {
        if (group.kind === "model") modelGroup = index; else if (input.checked) extraGroups.add(index); else extraGroups.delete(index);
        updateModelButtons();
      };
      const pick = make("td"); pick.append(input);
      const kind = group.kind === "model" ? "model" : group.kind === "mmproj" ? "vision (mmproj)" : "draft";
      const size = group.selectable ? gb(group.totalSize) : `${gb(group.totalSize)} (incomplete)`;
      row.append(pick, make("td", "mono", group.label + (group.split ? ` (${group.files.length} files)` : "")), make("td", "num", size), make("td", "", kind));
      return row;
    }));
  }

  async function listFiles(): Promise<void> {
    const link = el<HTMLInputElement>("llama-hf-link").value.trim();
    showError(el("llama-hf-error"), undefined);
    if (!link) { showError(el("llama-hf-error"), "Paste a Hugging Face link first."); return; }
    el<HTMLButtonElement>("llama-hf-list").disabled = true;
    let result: HfListResult;
    try { result = await api.hfListFiles(link); } catch (error) { result = { ok: false, message: errorText(error) }; }
    el<HTMLButtonElement>("llama-hf-list").disabled = modelBusy;
    downloaded = undefined; extraGroups.clear(); modelGroup = undefined; listing = undefined;
    if (!result.ok) { showError(el("llama-hf-error"), failureText(result)); renderListing(); updateModelButtons(); return; }
    listing = result;
    const wanted = result.groups.findIndex((group) => group.kind === "model" && group.selectable && result.quant !== undefined && group.quant === result.quant);
    if (wanted >= 0) modelGroup = wanted;
    if (!result.groups.length) showError(el("llama-hf-error"), "No GGUF files found in this repository.");
    el("llama-hf-text").textContent = "";
    renderListing(); updateModelButtons();
  }

  async function downloadChosen(): Promise<void> {
    const groups = chosenGroups();
    if (!listing || !groups.length || modelBusy) return;
    const request = { repo: listing.repo, revision: listing.revision, files: groups.flatMap((group) => group.files.map((file) => file.path)) };
    showError(el("llama-hf-error"), undefined);
    modelBusy = true; ownModel = true; downloaded = undefined; updateModelButtons();
    try {
      if (deps.isDirty() && !await deps.save()) return;
      el("llama-hf-text").textContent = "Starting…";
      const result = await api.hfDownload(request);
      if (result.ok) { downloaded = { paths: result.paths, groups }; el("llama-hf-text").textContent = `Downloaded ${result.paths.length} file${result.paths.length === 1 ? "" : "s"}.`; }
      else { el("llama-hf-text").textContent = ""; showError(el("llama-hf-error"), failureText(result)); }
    } catch (error) { showError(el("llama-hf-error"), errorText(error)); }
    finally { modelBusy = false; ownModel = false; el<HTMLProgressElement>("llama-hf-progress").hidden = true; updateModelButtons(); void refreshStatus(); }
  }

  /** The stored path of a downloaded group's first file: the returned path that ends with its `saveAs`, else `saveAs` itself. */
  function storedPath(group: HfFileGroupView): string {
    const first = group.files.find((file) => /-0*1-of-\d+/.test(file.saveAs)) ?? group.files[0];
    if (!first || !downloaded) return "";
    const norm = (path: string): string => path.replace(/\\/g, "/");
    return downloaded.paths.find((path) => norm(path).endsWith(norm(first.saveAs))) ?? first.saveAs;
  }

  function createProfile(): void {
    if (!downloaded || !listing) return;
    const model = downloaded.groups.find((group) => group.kind === "model");
    if (!model) return;
    const mmproj = downloaded.groups.find((group) => group.kind === "mmproj");
    const draft = downloaded.groups.find((group) => group.kind === "draft");
    const base = slug(model.label.replace(/\.gguf$/i, ""));
    const taken = new Set(profiles.flatMap((profile) => [profile.id, profile.model]));
    let id = base; let n = 2;
    while (taken.has(id)) id = `${base.slice(0, 44)}-${n++}`;
    const profile: LlamaProfileView = {
      id, label: model.label, model: id, vision: mmproj !== undefined, modelFile: storedPath(model), gpuLayers: "auto", flashAttn: "auto", specType: "none", extraArgs: "",
    };
    if (mmproj) profile.mmprojFile = storedPath(mmproj);
    if (draft) { profile.draftFile = storedPath(draft); profile.specType = "draft-simple"; }
    if (model.quant) profile.hf = { repo: listing.repo, revision: listing.revision, quant: model.quant, ...(mmproj ? { mmproj: baseName(mmproj.files[0]!.path) } : {}), ...(draft ? { draft: baseName(draft.files[0]!.path) } : {}) };
    profiles.push(profile);
    dirty(); renderProfiles();
    flash(el("llama-profiles-msg"), `Added profile "${profile.label}". Save to keep it.`);
  }

  // ---- Profiles ------------------------------------------------------------------------------------------------------------

  function field(labelText: string, input: HTMLElement, wide = false): HTMLLabelElement {
    const label = make("label", wide ? "field wide" : "field");
    label.append(make("span", "", labelText), input);
    return label;
  }
  const textInput = (value: string, apply: (value: string) => void): HTMLInputElement => {
    const input = make("input"); input.type = "text"; input.autocomplete = "off"; input.spellcheck = false; input.value = value;
    input.addEventListener("input", () => { apply(input.value); dirty(); });
    return input;
  };
  const numberInput = (value: number | undefined, apply: (value: number | undefined) => void, scale = 1): HTMLInputElement => {
    const input = make("input"); input.type = "number"; input.min = "0"; input.step = scale === 1 ? "1" : "any";
    input.value = scale === 1 ? (value === undefined ? "" : String(value)) : minutesText(value);
    input.addEventListener("input", () => {
      const number = Number(input.value);
      apply(input.value.trim() === "" || !Number.isFinite(number) || number <= 0 ? undefined : Math.round(number * scale));
      dirty();
    });
    return input;
  };
  /** auto / all / a number of layers. */
  function layersControl(value: LlamaLayersView | undefined, optional: boolean, apply: (value: LlamaLayersView | undefined) => void): HTMLElement {
    const select = make("select");
    for (const [v, t] of [...(optional ? [["", "Default"]] : []), ["auto", "auto"], ["all", "all"], ["number", "number…"]] as const) select.append(new Option(t, v));
    const count = make("input"); count.type = "number"; count.min = "0"; count.step = "1";
    select.value = value === undefined ? "" : typeof value === "number" ? "number" : value;
    count.value = typeof value === "number" ? String(value) : "0";
    count.hidden = select.value !== "number";
    const update = (): void => {
      count.hidden = select.value !== "number";
      apply(select.value === "" ? undefined : select.value === "number" ? Math.max(0, Math.floor(Number(count.value) || 0)) : select.value as "auto" | "all");
      dirty();
    };
    select.addEventListener("change", update); count.addEventListener("input", update);
    const row = make("div", "row"); row.append(select, count);
    return row;
  }

  function profileCard(profile: LlamaProfileView, index: number): HTMLElement {
    const card = make("div", "profile");
    card.dataset.index = String(index);
    const head = make("div", "profile-head");
    head.append(make("strong", "", profile.label || profile.id || "(new profile)"));
    const badge = make("span", "badge"); badge.dataset.role = "profile-badge";
    const start = make("button", "primary small", "Start"); start.type = "button"; start.dataset.role = "profile-start";
    start.onclick = () => void startProfile(profile.id);
    const download = make("button", "small", "Download model files"); download.type = "button"; download.dataset.role = "profile-download";
    download.title = "Downloads the files listed under this profile's Hugging Face source";
    download.onclick = () => void downloadProfile(profile.id);
    download.hidden = !profile.hf;
    const remove = make("button", "small", "Remove"); remove.type = "button";
    remove.onclick = () => { profiles.splice(index, 1); dirty(); renderProfiles(); };
    head.append(badge, start, download, remove);

    const warnings = make("div"); warnings.dataset.role = "profile-warnings";

    const vision = make("input"); vision.type = "checkbox"; vision.checked = profile.vision;
    vision.addEventListener("change", () => { profile.vision = vision.checked; dirty(); });
    const visionLabel = make("label", "switch"); visionLabel.append(vision, make("span", "", "Accepts images (vision; needs the mmproj file)"));

    const flash2 = make("select");
    for (const value of ["auto", "on", "off"] as const) flash2.append(new Option(value, value));
    flash2.value = profile.flashAttn;
    flash2.addEventListener("change", () => { profile.flashAttn = flash2.value as LlamaProfileView["flashAttn"]; dirty(); });

    const spec = make("select");
    for (const value of SPEC_TYPES) spec.append(new Option(value === "draft-mtp" ? "draft-mtp (MTP heads)" : value, value));
    spec.value = SPEC_TYPES.includes(profile.specType as typeof SPEC_TYPES[number]) ? profile.specType : "none";
    spec.addEventListener("change", () => { profile.specType = spec.value; dirty(); });

    const extra = make("textarea"); extra.rows = 2; extra.spellcheck = false; extra.value = profile.extraArgs;
    extra.addEventListener("input", () => { profile.extraArgs = extra.value; dirty(); });

    const grid = make("div", "grid");
    grid.append(
      field("Label", textInput(profile.label, (value) => { profile.label = value; })),
      field("Profile id (a-z, 0-9, . _ -)", textInput(profile.id, (value) => { profile.id = value; })),
      field("Model id (exposed as llama/<model>)", textInput(profile.model, (value) => { profile.model = value; })),
      field("Model file (relative to the models folder, first shard if split)", textInput(profile.modelFile, (value) => { profile.modelFile = value; })),
      field("mmproj file (vision)", textInput(profile.mmprojFile ?? "", (value) => { profile.mmprojFile = value; })),
      field("Context size (empty = model default)", numberInput(profile.ctxSize, (value) => { profile.ctxSize = value; })),
      field("GPU layers", layersControl(profile.gpuLayers, false, (value) => { profile.gpuLayers = value ?? "auto"; })),
      field("Flash attention", flash2),
      field("Speculative decoding type", spec),
      field("Draft file", textInput(profile.draftFile ?? "", (value) => { profile.draftFile = value; })),
      field("Draft tokens max", numberInput(profile.draftNMax, (value) => { profile.draftNMax = value; })),
      field("Draft tokens min", numberInput(profile.draftNMin, (value) => { profile.draftNMin = value; })),
      field("Draft GPU layers", layersControl(profile.draftGpuLayers, true, (value) => { profile.draftGpuLayers = value; })),
      field("Start timeout (minutes, empty = 10)", numberInput(profile.startTimeoutMs, (value) => { profile.startTimeoutMs = value; }, 60000)),
      field("Request timeout (minutes, empty = server default)", numberInput(profile.requestTimeoutMs, (value) => { profile.requestTimeoutMs = value; }, 60000)),
    );
    const note = make("small", "", "draft-mtp uses the model's own MTP heads. Extra arguments are appended after the generated flags and can override them.");
    card.append(head, warnings, grid, visionLabel, field("Extra arguments", extra, true), note);
    return card;
  }

  function renderProfiles(): void {
    el("llama-profiles").replaceChildren(...(profiles.length ? profiles.map(profileCard) : [make("p", "note", "No profiles. Add one or restore the presets.")]));
    updateProfileButtons();
  }

  /** Start / Switch / Download buttons and the warnings of each card, from the launcher and the status (in place, so typing is not interrupted). */
  function updateProfileButtons(): void {
    const anyRunning = launcher !== undefined && (launcher.state === "starting" || launcher.state === "ready");
    for (const node of document.querySelectorAll<HTMLElement>("#llama-profiles .profile")) {
      const profile = profiles[Number(node.dataset.index)];
      if (!profile) continue;
      const mine = launcher !== undefined && launcher.profile === profile.id && anyRunning;
      const waiting = startingProfiles.has(profile.id);
      const start = node.querySelector<HTMLButtonElement>('[data-role="profile-start"]')!;
      start.disabled = mine || waiting;
      start.textContent = waiting && !mine ? "Waiting…" : anyRunning && !mine ? "Switch to this" : "Start";
      const badge = node.querySelector<HTMLElement>('[data-role="profile-badge"]')!;
      badge.hidden = !mine;
      if (mine && launcher) deps.setBadge(badge, launcher.state);
      const download = node.querySelector<HTMLButtonElement>('[data-role="profile-download"]')!;
      const active = profileJob === profile.id && modelBusy;
      download.disabled = modelBusy && !active;
      download.textContent = active ? "Cancel download" : "Download model files";
      const lines: string[] = [];
      const entry = status?.profiles[profile.id];
      if (entry?.build === "too_old") lines.push(`Needs a newer build${entry.buildMessage ? `: ${entry.buildMessage}` : "."}`);
      else if (entry?.build === "unknown") lines.push("Build unknown.");
      if (entry?.missingFiles.length) lines.push(`Missing: ${entry.missingFiles.join(", ")}`);
      const host = node.querySelector<HTMLElement>('[data-role="profile-warnings"]')!;
      host.replaceChildren(...lines.map((line) => make("p", "profile-warn", line)));
    }
  }

  async function startProfile(profileId: string): Promise<void> {
    const msg = el("llama-profiles-msg");
    flash(msg, "");
    if (deps.isDirty() && !await deps.save()) return;
    startingProfiles.add(profileId); updateProfileButtons();
    flash(msg, "Starting or switching… a large model can take many minutes.");
    try {
      const result = await api.startLocalServer("llama", profileId);
      flash(msg, result.ok ? "" : result.message, !result.ok);
    } catch (error) { flash(msg, errorText(error), true); }
    finally { startingProfiles.delete(profileId); updateProfileButtons(); }
  }

  async function downloadProfile(profileId: string): Promise<void> {
    const msg = el("llama-profiles-msg");
    if (modelBusy && profileJob === profileId) { void api.cancelLlamaDownload("model"); return; }
    if (modelBusy) return;
    flash(msg, "");
    modelBusy = true; ownModel = true; profileJob = profileId; updateModelButtons();
    try {
      if (deps.isDirty() && !await deps.save()) return;
      flash(msg, `${profileId}: starting…`);
      const result = await api.downloadProfileModels(profileId);
      if (result.ok) {
        const target = profiles.find((profile) => profile.id === profileId);
        if (target) {
          target.modelFile = result.profile.modelFile;
          // An mmproj the app picked (the profile named none) fills an empty field only, and brings vision with it.
          const auto = !target.hf?.mmproj;
          if (result.profile.mmprojFile !== undefined && (!auto || !target.mmprojFile?.trim())) {
            target.mmprojFile = result.profile.mmprojFile;
            if (auto && result.profile.vision) target.vision = true;
          }
          if (result.profile.draftFile !== undefined) target.draftFile = result.profile.draftFile;
        }
        renderProfiles();
        flash(msg, `${profileId}: model files downloaded.`);
        await deps.refresh();
      } else flash(msg, failureText(result), true);
    } catch (error) { flash(msg, errorText(error), true); }
    finally { modelBusy = false; ownModel = false; profileJob = undefined; updateModelButtons(); void refreshStatus(); }
  }

  async function refreshStatus(): Promise<void> {
    try {
      status = await api.llamaStatus();
      if (!ownBinary) binaryBusy = status.jobs.binary;
      if (!ownModel) modelBusy = status.jobs.model;
      updateBuildButtons(); updateModelButtons(); renderInstalled();
    } catch { /* status is informational; the page works without it */ }
  }

  // ---- Wiring ----------------------------------------------------------------------------------------------------------------

  for (const mode of ["managed", "custom"] as const) modeInput(mode).addEventListener("change", () => { renderMode(); dirty(); });
  sourceSelect.addEventListener("change", () => {
    binary = { ...binary, source: sourceSelect.value as LlamaSourceView, backend: defaultBackend(sourceSelect.value as LlamaSourceView) };
    backendSelect.replaceChildren(new Option(binary.backend, binary.backend)); backendSelect.value = binary.backend;
    selectedTag = undefined;
    dirty(); void loadReleases();
  });
  versionSelect.addEventListener("change", () => { selectedTag = versionSelect.value; fillBackends(); });
  backendSelect.addEventListener("change", () => { binary = { ...binary, backend: backendSelect.value }; dirty(); updateBuildButtons(); });
  // The version and backend lists only offer assets of this architecture (assetsFor).
  archSelect.addEventListener("change", () => { binary = { ...binary, arch: archSelect.value === "arm64" ? "arm64" : "x64" }; dirty(); fillVersions(); });
  dirInput.addEventListener("input", dirty);
  exeInput.addEventListener("input", () => { binary = { ...binary, customBuild: undefined }; dirty(); renderInstalled(); });
  el("llama-dir-browse").onclick = async () => { const result = await api.pickDirectory("Folder for the llama.cpp builds", dirInput.value || undefined); if (result.path) { dirInput.value = result.path; dirty(); } };
  el("llama-models-browse").onclick = async () => {
    const input = el<HTMLInputElement>("providers.llama.modelsDir");
    const result = await api.pickDirectory("Folder for the models", input.value || undefined);
    if (result.path) { input.value = result.path; dirty(); }
  };
  el("llama-exe-browse").onclick = async () => { const result = await api.pickExecutable(); if (result.path) { exeInput.value = result.path; binary = { ...binary, customBuild: undefined }; dirty(); renderInstalled(); } };
  el("llama-exe-check").onclick = () => void checkExe();
  el("llama-install").onclick = () => void install();
  el("llama-install-cancel").onclick = () => void api.cancelLlamaDownload("binary");
  el("llama-releases-refresh").onclick = () => void loadReleases(true);
  el("llama-token-show").onclick = () => {
    const input = el<HTMLInputElement>("providers.llama.hfToken");
    input.type = input.type === "password" ? "text" : "password";
    el("llama-token-show").textContent = input.type === "password" ? "Show" : "Hide";
  };
  el("llama-hf-list").onclick = () => void listFiles();
  el<HTMLInputElement>("llama-hf-link").addEventListener("keydown", (event) => { if (event.key === "Enter") void listFiles(); });
  el("llama-hf-download").onclick = () => void downloadChosen();
  el("llama-hf-cancel").onclick = () => void api.cancelLlamaDownload("model");
  el("llama-hf-create").onclick = createProfile;
  el("llama-switch-wait").addEventListener("input", dirty);
  el("llama-add-profile").onclick = () => {
    const taken = new Set(profiles.flatMap((profile) => [profile.id, profile.model]));
    let n = profiles.length + 1;
    while (taken.has(`profile-${n}`)) n++;
    profiles.push({ id: `profile-${n}`, label: `Profile ${n}`, model: `profile-${n}`, vision: false, modelFile: "", gpuLayers: "auto", flashAttn: "auto", specType: "none", extraArgs: "" });
    dirty(); renderProfiles();
  };
  el("llama-restore-presets").onclick = async () => {
    try {
      const restored = await api.restoreLlamaPresets(profiles);
      const added = restored.length - profiles.length;
      profiles = restored;
      if (added > 0) dirty();
      renderProfiles();
      flash(el("llama-profiles-msg"), added > 0 ? `Added ${added} preset${added === 1 ? "" : "s"}. Save to keep them.` : "All presets are present.");
    } catch (error) { flash(el("llama-profiles-msg"), errorText(error), true); }
  };
  api.onLlamaProgress(applyProgress);

  return {
    shown(): void {
      if (!releases && !releasesLoading) void loadReleases();
      void refreshStatus();
    },
    load(settings: LlamaProviderSettingsView): void {
      binary = { ...settings.binary };
      profiles = settings.profiles.map((profile) => ({ ...profile }));
      el<HTMLInputElement>("llama-switch-wait").value = String(Math.round(settings.switchWaitMs / 60000));
      modeInput(binary.mode).checked = true;
      sourceSelect.value = binary.source;
      archSelect.value = binary.arch;
      dirInput.value = binary.dir;
      exeInput.value = binary.customPath ?? "";
      backendSelect.replaceChildren(new Option(binary.backend, binary.backend)); backendSelect.value = binary.backend;
      renderMode(); renderInstalled();
      // The release list is kept when the source did not change; the selects are rebuilt from it.
      if (releasesSource !== binary.source) { releases = undefined; selectedTag = undefined; }
      fillVersions();
      renderProfiles();
      updateModelButtons();
    },
    collect(): LlamaViewCollected {
      const errors: LlamaViewCollected["errors"] = [];
      const dir = dirInput.value.trim();
      if (!dir) errors.push({ path: "providers.llama.binary.dir", message: "Required" });
      const customPath = exeInput.value.trim();
      const out: LlamaBinarySettingsView = {
        ...binary,
        mode: modeInput("custom").checked ? "custom" : "managed",
        dir,
        source: sourceSelect.value as LlamaSourceView,
        backend: backendSelect.value || binary.backend,
        arch: archSelect.value === "arm64" ? "arm64" : "x64",
      };
      if (customPath) out.customPath = customPath; else { delete out.customPath; delete out.customBuild; }
      const wait = Number(el<HTMLInputElement>("llama-switch-wait").value);
      const waitText = el<HTMLInputElement>("llama-switch-wait").value.trim();
      let switchWaitMs: number | undefined;
      if (waitText === "" || !Number.isFinite(wait) || wait <= 0) errors.push({ path: "providers.llama.switchWaitMs", message: "Enter the wait in minutes" });
      else switchWaitMs = Math.round(wait * 60000);
      const cleaned = profiles.map((profile) => {
        const copy: LlamaProfileView = { ...profile, label: profile.label.trim(), id: profile.id.trim(), model: profile.model.trim(), modelFile: profile.modelFile.trim(), extraArgs: profile.extraArgs.trim() };
        for (const key of ["mmprojFile", "draftFile"] as const) {
          const value = copy[key]?.trim();
          if (value) copy[key] = value; else delete copy[key];
        }
        return copy;
      });
      return { binary: out, profiles: cleaned, ...(switchWaitMs !== undefined ? { switchWaitMs } : {}), errors };
    },
    setLauncher(server: LocalServerStatusView): void {
      launcher = server;
      updateProfileButtons();
    },
  };
}
