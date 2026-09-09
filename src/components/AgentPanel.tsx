import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CaretDown,
  Check,
  ClockCounterClockwise,
  FileText,
  Globe,
  MagnifyingGlass,
  NotePencil,
  Paperclip,
  PencilSimple,
  PlugsConnected,
  Sparkle,
  Terminal,
  Stop,
  Trash,
  TreeStructure,
  Wrench,
  X,
  type Icon,
} from '@phosphor-icons/react';
import {
  agentModels,
  EFFORTS,
  interpret,
  onAgentEvent,
  probeAgents,
  readSessions,
  runAgent,
  stderrGist,
  stopAgent,
  writeSessions,
  type AgentInfo,
  type AgentKind,
  type Beat,
  type ModelChoice,
  type Session,
  type ToolAct,
} from '../store/agent';
import { getConfig, setConfig } from '../store/appConfig';
import AgentMarkdown from './AgentMarkdown';

interface Props {
  /** Collapsed means hidden, not unmounted — see the note on the component */
  open: boolean;
  /** Absolute workspace path — the agent works inside this directory */
  vaultDir: string;
  /** The open draft (workspace-relative path), used to give the agent context */
  activeId: string;
  onClose: () => void;
  /** Flush unsaved edits before starting; see the comment further down */
  onBeforeRun: () => Promise<void>;
  /** A request written for you elsewhere in the app (currently: "make me a
   *  theme"), dropped into the composer for you to finish and send. It is
   *  never sent on your behalf — the last line is the part only you can write.
   *  A new object means a new request, which is why the timestamp is in it */
  seed?: { text: string; at: number } | null;
}

const KINDS: AgentKind[] = ['claude', 'codex'];
/** One icon per kind of tool call. Not decoration — a run of a dozen calls is
 *  read by shape long before it is read by name */
const TOOL_ICONS: Record<ToolAct, Icon> = {
  run: Terminal,
  read: FileText,
  edit: PencilSimple,
  search: MagnifyingGlass,
  web: Globe,
  mcp: PlugsConnected,
  task: TreeStructure,
  other: Wrench,
};
/** Which CLI to use is a property of this machine, not of the workspace, so it
 *  lives in the app config */
const KIND_KEY = 'agent.kind';
/** Model and effort are per-CLI: `opus` means nothing to codex, and the two
 *  keep separate conversations anyway */
const modelKey = (k: AgentKind) => `agent.model.${k}`;
const effortKey = (k: AgentKind) => `agent.effort.${k}`;
/** How many sessions to keep. You will not scroll further back than this, and
 *  the CLI has most likely forgotten those ids anyway */
const KEEP = 40;
/** Debounce on writing the session log to disk */
const SAVE_DELAY = 600;
/** How long to accumulate streamed tokens before repainting. Repainting on
 *  every token leaves the panel too busy to scroll; batched to this, it still
 *  looks like typing but repaints an order of magnitude less often */

const DRAW_DELAY = 60;
/** Within this many pixels of the bottom counts as "reading the latest", and
 *  new content scrolls along. Further up you are re-reading what was already
 *  said, and yanking someone back there means not letting them read */

const FOLLOW_SLACK = 96;

/** Common writing actions turn the editor's context into a usable prompt.
 * They intentionally fill the composer instead of sending immediately: the
 * user can adjust the request and still has the final say over an edit. */
const QUICK_ACTIONS = [
  {
    label: '润色全文',
    prompt:
      '请直接在当前打开的 Markdown 草稿上做中文润色：保留原意、结构和事实，只改善表达、断句与可读性。完成后说明改了什么。',
  },
  {
    label: '写标题摘要',
    prompt:
      '请阅读当前打开的 Markdown 草稿，给出 5 个适合微信公众号的标题和 3 个摘要候选。不要改文件，直接在回复中列出结果。',
  },
  {
    label: '检查发布',
    prompt:
      '请检查当前打开的 Markdown 草稿是否适合发布到微信公众号：关注标题、层级、链接、图片、字数和可能导致排版异常的内容。按“问题 / 建议”列出，不要直接改文件。',
  },
] as const;

/** The timestamp in the session list, in plain words */
function whenText(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hhmm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

interface TuneItem {
  id: string;
  label: string;
  /** The second line in the menu — what picking this actually means */
  note?: string;
}

/**
 * One of the three composer settings: a chip that says what is currently
 * chosen, and a menu that opens upward off it.
 *
 * Upward because the composer is pinned to the bottom of the panel; the shared
 * `.popover` is built for the toolbar and drops down from a top-right origin,
 * so the class here flips both.
 *
 * Every menu carries a "默认" entry that sends nothing at all. That is not the
 * same as picking the value the CLI happens to be set to today: it means this
 * panel does not have an opinion, so whatever ~/.codex/config.toml or
 * ~/.claude/settings.json says keeps applying, including after you change it.
 */
function TuneMenu({
  items,
  value,
  onPick,
  chip,
  title,
  wide,
  inherited,
}: {
  items: TuneItem[];
  /** '' = the default entry */
  value: string;
  onPick: (id: string) => void;
  /** What the chip reads when closed */
  chip: string;
  title: string;
  /** This is the chip that may have to give up width */
  wide?: boolean;
  /** The chip is naming the CLI's own setting rather than a choice made here */
  inherited?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={`agent-tune ${wide ? 'wide' : ''}`} ref={ref}>
      <button
        type="button"
        className={`agent-chip ${open ? 'on' : ''} ${inherited ? 'inherited' : ''}`}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-chip-text">{chip}</span>
        <CaretDown size={9} weight="bold" />
      </button>
      {open && (
        <div className="popover agent-tune-menu" role="menu">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitemradio"
              aria-checked={it.id === value}
              className="menu-item agent-tune-item"
              onClick={() => {
                onPick(it.id);
                setOpen(false);
              }}
            >
              <span className="agent-tune-lines">
                <span className="agent-tune-label">{it.label}</span>
                {it.note && <span className="agent-tune-note">{it.note}</span>}
              </span>
              <span className="menu-check" aria-hidden="true">
                <Check size={11} weight="bold" />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One tool call: an icon, what was called, and what it was called on.
 *
 * It stays on one line and trims to the panel's width — a command line or a
 * path wrapped across three lines in a 336px column costs more attention than
 * it is worth, and these are meant to be skimmed past on the way to what the
 * agent actually said. The untrimmed text is the tooltip.
 *
 * Sessions written before tool calls were split into verb + target have
 * neither, only the one preformatted string; that still renders, just without
 * the icon carrying any particular meaning.
 */
function ToolBeat({ beat }: { beat: Beat }) {
  const Glyph = TOOL_ICONS[beat.act ?? 'other'];
  const full = [beat.verb, beat.text].filter(Boolean).join(' ');
  return (
    <div className={`agent-beat tool${beat.bad ? ' bad' : ''}`} title={full}>
      <span className="agent-tool-icon" aria-hidden="true">
        <Glyph size={11} weight="bold" />
      </span>
      {beat.verb && <span className="agent-tool-verb">{beat.verb}</span>}
      {beat.text && <span className="agent-tool-target">{beat.text}</span>}
    </div>
  );
}

/**
 * Let the local claude / codex edit drafts inside this workspace.
 *
 * There is no model here and no network — this runs the CLI already on the
 * user's machine, just moved next to the editor, which saves the "switch to a
 * terminal, cd over, read the file name out to it" steps. Whose quota it runs
 * on is not decided here either: whatever the CLI itself is configured with,
 * subscription or key, is what it uses (that is exactly what switchers like
 * cc-switch change), and the panel only surfaces what it reports on startup.
 *
 * Edits do not flow back through this path: the agent writes .md files on disk
 * and the watcher notices them as usual. So the panel only ever shows what it
 * said and which file it touched — the left-hand side is the authority on what
 * the body actually looks like.
 *
 * The two CLIs get separate session areas: they are two processes that know
 * nothing about each other, claude cannot read what codex said, and laying
 * them out on one timeline would only suggest that they can. What genuinely
 * passes between them is the .md files on disk — that is the shared context.
 *
 * "Collapse" only hides, never unmounts: a run in flight must not become an
 * orphaned process because you wanted the space back, and reopening should
 * still show the last exchange. Only a real unmount (switching workspaces,
 * closing the window) kills it.
 */
export default function AgentPanel({ open, vaultDir, activeId, onClose, onBeforeRun, seed }: Props) {
  const [infos, setInfos] = useState<AgentInfo[]>([]);
  const [kind, setKind] = useState<AgentKind>(
    () => (KINDS.find((k) => k === getConfig(KIND_KEY)) ?? 'claude'),
  );
  /** Every conversation held in this workspace, both CLIs in one list, each
   *  entry carrying its own kind */
  const [sessions, setSessions] = useState<Session[]>([]);
  /** Which session each CLI currently has open. null = none yet; it is only
   *  really created when the first message is sent */
  const [activeKey, setActiveKey] = useState<Record<AgentKind, string | null>>({
    claude: null,
    codex: null,
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  /** Hand-entered CLI path (the way out when it is not on PATH) */
  const [binDraft, setBinDraft] = useState('');
  /** Still looking for the CLIs. Normally over before this renders, since the
   *  slow part of it is warmed at startup — but on the launch where it is not,
   *  saying so beats an empty panel that ignores the keyboard */
  const [probing, setProbing] = useState(true);
  /** What this machine's CLI can be pointed at. Read per CLI, since codex's
   *  list comes off disk and changes when a switcher rewrites it */
  const [models, setModels] = useState<ModelChoice[]>([]);
  /** The model that CLI's own config already names */
  const [configModel, setConfigModel] = useState<string | null>(null);
  /** '' on either of these means "no opinion, leave the CLI's config alone" */
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');

  /** Events are claimed by run_id. The callback cannot see the latest state,
   *  so this goes through a ref */
  const runIdRef = useRef<string | null>(null);
  /** Which conversation this run's output belongs to — the session may only
   *  have been created at the moment of sending */
  const runKeyRef = useRef<string | null>(null);
  /** stderr already reported this run (path-stripped), so the same thing is
   *  never posted twice */
  const saidOnce = useRef<Set<string>>(new Set());
  const seq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The trailing agent beat is unfinished — streamed tokens land on it */
  const writing = useRef(false);
  /** Text not painted yet. append = add to the end, set = the beat is exactly this */
  const draft = useRef<{ mode: 'append' | 'set'; text: string } | null>(null);
  const drawTimer = useRef<number | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);
  /** No need to write back what we only just read off disk */
  const loaded = useRef(false);
  /** An IME candidate window is open — Enter belongs to it, not to us */
  const composing = useRef(false);

  const info = infos.find((i) => i.kind === kind);
  /** Do not rush to say "not found" while the probe is still running */
  const missing = infos.length > 0 && !info?.bin;
  const noAgentInstalled = infos.length > 0 && infos.every((i) => !i.bin);

  const current = sessions.find((s) => s.key === activeKey[kind]) ?? null;
  const lines = current?.lines ?? [];
  const continuing = !!current?.cliId;

  /** Patch one conversation by key, pushing its timestamp to now */
  const patch = (key: string, fn: (s: Session) => Session) => {
    setSessions((prev) =>
      prev.map((s) => (s.key === key ? { ...fn(s), updatedAt: Date.now() } : s)),
    );
  };

  /** Append entries to a conversation. An empty title takes the first message */
  const pushTo = (key: string, beats: Beat[]) => {
    if (!beats.length) return;
    patch(key, (s) => ({
      ...s,
      title: s.title || beats.find((b) => b.role === 'you')?.text.slice(0, 40) || s.title,
      lines: [...s.lines, ...beats],
    }));
  };

  /* ---------- A request written elsewhere ---------- */

  /**
   * Drop a seeded request into the composer and put the caret at the end of it.
   *
   * Deliberately not sent: the seed is a preamble ending in "我想要：", and the
   * sentence after that colon is the whole point — only the person who wanted a
   * new theme can write it. Sending automatically would send an empty wish.
   *
   * Anything half-typed is kept in front of nothing: the seed replaces it, but
   * only because arriving here means the user just asked for exactly this.
   */
  useEffect(() => {
    if (!seed) return;
    setInput(seed.text);
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(seed.text.length, seed.text.length);
    el.scrollTop = el.scrollHeight;
  }, [seed]);

  /* ---------- The beat currently being spoken ---------- */

  /** Paint what has accumulated. Continue the current beat if it is still
   *  speaking, otherwise start a new one */
  const flush = (key: string) => {
    window.clearTimeout(drawTimer.current);
    drawTimer.current = undefined;
    const d = draft.current;
    draft.current = null;
    if (!d) return;
    const going = writing.current;
    writing.current = true;
    patch(key, (s) => {
      const lines = s.lines.slice();
      const last = lines.length - 1;
      if (going && lines[last]?.role === 'agent') {
        const now = d.mode === 'append' ? lines[last].text + d.text : d.text;
        lines[last] = { ...lines[last], text: now };
      } else {
        lines.push({ role: 'agent', text: d.text });
      }
      return { ...s, lines };
    });
  };

  /** Accumulate, then paint on a timer. A snapshot (set) is newer than the
   *  pending increments, so it simply overwrites them */
  const jot = (key: string, mode: 'append' | 'set', text: string) => {
    const d = draft.current;
    draft.current = mode === 'set' || !d ? { mode, text } : { mode: d.mode, text: d.text + text };
    if (drawTimer.current === undefined) {
      drawTimer.current = window.setTimeout(() => flush(key), DRAW_DELAY);
    }
  };

  /** Finalize: the whole-block version wins, then stop writing */
  const settle = (key: string, text: string) => {
    draft.current = { mode: 'set', text };
    flush(key);
    writing.current = false;
  };

  /** Stop writing without changing the text: something else is about to land on
   *  the timeline, or this run is over */
  const close = (key: string) => {
    flush(key);
    writing.current = false;
  };

  const probe = () => {
    setProbing(true);
    void probeAgents()
      .then((list) => {
        setInfos(list);
        // First run: if the stored choice is not on this machine, use one that is
        if (!getConfig(KIND_KEY)) {
          const usable = list.find((i) => i.bin)?.kind;
          if (usable) setKind(usable);
        }
      })
      .catch(() => undefined)
      .finally(() => setProbing(false));
  };
  useEffect(probe, []);

  // The remembered choices are per CLI, so they are re-read on every switch
  // rather than held in one place. A model that is no longer in the list (the
  // catalog was swapped out from under us) falls back to the default entry —
  // passing a slug the CLI does not know only earns an error at send time.
  useEffect(() => {
    setEffort(EFFORTS[kind].find((e) => e === getConfig(effortKey(kind))) ?? '');
    let alive = true;
    void agentModels(kind)
      .then((list) => {
        if (!alive) return;
        setModels(list.models);
        setConfigModel(list.current);
        const saved = getConfig(modelKey(kind)) ?? '';
        setModel(list.models.some((m) => m.id === saved) ? saved : '');
      })
      .catch(() => {
        if (!alive) return;
        setModels([]);
        setConfigModel(null);
        setModel('');
      });
    return () => {
      alive = false;
    };
  }, [kind]);

  /* ---------- Session log, to and from disk ---------- */

  // Read them back when the panel opens, but do not auto-resume any of them —
  // silently continuing an old conversation on launch leaves you unsure who you
  // are even talking to. To continue one, pick it from the history.

  useEffect(() => {
    let alive = true;
    void readSessions(vaultDir)
      .then((list) => {
        if (alive) setSessions(list);
      })
      .catch(() => undefined)
      .finally(() => {
        loaded.current = true;
      });
    return () => {
      alive = false;
    };
  }, [vaultDir]);

  useEffect(() => {
    if (!loaded.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      // Drop empty conversations: the ones opened and switched away from without
      // a word only serve to fill up the list
      const keep = sessions
        .filter((s) => s.lines.length)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, KEEP);
      void writeSessions(vaultDir, keep).catch(() => undefined);
    }, SAVE_DELAY);
  }, [sessions, vaultDir]);

  /* ---------- Running ---------- */

  // One subscription covers every run, filtered by run_id — a late event from
  // the previous run cannot leak into the next one
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onAgentEvent((e) => {
      if (e.runId !== runIdRef.current) return;
      if (e.stream === 'stderr') {
        const gist = stderrGist(e.line);
        if (saidOnce.current.has(gist)) return;
        saidOnce.current.add(gist);
      }
      const out = interpret(vaultDir, e);
      const key = runKeyRef.current;
      if (key) {
        if (out.delta) jot(key, 'append', out.delta);
        if (out.live !== undefined) jot(key, 'set', out.live);
        if (out.seal !== undefined) settle(key, out.seal);
        if (out.beats.length) {
          close(key);
          pushTo(key, out.beats);
        }
        // A mid-flight break (the process died, you pressed stop) still has to
        // close the beat, or the next run's text continues this one
        if (out.done) close(key);
        // The CLI reported its own session id; record it on this conversation —
        // "continue" means handing that id back
        if (out.sessionId) patch(key, (s) => ({ ...s, cliId: out.sessionId! }));
      }
      // Release the input as soon as result / task_complete arrives; no need to
      // wait for the process to actually exit
      if (out.done) setRunning(false);
      if (e.stream === 'exit') runIdRef.current = null;
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [vaultDir]);

  // Only clean up when the component really goes away (workspace switch, window
  // close) — collapsing the panel does not count
  useEffect(
    () => () => {
      window.clearTimeout(drawTimer.current);
      const id = runIdRef.current;
      if (id) void stopAgent(id).catch(() => undefined);
    },
    [],
  );

  // Switched conversations, or opened/closed the panel: drop straight to the
  // bottom, where the latest is
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeKey[kind], kind, open, historyOpen]);

  // Follow new content down, but only when you were already at the bottom.
  //
  // Watch the DOM rather than state: streamdown parses markdown inside a
  // transition, so the element only grows a beat after state settles, and
  // scrolling off state is permanently one step behind.
  // The browser's own scroll anchoring is no help either — the beat being
  // spoken reflows every 60ms and anchoring would push the viewport down the
  // whole way, which is why it is turned off in CSS (see .agent-log).



  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const follow = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK) {
        el.scrollTop = el.scrollHeight;
      }
    };
    const mo = new MutationObserver(follow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [historyOpen]);

  const send = () => {
    const text = input.trim();
    if (!text || running) return;
    void (async () => {
      // Flush unsaved edits first. Otherwise the agent reads a stale body, and
      // what it writes back no longer matches the version in our memory — the
      // conflict bar is guaranteed, and that conflict was self-inflicted.

      await onBeforeRun();

      // Create the session now if none is open: empty conversations are never
      // written to disk, so creating one early would only clutter the list
      let key = activeKey[kind];
      let resume: string | null = current?.cliId ?? null;
      if (!key) {
        key = `s${(seq.current += 1)}-${Date.now()}`;
        resume = null;
        setSessions((prev) => [
          { key: key!, kind, cliId: null, title: '', updatedAt: Date.now(), lines: [] },
          ...prev,
        ]);
        setActiveKey((prev) => ({ ...prev, [kind]: key }));
      }

      const context = activeId ? `（我正在编辑器里看着「${activeId}」这篇。）\n\n` : '';
      pushTo(key, [{ role: 'you', text }]);
      setInput('');
      saidOnce.current.clear();
      // If the previous run broke off mid-sentence, that sentence ends here:
      // this run's text starts a new beat
      writing.current = false;
      draft.current = null;
      setRunning(true);
      runKeyRef.current = key;
      try {
        const id = await runAgent({
          dir: vaultDir,
          kind,
          prompt: context + text,
          resume,
          model,
          effort,
        });
        runIdRef.current = id;
      } catch (err) {
        setRunning(false);
        pushTo(key, [
          { role: 'note', text: err instanceof Error ? err.message : String(err), bad: true },
        ]);
      }
    })();
  };

  const useQuickAction = (prompt: string) => {
    if (running || missing || probing) return;
    setInput(prompt);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const stop = () => {
    const id = runIdRef.current;
    if (id) void stopAgent(id).catch(() => undefined);
  };

  /* ---------- Switching between conversations ---------- */

  /** Start a new one: this only clears the pointer for the current CLI; the
   *  session is really created when the first message is sent */
  const startNew = () => {
    setActiveKey((prev) => ({ ...prev, [kind]: null }));
    setHistoryOpen(false);
  };

  /** Open one from the history, switching to the CLI it belongs to */
  const openSession = (s: Session) => {
    setKind(s.kind);
    setConfig(KIND_KEY, s.kind);
    setActiveKey((prev) => ({ ...prev, [s.kind]: s.key }));
    setHistoryOpen(false);
  };

  const dropSession = (key: string) => {
    setSessions((prev) => prev.filter((s) => s.key !== key));
    setActiveKey((prev) => ({
      claude: prev.claude === key ? null : prev.claude,
      codex: prev.codex === key ? null : prev.codex,
    }));
  };

  const switchKind = (next: AgentKind) => {
    if (next === kind) return;
    setKind(next);
    setConfig(KIND_KEY, next);
    setBinDraft('');
    setHistoryOpen(false);
  };

  const saveBin = () => {
    const path = binDraft.trim();
    if (!path) return;
    setConfig(`agent.bin.${kind}`, path);
    probe();
  };

  /** History list: both CLIs interleaved, newest first */
  const history = useMemo(
    () => sessions.filter((s) => s.lines.length).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  return (
    <aside className={`agent-side surface ${open ? '' : 'collapsed'}`}>
      <div className="pane-head">
        <span className="pane-title">
          <Sparkle size={13} weight="fill" />
          Agent
        </span>
        <div
          className="segmented agent-kinds"
          role="tablist"
          aria-label="用哪个 agent"
          style={{ '--seg-n': KINDS.length, '--seg-i': KINDS.indexOf(kind) } as React.CSSProperties}
        >
          {KINDS.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={`seg-btn ${kind === k ? 'active' : ''}`}
              disabled={running}
              onClick={() => switchKind(k)}
            >
              {k}
            </button>
          ))}
        </div>
        <button
          className={`ghost-btn ${historyOpen ? 'on' : ''}`}
          onClick={() => setHistoryOpen((v) => !v)}
          title="历史会话"
          aria-pressed={historyOpen}
        >
          <ClockCounterClockwise size={14} weight="bold" />
        </button>
        <button className="ghost-btn" onClick={startNew} disabled={running} title="新对话">
          <NotePencil size={14} weight="bold" />
        </button>
        <button className="ghost-btn" onClick={onClose} title="收起">
          <X size={14} weight="bold" />
        </button>
      </div>

      {missing && !historyOpen && (
        <div className="agent-missing">
          {noAgentInstalled ? (
            <>
              <h3>AI 助手还未启用</h3>
              <p>不用 AI 也可以正常写作：直接编辑 Markdown、查看公众号预览、复制正文，或配置微信后推送草稿。</p>
              <p className="agent-missing-help">如果想让 AI 帮你润色、写标题或检查文章，任选一个安装并登录即可：</p>
              <p className="agent-install-links">
                <a href="https://docs.anthropic.com/en/docs/claude-code/overview" target="_blank" rel="noopener noreferrer">安装 Claude Code</a>
                <a href="https://developers.openai.com/codex/cli" target="_blank" rel="noopener noreferrer">安装 Codex CLI</a>
              </p>
            </>
          ) : (
            <>
              <p>
                AI 使用你本机已经登录的 <code>{kind}</code>，VinsEditor 不需要再填 API Key。
                请先按官方文档安装并登录，再回到这里；如果已安装但没被找到，运行 <code>which {kind}</code>，把路径填这儿：
              </p>
              <p className="agent-missing-help">任选一个即可：Claude Code 适合日常写作，Codex 也可以直接处理当前草稿。</p>
            </>
          )}
          <div className="agent-bin-row">
            <input
              type="text"
              value={binDraft}
              placeholder={`/usr/local/bin/${kind}`}
              onChange={(e) => setBinDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveBin()}
            />
            <button type="button" onClick={saveBin}>
              记住
            </button>
          </div>
        </div>
      )}

      {historyOpen ? (
        <div className="agent-history scroll-thin">
          {history.length === 0 && <p className="agent-history-empty">还没有聊过什么</p>}
          {history.map((s) => (
            <div
              key={s.key}
              className={`agent-history-row ${s.key === activeKey[s.kind] ? 'active' : ''}`}
            >
              <button type="button" className="agent-history-open" onClick={() => openSession(s)}>
                <span className={`agent-badge ${s.kind}`}>{s.kind}</span>
                <span className="agent-history-title">{s.title || '（没说什么）'}</span>
                <span className="agent-history-when">{whenText(s.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="agent-history-drop"
                title="删掉这段记录"
                onClick={() => dropSession(s.key)}
              >
                <Trash size={12} weight="bold" />
              </button>
            </div>
          ))}
          <p className="agent-history-note">
            只收录从这个面板发起的对话。终端里开的那些在 <code>{kind}</code> 自己那儿。
          </p>
        </div>
      ) : (
        <div className="agent-log scroll-thin" ref={logRef}>
          {lines.length === 0 && !missing && probing && (
            <div className="agent-waking" aria-live="polite">
              <span className="agent-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              正在找本机的 claude / codex
            </div>
          )}
          {lines.length === 0 && !missing && !probing && (
            <div className="agent-empty" aria-hidden="true">
              <Terminal size={44} weight="duotone" />
            </div>
          )}
          {lines.map((l, i) =>
            l.role === 'tool' ? (
              <ToolBeat key={i} beat={l} />
            ) : (
              <div key={i} className={`agent-beat ${l.role}${l.bad ? ' bad' : ''}`}>
                {l.role === 'agent' ? <AgentMarkdown text={l.text} /> : l.text}
              </div>
            ),
          )}
          {running && (
            <div className="agent-beat working" aria-live="polite">
              <span className="dot" aria-hidden="true" />
            </div>
          )}
        </div>
      )}

      {!historyOpen && (
        <div className="agent-composer">
          {activeId && (
            <div className="agent-context" title={`这轮会告诉它你正在看「${activeId}」`}>
              <Paperclip size={11} weight="bold" />
              <span>{activeId}</span>
            </div>
          )}
          <div className="agent-quick-actions" aria-label="常用 AI 操作">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.label}
                type="button"
                className="agent-quick-action"
                onClick={() => useQuickAction(action.prompt)}
                disabled={missing || probing || running}
              >
                {action.label}
              </button>
            ))}
          </div>
          <textarea
            ref={inputRef}
            value={input}
            rows={3}
            placeholder={probing ? '正在找本机的 claude / codex…' : continuing ? '接着说…' : `让 ${kind} 做点什么`}
            disabled={missing || probing}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              // WebKit fires compositionend *before* the keydown of the Enter
              // that committed the candidate, so clearing the flag on the next
              // tick is what keeps that Enter from being read as "send".
              setTimeout(() => {
                composing.current = false;
              }, 0);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              send();
            }}
          />
          <div className="agent-composer-foot">
            <TuneMenu
              title="用哪个模型"
              wide
              inherited={!model}
              chip={model || configModel || '默认模型'}
              value={model}
              items={[
                {
                  id: '',
                  label: '默认',
                  note: configModel ? `${kind} 现在配的是 ${configModel}` : `跟着 ${kind} 自己的配置走`,
                },
                ...models.map((m) => ({ id: m.id, label: m.label, note: m.id })),
              ]}
              onPick={(id) => {
                setModel(id);
                setConfig(modelKey(kind), id);
              }}
            />
            <TuneMenu
              title="思考程度"
              chip={effort || '思考'}
              value={effort}
              items={[
                { id: '', label: '默认', note: `跟着 ${kind} 自己的配置走` },
                ...EFFORTS[kind].map((e) => ({ id: e, label: e })),
              ]}
              onPick={(id) => {
                setEffort(id);
                setConfig(effortKey(kind), id);
              }}
            />
            <span className="agent-foot-gap" />
            {running ? (
              <button
                type="button"
                className="agent-send stop"
                onClick={stop}
                title="停下"
                aria-label="停下"
              >
                <Stop size={14} weight="fill" />
              </button>
            ) : (
              <button
                type="button"
                className="agent-send"
                onClick={send}
                disabled={!input.trim() || missing || probing}
                title="发送（Enter，Shift + Enter 换行）"
                aria-label="发送"
              >
                <ArrowUp size={14} weight="bold" />
              </button>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
