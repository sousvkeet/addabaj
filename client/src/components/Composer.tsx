import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { FileText, LoaderCircle, Mic, Paperclip, Reply, SendHorizontal, Trash2, X } from 'lucide-react';
import { attachmentLabel, duration, formatBytes } from '../lib/format';
import { canRecordVoice, VoiceRecorder } from '../lib/recorder';
import type { Draft, PreparedFile, ReplyRef } from '../lib/types';
import { prepareFile } from '../lib/upload';
import { errorMessage } from '../lib/api';
import { toast } from '../store/ui';
import { IconButton } from './ui/Button';

type Props = {
  placeholder: string;
  onSend: (draft: Draft) => void;
  onTyping: (typing: boolean) => void;
  replyTo: ReplyRef | null;
  onCancelReply: () => void;
};

export type ComposerHandle = {
  /** Adds picked, pasted or dropped files to the tray. */
  addFiles: (files: FileList | File[]) => void;
  focus: () => void;
};

const MAX_LENGTH = 4000;
const MAX_FILES = 10;

type TrayItem = { key: number; name: string; file?: PreparedFile };
let trayKey = 0;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ placeholder, onSend, onTyping, replyTo, onCancelReply }, handle) {
  const [text, setText] = useState('');
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

  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);

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

  function change(value: string) {
    setText(value.slice(0, MAX_LENGTH));
    if (!value.trim()) return stopTyping();
    if (!typing.current) {
      typing.current = true;
      onTyping(true);
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(stopTyping, 2500);
  }

  const preparing = tray.some((t) => !t.file);
  const canSend = !preparing && (!!text.trim() || tray.length > 0);

  function send() {
    if (!canSend) return;
    const body = text.trim();
    const files = tray.map((t) => t.file!);
    if (!files.length) onSend({ body, replyTo });
    else {
      // The text and the reply go with the first file; the rest follow as their own messages.
      files.forEach((file, i) => onSend(i === 0 ? { body, file, replyTo } : { body: '', file }));
    }
    setText('');
    setTray([]);
    onCancelReply();
    stopTyping();
    ref.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape' && replyTo) onCancelReply();
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
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

  const showMic = !text.trim() && tray.length === 0 && canRecordVoice();

  return (
    <div className="shrink-0 px-3 pt-2 pb-[max(12px,var(--safe-bottom))] md:px-6 md:pb-5">
      <div className="glass mx-auto max-w-[860px] rounded-[26px] border border-line/80 p-1.5 shadow-float transition-[border-color,box-shadow] focus-within:border-brand/60 focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_14%,transparent),var(--shadow)]">
        {replyTo && (
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
            <IconButton label="Attach photos or files" size={44} onClick={() => picker.current?.click()} className="text-ink-soft hover:bg-subtle hover:text-brand dark:hover:text-live">
              <Paperclip size={20} />
            </IconButton>
            <textarea
              ref={ref}
              rows={1}
              value={text}
              onChange={(e) => change(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={tray.length ? 'Add a caption' : placeholder}
              aria-label={tray.length ? 'Caption' : placeholder}
              className="max-h-[168px] min-h-[44px] min-w-0 flex-1 resize-none bg-transparent px-2 py-[10px] text-[15px] leading-[1.45] text-ink outline-none placeholder:text-ink-soft/80"
            />
            {showMic ? (
              <IconButton label="Record a voice message" variant="primary" size={44} onClick={() => void startRecording()}>
                <Mic size={19} />
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
