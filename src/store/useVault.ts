/**
 * State layer for the workspace.
 *
 * Reading and debounced writing would be the whole of it if we were the only
 * writer. We are not: files change without our knowing — an agent running in
 * the same vault, or the user opening the same piece in another editor — so
 * alongside those there is a reconciliation path.
 * And because a workspace is an ordinary folder, the user will create
 * directories, rename things and drag them around in the tree. Those actions
 * all leave from here too — the disk is the source of truth and we follow it.
 *
 * The three threads and what each owns:
 * - the dirty set remembers which drafts changed but have not hit disk, and a
 *   debounce flushes them together
 * - every draft carries the mtime it was last read at, which Rust compares on
 *   write-back
 * - an outside change re-pulls the directory tree and then reconciles entry by
 *   entry: an mtime matching memory means we wrote it ourselves, so ignore it;
 *   a mismatch with no unsaved local edits is followed silently; only edits on
 *   both sides escalate to a conflict
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SAMPLE_MARKDOWN } from '../sample';
import * as api from './vault';
import type { Draft, Entry, Prefs } from './vault';
import { flattenFiles, isImagePath, isTextPath } from './vault';

export type { Draft, Entry, Prefs } from './vault';

/** Used for a fresh vault, or when the prefs file fails to parse */
const DEFAULT_PREFS: Prefs = {
  themeId: 'classic',
  densityId: 'standard',
  linkFootnotes: false,
  activeId: null,
};

/** Debounce interval for writing a body to disk. Deliberately unhurried: this
 *  writes a real file, and an agent may be reading it in the same vault, so
 *  fewer intermediate states is worth the wait */

const SAVE_DELAY = 600;
/** Coalescing window for outside-change events. One save often notifies several times */
const WATCH_DEBOUNCE = 200;

/** Built-in samples from earlier releases. Only these exact first headings
 * are migrated; a user's own document is never replaced just because it has
 * a familiar name. */
const LEGACY_SAMPLE_HEADINGS = [
  '# 2026 年设计趋势观察',
  '# 周末做一顿番茄鸡蛋面',
];

function isLegacySample(draft: Draft) {
  return draft.name === '未命名草稿' && LEGACY_SAMPLE_HEADINGS.some((heading) => draft.content.startsWith(heading));
}

/** A draft edited on both sides. diskContent is kept so the user can compare
 *  it or take it wholesale */
export interface Conflict {
  id: string;
  diskContent: string;
  diskUpdatedAt: number;
}

export type VaultStatus = 'booting' | 'novault' | 'ready' | 'error';

export function useVault() {
  const [dir, setDir] = useState<string | null>(null);
  const [status, setStatus] = useState<VaultStatus>('booting');
  const [error, setError] = useState<string | null>(null);
  const [tree, setTree] = useState<Entry[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [conflicts, setConflicts] = useState<Record<string, Conflict>>({});

  /** flush and reconciliation both run inside async callbacks where the closure
   *  cannot see the latest state, so everything goes through refs */
  const draftsRef = useRef<Draft[]>([]);
  draftsRef.current = drafts;
  const imagesRef = useRef<Record<string, string>>({});
  imagesRef.current = images;
  const dirRef = useRef<string | null>(null);
  dirRef.current = dir;
  /** Ids (= relative paths) of drafts changed but not yet written */
  const dirtyRef = useRef<Set<string>>(new Set());
  const saveTimer = useRef<number | undefined>(undefined);

  /* ---------- Opening the vault ---------- */

  const openVault = useCallback(async (target: string) => {
    setStatus('booting');
    try {
      const data = await api.loadVault(target);
      // An empty directory (most likely just created in the picker) gets a
      // sample piece, so the first thing you see is not an empty list
      if (!data.drafts.length) {
        data.drafts = [await api.createDraft(target, '', '未命名草稿', SAMPLE_MARKDOWN)];
        data.tree = await api.readTree(target);
      } else {
        // Existing workspaces retain their files across upgrades. Refresh only
        // the sample shipped by an older version so the new example is visible
        // without asking users to delete or recreate their workspace.
        for (const draft of data.drafts) {
          if (!isLegacySample(draft)) continue;
          const result = await api.writeDraft(target, draft.id, SAMPLE_MARKDOWN, draft.updatedAt);
          if (result.status === 'ok') {
            draft.content = SAMPLE_MARKDOWN;
            draft.updatedAt = result.updatedAt;
          }
        }
      }
      await api.rememberVault(target);
      dirtyRef.current.clear();
      setConflicts({});
      setTree(data.tree);
      setDrafts(data.drafts);
      setImages(data.images);
      setPrefsState({ ...DEFAULT_PREFS, ...(data.prefs ?? {}) });
      setDir(target);
      setStatus('ready');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  /** Startup: continue with the last workspace, or wait for the user to pick one */
  useEffect(() => {
    void (async () => {
      const remembered = await api.recallVault().catch(() => null);
      if (remembered) await openVault(remembered);
      else setStatus('novault');
    })();
  }, [openVault]);

  /** Switch workspaces, or pick one for the first time */
  const chooseVault = useCallback(async () => {
    const picked = await api.pickVault();
    if (picked) await openVault(picked);
  }, [openVault]);

  /* ---------- Writing to disk ---------- */

  const flush = useCallback(async () => {
    const target = dirRef.current;
    if (!target) return;
    for (const id of [...dirtyRef.current]) {
      const draft = draftsRef.current.find((d) => d.id === id);
      if (!draft) {
        dirtyRef.current.delete(id);
        continue;
      }
      try {
        const res = await api.writeDraft(target, id, draft.content, draft.updatedAt);
        if (res.status === 'ok') {
          dirtyRef.current.delete(id);
          // Only the mtime is updated. The body is deliberately not written
          // back — the user has very likely typed more during this IPC round trip
          setDrafts((prev) =>
            prev.map((d) => (d.id === id ? { ...d, updatedAt: res.updatedAt } : d)),
          );
        } else {
          // Stay dirty: after the user picks "keep mine", it has to be written again
          setConflicts((prev) => ({
            ...prev,
            [id]: { id, diskContent: res.diskContent, diskUpdatedAt: res.diskUpdatedAt },
          }));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), SAVE_DELAY);
  }, [flush]);

  /** Flush anything outstanding before the window closes */
  useEffect(() => {
    const onLeave = () => void flush();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [flush]);

  /* ---------- Directory tree ---------- */

  const refreshTree = useCallback(async () => {
    const target = dirRef.current;
    if (!target) return null;
    try {
      const next = await api.readTree(target);
      setTree(next);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  /* ---------- Drafts ---------- */

  const setDraftContent = useCallback(
    (id: string, content: string) => {
      setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, content } : d)));
      dirtyRef.current.add(id);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  /** Create one under `parent` (omit for the root) */
  const newDraft = useCallback(
    async (name: string, content = '', parent = ''): Promise<Draft | null> => {
      const target = dirRef.current;
      if (!target) return null;
      const created = await api.createDraft(target, parent, name, content);
      setDrafts((prev) => [created, ...prev]);
      await refreshTree();
      return created;
    },
    [refreshTree],
  );

  const newFolder = useCallback(
    async (name: string, parent = ''): Promise<string | null> => {
      const target = dirRef.current;
      if (!target) return null;
      const path = await api.createDir(target, parent, name);
      await refreshTree();
      return path;
    },
    [refreshTree],
  );

  /**
   * Re-map memory after a path change: draft ids, image keys, the dirty set and
   * conflict records all move with it.
   *
   * Both rename and move can shift an entire subtree (rename a folder and every
   * id below it changes), so this re-keys by prefix rather than matching the one
   * path that was named.
   */
  const remapPaths = useCallback((from: string, to: string) => {
    const remap = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    setDrafts((prev) => prev.map((d) => (remap(d.id) === d.id ? d : { ...d, id: remap(d.id) })));
    setImages((prev) => Object.fromEntries(Object.entries(prev).map(([p, url]) => [remap(p), url])));
    dirtyRef.current = new Set([...dirtyRef.current].map(remap));
    setConflicts((prev) =>
      Object.fromEntries(Object.entries(prev).map(([p, c]) => [remap(p), { ...c, id: remap(p) }])),
    );
  }, []);

  /** Rename (files and folders alike). Returns the new relative path */
  const renameEntry = useCallback(
    async (path: string, name: string): Promise<string | null> => {
      const target = dirRef.current;
      if (!target) return null;
      // A rename changes the file name, so flush pending edits first — otherwise
      // the write-back goes looking for a file that no longer exists
      await flush();
      const next = await api.renameEntry(target, path, name);
      remapPaths(path, next);
      // The display name follows the file name
      setDrafts((prev) =>
        prev.map((d) => (d.id === next ? { ...d, name: next.split('/').pop()?.replace(/\.[^.]+$/, '') ?? d.name } : d)),
      );
      await refreshTree();
      return next;
    },
    [flush, refreshTree, remapPaths],
  );

  /** Move into another directory (dragged in the tree). Returns the new path */
  const moveEntry = useCallback(
    async (path: string, toParent: string): Promise<string | null> => {
      const target = dirRef.current;
      if (!target) return null;
      await flush();
      const next = await api.moveEntry(target, path, toParent);
      remapPaths(path, next);
      await refreshTree();
      return next;
    },
    [flush, refreshTree, remapPaths],
  );

  /** Delete a file or folder (folders take their contents). Confirmation is the
   *  caller's job */
  const removeEntry = useCallback(
    async (path: string) => {
      const target = dirRef.current;
      if (!target) return;
      await api.deleteEntry(target, path);
      const inside = (p: string) => p === path || p.startsWith(`${path}/`);
      dirtyRef.current = new Set([...dirtyRef.current].filter((p) => !inside(p)));
      setDrafts((prev) => prev.filter((d) => !inside(d.id)));
      setImages((prev) => Object.fromEntries(Object.entries(prev).filter(([p]) => !inside(p))));
      setConflicts((prev) => Object.fromEntries(Object.entries(prev).filter(([p]) => !inside(p))));
      await refreshTree();
    },
    [refreshTree],
  );

  const revealEntry = useCallback(async (path: string) => {
    const target = dirRef.current;
    if (target) await api.revealEntry(target, path);
  }, []);

  /* ---------- Images ---------- */

  /** Store a new image (under images/), returning its workspace-relative path */
  const addImage = useCallback(
    async (name: string, dataUrl: string): Promise<string | null> => {
      const target = dirRef.current;
      if (!target) return null;
      const path = await api.writeImage(target, name, dataUrl);
      setImages((prev) => ({ ...prev, [path]: dataUrl }));
      await refreshTree();
      return path;
    },
    [refreshTree],
  );

  /* ---------- Prefs ---------- */

  const prefsTimer = useRef<number | undefined>(undefined);
  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      const target = dirRef.current;
      if (target) {
        window.clearTimeout(prefsTimer.current);
        prefsTimer.current = window.setTimeout(() => {
          void api.writePrefs(target, next).catch(() => undefined);
        }, 300);
      }
      return next;
    });
  }, []);

  /* ---------- Reconciliation ---------- */

  /**
   * Handle a batch of outside changes.
   *
   * Re-pull the directory tree first — a folder renamed wholesale, or an agent
   * creating a batch of files, cannot be reconstructed from the event paths
   * alone, and taking the tree as authoritative is far simpler. Then: text files
   * new to the tree are read in, ones missing from it are dropped from memory,
   * and the rest are reconciled by mtime.
   *
   * The order in that last step matters: compare mtimes first to filter out the
   * write we just made ourselves — every save of ours fires a watch event, and
   * without that filter we would be fighting our own writes.
   */
  const reconcile = useCallback(
    async (changed: string[]) => {
      const target = dirRef.current;
      if (!target) return;
      const next = await refreshTree();
      if (!next) return;

      const onDisk = new Map(flattenFiles(next).map((e) => [e.path, e]));
      const touched = new Set(changed);

      /* Drafts */
      for (const draft of draftsRef.current) {
        if (!onDisk.has(draft.id)) {
          // Gone from the tree = deleted, or moved outside the workspace
          dirtyRef.current.delete(draft.id);
          setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
          setConflicts((prev) => {
            const rest = { ...prev };
            delete rest[draft.id];
            return rest;
          });
        }
      }
      for (const [path, entry] of onDisk) {
        if (!isTextPath(path)) continue;
        const mine = draftsRef.current.find((d) => d.id === path);
        if (!mine) {
          // Created outside (an agent started a new piece, or the user dropped
          // an md into the directory)
          try {
            const disk = await api.readDraft(target, path);
            setDrafts((prev) => (prev.some((d) => d.id === path) ? prev : [disk, ...prev]));
          } catch {
            // Created and removed again in the same window; skip
          }
          continue;
        }
        // The write we just made: ignore. Anything this batch did not touch
        // does not need re-reading either
        if (!touched.has(path) || Math.abs(entry.updatedAt - mine.updatedAt) <= 1) continue;
        let disk: Draft;
        try {
          disk = await api.readDraft(target, path);
        } catch {
          continue;
        }
        if (dirtyRef.current.has(path)) {
          setConflicts((prev) => ({
            ...prev,
            [path]: { id: path, diskContent: disk.content, diskUpdatedAt: disk.updatedAt },
          }));
        } else {
          // No unsaved local edits — follow along silently, so what the user
          // sees is simply the agent's edit
          setDrafts((prev) => prev.map((d) => (d.id === path ? disk : d)));
        }
      }

      /* Images */
      for (const path of Object.keys(imagesRef.current)) {
        if (!onDisk.has(path)) {
          setImages((prev) => {
            const rest = { ...prev };
            delete rest[path];
            return rest;
          });
        }
      }
      for (const [path] of onDisk) {
        if (!isImagePath(path)) continue;
        // Do not re-read what has not changed: re-encoding an image as a data
        // URI is not cheap
        if (imagesRef.current[path] && !touched.has(path)) continue;
        try {
          const dataUrl = await api.readImage(target, path);
          setImages((prev) => ({ ...prev, [path]: dataUrl }));
        } catch {
          // Landed and gone again in the same window; skip
        }
      }
    },
    [refreshTree],
  );

  useEffect(() => {
    if (!dir) return;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    let disposed = false;
    const pending = new Set<string>();

    void api
      .watchVault(dir, (paths) => {
        paths.forEach((p) => pending.add(p));
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const batch = [...pending];
          pending.clear();
          void reconcile(batch);
        }, WATCH_DEBOUNCE);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      // Not fatal — every edit still saves, and the tree still refreshes when
      // you act on it. What stops is only "someone else changed this file and
      // you saw it happen", which is exactly the kind of thing that must not
      // fail in silence: on Linux the usual cause is the inotify quota, and the
      // message from the other side says how to lift it.
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

    return () => {
      disposed = true;
      unlisten?.();
      window.clearTimeout(timer);
    };
  }, [dir, reconcile]);

  /* ---------- The two ways out of a conflict ---------- */

  /** Take the disk version, discarding the local edits made in the meantime */
  const takeDisk = useCallback((id: string) => {
    setConflicts((prev) => {
      const c = prev[id];
      if (c) {
        dirtyRef.current.delete(id);
        setDrafts((ds) =>
          ds.map((d) =>
            d.id === id ? { ...d, content: c.diskContent, updatedAt: c.diskUpdatedAt } : d,
          ),
        );
      }
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  /** Keep the local version: swap the baseline for the disk mtime, so the next
   *  flush can write it through */
  const keepMine = useCallback(
    (id: string) => {
      setConflicts((prev) => {
        const c = prev[id];
        if (c) {
          setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, updatedAt: c.diskUpdatedAt } : d)));
          dirtyRef.current.add(id);
          scheduleFlush();
        }
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [scheduleFlush],
  );

  return {
    dir,
    status,
    error,
    tree,
    drafts,
    images,
    prefs,
    conflicts,
    chooseVault,
    setDraftContent,
    newDraft,
    newFolder,
    renameEntry,
    moveEntry,
    removeEntry,
    revealEntry,
    addImage,
    setPrefs,
    takeDisk,
    keepMine,
    flush,
  };
}
