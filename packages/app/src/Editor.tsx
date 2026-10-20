import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { useTranslation } from 'react-i18next';
import type { ParseError } from '@opsdraw/core';
import { useTheme } from './theme';

interface Props {
  text: string;
  errors: ParseError[];
  onChange(text: string): void;
  /** Leaving the editor; the app parses any text still waiting for the typing pause. */
  onBlur(): void;
  isFlowchart: boolean;
  onConvert(): void;
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)' },
});

export function Editor({ text, errors, onChange, onBlur, isFlowchart, onConvert }: Props) {
  const { t } = useTranslation();
  const dark = useTheme().resolved === 'dark';
  return (
    <section className="editor" aria-label="Mermaid">
      {/* Code is always left-to-right, even in RTL UI languages. */}
      <div className="editor-code" dir="ltr" onBlur={onBlur}>
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
          <button className="primary sm" onClick={onConvert}>
            {t('editor.convert')}
          </button>
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
