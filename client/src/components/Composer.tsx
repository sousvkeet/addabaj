import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import { IconButton } from './ui/Button';

type Props = {
  placeholder: string;
  onSend: (body: string) => void;
  onTyping: (typing: boolean) => void;
};

const MAX_LENGTH = 4000;

export function Composer({ placeholder, onSend, onTyping }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const typing = useRef(false);
  const timer = useRef<number>(0);
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;

  const stopTyping = () => {
    window.clearTimeout(timer.current);
    if (typing.current) {
      typing.current = false;
      onTypingRef.current(false);
    }
  };

  useEffect(() => stopTyping, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

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

  function send() {
    const body = text.trim();
    if (!body) return;
    onSend(body);
    setText('');
    stopTyping();
    ref.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="shrink-0 border-t border-line bg-paper px-3 pt-2.5 pb-[max(10px,env(safe-area-inset-bottom))] md:px-6">
      <div className="mx-auto flex max-w-[860px] items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          className="max-h-[168px] min-h-[44px] flex-1 resize-none rounded-[22px] border border-transparent bg-wall px-4 py-[10px] text-[15px] leading-[1.45] text-ink outline-none placeholder:text-ink-soft/80 focus:border-line"
        />
        <IconButton label="Send message" variant="primary" size={44} onClick={send} disabled={!text.trim()}>
          <SendHorizontal size={19} />
        </IconButton>
      </div>
    </div>
  );
}
