export type TaxMode = "NO_TAX" | "EXCLUSIVE" | "INCLUSIVE";

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
  timestamp?: string;
}

export type StaffRole = "WAITER" | "CASHIER" | "MANAGER";

export interface StaffInfo {
  id: number;
  name: string;
  username: string;
  role: StaffRole;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthPayload {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  staff: StaffInfo;
}

export type TableStatus = "AVAILABLE" | "OCCUPIED" | "RESERVED" | "CLEANING";

export interface TableResponse {
  id: number;
  tableCode: string;
  floor: number;
  tableNo: number;
  capacity: number;
  status: TableStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateTableStatusRequest {
  status: TableStatus;
}

export interface CategoryResponse {
  id: number;
  name: string;
  description?: string | null;
  displayOrder: number;
}

export interface MenuItemResponse {
  id: number;
  categoryId?: number;
  categoryName?: string;
  name: string;
  description?: string | null;
  price: number;
  cookTime?: number | null;
  available?: boolean;
  imageUrl?: string | null;
}

export type OrderStatus = "CREATED" | "CONFIRMED" | "PREPARING" | "READY" | "SERVED" | "PAID" | "CANCELLED";

export type OrderItemStatus = "PENDING" | "PREPARING" | "DONE" | "SERVED" | "CANCELLED";

export interface OrderItemResponse {
  id: number;
  revisionId: number;
  menuItemId: number;
  parentOrderItemId: number | null;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  unitTaxMode?: TaxMode;
  unitTaxRateBps?: number;
  netSubtotal?: number;
  taxSubtotal?: number;
  note?: string | null;
  status: OrderItemStatus;
  createdAt: string;
  billable: boolean;
  comboParent: boolean;
}

export interface OrderResponse {
  id: number;
  tableId: number;
  status: OrderStatus;
  subtotalAmount: number;
  taxAmount: number;
  totalAmount: number;
  taxMode: TaxMode;
  taxRateBps: number;
  taxSnapshotAt?: string | null;
  taxSnapshotById?: number | null;
  note?: string | null;
  splitBillAllowed: boolean;
  createdAt: string;
  confirmedAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  latestRevisionNumber: number;
  items: OrderItemResponse[];
}

export interface CancelOrderRequest {
  reason: string;
}

export interface CreateOrderItemRequest {
  menuItemId: number;
  quantity: number;
  note?: string | null;
  comboSelection?: unknown | null;
}

export interface CreateOrderRequest {
  tableCode: string;
  note?: string | null;
  splitBillAllowed?: boolean;
  items: CreateOrderItemRequest[];
}

export type PaymentMethod = "CASH" | "QR_CODE";
export type PaymentProvider = "CASH" | "VIETQR" | "VNPAY";

export interface CreatePaymentRequest {
  orderId: number;
  paymentMethod: PaymentMethod;
  provider: PaymentProvider;
  locale?: string | null;
  clientIp?: string | null;
  bankCode?: string | null;
}

export interface PaymentResponse {
  paymentId: number;
  orderId: number;
  shiftId: number;
  subtotalAmount: number;
  taxAmount: number;
  amount: number;
  taxMode: TaxMode;
  taxRateBps: number;
  paymentMethod: PaymentMethod;
  provider: PaymentProvider;
  status: string;
  qrContent: string | null;
  payUrl: string | null;
  qrExpiresAt: string | null;
  createdAt: string;
  paidAt: string | null;
  failedAt: string | null;
}

export interface PaymentStatusResponse {
  orderId: number;
  paymentId?: number;
  status: string;
  amount?: number;
  paidAt?: string | null;
}

/** Support requests — aligns with backend SupportRequest lifecycle */
export type SupportRequestStatus =
  | "CREATED"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "CLOSED";

export interface SupportRequestResponse {
  id: number;
  tableCode: string;
  status: SupportRequestStatus;
  staffId?: number | null;
  message?: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface CreateSupportRequest {
  tableCode: string;
  message?: string | null;
}

export interface AssignSupportRequestBody {
  staffId: number;
}

export interface UpdateSupportStatusBody {
  status: SupportRequestStatus;
}

/** Invoice JSON from BillingService.generateInvoice — shape evolves with backend */
export type OrderInvoiceJson = Record<string, unknown>;
