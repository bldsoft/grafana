// Analytix: client-side export of a generated inline panel.
//
// The chat renders a bare EmbeddedScene (no dashboard menu), so the usual
// panel-inspector export is not wired up — this reimplements the two useful
// bits directly:
//   - CSV: the panel's query result, run through applyFieldOverrides first so
//          the time column and units are FORMATTED (as Grafana's own CSV is),
//          and with a spreadsheet formula-injection guard on string cells.
//   - PNG: the panel's plot <canvas> composited onto an opaque background with
//          the title captioned on top. Offered only for panel types that draw
//          on a canvas (uPlot charts and the flot gauge — see canExportImage);
//          table/piechart/stat/bargauge are DOM/SVG with no client-side
//          rasterizer here. The legend is separate DOM and is NOT captured.
import saveAs from 'file-saver';

import {
  applyFieldOverrides,
  DataFrame,
  dateTimeFormat,
  FieldType,
  GrafanaTheme2,
  LoadingState,
  PanelData,
  toCSV,
} from '@grafana/data';
import { sceneGraph, SceneDataTransformer, VizPanel } from '@grafana/scenes';
import analytixLogoSvg from 'img/analytix_icon.svg';

import { SupportedPanelType } from './types';

/** Why an export could not run — drives the message shown to the user. */
export type ExportState = 'ready' | 'loading' | 'empty' | 'error';

// uPlot-based panels plus the flot-drawn gauge — all raster onto a <canvas>
// largestCanvas can grab. Excluded: bargauge/stat/table/piechart (DOM/SVG).
const CANVAS_PANEL_TYPES: readonly SupportedPanelType[] = [
  'timeseries',
  'barchart',
  'histogram',
  'heatmap',
  'state-timeline',
  'status-history',
  'trend',
  'xychart',
  'gauge',
];

/** True when the panel type renders on a <canvas> we can turn into a PNG. */
export function canExportImage(panelType: SupportedPanelType): boolean {
  return CANVAS_PANEL_TYPES.includes(panelType);
}

/** Timestamped, filesystem-safe download name derived from the panel title. */
export function exportFileName(title: string): string {
  const base =
    (title || 'panel')
      .trim()
      .replace(/[^\w.-]+/g, '_')
      // Trim leading/trailing separators AND dots, so no hidden ".name" file and
      // no leading dash that a shell could read as a flag.
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 80) || 'panel';
  // Colon/space-free timestamp so the filename is valid on every OS (the default
  // dateTimeFormat yields "YYYY-MM-DD HH:mm:ss", unsafe on Windows).
  return `${base}-${dateTimeFormat(new Date(), { format: 'YYYY-MM-DD-HHmmss' })}`;
}

/**
 * The query's own result — the rows the SQL returned. Chart panels sit behind
 * a client-side reshaping transformer (buildPanel.ts: long rows split into
 * one frame per entity, sorted, pivoted); the export wants the data before
 * that step, as one table, not one CSV block per series.
 */
function panelData(panel: VizPanel): PanelData | undefined {
  const provider = sceneGraph.getData(panel);
  const source = provider instanceof SceneDataTransformer ? provider.state.$data : undefined;
  return (source ?? provider).state.data;
}

/** Distinguish "still loading" from the terminal empty/error outcomes. */
export function exportState(panel: VizPanel): ExportState {
  const data = panelData(panel);
  if (!data || data.state === LoadingState.Loading || data.state === LoadingState.Streaming) {
    return 'loading';
  }
  if (data.state === LoadingState.Error) {
    return 'error';
  }
  if (!data.series?.length || data.series.every((frame) => frame.length === 0)) {
    return 'empty';
  }
  return 'ready';
}

// Neutralize spreadsheet formula injection: a string cell that begins with
// = + - @ TAB or CR is executed as a formula by Excel/LibreOffice on open.
// Prefix such cells with an apostrophe. Only STRING fields are touched, so
// numeric/time columns (and negative numbers stored as numbers) are unaffected.
const FORMULA_LEAD_RE = /^[=+\-@\t\r]/;
export function guardCsvInjection(frames: DataFrame[]): DataFrame[] {
  return frames.map((frame) => ({
    ...frame,
    fields: frame.fields.map((field) =>
      field.type === FieldType.string
        ? {
            ...field,
            values: field.values.map((v: unknown) =>
              typeof v === 'string' && FORMULA_LEAD_RE.test(v) ? `'${v}` : v
            ),
          }
        : field
    ),
  }));
}

/**
 * Save the panel's data as CSV. Returns the export state: 'ready' once the
 * download starts, otherwise why it could not (loading/empty/error) so the
 * caller can show the right message.
 */
export function exportPanelCsv(panel: VizPanel, title: string, theme: GrafanaTheme2): ExportState {
  const state = exportState(panel);
  if (state !== 'ready') {
    return state;
  }
  // applyFieldOverrides attaches the display processors the panel renders with,
  // so toCSV writes formatted dates instead of raw epoch-ms (the raw runner
  // frames carry no field.display). The panel's number unit is dropped on
  // purpose: charts abbreviate ("25.6 K", buildPanel.ts) while a spreadsheet
  // wants the exact value.
  const { defaults = {}, overrides = [] } = panel.state.fieldConfig ?? {};
  const formatted = applyFieldOverrides({
    data: guardCsvInjection(panelData(panel)!.series),
    fieldConfig: { defaults: { ...defaults, unit: undefined }, overrides },
    theme,
    replaceVariables: (value) => value,
    timeZone: 'browser',
  });
  saveAs(new Blob([toCSV(formatted)], { type: 'text/csv;charset=utf-8' }), `${exportFileName(title)}.csv`);
  return 'ready';
}

/** Largest non-empty canvas under the element (uPlot draws one plot canvas). */
function largestCanvas(rootEl: HTMLElement): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  for (const c of rootEl.querySelectorAll('canvas')) {
    if (c.width > 0 && c.height > 0 && (!best || c.width * c.height > best.width * best.height)) {
      best = c;
    }
  }
  return best;
}

export interface PngExportStyle {
  background: string;
  text: string;
  fontFamily: string;
}

// Analytix wordmark stamped into the top-right corner of every exported PNG.
// The SVG is bundled/same-origin (no canvas tainting) and white-filled — drawn
// on the dark theme backgrounds this (dark-only) build exports on.
const LOGO_URL: string = analytixLogoSvg;
// The wordmark's design proportions (viewBox 0 0 185 44). The drawn box is
// always derived from this constant — never from Image natural sizes — so the
// stamp cannot be distorted by whatever intrinsic size the browser reports.
// If the asset is ever replaced, update this ratio with it.
const LOGO_ASPECT = 185 / 44;
// Give a slow first fetch a moment; past it the text wordmark is drawn instead.
const LOGO_LOAD_TIMEOUT_MS = 1500;

let logoSvgPromise: Promise<string | null> | null = null;

function loadLogoSvg(): Promise<string | null> {
  if (!logoSvgPromise) {
    // The asset URL follows __webpack_public_path__, which a deployment can
    // point at a CDN; a CORS-less cross-origin host fails the fetch and the
    // export falls back to the text wordmark. Same-origin always works.
    logoSvgPromise = fetch(LOGO_URL)
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => (text && text.includes('<svg') ? text : null))
      .catch(() => null)
      .then((text) => {
        if (!text) {
          // Drop the cached failure so a later export retries the fetch.
          logoSvgPromise = null;
        }
        return text;
      });
  }
  return logoSvgPromise;
}

/**
 * Rasterize the wordmark at exactly the given device-pixel box. Drawing the
 * SVG straight through drawImage lets the browser rasterize it at its
 * intrinsic 185x44 and then bitmap-scale the result into the destination box,
 * which thins and blurs the glyph strokes at export sizes. Pinning the SVG's
 * width/height to the target box makes the vector engine rasterize 1:1 (and
 * preserveAspectRatio guards the proportions even against a mis-sized box).
 */
async function rasterizeLogo(width: number, height: number): Promise<HTMLImageElement | null> {
  const svg = await loadLogoSvg();
  if (!svg) {
    return null;
  }
  const patched = svg.replace(/<svg\b([^>]*)>/, (_match, attrs: string) => {
    const rest = attrs.replace(/\s(?:width|height)="[^"]*"/g, '');
    return `<svg${rest} width="${width}" height="${height}">`;
  });
  const url = URL.createObjectURL(new Blob([patched], { type: 'image/svg+xml' }));
  try {
    return await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

/**
 * Save the panel's chart as PNG. The uPlot canvas is transparent (the panel
 * background is CSS), so it is composited onto `background` with the title
 * captioned above the plot and the Analytix wordmark in the top-right corner.
 * The legend (separate DOM) is not included. Resolves false when no canvas is
 * present yet (still loading, or a non-canvas type).
 */
export async function exportPanelPng(rootEl: HTMLElement | null, title: string, style: PngExportStyle): Promise<boolean> {
  const src = rootEl ? largestCanvas(rootEl) : null;
  if (!src) {
    return false;
  }
  // Capture layout metrics before awaiting: the element may leave the DOM
  // while the logo loads (its canvas bitmap stays drawable regardless).
  const rect = src.getBoundingClientRect();
  // The canvas backing store is at device-pixel resolution; derive that scale
  // from its rendered size so the caption text matches the chart's crispness.
  const scale = rect.width > 0 ? src.width / rect.width : window.devicePixelRatio || 1;
  // The stamp box comes from the design-time aspect constant, and the SVG is
  // rasterized at exactly this device-pixel box (see rasterizeLogo).
  const logoHeight = Math.round(14 * scale);
  const logoWidth = Math.round(logoHeight * LOGO_ASPECT);
  const logo = await Promise.race([
    rasterizeLogo(logoWidth, logoHeight),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), LOGO_LOAD_TIMEOUT_MS)),
  ]);
  try {
    const caption = title.trim();
    // The top band always exists now — it carries the wordmark even for an
    // (unlikely) empty caption.
    const band = Math.round(30 * scale);
    const padding = Math.round(12 * scale);

    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height + band;
    const ctx = out.getContext('2d');
    if (!ctx) {
      return false;
    }
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, out.width, out.height);

    if (logo) {
      // 1:1 blit of the pre-rasterized wordmark — no scaling, no distortion.
      ctx.drawImage(logo, out.width - padding - logoWidth, Math.round((band - logoHeight) / 2), logoWidth, logoHeight);
    } else {
      // Fallback wordmark when the SVG could not be fetched in time.
      ctx.fillStyle = style.text;
      ctx.font = `bold ${Math.round(13 * scale)}px ${style.fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.fillText('Analytix', out.width - padding, band / 2);
      ctx.textAlign = 'left';
    }

    if (caption) {
      ctx.fillStyle = style.text;
      ctx.font = `${Math.round(13 * scale)}px ${style.fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.direction = 'inherit';
      ctx.fillText(fitText(ctx, caption, out.width - padding * 3 - logoWidth), padding, band / 2);
    }
    ctx.drawImage(src, 0, band);
    out.toBlob((blob) => {
      if (blob) {
        saveAs(blob, `${exportFileName(title)}.png`);
      }
    }, 'image/png');
    return true;
  } catch {
    // A tainted canvas (should never happen for uPlot) throws on toBlob/drawImage.
    return false;
  }
}
