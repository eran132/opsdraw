import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { useTranslation } from 'react-i18next';
import type { ParseError } from '@opsdraw/core';

interface Props {
  text: string;
  errors: ParseError[];
  onChange(text: string): void;
  isFlowchart: boolean;
  onConvert(): void;
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
});

export function Editor({ text, errors, onChange, isFlowchart, onConvert }: Props) {
  const { t } = useTranslation();
  const dark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  return (
    <section className="editor" aria-label="Mermaid">
      {/* Code is always left-to-right, even in RTL UI languages. */}
      <div className="editor-code" dir="ltr">
        <CodeMirror
          value={text}
          onChange={onChange}
          height="100%"
          theme={dark ? 'dark' : 'light'}
          extensions={[theme, EditorView.lineWrapping]}
          basicSetup={{ foldGutter: false }}
        />
      </div>
      {isFlowchart && (
        <div className="banner">
          <span>{t('editor.flowchartDetected')}</span>
          <button onClick={onConvert}>{t('editor.convert')}</button>
        </div>
      )}
      {errors.length > 0 && !isFlowchart && (
        <div className="problems" role="status">
          <strong>{t('editor.errors', { count: errors.length })}</strong>
          <ul>
            {errors.slice(0, 20).map((e, i) => (
              <li key={i}>
                <span className="muted">{t('editor.line', { line: e.line })}</span>{' '}
                <span dir="ltr">{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
