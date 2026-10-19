import { describe, expect, it } from 'vitest';
import { iconNameFromPath, sanitizeSvg } from '../src/packs';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg = (inner: string, attrs = 'viewBox="0 0 48 48"') => `<svg ${NS} ${attrs}>${inner}</svg>`;

function clean(inner: string, attrs?: string) {
  const r = sanitizeSvg(svg(inner, attrs), 'p');
  expect(r).not.toBeNull();
  return r!;
}

/** Parses the body the way the app uses it: innerHTML into an <svg> element (HTML parser). */
function render(body: string) {
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  document.body.appendChild(host);
  host.innerHTML = body;
  return host;
}

describe('sanitizeSvg: active content', () => {
  it('removes <script>', () => {
    const { body } = clean('<script>alert(1)</script><path d="M0 0"/><g><script>x</script></g>');
    expect(body).not.toMatch(/script/i);
    expect(body).toContain('<path');
  });

  it('removes on* handlers regardless of case', () => {
    const { body } = clean(
      '<path d="M0 0" onload="a()" onclick="b()"/><g ONMOUSEOVER="c()"><rect onFocus="d()"/></g>',
    );
    expect(body).not.toMatch(/\bon\w+=/i);
    expect(body).toContain('<path');
    expect(body).toContain('<rect');
  });

  it('removes namespaced on* handlers', () => {
    const { body } = clean('<path xmlns:x="urn:x" x:onload="a()" d="M0 0"/>');
    expect(body).not.toMatch(/onload/i);
  });

  it('removes <foreignObject> and <style>', () => {
    const { body } = clean(
      '<style>.a{fill:url(http://evil/x)}</style><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject><circle r="1"/>',
    );
    expect(body).not.toMatch(/foreignObject|style|img|onerror/i);
    expect(body).toContain('<circle');
  });

  it('removes non-allowed elements such as <a>, <image>, <animate>, <set>', () => {
    const { body } = clean(
      '<a href="javascript:alert(1)"><path d="M0 0"/></a><image href="http://evil/x.png"/><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/>',
    );
    expect(body).not.toMatch(/<a\b|image|<set|animate|javascript/i);
  });

  it('drops root attributes such as onload', () => {
    const { body } = clean('<path d="M0 0"/>', 'viewBox="0 0 48 48" onload="alert(1)"');
    expect(body).not.toMatch(/onload/);
    expect(body).not.toMatch(/^<svg/);
  });

  it('removes processing instructions and comments (HTML-parser breakout)', () => {
    const { body } = clean(
      '<?x a="><img src=x onerror=alert(1)>"?><!-- c --><path d="M0 0"/><g><?y ><img src=x onerror=alert(2)>?></g>',
    );
    expect(body).not.toMatch(/<\?|<!--|img|onerror/);
    const host = render(body);
    expect(host.querySelector('img')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('converts CDATA sections into escaped text', () => {
    const { body } = clean('<title><![CDATA[<img src=x onerror=alert(1)>]]></title>');
    expect(body).not.toContain('CDATA');
    expect(body).not.toContain('<img');
    const host = render(body);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('title')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('sanitizeSvg: links and references', () => {
  it.each([
    'http://evil/x.svg#a',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zy8+',
    ' javascript:x',
  ])('removes external href/xlink:href %s', (url) => {
    const { body } = clean(
      `<use href="${url}"/><use xlink:href="${url}"/><pattern xmlns:l="http://www.w3.org/1999/xlink" l:href="${url}"/>`,
    );
    expect(body).not.toMatch(/href/);
  });

  it('keeps and prefixes #id references', () => {
    const { body } = clean(
      '<defs><path id="shape" d="M0 0"/></defs><use href="#shape"/><use xlink:href="#shape"/>',
    );
    expect(body).toContain('id="p-shape"');
    expect(body).toContain('href="#p-shape"');
    expect(body).toContain('xlink:href="#p-shape"');
    expect(body).not.toMatch(/"#shape"/);
  });

  it('prefixes ids and rewrites url(#id) consistently', () => {
    const { body } = clean(
      '<defs><linearGradient id="g1"/><clipPath id="c1"/><mask id="m1"/></defs>' +
        '<path fill="url(#g1)" clip-path="url(#c1)" mask="url( \'#m1\' )" style="fill:url(&quot;#g1&quot;);stroke:red"/>',
    );
    for (const id of ['g1', 'c1', 'm1']) expect(body).toContain(`id="p-${id}"`);
    expect(body).toContain('fill="url(#p-g1)"');
    expect(body).toContain('clip-path="url(#p-c1)"');
    expect(body).toContain('mask="url(#p-m1)"');
    expect(body).toMatch(/style="fill:url\(#p-g1\);stroke:red"/);
    expect(body).not.toMatch(/url\(#(g1|c1|m1)\)/);
  });

  it('removes attributes with external url()', () => {
    const { body } = clean(
      '<path style="fill:url(http://evil/x)" d="M0 0"/><rect style="background:URL( \'//evil\' )"/><circle fill="url(https://evil/a#b)"/>',
    );
    expect(body).not.toMatch(/evil|style|fill=/);
    expect(body).toContain('<path');
  });

  it('removes style attributes hiding url() behind CSS escapes or @import', () => {
    const { body } = clean(
      '<path style="fill:u\\72 l(http://evil)"/><rect style="@import \'x\'"/>',
    );
    expect(body).not.toMatch(/style|evil/);
  });

  it('keeps harmless style attributes', () => {
    const { body } = clean('<path style="fill:#fff;opacity:.5"/>');
    expect(body).toContain('style="fill:#fff;opacity:.5"');
  });
});

describe('sanitizeSvg: input validation', () => {
  it.each([
    ['non-svg root', '<html><body/></html>'],
    ['prefixed root', '<s:svg xmlns:s="http://www.w3.org/2000/svg"/>'],
    ['uppercase root', '<SVG onload="alert(1)"><path/></SVG>'],
    ['malformed XML', '<svg><g></svg>'],
    ['not XML', 'hello'],
    ['empty', ''],
  ])('returns null for %s', (_, text) => {
    expect(sanitizeSvg(text, 'p')).toBeNull();
  });
});

describe('sanitizeSvg: size', () => {
  it('reads width/height from viewBox', () => {
    expect(clean('<path/>', 'viewBox="0 0 64 32"')).toMatchObject({ width: 64, height: 32 });
    expect(clean('<path/>', 'viewBox="0,0,10,20"')).toMatchObject({ width: 10, height: 20 });
  });

  it('falls back to width/height attributes, then 24', () => {
    expect(clean('<path/>', 'width="40px" height="30"')).toMatchObject({ width: 40, height: 30 });
    expect(clean('<path/>', '')).toMatchObject({ width: 24, height: 24 });
  });

  it('wraps bodies with a non-zero viewBox origin', () => {
    const r = clean('<path d="M0 0"/>', 'viewBox="-4 8 16 16"');
    expect(r).toMatchObject({ width: 16, height: 16 });
    expect(r.body).toMatch(/^<g transform="translate\(4 -8\)">.*<\/g>$/);
  });

  it('does not wrap zero-origin bodies', () => {
    expect(clean('<path d="M0 0"/>').body).not.toContain('translate');
  });
});

describe('iconNameFromPath', () => {
  it('normalizes AWS architecture icons', () => {
    expect(
      iconNameFromPath('Architecture-Service-Icons/Arch_Compute/48/Arch_Amazon-EC2_48.svg'),
    ).toEqual({
      name: 'amazon-ec2',
      size: 48,
    });
    expect(iconNameFromPath('Arch_Amazon-EC2_64@5x.svg')).toEqual({ name: 'amazon-ec2', size: 64 });
  });

  it('normalizes Azure icons', () => {
    expect(iconNameFromPath('Icons/compute/10021-icon-service-Virtual-Machine.svg')).toEqual({
      name: 'virtual-machine',
      size: 0,
    });
  });

  it('strips a variant suffix that follows the size', () => {
    expect(iconNameFromPath('Res_Amazon-Simple-Storage-Service_Bucket_48_Light.svg')).toEqual({
      name: 'amazon-simple-storage-service-bucket',
      size: 48,
    });
    expect(iconNameFromPath('Res_Amazon-Simple-Storage-Service_Bucket_48_Dark.svg').name).toBe(
      'amazon-simple-storage-service-bucket',
    );
  });

  it('handles icons without a size', () => {
    expect(iconNameFromPath('gcp/BigQuery.SVG')).toEqual({ name: 'bigquery', size: 0 });
  });
});
