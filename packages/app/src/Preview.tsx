import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { usePacksVersion } from './Icon';

let counter = 0;

export function initMermaid() {
  const dark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
  });
}

/** Renders Mermaid source to an SVG string with the real Mermaid renderer. */
export async function renderMermaid(text: string): Promise<string> {
  const { svg } = await mermaid.render(`archidraw-${++counter}`, text);
  return svg;
}

/** Shows what GitHub, GitLab or any Mermaid renderer will draw from this file. */
export function Preview({ text }: { text: string }) {
  const packs = usePacksVersion();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    const run = ++latest.current;
    const t = setTimeout(() => {
      renderMermaid(text).then(
        (out) => {
          if (run !== latest.current) return;
          setSvg(out);
          setError('');
        },
        (e: unknown) => run === latest.current && setError(String((e as Error)?.message ?? e)),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [text, packs]);

  return (
    <div className="preview" dir="ltr">
      {error && <pre className="preview-error">{error}</pre>}
      {/* Mermaid output, rendered with securityLevel "strict" (sanitized by Mermaid). */}
      <div
        className="preview-svg"
        data-testid="preview-svg"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
