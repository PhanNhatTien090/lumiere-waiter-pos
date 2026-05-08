/**
 * Waiter-app WebSocket client — STOMP over native WebSocket
 *
 * React Native does not support SockJS (requires DOM/browser APIs).
 * @stomp/stompjs works natively with React Native's WebSocket API.
 *
 * Backend config:
 *   endpoint: /ws (SockJS enabled on backend, but we connect to raw WebSocket)
 *   broker:   /topic
 *   auth:     permitAll — no JWT needed for handshake
 *
 * NOTE: Backend has SockJS fallback, but /ws also accepts plain WebSocket.
 * React Native's built-in WebSocket connects directly via ws:// or wss://.
 */

import { Client } from '@stomp/stompjs';

// ws:// for local dev, wss:// for production
const WS_URL = (process.env.EXPO_PUBLIC_WS_URL ?? 'https://lumiere-restaurant-backend.onrender.com/ws')
  // Ensure we use the ws/wss protocol (not http/https)
  .replace(/^http/, 'ws');

/**
 * Create a STOMP client for React Native.
 * Uses the native WebSocket constructor directly (no SockJS).
 */
export function createWaiterStompClient(): Client {
  return new Client({
    brokerURL: WS_URL,
    reconnectDelay: 5_000,
    heartbeatIncoming: 10_000,
    heartbeatOutgoing: 10_000,
    debug: (msg) => {
      if (__DEV__) console.log('[STOMP]', msg);
    },
    onStompError: (frame) => {
      console.error('[STOMP] Error:', frame.headers['message'], frame.body);
    },
  });
}
