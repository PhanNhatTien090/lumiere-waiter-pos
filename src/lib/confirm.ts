/**
 * Cross-platform confirm/alert helpers.
 *
 * react-native-web ships Alert as a no-op (no popup, no callbacks ever fire).
 * That silently breaks destructive flows like "Hủy món" when the app runs in
 * a browser — the button click does nothing and no log appears. These helpers
 * fall back to window.confirm / window.alert on web and use RN Alert on native.
 */

import { Alert, Platform } from "react-native";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const {
    title,
    message,
    confirmLabel = "Xác nhận",
    cancelLabel = "Đóng",
    destructive = false,
  } = options;

  if (Platform.OS === "web") {
    // window.confirm has no separate title — prepend it to the message.
    const ok = typeof window !== "undefined"
      ? window.confirm(`${title}\n\n${message}`)
      : false;
    return Promise.resolve(ok);
  }

  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: cancelLabel, style: "cancel", onPress: () => resolve(false) },
      {
        text: confirmLabel,
        style: destructive ? "destructive" : "default",
        onPress: () => resolve(true),
      },
    ]);
  });
}

export function notify(title: string, message: string): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}
