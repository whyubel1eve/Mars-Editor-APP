import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowCircleUp, BookOpenText, ClipboardText, GearSix, ImageSquare, PaperPlaneTilt, Sparkle, Stack, TextAa } from '@phosphor-icons/react';
import { chord } from '../platform';

interface Props {
  viewMode: 'split' | 'preview';
  onViewMode: (m: 'split' | 'preview') => void;
  status: string | null;
  /** Name of the open draft — the toolbar doubles as the window title */
  docName: string;
  /** A write is still in flight (the save indicator breathes) */
  saving: boolean;
  onCopy: () => void;
  /**
   * Export the body as one long PNG.
   *
   * The only export left. A draft is already a .md file in the workspace and
   * the images are already image files, so "export a draft" and "back up
   * everything" were both offering to produce a copy of what is already on
   * disk. A long image is the one thing the folder does not already contain.
   */
  onExportImage: () => void;
  /** An export is running: disable the button so it cannot be fired twice */
  exporting: boolean;
  /** A copy is running (remote images have to be fetched first) */
  copying: boolean;
  /** Open "push to drafts" */
  onPublish: () => void;
  /** Open the drafts box: what is already up there, and what to overwrite */
  onOpenDraftBox: () => void;
  /** Open settings (公众号凭据 lives there) */
  onOpenSettings: () => void;
  onOpenMarkdownGuide: () => void;
  /**
   * A newer release is waiting.
   *
   * The launch check is silent by design (see store/updater.ts), so this pill
   * is the entire announcement: visible, ignorable, and gone once the version
   * is installed or dismissed.
   */
  hasUpdate: boolean;
  onOpenUpdate: () => void;
  /** Is the agent panel expanded */
  agentOpen: boolean;
  onToggleAgent: () => void;
  /** Themes / density / body options / appearance, rendered into a popover.
   *  Given the popover's own close handle, so a control inside it can dismiss
   *  it on its way to opening something else (see the agent theme button) */
  typeset: (close: () => void) => ReactNode;
}

const MODES = [
  { id: 'split', name: '对照' },
  { id: 'preview', name: '预览' },
] as const;

/**
 * Top bar. On macOS this *is* the window title bar (see tauri.conf.json:
 * titleBarStyle Overlay) — the traffic lights float over its left end and
 * dragging it moves the window.
 *
 * That drag comes from `data-tauri-drag-region="deep"` on the header, and the
 * `deep` matters: a bare attribute means "only a click landing on this exact
 * element drags", so every span inside — the wordmark, the document name —
 * would swallow the gesture and leave just the slivers of empty header between
 * them draggable. `deep` makes the whole subtree drag, and Tauri already
 * excludes buttons and other interactive elements from it, so nothing here
 * needs to opt out by hand except a floating layer (see the popover).
 *
 * Left says what you are editing, right says what you can do to it, with a
 * single filled button for the one destructive-ish action worth emphasizing.
 */
export default function Toolbar({
  viewMode,
  onViewMode,
  status,
  docName,
  saving,
  onCopy,
  onExportImage,
  exporting,
  copying,
  onPublish,
  onOpenDraftBox,
  onOpenSettings,
  onOpenMarkdownGuide,
  hasUpdate,
  onOpenUpdate,
  agentOpen,
  onToggleAgent,
  typeset,
}: Props) {
  const [typesetOpen, setTypesetOpen] = useState(false);
  const typesetRef = useRef<HTMLDivElement>(null);

  // Click outside / Esc closes the popover
  useEffect(() => {
    if (!typesetOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!typesetRef.current?.contains(e.target as Node)) setTypesetOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTypesetOpen(false);
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [typesetOpen]);

  const modeIndex = MODES.findIndex((m) => m.id === viewMode);

  return (
    <header className="toolbar" data-tauri-drag-region="deep">
      <div className="brand">
        {/* The toolbar uses the same friendly page mascot as the app icon and
            favicon, so the brand stays consistent inside and outside the app. */}
        <span className="brand-mark">
          <img src="./favicon.svg" alt="" aria-hidden="true" />
        </span>
        <span className="brand-name">VinsEditor</span>
      </div>

      {docName && (
        <>
          <span className="tb-sep" aria-hidden="true" />
          <div className="tb-doc">
            <span className={`tb-dot ${saving ? 'saving' : ''}`} aria-hidden="true" />
            <span className="tb-doc-name" title={saving ? '正在保存…' : '已保存到工作区'}>
              {docName}
            </span>
          </div>
        </>
      )}

      <div className="toolbar-right">
        {hasUpdate && (
          <button className="btn update-pill" onClick={onOpenUpdate} title="有新版本可以安装">
            <ArrowCircleUp size={15} weight="bold" />
            新版本
          </button>
        )}

        <div
          className="segmented"
          role="tablist"
          aria-label="工作区模式"
          style={{ '--seg-n': MODES.length, '--seg-i': modeIndex } as React.CSSProperties}
        >
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={viewMode === m.id}
              className={`seg-btn ${viewMode === m.id ? 'active' : ''}`}
              onClick={() => onViewMode(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>

        {/* Themes, density, body options and the shell's own light/dark */}
        <div className="menu-wrap" ref={typesetRef}>
          <button
            className={`btn ${typesetOpen ? 'active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={typesetOpen}
            title="文章主题、排版密度、界面外观"
            onClick={() => setTypesetOpen((v) => !v)}
          >
            <TextAa size={15} weight="bold" />
            排版
          </button>
          {typesetOpen && typeset(() => setTypesetOpen(false))}
        </div>

        {/* Credentials and anything else configured once and then forgotten.
            Icon only: it is not part of the writing loop, and a labelled
            button here would compete with the four that are. */}
        <button className="btn icon" onClick={onOpenSettings} title="设置（公众号凭据）" aria-label="设置">
          <GearSix size={15} weight="bold" />
        </button>
        <button className="btn" onClick={onOpenMarkdownGuide} title="Markdown 语法说明">
          <BookOpenText size={15} weight="bold" />
          MD 语法
        </button>

        {/* Local agent: runs the claude / codex already on this machine.
            No model is wired into the editor itself. */}
        <button
          className={`btn ${agentOpen ? 'active' : ''}`}
          onClick={onToggleAgent}
          aria-pressed={agentOpen}
          title="让本地的 claude / codex 在这个工作区里改稿"
        >
          <Sparkle size={15} weight="bold" />
          Agent
        </button>

        <button className="btn" onClick={onExportImage} disabled={exporting} title="把整篇正文渲染成一张长图 PNG">
          <ImageSquare size={15} weight="bold" />
          {exporting ? '渲染中…' : '长图'}
        </button>

        <button className="btn" onClick={onCopy} disabled={copying} title={`复制为富文本，去公众号编辑器 ${chord('V')} 粘贴`}>
          <ClipboardText size={15} weight="bold" />
          {copying ? '处理中…' : '复制正文'}
        </button>

        {/* The drafts box is otherwise only visible inside the WeChat console,
            so after a few pushes it is unclear which version is up there. Also
            where an article is picked to overwrite rather than duplicate. */}
        <button className="btn icon" onClick={onOpenDraftBox} title="草稿箱：看看公众号上已有哪些草稿" aria-label="草稿箱">
          <Stack size={15} weight="bold" />
        </button>

        <button className="btn primary" onClick={onPublish} title="换图后直接推进公众号草稿箱">
          <PaperPlaneTilt size={15} weight="bold" />
          推草稿
        </button>
      </div>

      {status && <span className="status show">{status}</span>}
    </header>
  );
}
