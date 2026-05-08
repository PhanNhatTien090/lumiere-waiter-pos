import { OrderItemStatus, OrderStatus, StaffRole, TableStatus } from "../types";

export const ORDER_STATUS_BY_ROLE: Record<StaffRole, OrderStatus[]> = {
  WAITER:  ["CREATED", "CONFIRMED", "PREPARING", "READY"],
  CASHIER: ["SERVED", "PAID"],
  MANAGER: ["CREATED", "CONFIRMED", "PREPARING", "READY", "SERVED", "PAID", "CANCELLED"],
};

export const ORDER_LABEL: Record<OrderStatus, string> = {
  CREATED:   "Mới tạo",
  CONFIRMED: "Đã xác nhận",
  PREPARING: "Đang nấu",
  READY:     "Sẵn sàng phục vụ",
  SERVED:    "Đã phục vụ",
  PAID:      "Đã thanh toán",
  CANCELLED: "Đã hủy",
};

export const ORDER_ITEM_LABEL: Record<OrderItemStatus, string> = {
  PENDING:   "Chờ xác nhận",
  CONFIRMED: "Đã xác nhận",
  PREPARING: "Đang nấu",
  READY:     "Sẵn sàng phục vụ",
  SERVED:    "Đã phục vụ",
  CANCELLED: "Đã hủy",
};

export const TABLE_LABEL: Record<TableStatus, string> = {
  AVAILABLE: "Trống",
  OCCUPIED: "Đang dùng",
  RESERVED: "Đặt trước",
  CLEANING: "Chờ dọn · thanh toán",
};

/** LUMIÈRE UX palette — TABLE STATUS (fine dining POS) */
export const TABLE_COLOR: Record<TableStatus, string> = {
  AVAILABLE: "#16A34A",
  RESERVED: "#CA8A04",
  OCCUPIED: "#2563EB",
  CLEANING: "#EA580C",
};

export function formatMoney(value: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value);
}

/** Use for API fields that may be null/NaN/string — avoids "NaN đ" on menu tab */
export function formatMoneyOrContact(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "Liên hệ";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "Liên hệ";
  return formatMoney(n);
}

export function nextTableStatus(status: TableStatus): TableStatus {
  if (status === "AVAILABLE") return "RESERVED";
  if (status === "RESERVED") return "OCCUPIED";
  if (status === "OCCUPIED") return "CLEANING";
  return "AVAILABLE";
}
