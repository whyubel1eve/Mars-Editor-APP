import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import EditorPane from './components/EditorPane';
import FileTree from './components/FileTree';
import PreviewPane from './components/PreviewPane';
import TypesetPopover from './components/TypesetPopover';
import Toolbar from './components/Toolbar';
import DraftBoxDialog from './components/DraftBoxDialog';
import PublishDialog from './components/PublishDialog';
import ImportUrlDialog from './components/ImportUrlDialog';
import SettingsDialog from './components/SettingsDialog';
import UpdateDialog from './components/UpdateDialog';
import MarkdownGuideDialog from './components/MarkdownGuideDialog';
import ConflictBar from './components/ConflictBar';
import AgentPanel from './components/AgentPanel';
import VaultGate from './components/VaultGate';
import {
  collectImageRefs,
  ensureHighlighter,
  extractTitle,
  isHighlighterReady,
  lineReferencesImage,
  renderArticle,
} from './markdown';
import { copyRichText } from './clipboard';
import { confirmDestructive } from './confirm';
import { inlineRemoteImages } from './remoteImages';
import { importArticle } from './reader';
import { safeFileName, saveBlob } from './exchange';
import { renderLongImage } from './longimage';
import { DENSITIES, getDensity, getTheme } from './theme';
import { createScrollSyncChannel } from './scrollSync';
import { useVault } from './store/useVault';
import { useAppearance } from './store/appearance';
import { deleteCustomTheme, ensureThemeGuide, useCustomThemes } from './store/customThemes';
import { chord } from './platform';
import { useUpdate } from './store/updater';
import type { DraftTarget } from './publish';
import type { Entry } from './store/vault';
import './styles.css';

/** Minimum editor width, preserved while dragging — which is what lets the preview reach desktop width */
const MIN_EDITOR_PX = 180;
/** Minimum preview width (enough for a true phone measure) */
const MIN_PREVIEW_PX = 430;

type VaultApi = ReturnType<typeof useVault>;

/** Image relative path → file name */
const baseName = (path: string) => path.split('/').pop() ?? path;

/** Find a node in the tree by its relative path */
function findEntry(entries: Entry[], path: string): Entry | null {
  for (const e of entries) {
    if (e.path === path) return e;
    if (e.children) {
      const hit = findEntry(e.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/** Line number (0-based) of the first reference to that image, or -1 */
function findEmbedLine(content: string, name: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lineReferencesImage(lines[i], name)) return i;
  }
  return -1;
}

/**
 * The gate: the editor proper only renders once a workspace is open.
 *
 * The data lives in some folder on disk, and that folder may not have been
 * picked yet, or may have been moved away since. So: pick one, read it, and
 * only then continue.
 */
export default function App() {
  const vault = useVault();

  if (vault.status === 'booting') {
    return (
      <div className="vault-boot">
        <span className="spinner" aria-hidden="true" />
        正在打开工作区…
      </div>
    );
  }
  if (vault.status !== 'ready' || !vault.dir) {
    return <VaultGate error={vault.error} onChoose={() => void vault.chooseVault()} />;
  }
  // Keyed on dir: a different workspace is a different body of work, so
  // scroll positions and split widths should all start over
  return <Workspace key={vault.dir} vault={vault} />;
}

function Workspace({ vault }: { vault: VaultApi }) {
  const { tree, drafts, images, prefs, conflicts } = vault;

  // Fall back if the id went stale: drop to the first draft, and let every
  // later edit use that id, which is known to exist
  const activeDraft = drafts.find((d) => d.id === prefs.activeId) ?? drafts[0];
  const activeId = activeDraft?.id ?? '';
  const markdown = activeDraft?.content ?? '';
  const setMarkdown = (v: string) => {
    if (activeId) vault.setDraftContent(activeId, v);
  };
  const setActiveDraft = (id: string) => vault.setPrefs({ activeId: id });

  const themeId = prefs.themeId;
  const densityId = prefs.densityId;
  const linkFootnotes = prefs.linkFootnotes;

  /** Light/dark of the shell. Nothing to do with the draft, so it stays out of
   *  the vault prefs (see store/appearance.ts) */
  const { appearance, setAppearance } = useAppearance();

  /**
   * The "not on disk yet" indicator.
   *
   * useVault's dirty set is a ref (neither scrolling nor typing should re-render
   * the whole tree), so its changes are invisible from here. Instead this debounces
   * on the body itself: light up on any edit, and 700ms after the last keystroke
   * assume the 300ms debounced save has long since finished, and go out. The
   * toolbar and the source pane share this one value.
   */
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSaving(true);
    const timer = window.setTimeout(() => setSaving(false), 700);
    return () => window.clearTimeout(timer);
  }, [markdown]);

  /** A copy is running (remote images have to be fetched first) */
  const [copying, setCopying] = useState(false);
  /** "From a link": the dialog, and the folder the new draft should land in */
  const [importOpen, setImportOpen] = useState(false);
  const [importParent, setImportParent] = useState('');
  /** The push-to-drafts dialog */
  const [publishOpen, setPublishOpen] = useState(false);
  /** The drafts box, read back from WeChat */
  const [draftBoxOpen, setDraftBoxOpen] = useState(false);
  /**
   * The draft the next push should overwrite, picked in the drafts box.
   *
   * It is cleared whenever the push dialog closes: a target left lying around
   * would turn the next ordinary 推草稿 into a silent overwrite of an article
   * chosen minutes ago, which is exactly the kind of thing you find out about
   * afterwards.
   */
  const [publishTarget, setPublishTarget] = useState<DraftTarget | null>(null);
  const [publishTargetDigest, setPublishTargetDigest] = useState('');
  /** Settings (公众号凭据) — configured once, so it is a dialog of its own
   *  rather than a section of the push dialog */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [markdownGuideOpen, setMarkdownGuideOpen] = useState(false);

  /** The toolbar pill is the whole announcement — see store/updater.ts */
  const update = useUpdate();
  const hasUpdate =
    update.phase === 'available' || update.phase === 'downloading' || update.phase === 'ready';
  /** Local agent panel. Once opened it is never unmounted — a run in flight
   *  still needs someone watching it when the panel is collapsed */
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMounted, setAgentMounted] = useState(false);
  /** A request composed for the agent elsewhere in the app, waiting to be
   *  finished by hand in the composer */
  const [agentSeed, setAgentSeed] = useState<{ text: string; at: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** An export is running (long images and backup archives both take a while) */
  const [exporting, setExporting] = useState(false);
  /** Side-by-side / preview-only */
  const [viewMode, setViewMode] = useState<'split' | 'preview'>('split');
  /** Editor width as a percentage; defaults to the preview's minimum */
  const [editorPct, setEditorPct] = useState<number>(() => {
    const w = window.innerWidth;
    return Math.round(((w - MIN_PREVIEW_PX) / w) * 1000) / 10;
  });
  /** Disable the width transition while dragging */
  const draggingRef = useRef(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);

  /**
   * The image index used for rendering.
   *
   * The library is keyed by workspace-relative path (the tree has to show where
   * each file actually lives), while the body usually writes a bare file name
   * like `![[cover.png]]` — so both keys point at the same data URI here.
   * When two directories hold the same name, first one wins (path order, which
   * is stable and predictable).
   */
  const imageIndex = useMemo(() => {
    const index: Record<string, string> = {};
    for (const [path, dataUrl] of Object.entries(images)) index[path] = dataUrl;
    for (const [path, dataUrl] of Object.entries(images)) {
      const name = baseName(path);
      if (!(name in index)) index[name] = dataUrl;
    }
    return index;
  }, [images]);

  /** Candidates for ![[ completion: the body refers to images by file name */
  const imageNames = useMemo(() => [...new Set(Object.keys(images).map(baseName))], [images]);

  /** Themes the agent wrote. They are files on disk, watched, so this list
   *  changes underfoot while a run is going — which is the whole idea.
   *  null while the first read is still out */
  const loadedThemes = useCustomThemes();
  const customThemes = useMemo(() => loadedThemes ?? [], [loadedThemes]);
  /** A custom theme wins over a preset of the same name only because ids can
   *  never collide (see parseTheme); a deleted one falls back to classic */
  const theme = useMemo(
    () => customThemes.find((t) => t.id === themeId) ?? getTheme(themeId),
    [themeId, customThemes],
  );
  const density = useMemo(() => getDensity(densityId), [densityId]);
  const densityName = useMemo(
    () => DENSITIES.find((d) => d.id === densityId)?.name ?? '标准',
    [densityId],
  );
  /** Flips once the highlighter is ready, to trigger the re-render that adds it */
  const [hlReady, setHlReady] = useState(isHighlighterReady);
  // Whole-document re-render yields to typing: keep showing the previous
  // render while keys are coming in, recompute when the main thread is idle
  const deferredMarkdown = useDeferredValue(markdown);
  const renderOptions = useMemo(() => ({ linkFootnotes }), [linkFootnotes]);
  const result = useMemo(
    () => renderArticle(deferredMarkdown, theme, imageIndex, density, renderOptions),
    // hlReady is only a "recompute once" signal, not a render input
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deferredMarkdown, theme, imageIndex, density, renderOptions, hlReady],
  );

  // highlight.js loads lazily (never blocking first paint); once it is ready,
  // fill in the code highlighting
  useEffect(() => {
    if (hlReady) return;
    let cancelled = false;
    void ensureHighlighter().then(() => {
      if (!cancelled) setHlReady(isHighlighterReady());
    });
    return () => {
      cancelled = true;
    };
  }, [hlReady]);

  const statusTimer = useRef<number | null>(null);
  const flash = (msg: string) => {
    setStatus(msg);
    if (statusTimer.current) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), 2200);
  };
  useEffect(
    () => () => {
      if (statusTimer.current) window.clearTimeout(statusTimer.current);
    },
    [],
  );

  /* ---------- Themes the agent makes ---------- */

  /**
   * A theme that was not there a moment ago is one the agent just wrote, so
   * switch to it.
   *
   * Without this the loop stops one step short: you ask for a theme, it
   * appears in the list, and the preview keeps showing the old one until you
   * go and find the new card. The first load is exempt — every theme is new
   * then, and adopting one at startup would override the workspace's own
   * choice.
   */
  const knownThemes = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loadedThemes) return;
    const before = knownThemes.current;
    knownThemes.current = new Set(loadedThemes.map((t) => t.id));
    if (!before) return;
    const fresh = loadedThemes.find((t) => !before.has(t.id));
    if (fresh) vault.setPrefs({ themeId: fresh.id });
    // vault.setPrefs is stable enough for this; the list is the real trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedThemes]);

  /**
   * Hand the agent a half-written request for a new theme.
   *
   * The guide is written to disk first and named by absolute path, rather than
   * pasted into the prompt: the format description runs to a couple of hundred
   * lines, and a couple of hundred lines of specification sitting at the top of
   * the conversation is unreadable for the one person who has to read it. The
   * CLI opens files for a living; let it open this one.
   *
   * The request stops at "我想要：" on purpose — see the seed comment in
   * AgentPanel. Nothing is sent until the user finishes that sentence.
   */
  const askAgentForTheme = () => {
    void (async () => {
      let paths;
      try {
        paths = await ensureThemeGuide();
      } catch (err) {
        flash(err instanceof Error ? err.message : '写不了主题说明');
        return;
      }
      setAgentMounted(true);
      setAgentOpen(true);
      setAgentSeed({
        at: Date.now(),
        text:
          `帮我做一个公众号文章主题。\n\n` +
          `格式、全部字段和一个完整示例都在 ${paths.guide}，动手前先读它。\n` +
          `主题文件写到 ${paths.dir} 下面，文件名就是主题的 id（比如 celadon.json）。\n` +
          `存盘我这边预览立刻会变，我看了会告诉你哪儿再改，你改同一个文件就行。\n\n` +
          `我想要：`,
      });
    })();
  };

  /** Throw one away. If it was the one in use, the draft falls back to the
   *  default preset rather than silently keeping a theme that no longer exists */
  const dropTheme = (id: string) => {
    void deleteCustomTheme(id)
      .then(() => {
        if (themeId === id) vault.setPrefs({ themeId: 'classic' });
        flash('主题已删掉');
      })
      .catch((err) => flash(err instanceof Error ? err.message : '删不掉主题'));
  };

  // Surface disk trouble (cannot write, cannot read) — otherwise all the user
  // sees is that their work did not save
  useEffect(() => {
    if (vault.error) flash(vault.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.error]);

  /** New draft, created under `parent` (empty string = workspace root) */
  const handleNewDraft = (parent = '') => {
    void (async () => {
      try {
        const created = await vault.newDraft(`草稿 ${drafts.length + 1}`, '', parent);
        if (created) {
          setActiveDraft(created.id);
          flash(`已新建「${created.name}」`);
        }
      } catch (err) {
        flash(err instanceof Error ? err.message : '新建失败');
      }
    })();
  };

  /**
   * A web page, turned into a draft in this workspace.
   *
   * Two things happen and both belong to the workspace, not to reader.ts: the
   * images are written through the vault (so the tree and the preview pick them
   * up like any other image), and the finished body becomes a real file named
   * after the article.
   */
  const runImport = async (
    url: string,
    parent: string,
    withImages: boolean,
    onProgress: (msg: string) => void,
  ) => {
    const result = await importArticle(url, {
      withImages,
      addImage: vault.addImage,
      // The file names already in images/ — one import must not overwrite
      // pictures another one put there
      taken: new Set(imageNames),
      onProgress: (done, total) => onProgress(`正在存图 ${done}/${total}…`),
    });
    const created = await vault.newDraft(result.title || '网页导入', result.markdown, parent);
    if (created) setActiveDraft(created.id);
    const note = result.saved ? `，存了 ${result.saved} 张图` : '';
    const missed = result.missed ? `（${result.missed} 张没抓到，正文里还是外链）` : '';
    flash(`已导入「${created?.name ?? result.title}」${note}${missed}`);
  };

  /** New folder */
  const handleNewFolder = (parent = '') => {
    void (async () => {
      try {
        const path = await vault.newFolder('新文件夹', parent);
        if (path) flash(`已新建文件夹「${baseName(path)}」`);
      } catch (err) {
        flash(err instanceof Error ? err.message : '新建文件夹失败');
      }
    })();
  };

  /** Rename — on disk this renames a real file or directory, so collisions
   *  have to be caught */
  const handleRename = (path: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void (async () => {
      try {
        const next = await vault.renameEntry(path, trimmed);
        // The path *is* the id, so renaming changes it; the selection has to
        // follow, including for a draft inside a renamed directory
        if (next && (path === activeId || activeId.startsWith(`${path}/`))) {
          setActiveDraft(activeId === path ? next : next + activeId.slice(path.length));
        }
      } catch (err) {
        flash(err instanceof Error ? err.message : '改名失败');
      }
    })();
  };

  /** Drag-move into another directory */
  const handleMove = (path: string, toParent: string) => {
    void (async () => {
      try {
        const next = await vault.moveEntry(path, toParent);
        if (next && (path === activeId || activeId.startsWith(`${path}/`))) {
          setActiveDraft(activeId === path ? next : next + activeId.slice(path.length));
        }
      } catch (err) {
        flash(err instanceof Error ? err.message : '移动失败');
      }
    })();
  };

  /**
   * Delete a file or a folder.
   *
   * This deletes a real file with no trash to recover it from, so every case
   * asks first. Folders and still-referenced images each need their own
   * wording — a vague confirmation is worse than none.
   */
  const handleDelete = (path: string) => {
    const name = baseName(path);
    const isDir = !!findEntry(tree, path)?.isDir;
    const stillUsed = images[path] && (usedImageRefs.has(name) || usedImageRefs.has(path));
    const question = isDir
      ? `删除文件夹「${name}」？里面的东西会一起删掉。`
      : stillUsed
        ? `「${name}」还被正文引用，删除后那里会变成占位提示。仍要删除？`
        : `删除「${name}」？文件会从工作区里删掉。`;
    void (async () => {
      if (!(await confirmDestructive(question))) return;
      try {
        await vault.removeEntry(path);
        // The deleted item was the open draft (or the directory holding it):
        // the selection has to land on a file that really exists
        if (activeId === path || activeId.startsWith(`${path}/`)) {
          const remaining = drafts.filter((d) => d.id !== path && !d.id.startsWith(`${path}/`));
          const next = remaining.length ? remaining[0] : await vault.newDraft('未命名草稿');
          if (next) setActiveDraft(next.id);
        }
        flash(`已删除「${name}」`);
      } catch (err) {
        flash(err instanceof Error ? err.message : '删除失败');
      }
    })();
  };

  /** Files we cannot open (pdf, psd…): hand them to the system file manager */
  const handleReveal = (path: string) => {
    void vault.revealEntry(path).catch((err) => flash(err instanceof Error ? err.message : '打开失败'));
  };

  /** Images referenced by any draft (both bare names and full paths count) */
  const usedImageRefs = useMemo(() => {
    const used = new Set<string>();
    for (const d of drafts) {
      for (const name of collectImageRefs(d.content)) used.add(name);
    }
    return used;
  }, [drafts]);

  /** Editor jump request (used when an image is clicked in the file tree) */
  const [jumpRequest, setJumpRequest] = useState<{ line: number; nonce: number } | null>(null);
  const jumpNonce = useRef(0);

  /** Click an image: jump to the line referencing it, switching drafts if needed */
  const handleLocateImage = (path: string) => {
  // The body usually writes the bare name; the path is only where it lives
    const name = baseName(path);
    const inActive = activeDraft ? findEmbedLine(activeDraft.content, name) : -1;
    let line = inActive;
    let jumpedTo: { id: string; name: string } | null = null;
    if (line < 0) {
      // Not in the current draft, so look through the others
      for (const d of drafts) {
        if (d.id === activeId) continue;
        const l = findEmbedLine(d.content, name);
        if (l >= 0) {
          line = l;
          jumpedTo = d;
          break;
        }
      }
    }
    if (line < 0) {
      flash(`「${name}」还没有被任何草稿引用`);
      return;
    }
    if (jumpedTo) {
      setActiveDraft(jumpedTo.id);
      flash(`已跳到「${jumpedTo.name}」`);
    }
    jumpNonce.current += 1;
    setJumpRequest({ line, nonce: jumpNonce.current });
  };

  /** Sweep every image that no draft references */
  const handleCleanupImages = () => {
    const unused = Object.keys(images).filter(
      (p) => !usedImageRefs.has(baseName(p)) && !usedImageRefs.has(p),
    );
    if (!unused.length) {
      flash('没有未引用的图片');
      return;
    }
    void (async () => {
      const question = `删除 ${unused.length} 张未被任何草稿引用的图片？`;
      if (!(await confirmDestructive(question))) return;
      try {
        await Promise.all(unused.map((p) => vault.removeEntry(p)));
        flash(`已清理 ${unused.length} 张未引用图片`);
      } catch {
        flash('部分图片删除失败');
      }
    })();
  };

  /** Images dropped or pasted into the editor land under the workspace's images/ */
  const handleAddImage = (name: string, dataUrl: string) => {
    void vault.addImage(name, dataUrl).catch(() => flash('图片保存失败'));
  };

  const handleCopy = async () => {
    if (copying) return;
    setCopying(true);
    try {
      // The preview runs off a deferred value and the highlighter may still be
      // loading, so an export has to re-render from the current body
      await ensureHighlighter();
      const { html } = renderArticle(markdown, theme, imageIndex, density, renderOptions);
      // Inline remote images first: the moment an image host turns on hotlink
      // protection, WeChat cannot fetch them and the paste is all broken images
      const { html: inlined, failed } = await inlineRemoteImages(html, (done, total) =>
        flash(`正在抓取外链图 ${done}/${total}…`),
      );
      const ok = await copyRichText(inlined);
      flash(
        ok
          ? `已复制，去公众号 ${chord('V')} 粘贴${failed ? `（${failed} 张外链图没抓到，仍是外链）` : ''}`
          : '复制失败',
      );
    } catch (err) {
      // Errors from the image host (bad credentials, IP not allow-listed) have
      // to come through verbatim, or all the user sees is "copy failed"
      console.warn('复制失败', err);
      flash(err instanceof Error ? err.message : '复制失败');
    } finally {
      setCopying(false);
    }
  };

  /* ---------------- Export ---------------- */

  /** Export the body as one long PNG (re-rendered from the current body, not
   *  the deferred preview value) */
  const handleExportImage = async () => {
    setExporting(true);
    try {
      await ensureHighlighter();
      const { body } = renderArticle(markdown, theme, imageIndex, density, renderOptions);
      // A long image goes through <foreignObject>, which only sees resources it
      // carries itself, so remote images must be inlined first
      const { html: inlined } = await inlineRemoteImages(body);
      const blob = await renderLongImage({ body: inlined, theme, author: 'VinsEditor' });
      if (await saveBlob(`${safeFileName(activeDraft?.name ?? '长图')}.png`, blob)) flash('长图已导出');
    } catch (err) {
      console.warn('长图导出失败', err);
      flash(err instanceof Error ? err.message : '长图导出失败');
    } finally {
      setExporting(false);
    }
  };

  /** Closing the push dialog also drops the overwrite target — see publishTarget */
  const closePublish = () => {
    setPublishOpen(false);
    setPublishTarget(null);
    setPublishTargetDigest('');
  };

  /** Body HTML for the push: the preview runs off a deferred value and the
   *  highlighter may still be loading, so re-render from the current body */
  const buildArticleHtml = async (): Promise<string> => {
    await ensureHighlighter();
    return renderArticle(markdown, theme, imageIndex, density, renderOptions).html;
  };

  /** Default title: the first H1 in the body, falling back to the draft name.
   *  Computed only at the moment the dialog opens */
  const defaultTitle = useMemo(() => {
    const fromBody = extractTitle(renderArticle(markdown, theme, imageIndex, density, renderOptions).body);
    return fromBody || activeDraft?.name || '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishOpen]);

  /** Dragging the splitter: write the editor's DOM width directly so it tracks
   *  the cursor, and fall back to state on mouseup */
  const handleDrag = (clientX: number) => {
    const split = splitRef.current;
    const editor = editorRef.current;
    if (!split || !editor) return;
    const rect = split.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    // Editor width range: [MIN_EDITOR_PX, W - MIN_PREVIEW_PX], which keeps a
    // true phone measure available to the preview
    const minPct = (MIN_EDITOR_PX / rect.width) * 100;
    const maxPct = ((rect.width - MIN_PREVIEW_PX) / rect.width) * 100;
    const clamped = Math.max(minPct, Math.min(maxPct, pct));
    editor.style.width = `${clamped}%`; // Straight to the DOM, skipping React's render latency
    void editor.offsetHeight; // Force a reflow so the width transition is skipped
  };

  /** Drag start/end: toggle the DOM class by hand (a ref triggers no render,
   *  so the class has to be set manually) */
  const setDraggingUi = (on: boolean) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.classList.toggle('no-transition', on);
  };

  const endDrag = () => {
    draggingRef.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.documentElement.classList.remove('split-dragging');
    setDraggingUi(false);
    const editor = editorRef.current;
    const split = splitRef.current;
    if (editor && split) {
      const rect = split.getBoundingClientRect();
      // Write the final width back to state (used by mode switching and reset)
      setEditorPct(Math.max(0, Math.min(100, (editor.getBoundingClientRect().width / rect.width) * 100)));
    }
  };

  // Global drag listeners, mounted permanently; the callbacks check the flag
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current) handleDrag(e.clientX);
    };
    const onUp = () => {
      if (draggingRef.current) endDrag();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  /** Double-click the splitter to reset (to the preview's minimum width) */
  const resetSplit = () => {
    const editor = editorRef.current;
    const split = splitRef.current;
    if (!editor || !split) return;
    setDraggingUi(true);
    const rect = split.getBoundingClientRect();
    const pct = Math.round(((rect.width - MIN_PREVIEW_PX) / rect.width) * 1000) / 10;
    editor.style.width = `${pct}%`;
    void editor.offsetHeight;
    setDraggingUi(false);
    setEditorPct(pct);
  };

  /**
   * Scroll-sync channel: the editor publishes a position, the preview subscribes.
   * A mutable object rather than state — scrolling should not re-render the tree.
   */
  const scrollSync = useRef(createScrollSyncChannel()).current;

  const isPreviewOnly = viewMode === 'preview';

  return (
    <div className="app">
      <Toolbar
        viewMode={viewMode}
        onViewMode={setViewMode}
        status={status}
        docName={activeDraft?.name ?? ''}
        saving={saving}
        onCopy={handleCopy}
        onExportImage={() => void handleExportImage()}
        exporting={exporting}
        copying={copying}
        onPublish={() => setPublishOpen(true)}
        onOpenDraftBox={() => setDraftBoxOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMarkdownGuide={() => setMarkdownGuideOpen(true)}
        hasUpdate={hasUpdate}
        onOpenUpdate={() => setUpdateOpen(true)}
        agentOpen={agentOpen}
        onToggleAgent={() => {
          setAgentOpen((v) => !v);
          setAgentMounted(true);
        }}
        typeset={(close) => (
          <TypesetPopover
            themeId={themeId}
            onThemeChange={(id) => vault.setPrefs({ themeId: id })}
            customThemes={customThemes}
            onDeleteTheme={dropTheme}
            onAskAgent={() => {
              close();
              askAgentForTheme();
            }}
            densityId={densityId}
            onDensityChange={(id) => vault.setPrefs({ densityId: id })}
            linkFootnotes={linkFootnotes}
            onLinkFootnotes={(on) => vault.setPrefs({ linkFootnotes: on })}
            appearance={appearance}
            onAppearance={setAppearance}
          />
        )}
      />
      <ConflictBar
        conflicts={conflicts}
        drafts={drafts}
        onTakeDisk={vault.takeDisk}
        onKeepMine={vault.keepMine}
      />
      <main className={`workspace ${isPreviewOnly ? 'mode-preview' : ''}`}>
        <FileTree
          vaultDir={vault.dir ?? ''}
          onChangeVault={() => void vault.chooseVault()}
          tree={tree}
          drafts={drafts}
          activeId={activeId}
          images={images}
          usedImageRefs={usedImageRefs}
          onOpen={setActiveDraft}
          onLocateImage={handleLocateImage}
          onReveal={handleReveal}
          onNewDraft={handleNewDraft}
          onNewFolder={handleNewFolder}
          onImportUrl={(parent) => {
            setImportParent(parent);
            setImportOpen(true);
          }}
          onRename={handleRename}
          onDelete={handleDelete}
          onMove={handleMove}
          onCleanupImages={handleCleanupImages}
        />
        <div className="split" ref={splitRef}>
          <EditorPane
            ref={editorRef}
            value={markdown}
            onChange={setMarkdown}
            onAddImage={handleAddImage}
            imageNames={imageNames}
            draftId={activeId}
            sync={scrollSync}
            jumpRequest={jumpRequest}
            collapsed={isPreviewOnly}
            widthPct={editorPct}
            saving={saving}
          />
          <div
            className="split-bar"
            title="拖动调整 · 双击复位"
            onMouseDown={(e) => {
              draggingRef.current = true;
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
              document.documentElement.classList.add('split-dragging');
              setDraggingUi(true);
              handleDrag(e.clientX);
            }}
            onDoubleClick={resetSplit}
          />
          <PreviewPane
            body={result.body}
            theme={theme}
            hasImage={result.hasImage}
            densityName={densityName}
            resizeKey={`${viewMode}:${editorPct}`}
            sync={scrollSync}
          />
        </div>
        {agentMounted && (
          <AgentPanel
            open={agentOpen}
            vaultDir={vault.dir ?? ''}
            activeId={activeId}
            onClose={() => setAgentOpen(false)}
            onBeforeRun={vault.flush}
            seed={agentSeed}
          />
        )}
      </main>
      <ImportUrlDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        parent={importParent}
        onImport={(url, withImages, onProgress) => runImport(url, importParent, withImages, onProgress)}
      />
      <PublishDialog
        open={publishOpen}
        onClose={closePublish}
        defaultTitle={defaultTitle}
        buildHtml={buildArticleHtml}
        onFlash={flash}
        target={publishTarget}
        targetDigest={publishTargetDigest}
        onOpenDraftBox={() => {
          setPublishOpen(false);
          setDraftBoxOpen(true);
        }}
        onClearTarget={() => {
          setPublishTarget(null);
          setPublishTargetDigest('');
        }}
        onOpenSettings={() => {
          // One modal at a time: the push dialog steps aside, and pressing
          // 推草稿 again afterwards comes back with the new credentials
          setPublishOpen(false);
          setSettingsOpen(true);
        }}
      />
      <DraftBoxDialog
        open={draftBoxOpen}
        onClose={() => setDraftBoxOpen(false)}
        onPickTarget={(target, digest) => {
          setPublishTarget(target);
          setPublishTargetDigest(digest);
          setDraftBoxOpen(false);
          setPublishOpen(true);
        }}
        onOpenSettings={() => {
          setDraftBoxOpen(false);
          setSettingsOpen(true);
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenUpdate={() => {
          // One modal at a time, same as the push dialog does
          setSettingsOpen(false);
          setUpdateOpen(true);
        }}
      />
      <MarkdownGuideDialog open={markdownGuideOpen} onClose={() => setMarkdownGuideOpen(false)} />
      <UpdateDialog open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </div>
  );
}
