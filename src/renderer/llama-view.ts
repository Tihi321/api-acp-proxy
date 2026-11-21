import type {
  Failure, HfFileGroupView, HfListResult, LlamaBinarySettingsView, LlamaLayersView, LlamaLocalFileView, LlamaProfileView, LlamaProgressView,
  LlamaProviderSettingsView, LlamaReleaseView, LlamaScanResult, LlamaSourceView, LlamaStatusView, LocalServerStatusView, ProxyApi,
} from "../shared/ipc.js";
import { applyFix, draftMissingFiles, foundFileFixes, profileFromFile, specTypeForDraft, usedBy } from "./llama-models.js";
import type { FileField } from "./llama-models.js";

/** Page logic of the Llama.cpp settings page (build install, models on disk, profiles, Hugging Face downloads). The shared save/dirty plumbing stays in settings.ts. */
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
  /** The model file of the embedding server (the other embedding fields are plain inputs read by settings.ts). */
  embeddingModelFile: string;
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
  /** The state of the embedding server (`embed`). */
  setEmbedLauncher(server: LocalServerStatusView): void;
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
const norm = (path: string): string => path.replace(/\\/g, "/").toLowerCase();
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
  let embedLauncher: LocalServerStatusView | undefined;
  /** The embedding model file being edited (picked like a profile's file). */
  let embedDraft: Pick<LlamaProfileView, FileField> = { modelFile: "" };
  let releases: LlamaReleaseView[] | undefined;
  let releasesSource: LlamaSourceView | undefined;
  let releasesLoading = false;
  let selectedTag: string | undefined;
  let binaryBusy = false;
  let modelBusy = false;
  /** True while this page itself runs the job (the status poll must not reset the flag then). */
  let ownBinary = false;
  let ownModel = false;
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
  }

  // ---- Models on disk card -----------------------------------------------------------------------------------------------

  let scanFiles: LlamaLocalFileView[] = [];
  let scanning = false;
  /** True once a scan has succeeded; until then the draft cannot be checked against the scan. */
  let scanOk = false;
  let scanAgain = false;
  /** The saved models folder at the start of the last scan; a different saved folder (after a Save) triggers a scan. */
  let scannedFor: string | undefined;
  let savedModelsDir = "";
  /** Paths returned by the last successful download; the matching rows are marked "new". */
  let newPaths: string[] = [];
  const pickerRebuilds: Array<() => void> = [];

  const isNew = (file: LlamaLocalFileView): boolean => {
    const wanted = norm(file.path);
    return newPaths.some((path) => { const have = norm(path); return have === wanted || have.endsWith(`/${wanted}`); });
  };

  function renderScanTable(): void {
    el("llama-scan-wrap").hidden = scanFiles.length === 0;
    el("llama-scan-body").replaceChildren(...scanFiles.map((file) => {
      const row = make("tr");
      const name = make("td", "mono", file.shards ? `${file.path} (${file.shards} files)` : file.path);
      if (isNew(file)) name.append(" ", make("span", "badge info", "new"));
      const action = make("td");
      if (!file.complete) action.append(make("span", "muted", "(incomplete)"));
      else if (file.kind === "model") {
        const create = make("button", "small", "Create profile"); create.type = "button";
        create.onclick = () => createFromFile(file);
        action.append(create);
      }
      const kind = file.kind === "mmproj" ? "vision (mmproj)" : file.kind;
      row.append(name, make("td", "", kind), make("td", "", file.quant ?? ""), make("td", "num", bytesText(file.size)), make("td", "mono", usedBy(file.path, profiles).join(", ")), action);
      return row;
    }));
  }

  /** Everything that shows the scan or the profiles' files: the table, the pickers and the per-card fixes, in place. */
  function refreshFileViews(): void {
    renderScanTable();
    for (const rebuild of pickerRebuilds) rebuild();
    updateProfileButtons();
  }

  function createFromFile(file: LlamaLocalFileView): void {
    const taken = new Set(profiles.flatMap((profile) => [profile.id, profile.model]));
    const profile = profileFromFile(file, scanFiles, taken);
    profiles.push(profile);
    dirty(); renderProfiles();
    el("llama-profiles").lastElementChild?.scrollIntoView({ block: "center", behavior: "smooth" });
    flash(el("llama-profiles-msg"), `Added profile "${profile.label}". Save to keep it.`);
  }

  function applyScan(result: LlamaScanResult): void {
    const status = el("llama-scan-status");
    if (!result.ok) { flash(status, failureText(result), true); return; }
    scanFiles = result.files; scanOk = true;
    const text = result.missingDir ? "Folder does not exist yet."
      : result.files.length === 0 ? `No .gguf files found in ${result.modelsDir}.`
      : result.truncated ? `Stopped after ${result.files.length} files (limit reached) in ${result.modelsDir}.`
      : `Scanned ${result.modelsDir}: ${result.files.length} file${result.files.length === 1 ? "" : "s"}`;
    flash(status, text, false);
    refreshFileViews();
  }

  /** Scans the saved models folder. A scan already running is not started twice: one more runs after it, so the newest result wins. */
  async function scan(): Promise<void> {
    if (scanning) { scanAgain = true; return; }
    scanning = true;
    try {
      do {
        scanAgain = false;
        scannedFor = savedModelsDir;
        el<HTMLButtonElement>("llama-scan").disabled = true;
        flash(el("llama-scan-status"), "Scanning…");
        let result: LlamaScanResult;
        try { result = await api.llamaScanModels(); } catch (error) { result = { ok: false, message: errorText(error) }; }
        if (!scanAgain) applyScan(result);
      } while (scanAgain);
    } finally { scanning = false; el<HTMLButtonElement>("llama-scan").disabled = false; }
  }

  /** Rescan: the scan reads the saved folder, so unsaved edits (the folder field) are saved first. */
  async function rescan(): Promise<void> {
    if (deps.isDirty() && !await deps.save()) return;
    await scan();
  }

  // ---- Download from Hugging Face card -----------------------------------------------------------------------------------------

  let listing: { repo: string; revision: string; quant?: string; groups: HfFileGroupView[] } | undefined;
  let modelGroup: number | undefined;
  const extraGroups = new Set<number>();

  const chosenGroups = (): HfFileGroupView[] => {
    if (!listing) return [];
    const groups: HfFileGroupView[] = [];
    if (modelGroup !== undefined && listing.groups[modelGroup]) groups.push(listing.groups[modelGroup]!);
    for (const index of [...extraGroups].sort((a, b) => a - b)) if (listing.groups[index]) groups.push(listing.groups[index]!);
    return groups;
  };

  function updateModelButtons(): void {
    el<HTMLButtonElement>("llama-hf-download").disabled = modelBusy || chosenGroups().length === 0;
    // A model job (also one started elsewhere) shows its progress and Cancel here, with or without a listing.
    el("llama-hf-actions").hidden = !listing && !modelBusy;
    el("llama-hf-download").hidden = !listing;
    el("llama-hf-cancel").hidden = !modelBusy;
    el<HTMLButtonElement>("llama-hf-list").disabled = modelBusy;
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
    extraGroups.clear(); modelGroup = undefined; listing = undefined;
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
    modelBusy = true; ownModel = true; newPaths = []; updateModelButtons();
    try {
      if (deps.isDirty() && !await deps.save()) return;
      el("llama-hf-text").textContent = "Starting…";
      const result = await api.hfDownload(request);
      if (result.ok) {
        newPaths = result.paths;
        el("llama-hf-text").textContent = `Downloaded ${result.paths.length} file${result.paths.length === 1 ? "" : "s"}. Create a profile from them under Models on disk.`;
        void scan();
      } else { el("llama-hf-text").textContent = ""; showError(el("llama-hf-error"), failureText(result)); }
    } catch (error) { showError(el("llama-hf-error"), errorText(error)); }
    finally { modelBusy = false; ownModel = false; el<HTMLProgressElement>("llama-hf-progress").hidden = true; updateModelButtons(); void refreshStatus(); }
  }

  /** "Find on Hugging Face": fills the download card's link from the profile's `hf` source and lists the files. Nothing is downloaded. */
  function findOnHuggingFace(profile: LlamaProfileView): void {
    const hf = profile.hf;
    if (!hf) return;
    el<HTMLInputElement>("llama-hf-link").value = hf.revision === "main" ? `${hf.repo}:${hf.quant}` : `https://huggingface.co/${hf.repo}/tree/${hf.revision}`;
    el("llama-hf-card").scrollIntoView({ block: "start", behavior: "smooth" });
    void listFiles();
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

  const optionText = (file: LlamaLocalFileView): string =>
    `${file.path}${file.quant ? ` - ${file.quant}` : ""} - ${bytesText(file.size)}${file.complete ? "" : " (incomplete)"}`;
  const CUSTOM = "\u0000custom";

  /** A file field as a select (scanned files, "(none)", "Custom path…") with a text input and Browse…; rebuilt in place by the scan. */
  function filePicker(profile: Pick<LlamaProfileView, FileField>, key: FileField, labelText: string, onPicked: (key: FileField, value: string, had: boolean) => void): HTMLElement {
    const select = make("select");
    const custom = make("input"); custom.type = "text"; custom.autocomplete = "off"; custom.spellcheck = false;
    custom.placeholder = "Path relative to the models folder, or absolute";
    const browse = make("button", "small", "Browse…"); browse.type = "button";
    const customRow = make("div", "row"); customRow.append(custom, browse);
    let customMode = false;
    const current = (): string => profile[key] ?? "";
    const set = (value: string): void => {
      if (key === "modelFile") profile.modelFile = value; else if (value) profile[key] = value; else delete profile[key];
    };
    const option = (file: LlamaLocalFileView): HTMLOptionElement => {
      const item = new Option(optionText(file), file.path); item.disabled = !file.complete; return item;
    };
    const rebuild = (): void => {
      const value = current();
      const kind = key === "modelFile" ? "model" : key === "mmprojFile" ? "mmproj" : "draft";
      const entries = scanFiles.filter((file) => file.kind === kind);
      select.replaceChildren();
      if (key !== "modelFile") select.append(new Option("(none)", ""));
      else if (!value) select.append(new Option("(choose a file)", ""));
      select.append(...entries.map(option));
      if (key === "draftFile") {
        const others = scanFiles.filter((file) => file.kind === "model");
        if (others.length) {
          const group = make("optgroup"); group.label = "Other models";
          group.append(...others.map(option));
          select.append(group);
        }
      }
      // The stored value is always the selected option: a scanned file of another kind gets an extra option, a file that is on neither disk nor scan says "(not found)".
      const match = value ? scanFiles.find((file) => norm(file.path) === norm(value)) : undefined;
      const selected = match ? match.path : value;
      if (selected && ![...select.options].some((item) => item.value === selected)) select.append(new Option(match ? selected : `${selected} (not found)`, selected));
      select.append(new Option("Custom path…", CUSTOM));
      select.value = customMode ? CUSTOM : selected;
      customRow.hidden = !customMode;
      if (document.activeElement !== custom) custom.value = value;
    };
    select.addEventListener("change", () => {
      if (select.value === CUSTOM) { customMode = true; customRow.hidden = false; custom.value = current(); custom.focus(); return; }
      customMode = false; customRow.hidden = true;
      const had = current() !== "";
      set(select.value); dirty(); onPicked(key, select.value, had);
      rebuild();
    });
    // Typing stores the path; leaving the field (change) applies the same vision / spec type logic as picking. `hadBefore` is read when editing starts.
    let hadBefore = false;
    custom.addEventListener("focus", () => { hadBefore = current() !== ""; });
    custom.addEventListener("input", () => { set(custom.value); dirty(); });
    custom.addEventListener("change", () => { onPicked(key, current(), hadBefore); hadBefore = current() !== ""; });
    const message = make("small", "muted");
    browse.onclick = async () => {
      flash(message, "");
      try {
        const result = await api.pickModelFile();
        if (!result.path) return;
        const had = current() !== "";
        customMode = false; set(result.path); dirty(); onPicked(key, result.path, had);
        rebuild();
      } catch (error) { flash(message, errorText(error), true); }
    };
    rebuild();
    pickerRebuilds.push(rebuild);
    const wrap = make("div", "field");
    wrap.append(make("span", "", labelText), select, customRow, message);
    return wrap;
  }

  function profileCard(profile: LlamaProfileView, index: number): HTMLElement {
    const card = make("div", "profile");
    card.dataset.index = String(index);
    const head = make("div", "profile-head");
    head.append(make("strong", "", profile.label || profile.id || "(new profile)"));
    const badge = make("span", "badge"); badge.dataset.role = "profile-badge";
    const start = make("button", "primary small", "Start"); start.type = "button"; start.dataset.role = "profile-start";
    start.onclick = () => void startProfile(profile.id);
    const remove = make("button", "small", "Remove"); remove.type = "button";
    remove.onclick = () => { profiles.splice(index, 1); dirty(); renderProfiles(); };
    head.append(badge, start, remove);

    const warnings = make("div"); warnings.dataset.role = "profile-warnings";

    const vision = make("input"); vision.type = "checkbox"; vision.checked = profile.vision;
    vision.addEventListener("change", () => { profile.vision = vision.checked; dirty(); updateProfileButtons(); });
    const visionLabel = make("label", "switch"); visionLabel.append(vision, make("span", "", "Accepts images (vision; needs the mmproj file)"));

    const flash2 = make("select");
    for (const value of ["auto", "on", "off"] as const) flash2.append(new Option(value, value));
    flash2.value = profile.flashAttn;
    flash2.addEventListener("change", () => { profile.flashAttn = flash2.value as LlamaProfileView["flashAttn"]; dirty(); });

    const spec = make("select");
    for (const value of SPEC_TYPES) spec.append(new Option(value === "draft-mtp" ? "draft-mtp (MTP heads)" : value, value));
    spec.value = SPEC_TYPES.includes(profile.specType as typeof SPEC_TYPES[number]) ? profile.specType : "none";
    spec.addEventListener("change", () => { profile.specType = spec.value; dirty(); updateProfileButtons(); });

    const extra = make("textarea"); extra.rows = 2; extra.spellcheck = false; extra.value = profile.extraArgs;
    extra.addEventListener("input", () => { profile.extraArgs = extra.value; dirty(); });

    /** A file was chosen in a picker: mmproj switches vision on (it was empty) or off (none), a draft sets the spec type when it was none. */
    const picked = (key: FileField, value: string, had: boolean): void => {
      if (key === "mmprojFile") {
        if (value && !had) vision.checked = true; else if (!value) vision.checked = false;
        profile.vision = vision.checked;
      } else if (key === "draftFile" && value && profile.specType === "none") {
        profile.specType = specTypeForDraft(baseName(value));
        spec.value = SPEC_TYPES.includes(profile.specType as typeof SPEC_TYPES[number]) ? profile.specType : "none";
      }
      renderScanTable(); updateProfileButtons();
    };

    const grid = make("div", "grid");
    grid.append(
      field("Label", textInput(profile.label, (value) => { profile.label = value; })),
      field("Profile id (a-z, 0-9, . _ -)", textInput(profile.id, (value) => { profile.id = value; })),
      field("Model id (exposed as llama/<model>)", textInput(profile.model, (value) => { profile.model = value; })),
      filePicker(profile, "modelFile", "Model file (first shard if split)", picked),
      filePicker(profile, "mmprojFile", "mmproj file (vision)", picked),
      field("Context size (empty = model default)", numberInput(profile.ctxSize, (value) => { profile.ctxSize = value; })),
      field("GPU layers", layersControl(profile.gpuLayers, false, (value) => { profile.gpuLayers = value ?? "auto"; })),
      field("Flash attention", flash2),
      field("Speculative decoding type", spec),
      filePicker(profile, "draftFile", "Draft file", picked),
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

  /** "Use found files" (one button when every missing field has exactly one candidate) or one "Use <name>" button per candidate. */
  function fixButtons(profile: LlamaProfileView): HTMLElement[] {
    const fixes = foundFileFixes(profile, scanFiles);
    if (!fixes.length) return [];
    const apply = (picks: Array<[FileField, LlamaLocalFileView]>): void => {
      let next = profile;
      for (const [field, file] of picks) next = applyFix(next, field, file);
      Object.assign(profile, next);
      dirty(); renderProfiles();
      flash(el("llama-profiles-msg"), "Files replaced. Save to keep them (Start saves too).");
    };
    const row = make("div", "row fix-row");
    if (fixes.every((fix) => fix.candidates.length === 1)) {
      const button = make("button", "small", `Use found files: ${fixes.map((fix) => fix.candidates[0]!.name).join(", ")}`); button.type = "button";
      button.onclick = () => apply(fixes.map((fix) => [fix.field, fix.candidates[0]!] as [FileField, LlamaLocalFileView]));
      row.append(button);
    } else {
      for (const fix of fixes) for (const file of fix.candidates) {
        const button = make("button", "small", `Use ${file.name}`); button.type = "button";
        button.title = `Replaces ${fix.current}`;
        button.onclick = () => apply([[fix.field, file]]);
        row.append(button);
      }
    }
    return [row];
  }

  // ---- Embeddings card ---------------------------------------------------------------------------------------------------

  /** The model file picker of the Embeddings card; mounted again whenever the pickers are rebuilt. */
  function mountEmbedPicker(): void {
    el("llama-embed-file").replaceChildren(filePicker(embedDraft, "modelFile", "Model file (nomic-embed-text-v1.5 GGUF)", () => undefined));
  }

  function updateEmbedCard(): void {
    const server = embedLauncher;
    const running = server !== undefined && (server.state === "starting" || server.state === "ready");
    deps.setBadge(el("llama-embed-badge"), server?.state ?? "stopped");
    el<HTMLButtonElement>("llama-embed-start").disabled = running || embedStarting;
    el<HTMLButtonElement>("llama-embed-stop").disabled = !running;
    showError(el("llama-embed-error"), server?.state === "error" ? server.error : undefined);
    const info = server ? [server.pid !== undefined ? `pid ${server.pid}` : "", server.port !== undefined ? `port ${server.port}` : ""].filter(Boolean).join(" · ") : "";
    el("llama-embed-info").textContent = server?.commandLine ? `${info ? `${info} · ` : ""}${server.commandLine}` : info;
    const missing = status?.embedding.missingFiles ?? [];
    showError(el("llama-embed-warn"), missing.length ? `Missing: ${missing.join(", ")}` : undefined);
  }

  let embedStarting = false;
  async function startEmbed(): Promise<void> {
    flash(el("llama-profiles-msg"), "");
    if (deps.isDirty() && !await deps.save()) return;
    embedStarting = true; updateEmbedCard();
    try {
      const result = await api.startLocalServer("embed");
      if (!result.ok) showError(el("llama-embed-error"), result.message);
    } catch (error) { showError(el("llama-embed-error"), errorText(error)); }
    finally { embedStarting = false; updateEmbedCard(); }
  }

  function renderProfiles(): void {
    pickerRebuilds.length = 0;
    mountEmbedPicker();
    el("llama-profiles").replaceChildren(...(profiles.length ? profiles.map(profileCard) : [make("p", "note", "No profiles. Add one or restore the presets.")]));
    renderScanTable();
    updateProfileButtons();
  }

  /** Start / Switch buttons, the warnings and the "Use found files" fixes of each card, from the launcher and the status (in place, so typing is not interrupted). */
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
      const lines: string[] = [];
      const entry = status?.profiles[profile.id];
      // With unsaved edits the saved-settings status is stale: check the draft against the last scan (absolute paths keep the status result).
      const missing = deps.isDirty() && scanOk ? draftMissingFiles(profile, scanFiles, entry?.missingFiles ?? []) : entry?.missingFiles ?? [];
      if (entry?.build === "too_old") lines.push(`Needs a newer build${entry.buildMessage ? `: ${entry.buildMessage}` : "."}`);
      else if (entry?.build === "unknown") lines.push("Build unknown.");
      if (missing.length) lines.push(`Missing: ${missing.join(", ")}`);
      const host = node.querySelector<HTMLElement>('[data-role="profile-warnings"]')!;
      const warnings: HTMLElement[] = lines.map((line) => make("p", "profile-warn", line));
      if (missing.length && profile.hf) {
        const find = make("button", "small", "Find on Hugging Face"); find.type = "button";
        find.title = "Fills the link in Download from Hugging Face and lists the files; nothing is downloaded";
        find.onclick = () => findOnHuggingFace(profile);
        warnings.push(find);
      }
      host.replaceChildren(...warnings, ...fixButtons(profile));
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

  async function refreshStatus(): Promise<void> {
    try {
      status = await api.llamaStatus();
      if (!ownBinary) binaryBusy = status.jobs.binary;
      if (!ownModel) modelBusy = status.jobs.model;
      updateBuildButtons(); updateModelButtons(); renderInstalled(); updateProfileButtons(); updateEmbedCard();
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
  el("llama-scan").onclick = () => void rescan();
  el("llama-switch-wait").addEventListener("input", dirty);
  el("llama-embed-start").onclick = () => void startEmbed();
  el("llama-embed-stop").onclick = () => void api.stopLocalServer("embed");
  for (const id of ["providers.llama.embedding.enabled", "providers.llama.embedding.port", "providers.llama.embedding.ctxSize"]) el(id).addEventListener(id.endsWith("enabled") ? "change" : "input", dirty);
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
      void scan();
    },
    load(settings: LlamaProviderSettingsView): void {
      binary = { ...settings.binary };
      savedModelsDir = settings.modelsDir;
      profiles = settings.profiles.map((profile) => ({ ...profile }));
      embedDraft = { modelFile: settings.embedding.modelFile };
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
      void refreshStatus();
      // A Save that changed the models folder: scan the new one (only once the page has scanned before; shown() does the first scan).
      if (scannedFor !== undefined && scannedFor !== savedModelsDir) void scan();
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
      const embeddingModelFile = embedDraft.modelFile.trim();
      if (!embeddingModelFile) errors.push({ path: "providers.llama.embedding.modelFile", message: "Required" });
      const cleaned = profiles.map((profile) => {
        const copy: LlamaProfileView = { ...profile, label: profile.label.trim(), id: profile.id.trim(), model: profile.model.trim(), modelFile: profile.modelFile.trim(), extraArgs: profile.extraArgs.trim() };
        for (const key of ["mmprojFile", "draftFile"] as const) {
          const value = copy[key]?.trim();
          if (value) copy[key] = value; else delete copy[key];
        }
        return copy;
      });
      return { binary: out, profiles: cleaned, embeddingModelFile, ...(switchWaitMs !== undefined ? { switchWaitMs } : {}), errors };
    },
    setLauncher(server: LocalServerStatusView): void {
      launcher = server;
      updateProfileButtons();
    },
    setEmbedLauncher(server: LocalServerStatusView): void {
      embedLauncher = server;
      updateEmbedCard();
    },
  };
}
