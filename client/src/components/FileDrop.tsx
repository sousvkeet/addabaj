import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ImagePlus } from 'lucide-react';

const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');

/** Drag photos or files from the computer onto a chat to send them. */
export function FileDrop({ onFiles, className = '', children }: { onFiles: (files: FileList) => void; className?: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child, so count them.
  const depth = useRef(0);

  return (
    <div
      className={`relative ${className}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        if (--depth.current > 0) return;
        depth.current = 0;
        setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand bg-surface/92 text-center dark:border-live">
          <ImagePlus size={34} className="text-brand dark:text-live" />
          <p className="font-display text-[20px]">Drop to send</p>
          <p className="text-[13.5px] text-ink-soft">Photos, videos and files</p>
        </div>
      )}
    </div>
  );
}
