import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { useTranslation } from 'react-i18next';
import type { Diagram } from '@opsdraw/core';
import { usePacksVersion } from './Icon';
import { builtinFor, isPrefixedIcon, toBuiltinIcons } from './builtinIcons';

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
  const { svg } = await mermaid.render(`opsdraw-${++counter}`, text);
  return svg;
}

/** Shows what GitHub, GitLab or any Mermaid renderer will draw from this file. */
export function Preview({
  text,
  diagram,
  onChange,
}: {
  text: string;
  /** The architecture diagram the text describes, if it is one. */
  diagram?: Diagram;
  onChange(d: Diagram): void;
}) {
  const { t } = useTranslation();
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

  const packIcons = diagram?.nodes.filter((n) => isPrefixedIcon(n.icon)) ?? [];
  const mappable = packIcons.filter((n) => builtinFor(n.icon)).length;

  return (
    <div className="preview-wrap">
      {diagram && packIcons.length > 0 && (
        <div className="banner info" role="note" data-testid="github-icons-hint">
          <span>{t('preview.githubIcons')}</span>
          <button disabled={!mappable} onClick={() => onChange(toBuiltinIcons(diagram).diagram)}>
            {t('preview.useBuiltins')}
          </button>
        </div>
      )}
      <PreviewSvg svg={svg} error={error} />
    </div>
  );
}

function PreviewSvg({ svg, error }: { svg: string; error: string }) {
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
