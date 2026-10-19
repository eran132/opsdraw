import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReactFlowProvider } from '@xyflow/react';
import {
  autoLayout,
  emptyDiagram,
  importIac,
  parseMermaid,
  renderDiagramSvg,
  serializeArchitecture,
  type Diagram,
  type LayoutDirection,
  type ParseError,
} from '@opsdraw/core';
import { Canvas, type Selection } from './Canvas';
import { Editor } from './Editor';
import { Inspector } from './Inspector';
import { Palette } from './Palette';
import { Preview } from './Preview';
import { resolveIcon } from './icons';
import { PackDialog } from './PackDialog';
import { LANGUAGES } from './i18n';
import {
  NoEmbeddedSourceError,
  download,
  openFile,
  pickFiles,
  readIfChanged,
  saveFile,
  svgToPngWithSource,
  type OpenedFile,
} from './file';
import { SAMPLE } from './sample';

type Handle = OpenedFile['handle'];

export function App() {
  const { t, i18n } = useTranslation();
  const [text, setTextState] = useState(SAMPLE);
  const [diagram, setDiagram] = useState<Diagram>(() => parseMermaid(SAMPLE).diagram);
  const [errors, setErrors] = useState<ParseError[]>([]);
  const [isFlowchart, setIsFlowchart] = useState(false);
  const [fileName, setFileName] = useState(t('file.untitled'));
  const [savedText, setSavedText] = useState(SAMPLE);
  const [selection, setSelection] = useState<Selection>(null);
  const [fitKey, setFitKey] = useState(0);
  const [focusLabel, setFocusLabel] = useState(0);
  const [view, setView] = useState<'canvas' | 'preview'>('canvas');
  const [packsOpen, setPacksOpen] = useState(false);
  const [diskVersion, setDiskVersion] = useState<OpenedFile | null>(null);
  const [status, setStatus] = useState('');
  const handle = useRef<Handle>(undefined);
  const lastModified = useRef(0);
  const undo = useRef<string[]>([]);
  const redo = useRef<string[]>([]);
  const textRef = useRef(text);
  textRef.current = text;
  const dirty = text !== savedText;

  /** Text is the source of truth; the canvas follows the last version that parsed cleanly. */
  const setText = useCallback((next: string) => {
    setTextState(next);
    const result = parseMermaid(next);
    setIsFlowchart(result.kind === 'flowchart');
    setErrors(result.errors);
    if (result.kind === 'architecture' && result.errors.length === 0) setDiagram(result.diagram);
  }, []);

  const applyDiagram = useCallback((d: Diagram) => {
    undo.current.push(textRef.current);
    redo.current = [];
    setDiagram(d);
    setErrors([]);
    setIsFlowchart(false);
    setTextState(serializeArchitecture(d));
  }, []);

  /** Loads new content; diagrams without any positions get an automatic layout. */
  const loadText = useCallback(
    async (next: string, opts: { fit?: boolean } = {}) => {
      const result = parseMermaid(next);
      setText(next);
      const unplaced =
        result.diagram.nodes.length > 0 && !Object.keys(result.diagram.layout).length;
      if (result.kind === 'architecture' && result.errors.length === 0 && unplaced) {
        applyDiagram(await autoLayout(result.diagram));
      }
      setSelection(null);
      if (opts.fit !== false) setFitKey((k) => k + 1);
    },
    [applyDiagram, setText],
  );

  // The bundled sample has no positions; lay it out once on start.
  useEffect(() => {
    void autoLayout(parseMermaid(SAMPLE).diagram).then((d) => {
      const laid = serializeArchitecture(d);
      setSavedText(laid);
      setText(laid);
      setFitKey((k) => k + 1);
    });
  }, [setText]);

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${fileName} — OpsDraw`;
  }, [dirty, fileName]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Follow edits made to the open file by other tools (an editor, git, the MCP server).
  useEffect(() => {
    const timer = setInterval(async () => {
      if (!handle.current) return;
      try {
        const changed = await readIfChanged(handle.current, lastModified.current);
        if (!changed) return;
        lastModified.current = changed.lastModified;
        if (changed.text === textRef.current) return;
        if (textRef.current === savedTextRef.current) {
          setSavedText(changed.text);
          await loadText(changed.text, { fit: false });
        } else {
          setDiskVersion(changed);
        }
      } catch {
        // File moved or permission revoked; keep editing what we have.
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [loadText]);
  const savedTextRef = useRef(savedText);
  savedTextRef.current = savedText;

  const confirmDiscard = () => !dirty || confirm(t('file.discardConfirm'));

  async function doOpen() {
    if (!confirmDiscard()) return;
    let f: OpenedFile | null;
    try {
      f = await openFile();
    } catch (e) {
      if (!(e instanceof NoEmbeddedSourceError)) throw e;
      setStatus(t('file.noEmbeddedSource'));
      return;
    }
    if (!f) return;
    handle.current = f.handle;
    lastModified.current = f.lastModified;
    setFileName(f.name);
    setSavedText(f.text);
    undo.current = [];
    await loadText(f.text);
  }

  async function doSave(as = false) {
    const res = await saveFile(text, fileName, as ? undefined : handle.current);
    if (!res) return;
    handle.current = res.handle;
    lastModified.current = res.lastModified;
    setFileName(res.name);
    setSavedText(text);
    setStatus(t('status.saved'));
  }

  function doNew() {
    if (!confirmDiscard()) return;
    const blank = serializeArchitecture(emptyDiagram());
    handle.current = undefined;
    setFileName(t('file.untitled'));
    setSavedText(blank);
    undo.current = [];
    setText(blank);
    setSelection(null);
  }

  async function doImportIac() {
    const files = await pickFiles('.tf,.tofu,.yaml,.yml,.json,.template,.ini,.nomad,.hcl', true);
    if (!files.length) return;
    const contents = await Promise.all(
      files.map(async (f) => ({ path: f.name, content: await f.text() })),
    );
    const { diagram: imported } = importIac(contents);
    const laid = await autoLayout(imported);
    applyDiagram(laid);
    setSelection(null);
    setFitKey((k) => k + 1);
    setStatus(t('status.terraformImported', { count: imported.nodes.length }));
  }

  async function doLayout(direction: LayoutDirection) {
    applyDiagram(await autoLayout(diagram, direction));
    setFitKey((k) => k + 1);
  }

  async function doConvert() {
    const result = parseMermaid(text);
    if (result.errors.length) return;
    applyDiagram(await autoLayout(result.diagram));
    setFitKey((k) => k + 1);
  }

  /**
   * Exports are drawn from the canvas geometry, so they match what you see (Mermaid's own
   * renderer ignores stored positions). Both formats embed the source and can be reopened.
   */
  async function doExport(kind: 'svg' | 'png') {
    const base = fileName.replace(/\.(mmd|mermaid|md)$/i, '');
    const theme = kind === 'svg' ? 'auto' : 'light';
    const svg = renderDiagramSvg(diagram, { resolveIcon, theme });
    if (kind === 'svg') download(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
    else download(await svgToPngWithSource(svg, serializeArchitecture(diagram)), `${base}.png`);
  }

  const pickIcon = (icon: string) => {
    if (selection?.type !== 'node') return;
    const node = diagram.nodes.find((n) => n.id === selection.id);
    if (!node || node.kind === 'junction') return;
    applyDiagram({
      ...diagram,
      nodes: diagram.nodes.map((n) => (n.id === node.id ? { ...n, icon } : n)),
    });
  };

  // Shortcuts. Undo/redo here covers canvas edits; the code editor keeps its own history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void doSave(e.shiftKey);
      } else if (key === 'o') {
        e.preventDefault();
        void doOpen();
      } else if (key === 'z' || key === 'y') {
        const target = e.target as HTMLElement;
        if (target.closest('.cm-editor, input, textarea, select')) return;
        e.preventDefault();
        const from = key === 'y' || e.shiftKey ? redo : undo;
        const to = from === undo ? redo : undo;
        const prev = from.current.pop();
        if (prev === undefined) return;
        to.current.push(textRef.current);
        setText(prev);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <img src="./favicon.svg" alt="" width={22} height={22} />
          <strong>OpsDraw</strong>
          <span className="muted small">{t('app.tagline')}</span>
        </div>
        <div className="actions">
          <button onClick={doNew}>{t('toolbar.new')}</button>
          <button onClick={() => void doOpen()}>{t('toolbar.open')}</button>
          <button onClick={() => void doSave()}>{t('toolbar.save')}</button>
          <button onClick={() => void doSave(true)}>{t('toolbar.saveAs')}</button>
          <span className="sep" />
          <button onClick={() => void doImportIac()}>{t('toolbar.importIac')}</button>
          <button onClick={() => void doLayout('RIGHT')}>{t('toolbar.layoutRight')}</button>
          <button onClick={() => void doLayout('DOWN')}>{t('toolbar.layoutDown')}</button>
          <span className="sep" />
          <button onClick={() => void doExport('svg')}>{t('toolbar.exportSvg')}</button>
          <button onClick={() => void doExport('png')}>{t('toolbar.exportPng')}</button>
          <button onClick={() => setPacksOpen(true)}>{t('toolbar.iconPacks')}</button>
          <select
            aria-label={t('toolbar.language')}
            value={i18n.language}
            onChange={(e) => void i18n.changeLanguage(e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {diskVersion && (
        <div className="banner">
          <span>{t('file.changedOnDisk')}</span>
          <button
            onClick={() => {
              setSavedText(diskVersion.text);
              void loadText(diskVersion.text, { fit: false });
              setDiskVersion(null);
            }}
          >
            {t('file.reload')}
          </button>
          <button onClick={() => setDiskVersion(null)}>{t('file.keepMine')}</button>
        </div>
      )}

      <main className="workspace">
        <Palette onPick={pickIcon} />
        <Editor
          text={text}
          errors={errors}
          onChange={setText}
          isFlowchart={isFlowchart}
          onConvert={() => void doConvert()}
        />
        <section className="stage">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={view === 'canvas'} onClick={() => setView('canvas')}>
              {t('view.canvas')}
            </button>
            <button
              role="tab"
              aria-selected={view === 'preview'}
              onClick={() => setView('preview')}
            >
              {t('view.preview')}
            </button>
            <span className="file-name" dir="auto">
              {fileName}
              {dirty && <span className="muted"> • {t('file.unsaved')}</span>}
            </span>
          </div>
          {view === 'canvas' ? (
            <ReactFlowProvider>
              <Canvas
                diagram={diagram}
                onChange={applyDiagram}
                selection={selection}
                onSelect={setSelection}
                fitKey={fitKey}
                onEditLabel={() => setFocusLabel((n) => n + 1)}
              />
            </ReactFlowProvider>
          ) : (
            <Preview text={text} />
          )}
        </section>
        <Inspector
          diagram={diagram}
          selection={selection}
          onChange={applyDiagram}
          onSelect={setSelection}
          focusLabel={focusLabel}
        />
      </main>
      <footer className="statusbar">
        <span role="status">{status}</span>
        <span className="muted small">
          Apache-2.0 · Vendor names and icons belong to their owners; OpsDraw is not affiliated with
          them.
        </span>
      </footer>
      <PackDialog open={packsOpen} onClose={() => setPacksOpen(false)} />
    </div>
  );
}
