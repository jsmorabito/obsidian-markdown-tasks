/**
 * Status icons for styled links — the same SVGs the Note Types plugin draws
 * for its status links, so both plugins' pills look alike side by side.
 */

export type StatusKind = "backlog" | "todo" | "started" | "paused" | "done" | "canceled";

const STATUS_SVG_MARKUP: Record<StatusKind, string> = {
	backlog: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="#A1A1A1" stroke-width="2" stroke-linecap="round" stroke-dasharray="4 4"/></svg>`,
	todo: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="#A1A1A1" stroke-width="2" stroke-linecap="round"/></svg>`,
	started: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="#BD8E37" stroke-width="2" stroke-linecap="round"/><path d="M12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6V18Z" fill="#BD8E37"/></svg>`,
	paused: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="#A1A1A1" stroke-width="2" stroke-linecap="round"/><path d="M10 8.5V15.5M14 8.5V15.5" stroke="#A1A1A1" stroke-width="2" stroke-linecap="round"/></svg>`,
	done: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2ZM15.707 9.29297C15.3165 8.90244 14.6835 8.90244 14.293 9.29297L11 12.5859L9.70703 11.293C9.31651 10.9024 8.68349 10.9024 8.29297 11.293C7.90244 11.6835 7.90244 12.3165 8.29297 12.707L10.293 14.707C10.6835 15.0976 11.3165 15.0976 11.707 14.707L15.707 10.707C16.0976 10.3165 16.0976 9.68349 15.707 9.29297Z" fill="#8E68F5"/></svg>`,
	canceled: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2ZM15.707 8.29297C15.3165 7.90244 14.6835 7.90244 14.293 8.29297L12 10.5859L9.70703 8.29297C9.31651 7.90244 8.68349 7.90244 8.29297 8.29297C7.90244 8.68349 7.90244 9.31651 8.29297 9.70703L10.5859 12L8.29297 14.293C7.90244 14.6835 7.90244 15.3165 8.29297 15.707C8.68349 16.0976 9.31651 16.0976 9.70703 15.707L12 13.4141L14.293 15.707C14.6835 16.0976 15.3165 16.0976 15.707 15.707C16.0976 15.3165 16.0976 14.6835 15.707 14.293L13.4141 12L15.707 9.70703C16.0976 9.31651 16.0976 8.68349 15.707 8.29297Z" fill="#A1A1A1"/></svg>`,
};

const parser = new DOMParser();
const svgCache = new Map<StatusKind, SVGElement>();
const dataUrlCache = new Map<StatusKind, string>();

/** A fresh SVG element for the status, built via DOMParser so callers never need innerHTML. */
export function statusIconSvg(kind: StatusKind | null): SVGElement | null {
	if (!kind) return null;
	let svg = svgCache.get(kind);
	if (!svg) {
		svg = parser.parseFromString(STATUS_SVG_MARKUP[kind], "image/svg+xml").documentElement as unknown as SVGElement;
		svgCache.set(kind, svg);
	}
	return svg.cloneNode(true) as SVGElement;
}

/**
 * The status icon as a CSS `url(...)` value, for the Live Preview mark's style
 * attribute (a widget inside the mark would split the pill in two).
 */
export function statusIconDataUrl(kind: StatusKind | null): string | null {
	if (!kind) return null;
	let url = dataUrlCache.get(kind);
	if (!url) {
		url = `url("data:image/svg+xml,${encodeURIComponent(STATUS_SVG_MARKUP[kind])}")`;
		dataUrlCache.set(kind, url);
	}
	return url;
}

/** A CSS colour as a user would type it, or null when it is empty or could escape a declaration. */
export function safeCssColor(value: string): string | null {
	const color = value.trim();
	return color && /^[#a-z0-9(),.%\s/-]+$/i.test(color) && !/url\(/i.test(color) ? color : null;
}
