/**
 * Inline SVG icons built from Lucide icon nodes.
 *
 * Named imports keep the webview and extension bundles to the icons actually
 * used (lucide is side-effect free). `icon()` only serializes strings, so the
 * extension host can call it while rendering webview markup.
 *
 * Icons: Lucide (https://lucide.dev), ISC License.
 */
import {
  AArrowDown,
  AArrowUp,
  ALargeSmall,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleX,
  CloudAlert,
  CloudCheck,
  CloudCog,
  CloudOff,
  CloudSync,
  CloudUpload,
  Copy,
  FileJson,
  FileText,
  Globe,
  Info,
  Keyboard,
  LoaderCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Send,
  Settings,
  Trash2,
  Upload,
  X,
  type IconNode,
} from "lucide";

/**
 * Document outline with a corner fold, carrying a letter `A` instead of text
 * lines. Marks the global AGENTS.md file, so it shares `FileText`'s frame and
 * keeps the same 24px grid and stroke weight as the Lucide set.
 */
const FileLetterA: IconNode = [
  ...FileText.slice(0, 2),
  ["path", { d: "M9.1 18 11.4 12h1.2l2.3 6" }],
  ["path", { d: "M9.9 16h4.2" }],
];

export const ICONS = {
  aArrowDown: AArrowDown,
  aArrowUp: AArrowUp,
  aLargeSmall: ALargeSmall,
  arrowUp: ArrowUp,
  arrowUpLeft: ArrowUpLeft,
  arrowUpRight: ArrowUpRight,
  check: Check,
  chevronDown: ChevronDown,
  circleX: CircleX,
  cloudAlert: CloudAlert,
  cloudCheck: CloudCheck,
  cloudCog: CloudCog,
  cloudOff: CloudOff,
  cloudSync: CloudSync,
  cloudUpload: CloudUpload,
  copy: Copy,
  fileJson: FileJson,
  fileLetterA: FileLetterA,
  globe: Globe,
  info: Info,
  keyboard: Keyboard,
  loader: LoaderCircle,
  pencil: Pencil,
  refresh: RefreshCw,
  rotateCcw: RotateCcw,
  rotateCw: RotateCw,
  send: Send,
  settings: Settings,
  trash: Trash2,
  upload: Upload,
  x: X,
} satisfies Record<string, IconNode>;

function attr(value: string | number | undefined): string {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Serialize a Lucide icon node to an inline SVG string. */
export function icon(
  node: IconNode,
  size = 14,
  className?: string,
): string {
  const body = node
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => ` ${name}="${attr(value)}"`)
        .join("");
      return `<${tag}${pairs}/>`;
    })
    .join("");
  const cls = className ? ` class="${attr(className)}"` : "";
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    `stroke-linejoin="round" aria-hidden="true"${cls}>${body}</svg>`
  );
}
