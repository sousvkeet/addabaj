import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Check, FileText, LoaderCircle, Mic, Paperclip, Pencil, Reply, SendHorizontal, Trash2, X } from 'lucide-react';
import { attachmentLabel, duration, formatBytes } from '../lib/format';
import { canRecordVoice, VoiceRecorder } from '../lib/recorder';
import type { Draft, Mention, PreparedFile, ReplyRef } from '../lib/types';
import { prepareFile } from '../lib/upload';
import { errorMessage } from '../lib/api';
import { toast } from '../store/ui';
import { Avatar } from './ui/Avatar';
import { IconButton } from './ui/Button';

/** Someone who can be mentioned ("@Rahul Das"): in rooms, the other members. */
export type Mentionable = { id: string; name: string; hue: number; photo?: string | null; handle?: string | null };

/** One of my messages being edited: what it says now (and, in rooms, who it names). */
export type EditTarget = { id: number; body: string; mentions?: Mention[] | null; hasFile?: boolean };

type Props = {
  placeholder: string;
  onSend: (draft: Draft) => void;
  onTyping: (typing: boolean) => void;
  replyTo: ReplyRef | null;
  onCancelReply: () => void;
  /** Typing "@" offers these people (rooms). */
  mentionable?: Mentionable[];
  /** Editing a message of mine: its text is in the box until it's saved (resolves true) or cancelled. */
  editing?: EditTarget | null;
  onSaveEdit?: (target: EditTarget, body: string, mentions: Mention[]) => Promise<boolean>;
  onCancelEdit?: () => void;
};

/** A letter or digit right before "@" means it's part of a word (an email address), not a mention. */
const WORDY = /[\p{L}\p{N}_.]/u;

/** The "@…" being typed at the caret: where it starts and what follows it. */
function mentionAt(value: string, caret: number) {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && WORDY.test(before[at - 1]))) return null;
  const typed = before.slice(at + 1);
  if (typed.length > 40 || /\n|\s{2}/.test(typed)) return null;
  return { start: at, typed };
}

/** Who matches what's been typed after "@": the start of their name, of any word in it, or of their user ID. */
function suggestions(people: Mentionable[], typed: string) {
  const q = typed.toLowerCase();
  const rank = (p: Mentionable) => {
    const name = p.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (p.handle?.toLowerCase().startsWith(q)) return 2;
    return -1;
  };
  return people
    .map((p) => ({ p, r: rank(p) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.p.name.localeCompare(b.p.name))
    .slice(0, 6)
    .map((x) => x.p);
}

/**
 * The mentions in a message about to be sent: "@" and someone's full name
 * (longest names first, so "@Rahul Das" isn't taken for "@Rahul"). Two people
 * with the same name: the one picked from the list.
 */
function findMentions(body: string, people: Mentionable[], picked: Map<string, string>): Mention[] {
  const byLength = [...people].sort((a, b) => b.name.length - a.name.length);
  const out: Mention[] = [];
  let i = body.indexOf('@');
  while (i >= 0) {
    let next = i + 1;
    if (i === 0 || !WORDY.test(body[i - 1])) {
      const rest = body.slice(i + 1).toLowerCase();
      const hit = byLength.find((p) => rest.startsWith(p.name.toLowerCase()) && !WORDY.test(rest[p.name.length] ?? ''));
      if (hit) {
        const key = hit.name.toLowerCase();
        const same = byLength.filter((p) => p.name.toLowerCase() === key);
        const person = same.length > 1 ? same.find((p) => picked.get(key) === p.id) : hit;
        if (person && !out.some((m) => m.id === person.id)) out.push({ id: person.id, offset: i, length: hit.name.length + 1 });
        next = i + 1 + hit.name.length;
      }
    }
    i = body.indexOf('@', next);
  }
  return out;
}

export type ComposerHandle = {
  /** Adds picked, pasted or dropped files to the tray. */
  addFiles: (files: FileList | File[]) => void;
  focus: () => void;
};

const MAX_LENGTH = 4000;
const MAX_FILES = 10;

type TrayItem = { key: number; name: string; file?: PreparedFile };
let trayKey = 0;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { placeholder, onSend, onTyping, replyTo, onCancelReply, mentionable, editing, onSaveEdit, onCancelEdit },
  handle,
) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  // Mentions: the "@…" at the caret, the highlighted suggestion, and who was picked (by name).
  const [mention, setMention] = useState<{ start: number; typed: string } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const picked = useRef(new Map<string, string>());
  /** Where the caret goes once the text with a picked mention is in place. */
  const caretAfter = useRef<number | null>(null);
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [recording, setRecording] = useState<{ seconds: number; levels: number[] } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  const typing = useRef(false);
  const timer = useRef<number>(0);
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;
  const trayRef = useRef(tray);
  trayRef.current = tray;

  const stopTyping = () => {
    window.clearTimeout(timer.current);
    if (typing.current) {
      typing.current = false;
      onTypingRef.current(false);
    }
  };

  // Leaving the chat: stop typing, drop an unfinished recording and free previews.
  useEffect(
    () => () => {
      stopTyping();
      recorder.current?.cancel();
      for (const t of trayRef.current) if (t.file?.previewUrl) URL.revokeObjectURL(t.file.previewUrl);
    },
    [],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  // Right as the new text is in (before the next key), so typing carries on after the name.
  useLayoutEffect(() => {
    const at = caretAfter.current;
    if (at === null) return;
    caretAfter.current = null;
    ref.current?.setSelectionRange(at, at);
  }, [text]);

  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);

  // Editing starts: the message's text in the box (what was being written
  // waits aside); it ends: back to what was being written. Both in the same
  // render as the change, so the box never shows one with the other's label.
  const editingId = editing?.id ?? null;
  const [shownEdit, setShownEdit] = useState<number | null>(null);
  const [unsent, setUnsent] = useState<string | null>(null);
  if (editingId !== shownEdit) {
    setShownEdit(editingId);
    if (editing) {
      if (unsent === null) setUnsent(text);
      setText(editing.body);
      setMention(null);
    } else if (unsent !== null) {
      setText(unsent);
      setUnsent(null);
    }
  }
  // Then who it names (for two people with the same name), and the caret at its end.
  useEffect(() => {
    if (!editing) return;
    picked.current.clear();
    for (const m of editing.mentions ?? []) picked.current.set(editing.body.slice(m.offset + 1, m.offset + m.length).toLowerCase(), m.id);
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(editing.body.length, editing.body.length);
    // Only when a different message starts being edited.
  }, [editingId]);

  function addFiles(list: FileList | File[]) {
    const files = [...list].slice(0, Math.max(0, MAX_FILES - trayRef.current.length));
    if (list.length > files.length) toast(`You can send up to ${MAX_FILES} files at once.`);
    for (const f of files) {
      const key = ++trayKey;
      setTray((t) => [...t, { key, name: f.name }]);
      prepareFile(f)
        .then((file) => {
          // Removed while it was being prepared.
          if (!trayRef.current.some((t) => t.key === key)) return file.previewUrl && URL.revokeObjectURL(file.previewUrl);
          setTray((t) => t.map((x) => (x.key === key ? { ...x, file } : x)));
        })
        .catch((err) => {
          setTray((t) => t.filter((x) => x.key !== key));
          toast(errorMessage(err), 'error');
        });
    }
    ref.current?.focus();
  }

  useImperativeHandle(handle, () => ({ addFiles, focus: () => ref.current?.focus() }));

  function removeFromTray(key: number) {
    const item = tray.find((t) => t.key === key);
    if (item?.file?.previewUrl) URL.revokeObjectURL(item.file.previewUrl);
    setTray((t) => t.filter((x) => x.key !== key));
  }

  /** Looks again for an "@…" at the caret (after typing, or moving the caret). */
  function findMention() {
    const el = ref.current;
    if (!el || !mentionable?.length) return;
    const found = el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null;
    setMention((cur) => (found?.start === cur?.start && found?.typed === cur?.typed ? cur : found));
    if (found?.start !== mention?.start) setHighlighted(0);
  }

  const offered = mention && mentionable?.length ? suggestions(mentionable, mention.typed) : [];

  /** Puts "@Their Name " in place of the "@…" being typed. */
  function pick(person: Mentionable) {
    const el = ref.current;
    if (!el || !mention) return;
    const end = mention.start + 1 + mention.typed.length;
    const insert = `@${person.name} `;
    const value = (el.value.slice(0, mention.start) + insert + el.value.slice(end)).slice(0, MAX_LENGTH);
    picked.current.set(person.name.toLowerCase(), person.id);
    caretAfter.current = mention.start + insert.length;
    setText(value);
    setMention(null);
    el.focus();
  }

  function change(value: string) {
    setText(value.slice(0, MAX_LENGTH));
    // Editing isn't typing a new message.
    if (!value.trim() || editing) return stopTyping();
    if (!typing.current) {
      typing.current = true;
      onTyping(true);
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(stopTyping, 2500);
  }

  const preparing = tray.some((t) => !t.file);
  const canSend = editing ? !saving && (!!text.trim() || !!editing.hasFile) : !preparing && (!!text.trim() || tray.length > 0);

  async function saveEdit() {
    if (!editing || !canSend) return;
    const body = text.trim();
    const mentions = mentionable?.length ? findMentions(body, mentionable, picked.current) : [];
    // Nothing changed: nothing to save.
    if (body === editing.body.trim()) return onCancelEdit?.();
    setSaving(true);
    const ok = await (onSaveEdit?.(editing, body, mentions) ?? Promise.resolve(false));
    setSaving(false);
    if (ok) onCancelEdit?.();
  }

  function send() {
    if (editing) return void saveEdit();
    if (!canSend) return;
    const body = text.trim();
    const files = tray.map((t) => t.file!);
    const mentions = mentionable?.length ? findMentions(body, mentionable, picked.current) : [];
    const named = mentions.length ? { mentions } : {};
    if (!files.length) onSend({ body, replyTo, ...named });
    else {
      // The text, its mentions and the reply go with the first file; the rest follow as their own messages.
      files.forEach((file, i) => onSend(i === 0 ? { body, file, replyTo, ...named } : { body: '', file }));
    }
    picked.current.clear();
    setMention(null);
    setText('');
    setTray([]);
    onCancelReply();
    stopTyping();
    ref.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Choosing someone to mention.
    if (offered.length && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHighlighted((h) => (h + step + offered.length) % offered.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(offered[Math.min(highlighted, offered.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape' && editing) onCancelEdit?.();
    else if (e.key === 'Escape' && replyTo) onCancelReply();
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files];
    if (!files.length || editing) return;
    e.preventDefault();
    addFiles(files);
  }

  // ── Voice messages ──

  async function startRecording() {
    const rec = new VoiceRecorder();
    recorder.current = rec;
    rec.onLevel = (level) =>
      setRecording((r) => (r && recorder.current === rec ? { seconds: rec.seconds(), levels: [...r.levels, level].slice(-40) } : r));
    rec.onLimit = () => {
      toast('Voice messages can be up to 5 minutes, so this one was sent.');
      void finishRecording();
    };
    setRecording({ seconds: 0, levels: [] });
    try {
      await rec.start();
      // Discarded (or the chat closed) while the browser was asking for the microphone.
      if (recorder.current !== rec) rec.cancel();
    } catch (err) {
      if (recorder.current !== rec) return;
      recorder.current = null;
      setRecording(null);
      toast(errorMessage(err), 'error');
    }
  }

  function cancelRecording() {
    recorder.current?.cancel();
    recorder.current = null;
    setRecording(null);
  }

  async function finishRecording() {
    const rec = recorder.current;
    if (!rec) return;
    recorder.current = null;
    setRecording(null);
    if (rec.seconds() < 0.7) {
      rec.cancel();
      toast('Hold on a little longer to record a voice message.');
      return;
    }
    try {
      const file = await rec.stop();
      onSend({ body: '', file, replyTo });
      onCancelReply();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const showMic = !editing && !text.trim() && tray.length === 0 && canRecordVoice();

  return (
    <div className="shrink-0 px-3 pt-2 pb-[max(12px,var(--safe-bottom))] md:px-6 md:pb-5">
      <div className="glass relative mx-auto max-w-[860px] rounded-[26px] border border-line/80 p-1.5 shadow-float transition-[border-color,box-shadow] focus-within:border-brand/60 focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_14%,transparent),var(--shadow)]">
        {offered.length > 0 && (
          <ul
            id="mention-list"
            role="listbox"
            aria-label="People to mention"
            className="pop-in absolute inset-x-0 bottom-full z-20 mb-2 max-h-[280px] overflow-y-auto rounded-[22px] border border-line/80 bg-surface p-1.5 shadow-float"
          >
            {offered.map((p, i) => (
              <li
                key={p.id}
                id={`mention-${p.id}`}
                role="option"
                aria-selected={i === highlighted}
                // Keep the typing where it is: no blur on tap.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
                onMouseEnter={() => setHighlighted(i)}
                className={`flex cursor-pointer items-center gap-3 rounded-2xl px-2.5 py-2 ${i === highlighted ? 'bg-subtle' : ''}`}
              >
                <Avatar name={p.name} hue={p.hue} photo={p.photo} size={32} />
                <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold">{p.name}</span>
                {p.handle && <span className="shrink-0 truncate text-[12.5px] text-ink-soft">{p.handle}</span>}
              </li>
            ))}
          </ul>
        )}

        {editing && (
          <div className="mb-1.5 flex items-center gap-2.5 rounded-[20px] bg-subtle/80 py-1.5 pr-1.5 pl-3">
            <Pencil size={16} className="shrink-0 text-brand dark:text-live" />
            <div className="min-w-0 flex-1 border-l-[3px] border-brand pl-2.5 dark:border-live">
              <p className="text-[12.5px] font-semibold">Editing message</p>
              <p className="truncate text-[13px] text-ink-soft">{editing.body || 'Caption'}</p>
            </div>
            <IconButton label="Cancel editing" size={32} onClick={() => onCancelEdit?.()}>
              <X size={17} />
            </IconButton>
          </div>
        )}

        {replyTo && !editing && (
          <div className="mb-1.5 flex items-center gap-2.5 rounded-[20px] bg-subtle/80 py-1.5 pr-1.5 pl-3">
            <Reply size={17} className="shrink-0 text-brand dark:text-live" />
            <div className="min-w-0 flex-1 border-l-[3px] border-brand pl-2.5 dark:border-live">
              <p className="text-[12.5px] font-semibold">Replying to {replyTo.senderName}</p>
              <p className="truncate text-[13px] text-ink-soft">{replyTo.body || (replyTo.attachment ? attachmentLabel(replyTo.attachment) : '')}</p>
            </div>
            <IconButton label="Cancel reply" size={32} onClick={onCancelReply}>
              <X size={17} />
            </IconButton>
          </div>
        )}

        {tray.length > 0 && (
          <ul className="mb-1.5 flex gap-2 overflow-x-auto px-1.5 pt-1.5 pb-1" aria-label="Files to send">
            {tray.map((t) => (
              <li key={t.key} className="relative shrink-0">
                <TrayThumb item={t} />
                <button
                  type="button"
                  onClick={() => removeFromTray(t.key)}
                  aria-label={`Remove ${t.name}`}
                  className="absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full bg-ink text-surface shadow"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {recording ? (
          <div className="flex items-center gap-1.5">
            <IconButton label="Discard voice message" size={44} onClick={cancelRecording} className="text-danger hover:bg-danger/10">
              <Trash2 size={19} />
            </IconButton>
            <div className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-[20px] bg-danger/8 px-4" aria-live="polite">
              <span className="rec-dot size-2.5 shrink-0 rounded-full bg-danger shadow-[0_0_10px_var(--danger)]" aria-hidden />
              <span className="shrink-0 text-[15px] font-semibold tabular-nums">{duration(recording.seconds)}</span>
              <span className="sr-only">Recording a voice message</span>
              <span className="flex h-6 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden" aria-hidden>
                {recording.levels.map((l, i) => (
                  <span key={i} className="w-[3px] shrink-0 rounded-full bg-aurora" style={{ height: `${Math.max(12, Math.min(100, l * 100))}%` }} />
                ))}
              </span>
            </div>
            <IconButton label="Send voice message" variant="primary" size={44} onClick={() => void finishRecording()}>
              <SendHorizontal size={19} />
            </IconButton>
          </div>
        ) : (
          <div className="flex items-end gap-1">
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            {!editing && (
              <IconButton label="Attach photos or files" size={44} onClick={() => picker.current?.click()} className="text-ink-soft hover:bg-subtle hover:text-brand dark:hover:text-live">
                <Paperclip size={20} />
              </IconButton>
            )}
            <textarea
              ref={ref}
              rows={1}
              value={text}
              onChange={(e) => change(e.target.value)}
              onKeyDown={onKeyDown}
              onSelect={findMention}
              onBlur={() => setMention(null)}
              onPaste={onPaste}
              role={mentionable?.length ? 'combobox' : undefined}
              aria-autocomplete={mentionable?.length ? 'list' : undefined}
              aria-expanded={mentionable?.length ? offered.length > 0 : undefined}
              aria-controls={offered.length ? 'mention-list' : undefined}
              aria-activedescendant={offered.length ? `mention-${offered[Math.min(highlighted, offered.length - 1)].id}` : undefined}
              placeholder={editing ? 'Edit your message' : tray.length ? 'Add a caption' : placeholder}
              aria-label={editing ? 'Edit message' : tray.length ? 'Caption' : placeholder}
              className={`max-h-[168px] min-h-[44px] min-w-0 flex-1 resize-none bg-transparent py-[10px] text-[15px] leading-[1.45] text-ink outline-none placeholder:text-ink-soft/80 ${editing ? 'px-3' : 'px-2'}`}
            />
            {showMic ? (
              <IconButton label="Record a voice message" variant="primary" size={44} onClick={() => void startRecording()}>
                <Mic size={19} />
              </IconButton>
            ) : editing ? (
              <IconButton label="Save changes" variant="primary" size={44} onClick={send} disabled={!canSend}>
                {saving ? <LoaderCircle size={19} className="animate-spin" /> : <Check size={20} strokeWidth={2.5} />}
              </IconButton>
            ) : (
              <IconButton label={preparing ? 'Getting files ready' : 'Send message'} variant="primary" size={44} onClick={send} disabled={!canSend}>
                {preparing ? <LoaderCircle size={19} className="animate-spin" /> : <SendHorizontal size={19} />}
              </IconButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function TrayThumb({ item }: { item: TrayItem }) {
  const f = item.file;
  const box = 'flex size-[72px] items-center justify-center overflow-hidden rounded-2xl border border-line bg-subtle';
  if (!f) {
    return (
      <div className={box} title={item.name}>
        <LoaderCircle size={20} className="animate-spin text-ink-soft" />
      </div>
    );
  }
  if (f.meta.kind === 'image' && f.previewUrl) {
    return <img src={f.previewUrl} alt={f.meta.name} className={`${box} object-cover`} />;
  }
  if (f.meta.kind === 'video' && f.previewUrl) {
    return (
      <div className={`${box} relative`}>
        <video src={f.previewUrl} muted playsInline preload="metadata" className="size-full object-cover" />
        <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[11px] font-semibold text-white">{duration(f.meta.duration ?? 0)}</span>
      </div>
    );
  }
  return (
    <div className={`${box} w-[150px] flex-col items-start justify-center gap-0.5 px-2.5`} title={f.meta.name}>
      <FileText size={18} className="text-ink-soft" />
      <span className="w-full truncate text-[12.5px] font-semibold">{f.meta.name}</span>
      <span className="text-[11.5px] text-ink-soft">{formatBytes(f.blob.size)}</span>
    </div>
  );
}
