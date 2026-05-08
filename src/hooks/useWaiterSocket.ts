/**
 * useWaiterSocket — React Native hook for waiter realtime updates
 *
 * Topics (per KITCHEN_UPDATES_FRONTEND.md §1):
 *
 *   /topic/waiter/ready      → WaiterReadyPayload
 *     Fires when ALL items in an order are DONE (kitchen). Used for "Order Ready" alerts.
 *
 *   /topic/waiter/new-order  → OrderResponse   [NEW]
 *     Fires when a customer places an order via QR. Play sound / show toast immediately.
 *
 *   /topic/waiter/item-done  → WaiterItemDonePayload   [NEW]
 *     Fires when kitchen marks a single task DONE. Use to update item status granularly
 *     without waiting for the whole order to become READY.
 *
 * All callbacks are stored in stable refs — the effect never re-subscribes due to
 * parent re-renders with new callback references.
 */

import { useEffect, useRef } from 'react';
import type { Client } from '@stomp/stompjs';
import { createWaiterStompClient } from '../lib/websocket';
import type { OrderResponse } from '../types';

// ── Payload types ──────────────────────────────────────────────────────────────

export interface WaiterReadyPayload {
  orderId: number;
  tableId: number;
  status: string;
  readyAt: string;
}

/** Subset of KitchenTaskResponse sent when a single kitchen task is completed */
export interface WaiterItemDonePayload {
  taskId: number;
  orderId: number;
  orderItemId: number;
  menuItemId: number | null;
  tableId: number;
  status: 'DONE';
}

// ── Hook ───────────────────────────────────────────────────────────────────────

interface UseWaiterSocketOptions {
  /** Only connect when user is authenticated */
  enabled: boolean;
  /** All items in an order are DONE — show "Order Ready" alert */
  onOrderReady?: (payload: WaiterReadyPayload) => void;
  /** Customer placed a new order via QR — play sound / toast */
  onNewOrder?: (payload: OrderResponse) => void;
  /** Kitchen marked one task DONE — update item status granularly */
  onItemDone?: (payload: WaiterItemDonePayload) => void;
  /** Called when socket connection state changes */
  onConnectionChange?: (connected: boolean) => void;
}

export function useWaiterSocket({
  enabled,
  onOrderReady,
  onNewOrder,
  onItemDone,
  onConnectionChange,
}: UseWaiterSocketOptions) {
  const clientRef = useRef<Client | null>(null);

  // Stable refs — callbacks update without causing re-subscription
  const onOrderReadyRef      = useRef(onOrderReady);
  const onNewOrderRef        = useRef(onNewOrder);
  const onItemDoneRef        = useRef(onItemDone);
  const onConnectionChangeRef = useRef(onConnectionChange);
  onOrderReadyRef.current       = onOrderReady;
  onNewOrderRef.current         = onNewOrder;
  onItemDoneRef.current         = onItemDone;
  onConnectionChangeRef.current = onConnectionChange;

  useEffect(() => {
    if (!enabled) return;

    const client = createWaiterStompClient();

    client.onConnect = () => {
      onConnectionChangeRef.current?.(true);

      // ── /topic/waiter/ready ───────────────────────────────────────────────
      // All items in an order are DONE → "Order Ready" summary alert
      client.subscribe('/topic/waiter/ready', (message) => {
        try {
          const payload: WaiterReadyPayload = JSON.parse(message.body);
          onOrderReadyRef.current?.(payload);
        } catch (e) {
          console.error('[STOMP] Failed to parse /topic/waiter/ready', e);
        }
      });

      // ── /topic/waiter/new-order ───────────────────────────────────────────
      // Customer placed a new order via QR — notify waiter immediately
      client.subscribe('/topic/waiter/new-order', (message) => {
        try {
          const payload: OrderResponse = JSON.parse(message.body);
          onNewOrderRef.current?.(payload);
        } catch (e) {
          console.error('[STOMP] Failed to parse /topic/waiter/new-order', e);
        }
      });

      // ── /topic/waiter/item-done ───────────────────────────────────────────
      // Kitchen marked a single task DONE → update item status without waiting
      // for the full order-ready event
      client.subscribe('/topic/waiter/item-done', (message) => {
        try {
          const payload: WaiterItemDonePayload = JSON.parse(message.body);
          onItemDoneRef.current?.(payload);
        } catch (e) {
          console.error('[STOMP] Failed to parse /topic/waiter/item-done', e);
        }
      });
    };

    client.onDisconnect = () => {
      onConnectionChangeRef.current?.(false);
    };

    client.activate();
    clientRef.current = client;

    return () => {
      client.deactivate();
      clientRef.current = null;
      onConnectionChangeRef.current?.(false);
    };
  // Callbacks excluded from deps — using stable refs above
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return clientRef;
}
