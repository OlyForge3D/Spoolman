import { getJson } from '$lib/api/http';
import { parseSetting, type SettingResponse } from '$lib/api/settings';
import { paperSize } from './paper';
import { resolveExportFormat } from './export';
import {
	DEFAULT_LAYOUT,
	type LabelDesign,
	type LabelElement,
	type LabelKind,
	type PaperName,
	type PrintLayout
} from './types';

// One-time transfer of the v1 client's print presets into v2 label designs. The
// v1 label was a fixed QR-left / text-right layout with a text template; the v2
// designer is far more capable, but the default QR-code-plus-textbox design
// produced here reproduces the old look. The layout (paper, margins, spacing,
// columns, safe-zone, skip, copies, border) maps essentially 1-1; the template's
// field paths are rewritten to the v2 names.
//
// Upstream v1 stored a single `print_presets` setting of spool labels printed to
// a sheet. This fork added three more, so all four are imported:
//
//   print_presets           spool    → sheet   (upstream)
//   print_presets_filament  filament → sheet
//   image_presets           spool    → image   (file export)
//   image_presets_filament  filament → image
//
// The fork's presets also carry settings upstream's v1 never had — an export DPI,
// a PNG/AML format choice and an explicit AML label size — which map onto the v2
// layout fields of the same meaning instead of falling back to the defaults.

// --- v1 shapes (subset we read) --------------------------------------------
// Mirrors client/src/pages/printing/printing.tsx.

interface V1PrintSettings {
	name?: string;
	margin?: { top: number; bottom: number; left: number; right: number };
	printerMargin?: { top: number; bottom: number; left: number; right: number };
	spacing?: { horizontal: number; vertical: number };
	columns?: number;
	rows?: number;
	skipItems?: number;
	itemCopies?: number;
	paperSize?: string;
	customPaperSize?: { width: number; height: number };
	borderShowMode?: 'none' | 'border' | 'grid';
	// Fork-only, set by the label export dialogs.
	amlLabelSize?: { width: number; height: number };
	exportDpi?: number;
	exportFormat?: 'png' | 'aml';
	exportAmlAsPages?: boolean;
}
interface V1LabelSettings {
	showContent?: boolean;
	showQRCodeMode?: 'no' | 'simple' | 'withIcon';
	textSize?: number;
	printSettings?: V1PrintSettings;
}
interface V1Preset {
	template?: string;
	labelSettings?: V1LabelSettings;
}

// The v1 default template (used when a preset stored no explicit template), before
// path rewriting. Kept verbatim from spoolQrCodePrintingDialog.tsx.
const V1_DEFAULT_TEMPLATE = `**{filament.vendor.name} - {filament.name}
#{id} - {filament.material}**
Spool Weight: {filament.spool_weight} g
{ET: {filament.settings_extruder_temp} °C}
{BT: {filament.settings_bed_temp} °C}
{Lot Nr: {lot_nr}}
{{comment}}
{filament.comment}
{filament.vendor.comment}`;

// The fork's default template for *filament* presets, kept verbatim from
// filamentQrCodePrintingDialog.tsx. A filament preset has no spool behind it, so
// its paths are rooted at the filament itself — `{name}`, not `{filament.name}`.
const V1_FILAMENT_DEFAULT_TEMPLATE = `**{vendor.name} - {name}
#{id} - {material}**
{Diameter: {diameter} mm}
{Weight: {weight} g}
{Spool Weight: {spool_weight} g}
{ET: {settings_extruder_temp} °C}
{BT: {settings_bed_temp} °C}
{Article: {article_number}}
{{comment}}
{comment}
{vendor.comment}`;

// v1 placeholder path → v2 resolver path (see labels/template.ts). Paths already
// identical in both (filament.name/material/price/density/diameter/weight/comment,
// filament.registered) are omitted — they pass through unchanged. Paths with no v2
// equivalent (e.g. remaining_length, archived) are left as-is and resolve to "?".
const PATH_MAP: Record<string, string> = {
	// Spool
	id: 'spool.id',
	registered: 'spool.registered',
	first_used: 'spool.firstUsed',
	last_used: 'spool.lastUsed',
	location: 'spool.location',
	lot_nr: 'spool.lot',
	comment: 'spool.comment',
	price: 'spool.price',
	remaining_weight: 'spool.remaining',
	initial_weight: 'spool.initial',
	used_weight: 'spool.used',
	// v1 offered the spool's own tare weight as a bare `spool_weight`. It had no v2
	// equivalent until the spool gained the field back (#1013), so a migrated design
	// using it resolved to "?".
	spool_weight: 'spool.spoolWeight',
	// Filament
	'filament.spool_weight': 'filament.spoolWeight',
	'filament.settings_extruder_temp': 'filament.nozzleTemp',
	'filament.settings_bed_temp': 'filament.bedTemp',
	'filament.color_hex': 'filament.color',
	'filament.article_number': 'filament.articleNumber',
	'filament.external_id': 'filament.externalId',
	// Vendor (v1 nested it under filament)
	'filament.vendor.name': 'vendor.name',
	'filament.vendor.comment': 'vendor.comment',
	'filament.vendor.empty_spool_weight': 'vendor.emptyWeight',
	'filament.vendor.external_id': 'vendor.externalId',
	'filament.vendor.registered': 'vendor.registered'
};

/**
 * Filament-preset placeholder path → v2 resolver path. A filament preset's paths
 * are rooted at the filament, so the bare names here mean something different
 * from the same names in {@link PATH_MAP} (`{id}` is the filament, not the spool)
 * — which is why the two kinds get separate maps rather than one merged one.
 * Vendor paths were already `vendor.*` in v1 filament presets.
 */
const FILAMENT_PATH_MAP: Record<string, string> = {
	id: 'filament.id',
	name: 'filament.name',
	material: 'filament.material',
	diameter: 'filament.diameter',
	density: 'filament.density',
	weight: 'filament.weight',
	price: 'filament.price',
	comment: 'filament.comment',
	registered: 'filament.registered',
	spool_weight: 'filament.spoolWeight',
	settings_extruder_temp: 'filament.nozzleTemp',
	settings_bed_temp: 'filament.bedTemp',
	color_hex: 'filament.color',
	article_number: 'filament.articleNumber',
	external_id: 'filament.externalId',
	// Vendor
	'vendor.empty_spool_weight': 'vendor.emptyWeight',
	'vendor.external_id': 'vendor.externalId'
};

/** Rewrite a v1 template's `{path}` tokens to the v2 field paths. */
export function migrateTemplate(template: string, kind: LabelKind = 'spool'): string {
	let out = template;
	if (kind === 'filament') {
		// A filament preset's extras are the filament's own, and its vendor's are
		// already `vendor.extra.*`. Only the bare form needs a prefix.
		out = out.split('{extra.').join('{filament.extra.');
		for (const [v1, v2] of Object.entries(FILAMENT_PATH_MAP)) {
			out = out.split(`{${v1}}`).join(`{${v2}}`);
		}
		return out;
	}
	// Extra-field prefixes: v1 spool extras are bare `extra.*`; vendor extras are
	// nested under filament. Do the longer vendor form first.
	out = out.split('{filament.vendor.extra.').join('{vendor.extra.');
	out = out.split('{extra.').join('{spool.extra.');
	// Fixed paths. A path always sits inside its own braces (both the bare `{path}`
	// and the wrapped `{prefix{path}suffix}` forms), so replacing `{v1}` → `{v2}`
	// is unambiguous.
	for (const [v1, v2] of Object.entries(PATH_MAP)) {
		out = out.split(`{${v1}}`).join(`{${v2}}`);
	}
	return out;
}

/** Map a v1 paper name to the closest v2 paper + custom dimensions. */
function mapPaper(ps: V1PrintSettings): { paper: PaperName; custom: { w: number; h: number } } {
	const known: PaperName[] = ['A4', 'A3', 'A5', 'Letter', 'Legal'];
	const custom = {
		w: ps.customPaperSize?.width ?? DEFAULT_LAYOUT.custom.w,
		h: ps.customPaperSize?.height ?? DEFAULT_LAYOUT.custom.h
	};
	const size = ps.paperSize ?? 'A4';
	// v2 dropped Tabloid — carry it over as a custom size so the sheet stays right.
	if (size === 'Tabloid') return { paper: 'custom', custom: { w: 279, h: 432 } };
	if (size === 'custom') return { paper: 'custom', custom };
	if (known.includes(size as PaperName)) return { paper: size as PaperName, custom };
	return { paper: 'A4', custom };
}

function mapLayout(ps: V1PrintSettings, mode: PrintLayout['mode']): PrintLayout {
	const { paper, custom } = mapPaper(ps);
	return {
		mode,
		// Upstream's v1 had neither setting, so a preset without them keeps the
		// defaults. The fork's export dialogs wrote both, and they carry the same
		// meaning in v2, so they come across as-is. A nonsensical stored DPI is
		// clamped rather than dropped: it still tells us the intended ballpark.
		dpi: clampDpi(ps.exportDpi),
		exportFormat: resolveExportFormat(ps.exportFormat).id,
		paper,
		custom,
		landscape: false,
		margin: {
			t: ps.margin?.top ?? DEFAULT_LAYOUT.margin.t,
			b: ps.margin?.bottom ?? DEFAULT_LAYOUT.margin.b,
			l: ps.margin?.left ?? DEFAULT_LAYOUT.margin.l,
			r: ps.margin?.right ?? DEFAULT_LAYOUT.margin.r
		},
		safe: {
			t: ps.printerMargin?.top ?? 0,
			b: ps.printerMargin?.bottom ?? 0,
			l: ps.printerMargin?.left ?? 0,
			r: ps.printerMargin?.right ?? 0
		},
		columns: Math.max(1, Math.round(ps.columns ?? 3)),
		spacing: { h: ps.spacing?.horizontal ?? 0, v: ps.spacing?.vertical ?? 0 },
		skip: Math.max(0, ps.skipItems ?? 0),
		copies: Math.max(1, ps.itemCopies ?? 1),
		// v2 has no separate "grid" mode; fold it into a plain border.
		border: ps.borderShowMode === 'none' ? 'none' : 'border'
	};
}

/**
 * Keep a stored export DPI inside a range the rasterizer can actually honour.
 * The fork's slider offered 96–600; anything outside that (hand-edited, or absent)
 * falls back to the v2 default rather than producing a 1-pixel or 20-megapixel label.
 */
function clampDpi(dpi: number | undefined): number {
	if (typeof dpi !== 'number' || !Number.isFinite(dpi)) return DEFAULT_LAYOUT.dpi;
	return Math.min(600, Math.max(96, Math.round(dpi)));
}

/**
 * Recreate the v1 label size, which was derived from the grid rather than stored:
 * the usable area split into columns × rows, minus the spacing. Guarded so a
 * degenerate preset can't produce a zero/negative canvas.
 *
 * The fork's export presets are the exception: they stored the physical label size
 * outright (it is what the AML file declares to the printer), so when that is
 * present it wins over anything the sheet grid implies.
 */
function deriveLabelSize(ps: V1PrintSettings, layout: PrintLayout): { w: number; h: number } {
	const aml = ps.amlLabelSize;
	if (aml && aml.width > 0 && aml.height > 0) {
		return { w: aml.width, h: aml.height };
	}
	const page = paperSize(layout);
	const cols = layout.columns;
	const rows = Math.max(1, Math.round(ps.rows ?? 8));
	const usableW = page.w - layout.margin.l - layout.margin.r;
	const usableH = page.h - layout.margin.t - layout.margin.b;
	const w = (usableW - layout.spacing.h) / cols - layout.spacing.h;
	const h = (usableH - layout.spacing.v) / rows - layout.spacing.v;
	const round = (n: number) => Math.round(n * 10) / 10;
	return { w: Math.max(10, round(w)), h: Math.max(8, round(h)) };
}

/** Build the QR-left / text-right elements that reproduce the v1 label. */
function buildElements(
	ls: V1LabelSettings,
	id: string,
	size: { w: number; h: number },
	template: string
): LabelElement[] {
	const pad = 1;
	const mode = ls.showQRCodeMode ?? 'withIcon';
	const showQr = mode !== 'no';
	const showText = ls.showContent !== false;
	const elements: LabelElement[] = [];

	let textX = pad;
	if (showQr) {
		// Square QR pinned to the left, ~half the width, vertically centered.
		const qrSize = Math.max(6, Math.min(size.h - 2 * pad, size.w * 0.45));
		elements.push({
			id: `${id}-qr`,
			type: 'qr',
			x: pad,
			y: Math.max(pad, (size.h - qrSize) / 2),
			size: qrSize,
			ec: 'H',
			encoding: 'scheme',
			logo: mode === 'withIcon'
		});
		textX = pad + qrSize + pad;
	}

	if (showText) {
		elements.push({
			id: `${id}-t`,
			type: 'text',
			x: textX,
			y: pad,
			w: Math.max(4, size.w - textX - pad),
			fontSize: ls.textSize ?? 3,
			bold: false,
			align: 'left',
			color: '#000000',
			wrap: true,
			template
		});
	}
	return elements;
}

let counter = 0;
function uid(): string {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	return `v1-${Date.now()}-${counter++}`;
}

/** Which entity a v1 preset labelled, and how it was output. */
export interface V1PresetSource {
	kind: LabelKind;
	mode: PrintLayout['mode'];
}

/** Convert a single v1 preset into a v2 design. */
export function presetToDesign(
	preset: V1Preset,
	source: V1PresetSource = { kind: 'spool', mode: 'sheet' }
): LabelDesign {
	const id = uid();
	const ls = preset.labelSettings ?? {};
	const ps = ls.printSettings ?? {};
	const layout = mapLayout(ps, source.mode);
	const label = deriveLabelSize(ps, layout);
	const fallback = source.kind === 'filament' ? V1_FILAMENT_DEFAULT_TEMPLATE : V1_DEFAULT_TEMPLATE;
	const template = migrateTemplate(preset.template ?? fallback, source.kind);

	return {
		id,
		name: ps.name || 'Imported label',
		kind: source.kind,
		label,
		elements: buildElements(ls, id, label, template),
		layout
	};
}

/**
 * The v1 settings holding print presets, and what each one's presets describe.
 * Upstream shipped only `print_presets`; the rest are this fork's. Order fixes the
 * order of the imported designs.
 */
const V1_PRESET_SETTINGS: { key: string; source: V1PresetSource }[] = [
	{ key: 'print_presets', source: { kind: 'spool', mode: 'sheet' } },
	{ key: 'print_presets_filament', source: { kind: 'filament', mode: 'sheet' } },
	{ key: 'image_presets', source: { kind: 'spool', mode: 'image' } },
	{ key: 'image_presets_filament', source: { kind: 'filament', mode: 'image' } }
];

/** Read one v1 preset setting. Returns [] when unset, empty or unreadable. */
async function readPresetSetting(key: string, source: V1PresetSource): Promise<LabelDesign[]> {
	try {
		const s = await getJson<SettingResponse>(`/setting/${key}`);
		if (!s?.is_set) return [];
		const presets = parseSetting<V1Preset[]>(s, []);
		if (!Array.isArray(presets) || presets.length === 0) return [];
		return presets.map((p) => presetToDesign(p, source));
	} catch (e) {
		// A key this server doesn't know (an upstream server has none of the fork's
		// three) 404s. That is the normal case, not a failure worth surfacing.
		console.debug(`No v1 presets imported from ${key}`, e);
		return [];
	}
}

/**
 * Read every v1 print-preset setting and convert them to v2 designs. Returns an
 * empty array when v1 was never used or on any error — this runs unattended at
 * first load and must never throw.
 */
export async function importV1Presets(): Promise<LabelDesign[]> {
	const groups = await Promise.all(
		V1_PRESET_SETTINGS.map(({ key, source }) => readPresetSetting(key, source))
	);
	return groups.flat();
}
