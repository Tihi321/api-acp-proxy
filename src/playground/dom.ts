// DOM and storage helpers shared by the playground modules. Model text is never put in through innerHTML; only createElement / textContent.

export const el = <T extends HTMLElement = HTMLElement>(id: string): T => { const node = document.getElementById(id); if (!node) throw new Error(`#${id} missing`); return node as T; };
export const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };

const SVG_NS = "http://www.w3.org/2000/svg";

/** An icon from the sprite in playground.html: <svg class="icon"><use href="#i-NAME"></svg>. Colour and size come from the .icon CSS rule. */
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// Storage can be unavailable (private window, blocked site data): the page then works without history.
export const storage = {
  get(area: Storage | undefined, key: string): string | null { try { return area?.getItem(key) ?? null; } catch { return null; } },
  set(area: Storage | undefined, key: string, value: string): boolean { try { area?.setItem(key, value); return true; } catch { return false; } },
};
export const local = (() => { try { return window.localStorage; } catch { return undefined; } })();
export const session = (() => { try { return window.sessionStorage; } catch { return undefined; } })();

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows one toast in #toast (role=status) for 6 s, replacing any previous one. The optional action button runs and dismisses it. */
export function toast(text: string, action?: { label: string; run(): void }): void {
  const host = el("toast");
  clearTimeout(toastTimer);
  const item = make("div", "toast-item");
  item.append(make("span", "toast-text", text));
  if (action) {
    const button = make("button", "toast-action", action.label);
    button.type = "button";
    button.onclick = () => { clearTimeout(toastTimer); host.replaceChildren(); action.run(); };
    item.append(button);
  }
  host.replaceChildren(item);
  toastTimer = setTimeout(() => host.replaceChildren(), 6000);
}
