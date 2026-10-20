// Ring and ringback tones synthesised with WebAudio, so no audio files ship.
let ctx: AudioContext | null = null;
let stopCurrent: (() => void) | null = null;

/**
 * Call synchronously inside a click handler (before any await): browsers only
 * let a page start audio in direct response to the user.
 */
export function unlockAudio() {
  try {
    audioContext();
  } catch {
    /* audio unavailable */
  }
}

export function audioContext() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

function beep(c: AudioContext, freqs: number[], start: number, length: number, gain = 0.06) {
  const g = c.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.02);
  g.gain.setValueAtTime(gain, start + length - 0.05);
  g.gain.linearRampToValueAtTime(0, start + length);
  g.connect(c.destination);
  for (const f of freqs) {
    const o = c.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start(start);
    o.stop(start + length);
  }
}

/** 'incoming' = bright double chirp; 'ringback' = the tone the caller hears. */
export function startTone(kind: 'incoming' | 'ringback') {
  stopTone();
  let c: AudioContext;
  try {
    c = audioContext();
  } catch {
    return;
  }
  const play = () => {
    const t = c.currentTime + 0.05;
    if (kind === 'incoming') {
      beep(c, [880, 1320], t, 0.18, 0.05);
      beep(c, [880, 1320], t + 0.28, 0.18, 0.05);
    } else {
      beep(c, [440, 480], t, 1.6, 0.04);
    }
  };
  play();
  const id = window.setInterval(play, kind === 'incoming' ? 1800 : 3500);
  stopCurrent = () => window.clearInterval(id);
}

export function stopTone() {
  stopCurrent?.();
  stopCurrent = null;
}

export function blip(kind: 'join' | 'leave') {
  try {
    const c = audioContext();
    const t = c.currentTime + 0.02;
    beep(c, [kind === 'join' ? 660 : 520], t, 0.09, 0.04);
    beep(c, [kind === 'join' ? 880 : 390], t + 0.1, 0.12, 0.04);
  } catch {
    /* audio unavailable */
  }
}
