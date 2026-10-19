import JSZip from 'jszip';
import type { IconPack } from './icons';

/**
 * Turns a vendor's downloaded icon archive (a .zip of SVG files) into an Iconify-style pack.
 * Everything happens locally; nothing is uploaded.
 */

const ALLOWED_TAGS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
  'use',
  'symbol',
  'title',
  'desc',
  'filter',
  'fegaussianblur',
  'feoffset',
  'feblend',
  'fecolormatrix',
  'feflood',
  'fecomposite',
  'femerge',
  'femergenode',
]);

const SIZE_SUFFIX = /[_-](\d{2,3})(?:@\dx)?$/;
const VARIANT_SUFFIX = /[_-](light|dark|color|bg)$/i;

/** Normalizes vendor file names: "Arch_Amazon-EC2_48.svg" -> "amazon-ec2". */
export function iconNameFromPath(path: string): { name: string; size: number } {
  // Variant suffixes may come after the size ("Res_..._48_Light"), so strip them first.
  let base = path
    .split('/')
    .pop()!
    .replace(/\.svg$/i, '')
    .replace(VARIANT_SUFFIX, '');
  const size = Number(SIZE_SUFFIX.exec(base)?.[1] ?? 0);
  base = base
    .replace(SIZE_SUFFIX, '')
    .replace(/^\d+-icon-service-/i, '')
    .replace(/^(arch-category|arch|res)[_-]/i, '')
    .replace(VARIANT_SUFFIX, '');
  const name = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return { name, size };
}

/** Any url(...) reference that does not point at a local "#id". */
const EXTERNAL_URL = /url\(\s*(?![\s'"]*#)/i;
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const LOCAL_URL = /url\(\s*['"]?\s*#([^)'"\s]+)['"]?\s*\)/g;

function sanitizeAttributes(el: Element, idPrefix: string) {
  for (const attr of [...el.attributes]) {
    // localName so that prefixed variants ("x:onload", "foo:href" bound to xlink) are caught too.
    const local = attr.localName.toLowerCase();
    const v = attr.value.trim();
    if (local.startsWith('on')) el.removeAttributeNode(attr);
    else if (local === 'href') {
      if (v.startsWith('#')) attr.value = `#${idPrefix}-${v.slice(1)}`;
      else el.removeAttributeNode(attr);
    } else if (local === 'id' && !attr.prefix) attr.value = `${idPrefix}-${v}`;
    // External url() in any attribute (fill, style, ...) is dropped; CSS escapes could hide one.
    else if (
      EXTERNAL_URL.test(v) ||
      (local === 'style' && /\\|@import|image-set|expression\s*\(/i.test(v))
    )
      el.removeAttributeNode(attr);
    else if (/url\(/i.test(v)) attr.value = v.replace(LOCAL_URL, `url(#${idPrefix}-$1)`);
  }
}

/**
 * Strips anything active from an SVG: scripts, event handlers, foreignObject, external links.
 * Ids are prefixed so gradients from different icons don't collide on one page.
 * The returned body is later injected with innerHTML (HTML parser), so comments, processing
 * instructions and CDATA sections are removed/converted: they serialize to markup the HTML
 * parser reads differently (e.g. `<?x a="><img onerror=...>"?>` breaks out of the comment).
 */
export function sanitizeSvg(
  svgText: string,
  idPrefix: string,
): { body: string; width: number; height: number } | null {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  // Exact, case-sensitive match: "<SVG>" is a different element in XML but becomes <svg> in HTML.
  if (
    !svg ||
    svg.localName !== 'svg' ||
    svg.prefix ||
    doc.getElementsByTagName('parsererror').length
  )
    return null;

  const walk = (el: Element) => {
    for (const child of [...el.childNodes]) {
      if (child.nodeType === 4 /* CDATA_SECTION_NODE */) {
        child.replaceWith(doc.createTextNode((child as CDATASection).data));
        continue;
      }
      if (child.nodeType === 3 /* TEXT_NODE */) continue;
      if (child.nodeType !== 1 /* ELEMENT_NODE */) {
        child.remove();
        continue;
      }
      const e = child as Element;
      if (e.prefix || !ALLOWED_TAGS.has(e.localName.toLowerCase())) {
        e.remove();
        continue;
      }
      sanitizeAttributes(e, idPrefix);
      walk(e);
    }
  };
  walk(svg);
  // <style> blocks are dropped by the allow-list; class-based colors then fall back to defaults.

  const vb = svg
    .getAttribute('viewBox')
    ?.split(/[\s,]+/)
    .map(Number);
  const width = vb?.[2] || Number.parseFloat(svg.getAttribute('width') ?? '') || 24;
  const height = vb?.[3] || Number.parseFloat(svg.getAttribute('height') ?? '') || 24;
  // Root attributes never reach the output: drop them all (keeping only the fixed xlink
  // declaration so child xlink:href keeps its prefix), so the root tag stripped below has
  // known content and cannot hide markup in an attribute value.
  for (const attr of [...svg.attributes]) svg.removeAttributeNode(attr);
  svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', XLINK_NS);
  let body = new XMLSerializer().serializeToString(svg);
  body = /^<svg[^>]*\/>$/.test(body) ? '' : body.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  // Non-zero viewBox origins are wrapped so the Iconify-style 0 0 w h box still lines up.
  if (vb && Number.isFinite(vb[0]) && Number.isFinite(vb[1]) && (vb[0] || vb[1]))
    body = `<g transform="translate(${-vb[0]!} ${-vb[1]!})">${body}</g>`;
  return { body, width, height };
}

export async function importPackZip(file: Blob, prefix: string, name: string): Promise<IconPack> {
  const zip = await JSZip.loadAsync(file);
  const pack: IconPack = { prefix, name, icons: {}, keywords: {} };
  const sizes = new Map<string, number>();
  const files = Object.values(zip.files).filter(
    (f) => !f.dir && /\.svg$/i.test(f.name) && !f.name.includes('__MACOSX'),
  );
  for (const f of files) {
    const { name: iconName, size } = iconNameFromPath(f.name);
    if (!iconName) continue;
    // Vendors ship the same icon in several sizes; keep the largest.
    if (sizes.has(iconName) && sizes.get(iconName)! >= size) continue;
    const icon = sanitizeSvg(await f.async('string'), `${prefix}-${iconName}`);
    if (!icon) continue;
    sizes.set(iconName, size);
    pack.icons[iconName] = icon;
    pack.keywords![iconName] = f.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  }
  return pack;
}
