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
  Bot,
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

export const ICONS = {
  aArrowDown: AArrowDown,
  aArrowUp: AArrowUp,
  aLargeSmall: ALargeSmall,
  arrowUp: ArrowUp,
  arrowUpLeft: ArrowUpLeft,
  arrowUpRight: ArrowUpRight,
  bot: Bot,
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
