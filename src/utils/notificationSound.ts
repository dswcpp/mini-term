import { convertFileSrc } from '@tauri-apps/api/core';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function playDefaultSound() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  const now = ctx.currentTime;

  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.frequency.value = 880;
  osc1.type = 'sine';
  gain1.gain.setValueAtTime(0.3, now);
  gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
  osc1.connect(gain1).connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.12);

  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.frequency.value = 660;
  osc2.type = 'sine';
  gain2.gain.setValueAtTime(0.3, now + 0.13);
  gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.28);
  osc2.connect(gain2).connect(ctx.destination);
  osc2.start(now + 0.13);
  osc2.stop(now + 0.28);
}

function playCustomSound(filePath: string) {
  const url = convertFileSrc(filePath);
  const audio = new Audio(url);
  audio.volume = 0.5;
  audio.addEventListener('ended', () => { audio.src = ''; }, { once: true });
  audio.play().catch(() => {});
}

export function playNotificationSound(soundPath?: string): void {
  try {
    if (soundPath) {
      playCustomSound(soundPath);
    } else {
      playDefaultSound();
    }
  } catch {
    // silent
  }
}
