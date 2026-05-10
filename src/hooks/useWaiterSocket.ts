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
 *   /topic/waiter/payment-success  → WaiterPaymentSuccessPayload
 *     Fires when a payment is completed. Used for sound alert + table status update.
 *
 * All callbacks are stored in stable refs — the effect never re-subscribes due to
 * parent re-renders with new callback references.
 */

import { useEffect, useRef } from 'react';
import type { Client } from '@stomp/stompjs';
import { createWaiterStompClient } from '../lib/websocket';
import type { OrderResponse, SupportRequestResponse } from '../types';

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

/** Payload sent when a payment is completed successfully */
export interface WaiterPaymentSuccessPayload {
  orderId: number;
  tableId: number;
  status: string;
  paidAt: string;
  paymentId: number;
  amount: number;
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
  /** Customer created a new support request */
  onNewSupportRequest?: (payload: SupportRequestResponse) => void;
  /** Payment completed successfully — play sound + update table status */
  onPaymentSuccess?: (payload: WaiterPaymentSuccessPayload) => void;
  /** Called when socket connection state changes */
  onConnectionChange?: (connected: boolean) => void;
}

export function useWaiterSocket({
  enabled,
  onOrderReady,
  onNewOrder,
  onItemDone,
  onNewSupportRequest,
  onPaymentSuccess,
  onConnectionChange,
}: UseWaiterSocketOptions) {
  const clientRef = useRef<Client | null>(null);

  // Stable refs — callbacks update without causing re-subscription
  const onOrderReadyRef          = useRef(onOrderReady);
  const onNewOrderRef            = useRef(onNewOrder);
  const onItemDoneRef            = useRef(onItemDone);
  const onNewSupportRequestRef   = useRef(onNewSupportRequest);
  const onPaymentSuccessRef      = useRef(onPaymentSuccess);
  const onConnectionChangeRef    = useRef(onConnectionChange);
  onOrderReadyRef.current          = onOrderReady;
  onNewOrderRef.current            = onNewOrder;
  onItemDoneRef.current            = onItemDone;
  onNewSupportRequestRef.current   = onNewSupportRequest;
  onPaymentSuccessRef.current      = onPaymentSuccess;
  onConnectionChangeRef.current    = onConnectionChange;

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

      // ── /topic/waiter/support-request ────────────────────────────────────
      // Customer created a new support request via QR → notify waiter immediately
      client.subscribe('/topic/waiter/support-request', (message) => {
        try {
          const payload: SupportRequestResponse = JSON.parse(message.body);
          onNewSupportRequestRef.current?.(payload);
        } catch (e) {
          console.error('[STOMP] Failed to parse /topic/waiter/support-request', e);
        }
      });

      // ── /topic/waiter/payment-success ────────────────────────────────────
      // Payment completed → play sound + update table status to CLEANING
      client.subscribe('/topic/waiter/payment-success', (message) => {
        try {
          const payload: WaiterPaymentSuccessPayload = JSON.parse(message.body);
          onPaymentSuccessRef.current?.(payload);
        } catch (e) {
          console.error('[STOMP] Failed to parse /topic/waiter/payment-success', e);
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

