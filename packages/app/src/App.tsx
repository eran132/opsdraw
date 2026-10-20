import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import {
  GENERIC_CATALOG,
  SERVICE_SIZE,
  catalogEntry,
  emptyDiagram,
  importIac,
  makeId,
  parseMermaid,
  renderDiagramSvg,
  repickMovedSides,
  serializeArchitecture,
  type ArchNode,
  type Diagram,
  type LayoutDirection,
  type ParseError,
} from '@opsdraw/core';
import { Canvas, type Selection } from './Canvas';
import { Editor } from './Editor';
import { Inspector } from './Inspector';
import { Palette, useIconTitle } from './Palette';
import { Preview } from './Preview';
import { resolveIcon, searchIcons } from './icons';
import { layoutDiagram } from './layout';
import { PackDialog } from './PackDialog';
import { LANGUAGES, isRtlLanguage } from './i18n';
import { AppBar, THEME_ICONS } from './AppBar';
import { CommandPalette, type Command } from './CommandPalette';
import { shortcut } from './Menu';
import { UiIcon } from './Icon';
import { THEME_PREFERENCES, setThemePreference, useTheme } from './theme';
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

/** Pause in typing before the canvas re-parses the text. */
const PARSE_DEBOUNCE_MS = 150;

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
  const [legend, setLegend] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  /** Center of the visible canvas in diagram coordinates, when the canvas is shown. */
  const viewCenter = useRef<() => { x: number; y: number } | null>(() => null);
  const handle = useRef<Handle>(undefined);
  const lastModified = useRef(0);
  const undo = useRef<string[]>([]);
  const redo = useRef<string[]>([]);
  const textRef = useRef(text);
  textRef.current = text;
  const dirty = text !== savedText;

  const parseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Typed text the canvas has not caught up with yet. */
  const unparsed = useRef<string | null>(null);

  /**
   * Text is the source of truth; the canvas follows the last version that parsed cleanly.
   * Returns that diagram when the text is a valid architecture diagram.
   */
  const parseNow = useCallback((next: string): Diagram | undefined => {
    clearTimeout(parseTimer.current);
    unparsed.current = null;
    const result = parseMermaid(next);
    setIsFlowchart(result.kind === 'flowchart');
    setErrors(result.errors);
    if (result.kind !== 'architecture' || result.errors.length) return undefined;
    setDiagram(result.diagram);
    return result.diagram;
  }, []);

  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      textRef.current = next;
      parseNow(next);
    },
    [parseNow],
  );

  /** Catches the canvas up with typing that is still waiting for the debounce. */
  const flushParse = useCallback(
    () => (unparsed.current === null ? undefined : parseNow(unparsed.current)),
    [parseNow],
  );

  /** Typing updates the text at once and re-parses after a short pause, so big files stay fast. */
  const onType = useCallback(
    (next: string) => {
      setTextState(next);
      textRef.current = next;
      unparsed.current = next;
      clearTimeout(parseTimer.current);
      parseTimer.current = setTimeout(() => parseNow(next), PARSE_DEBOUNCE_MS);
    },
    [parseNow],
  );

  useEffect(() => () => clearTimeout(parseTimer.current), []);

  const applyDiagram = useCallback((d: Diagram) => {
    // The diagram's text replaces whatever was typed, so a pending parse is moot.
    clearTimeout(parseTimer.current);
    unparsed.current = null;
    undo.current.push(textRef.current);
    redo.current = [];
    setDiagram(d);
    setErrors([]);
    setIsFlowchart(false);
    setTextState(serializeArchitecture(d));
  }, []);

  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;
  /**
   * An edit made on the canvas or in the inspector. When it moved nodes (drag, align, nudge, group
   * resize), edges with a moved end get their sides re-picked, so lined-up nodes get a straight
   * edge, and routes that no longer fit are dropped.
   */
  const editDiagram = useCallback(
    (d: Diagram) => applyDiagram(repickMovedSides(diagramRef.current, d)),
    [applyDiagram],
  );

  /** Loads new content; diagrams without any positions get an automatic layout. */
  const loadText = useCallback(
    async (next: string, opts: { fit?: boolean } = {}) => {
      const result = parseMermaid(next);
      setText(next);
      const unplaced =
        result.diagram.nodes.length > 0 && !Object.keys(result.diagram.layout).length;
      if (result.kind === 'architecture' && result.errors.length === 0 && unplaced) {
        applyDiagram(await layoutDiagram(result.diagram));
      }
      setSelection(null);
      if (opts.fit !== false) setFitKey((k) => k + 1);
    },
    [applyDiagram, setText],
  );

  // The bundled sample has no positions; lay it out once on start.
  useEffect(() => {
    void layoutDiagram(parseMermaid(SAMPLE).diagram).then((d) => {
      // The layout runs off the main thread; don't overwrite anything typed or opened meanwhile.
      if (textRef.current !== SAMPLE) return;
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
    flushParse();
    const current = textRef.current;
    const res = await saveFile(current, fileName, as ? undefined : handle.current);
    if (!res) return;
    handle.current = res.handle;
    lastModified.current = res.lastModified;
    setFileName(res.name);
    setSavedText(current);
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
    const laid = await layoutDiagram(imported);
    applyDiagram(laid);
    setSelection(null);
    setFitKey((k) => k + 1);
    setStatus(t('status.terraformImported', { count: imported.nodes.length }));
  }

  async function doLayout(direction: LayoutDirection) {
    const current = flushParse() ?? diagram;
    applyDiagram(await layoutDiagram(current, direction));
    setFitKey((k) => k + 1);
  }

  async function doConvert() {
    const result = parseMermaid(textRef.current);
    if (result.errors.length) return;
    applyDiagram(await layoutDiagram(result.diagram));
    setFitKey((k) => k + 1);
  }

  /**
   * Exports are drawn from the canvas geometry, so they match what you see (Mermaid's own
   * renderer ignores stored positions). Both formats embed the source and can be reopened.
   */
  async function doExport(kind: 'svg' | 'png') {
    const base = fileName.replace(/\.(mmd|mermaid|md)$/i, '');
    const theme = kind === 'svg' ? 'auto' : 'light';
    const current = flushParse() ?? diagram;
    const svg = renderDiagramSvg(current, {
      resolveIcon,
      theme,
      legend,
      legendTitle: t('toolbar.legend'),
    });
    if (kind === 'svg') download(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
    else download(await svgToPngWithSource(svg, serializeArchitecture(current)), `${base}.png`);
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

  /** Adds a service with this icon in the middle of the visible canvas and selects it. */
  function addIcon(icon: string, label: string) {
    const current = flushParse() ?? diagramRef.current;
    const id = makeId(
      label.toLowerCase(),
      current.nodes.map((n) => n.id),
    );
    const node: ArchNode = { id, kind: 'service', label, icon };
    const center = viewCenter.current();
    const snap = (v: number) => Math.round(v / 8) * 8;
    const layout = center
      ? {
          ...current.layout,
          [id]: { x: snap(center.x - SERVICE_SIZE.w / 2), y: snap(center.y - SERVICE_SIZE.h / 2) },
        }
      : current.layout;
    editDiagram({ ...current, nodes: [...current.nodes, node], layout });
    setSelection({ type: 'node', id });
  }

  const titleOf = useIconTitle();
  const addGroup = t('commands.groupAdd');
  const addCommand = (ref: string, keywords = ''): Command => ({
    id: `add:${ref}`,
    label: t('commands.addIcon', { name: titleOf(ref) }),
    group: addGroup,
    iconRef: ref,
    keywords: `add ${ref} ${keywords}`,
    run: () => addIcon(ref, titleOf(ref)),
  });

  const actions = t('commands.groupActions');
  const settings = t('commands.groupSettings');
  const theme = useTheme();
  const commands: Command[] = [
    { id: 'new', label: t('toolbar.new'), group: actions, icon: 'file-plus', run: doNew },
    {
      id: 'open',
      label: t('toolbar.open'),
      group: actions,
      icon: 'folder-open',
      shortcut: shortcut('Ctrl+O'),
      run: () => void doOpen(),
    },
    {
      id: 'save',
      label: t('toolbar.save'),
      group: actions,
      icon: 'save',
      shortcut: shortcut('Ctrl+S'),
      run: () => void doSave(),
    },
    {
      id: 'save-as',
      label: t('toolbar.saveAs'),
      group: actions,
      icon: 'save-all',
      shortcut: shortcut('Ctrl+Shift+S'),
      run: () => void doSave(true),
    },
    {
      id: 'import-iac',
      label: t('toolbar.importIac'),
      group: actions,
      icon: 'import',
      keywords: 'terraform kubernetes compose cloudformation',
      run: () => void doImportIac(),
    },
    {
      id: 'export-svg',
      label: t('toolbar.exportSvg'),
      group: actions,
      icon: 'file-code',
      keywords: 'export svg',
      run: () => void doExport('svg'),
    },
    {
      id: 'export-png',
      label: t('toolbar.exportPng'),
      group: actions,
      icon: 'file-image',
      keywords: 'export png',
      run: () => void doExport('png'),
    },
    {
      id: 'legend',
      label: legend ? t('commands.legendOff') : t('commands.legendOn'),
      group: actions,
      icon: 'list',
      keywords: 'legend',
      run: () => setLegend(!legend),
    },
    {
      id: 'layout-right',
      label: t('toolbar.layoutRight'),
      group: actions,
      icon: 'arrow-right-from-line',
      keywords: 'auto layout',
      run: () => void doLayout('RIGHT'),
    },
    {
      id: 'layout-down',
      label: t('toolbar.layoutDown'),
      group: actions,
      icon: 'arrow-down-from-line',
      keywords: 'auto layout',
      run: () => void doLayout('DOWN'),
    },
    {
      id: 'view-canvas',
      label: t('commands.showView', { name: t('view.canvas') }),
      group: actions,
      icon: 'layout-grid',
      keywords: 'canvas',
      run: () => setView('canvas'),
    },
    {
      id: 'view-preview',
      label: t('commands.showView', { name: t('view.preview') }),
      group: actions,
      icon: 'scan-search',
      keywords: 'mermaid preview',
      run: () => setView('preview'),
    },
    {
      id: 'icon-packs',
      label: t('toolbar.iconPacks'),
      group: settings,
      icon: 'package',
      keywords: 'icon packs aws azure gcp',
      run: () => setPacksOpen(true),
    },
    {
      id: 'theme-toggle',
      label: t('commands.toggleTheme'),
      group: settings,
      icon: 'sun-moon',
      keywords: 'theme dark light mode',
      run: () => setThemePreference(theme.resolved === 'dark' ? 'light' : 'dark'),
    },
    ...THEME_PREFERENCES.map((pref): Command => ({
      id: `theme-${pref}`,
      label: `${t('theme.label')}: ${t(`theme.${pref}`)}`,
      group: settings,
      icon: THEME_ICONS[pref],
      keywords: `theme ${pref}`,
      run: () => setThemePreference(pref),
    })),
    ...LANGUAGES.map((l): Command => ({
      id: `lang-${l.code}`,
      label: `${t('toolbar.language')}: ${l.name}`,
      group: settings,
      icon: 'languages',
      keywords: `language ${l.code}`,
      run: () => void i18n.changeLanguage(l.code),
    })),
    ...GENERIC_CATALOG.flatMap((cat) => cat.icons.map((i) => addCommand(i.ref, i.title))),
  ];
  /** Icons outside the curated set are offered once the user types. */
  const searchCommands = useMemo(
    () => (query: string) =>
      searchIcons(query.replace(/^\s*add\s+/i, ''), 30, titleOf)
        .filter((hit) => !catalogEntry(hit.ref))
        .map((hit) => addCommand(hit.ref)),
    // addCommand only closes over t (through titleOf) and stable refs and setters.
    [titleOf],
  );

  // Shortcuts. Undo/redo here covers canvas edits; the code editor keeps its own history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setCommandsOpen((open) => !open);
      } else if (key === 's') {
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
    // Direction and language live on the app root, not <html>, so the editor can be embedded.
    <div className="app" dir={isRtlLanguage(i18n.language) ? 'rtl' : 'ltr'} lang={i18n.language}>
      <AppBar
        fileName={fileName}
        dirty={dirty}
        legend={legend}
        onLegend={setLegend}
        onNew={doNew}
        onOpen={() => void doOpen()}
        onSave={(as) => void doSave(as)}
        onImportIac={() => void doImportIac()}
        onExport={(kind) => void doExport(kind)}
        onLayout={(direction) => void doLayout(direction)}
        onIconPacks={() => setPacksOpen(true)}
        onCommands={() => setCommandsOpen(true)}
      />

      {diskVersion && (
        <div className="banner">
          <span>{t('file.changedOnDisk')}</span>
          <button
            className="primary sm"
            onClick={() => {
              setSavedText(diskVersion.text);
              void loadText(diskVersion.text, { fit: false });
              setDiskVersion(null);
            }}
          >
            {t('file.reload')}
          </button>
          <button className="sm" onClick={() => setDiskVersion(null)}>
            {t('file.keepMine')}
          </button>
        </div>
      )}

      {/* One React Flow store for the canvas and the inspector (which measures nodes to align them). */}
      <ReactFlowProvider>
        <main className="workspace">
          <Palette onPick={pickIcon} />
          <Editor
            text={text}
            errors={errors}
            onChange={onType}
            onBlur={flushParse}
            isFlowchart={isFlowchart}
            onConvert={() => void doConvert()}
          />
          <section className="stage">
            <div className="stage-bar">
              <ViewTabs view={view} onView={setView} />
            </div>
            {view === 'canvas' ? (
              <Canvas
                diagram={diagram}
                onChange={editDiagram}
                selection={selection}
                onSelect={setSelection}
                fitKey={fitKey}
                onEditLabel={() => setFocusLabel((n) => n + 1)}
              />
            ) : (
              <Preview
                text={text}
                diagram={isFlowchart ? undefined : diagram}
                onChange={editDiagram}
              />
            )}
          </section>
          <Inspector
            diagram={diagram}
            selection={selection}
            onChange={editDiagram}
            onSelect={setSelection}
            focusLabel={focusLabel}
          />
        </main>
        <ViewCenter target={viewCenter} />
      </ReactFlowProvider>
      <footer className="statusbar">
        <span role="status">{status}</span>
        <span className="muted small" dir="auto">
          Apache-2.0 · Vendor names and icons belong to their owners; OpsDraw is not affiliated with
          them.
        </span>
      </footer>
      <PackDialog open={packsOpen} onClose={() => setPacksOpen(false)} />
      {commandsOpen && (
        <CommandPalette
          onClose={() => setCommandsOpen(false)}
          commands={commands}
          extra={searchCommands}
        />
      )}
    </div>
  );
}

type View = 'canvas' | 'preview';
const VIEWS: View[] = ['canvas', 'preview'];

/** Canvas / Mermaid preview as a segmented control (APG tabs: arrows move and select). */
function ViewTabs({ view, onView }: { view: View; onView(v: View): void }) {
  const { t } = useTranslation();
  const refs = useRef<Record<View, HTMLButtonElement | null>>({ canvas: null, preview: null });
  const onKeyDown = (e: React.KeyboardEvent) => {
    const rtl = (e.currentTarget as HTMLElement).closest('[dir=rtl]') !== null;
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    const i = VIEWS.indexOf(view);
    let next: View | undefined;
    if (e.key === forward) next = VIEWS[(i + 1) % VIEWS.length];
    else if (e.key === back) next = VIEWS[(i - 1 + VIEWS.length) % VIEWS.length];
    else if (e.key === 'Home') next = VIEWS[0];
    else if (e.key === 'End') next = VIEWS[VIEWS.length - 1];
    if (!next) return;
    e.preventDefault();
    onView(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="segmented tabs" role="tablist" aria-label={t('view.label')}>
      {VIEWS.map((v) => (
        <button
          key={v}
          ref={(el) => {
            refs.current[v] = el;
          }}
          role="tab"
          aria-selected={view === v}
          tabIndex={view === v ? 0 : -1}
          onClick={() => onView(v)}
          onKeyDown={onKeyDown}
        >
          <UiIcon name={v === 'canvas' ? 'layout-grid' : 'scan-search'} />
          {t(v === 'canvas' ? 'view.canvas' : 'view.preview')}
        </button>
      ))}
    </div>
  );
}

/** Lets the app place new nodes in the middle of what the canvas currently shows. */
function ViewCenter({
  target,
}: {
  target: React.RefObject<() => { x: number; y: number } | null>;
}) {
  const rf = useReactFlow();
  useEffect(() => {
    target.current = () => {
      const pane = document.querySelector('.canvas');
      if (!pane) return null;
      const r = pane.getBoundingClientRect();
      return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
  }, [rf, target]);
  return null;
}
