// Runs in an offscreen document (see background.js's playCompletionSound)
// because MV3 service workers have no Audio()/Web Audio API of their own —
// this is the only context in the extension that can actually play a sound.
//
// This document exists solely to play one chime: background.js creates it
// fresh for each completion and closes it again shortly after, so playback
// happens immediately on script load rather than depending on a runtime
// message reaching an onMessage listener that might not be registered yet
// (a real race — sendMessage can look like it "succeeded" even if this
// document's listener never actually got it, since background.js has its
// own onMessage listener that would silently swallow the same message).
playChime();

function playChime() {
  const ctx = new AudioContext();
  // Extension pages are normally exempt from autoplay restrictions, but
  // resume() defensively in case a context ever starts "suspended".
  ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  // A short two-note "ding-dong" instead of one flat beep, so it reads as a
  // deliberate completion chime rather than an alert/error tone.
  const notes = [
    { freq: 880, start: 0, duration: 0.18 },
    { freq: 659.25, start: 0.16, duration: 0.3 },
  ];

  notes.forEach(({ freq, start, duration }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.3, now + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + start + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.05);
  });

  setTimeout(() => ctx.close(), 800);
}
