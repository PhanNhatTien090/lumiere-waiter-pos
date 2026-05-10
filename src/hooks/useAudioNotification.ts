/**
 * useAudioNotification — Expo Audio hook for waiter POS staff alerts.
 *
 * Uses expo-av (if installed) to play notification sounds.
 * Falls back to a silent no-op when expo-av is not available,
 * so the hook never crashes on web or misconfigured builds.
 *
 * Usage:
 *   const { playNewOrder, playPaymentSuccess, playAlert } = useAudioNotification();
 *   // Call playNewOrder() when a new QR order arrives.
 *   // Call playPaymentSuccess() when a payment completes.
 *   // Call playAlert() for support requests.
 */
import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';

// Web Audio API types for web platform fallback
type WebKitWindow = Window & { webkitAudioContext?: typeof AudioContext };

export function useAudioNotification() {
  const ctxRef = useRef<AudioContext | null>(null);
  const unlockedRef = useRef(false);

  /** Must be called inside a user-gesture handler (press, tap) to unlock audio on web/iOS. */
  const unlock = useCallback(() => {
    if (unlockedRef.current) return;
    if (Platform.OS !== 'web') {
      // On native platforms, no unlock needed — mark as ready
      unlockedRef.current = true;
      return;
    }
    try {
      const AudioCtx = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      ctxRef.current = new AudioCtx();
      if (ctxRef.current!.state === 'suspended') void ctxRef.current!.resume();
      // Silent 1-sample buffer: required to fully satisfy iOS autoplay policy
      const buf = ctxRef.current!.createBuffer(1, 1, 22050);
      const src = ctxRef.current!.createBufferSource();
      src.buffer = buf;
      src.connect(ctxRef.current!.destination);
      src.start(0);
      unlockedRef.current = true;
    } catch {
      // AudioContext not supported — silent fail
    }
  }, []);

  const scheduleNote = useCallback((
    frequency: number,
    startSec: number,
    duration: number,
    type: OscillatorType,
    volume: number,
  ) => {
    const ctx = ctxRef.current;
    if (!ctx || !unlockedRef.current) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, ctx.currentTime + startSec);
    // Soft attack + exponential decay envelope
    gain.gain.setValueAtTime(0.001, ctx.currentTime + startSec);
    gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + startSec + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startSec + duration - 0.01);
    osc.start(ctx.currentTime + startSec);
    osc.stop(ctx.currentTime + startSec + duration);
  }, []);

  /** Two-tone ascending chime: played when a new QR order arrives. */
  const playNewOrder = useCallback(() => {
    scheduleNote(880,  0,    0.35, 'sine', 0.22);
    scheduleNote(1100, 0.38, 0.48, 'sine', 0.18);
  }, [scheduleNote]);

  /** Three-tone descending chime: played when a payment is completed successfully. */
  const playPaymentSuccess = useCallback(() => {
    scheduleNote(1200, 0,    0.25, 'sine', 0.20);
    scheduleNote(1000, 0.28, 0.25, 'sine', 0.18);
    scheduleNote(800,  0.56, 0.35, 'sine', 0.15);
  }, [scheduleNote]);

  /** Triple-pulse alert: played for support requests or urgent events. */
  const playAlert = useCallback(() => {
    scheduleNote(660, 0,    0.22, 'triangle', 0.28);
    scheduleNote(660, 0.30, 0.22, 'triangle', 0.22);
    scheduleNote(660, 0.60, 0.38, 'triangle', 0.22);
  }, [scheduleNote]);

  /** Single ascending chime: played when all items in an order are ready. */
  const playOrderReady = useCallback(() => {
    scheduleNote(523,  0,    0.20, 'sine', 0.20);
    scheduleNote(659,  0.22, 0.20, 'sine', 0.20);
    scheduleNote(784,  0.44, 0.20, 'sine', 0.18);
    scheduleNote(1047, 0.66, 0.40, 'sine', 0.15);
  }, [scheduleNote]);

  return { unlock, playNewOrder, playPaymentSuccess, playAlert, playOrderReady };
}
