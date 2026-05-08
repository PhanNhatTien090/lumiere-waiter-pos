import axiosInstance from "./client";
import {
  ApiResponse,
  AssignSupportRequestBody,
  AuthPayload,
  CancelOrderRequest,
  CategoryResponse,
  CreatePaymentRequest,
  CreateSupportRequest,
  LoginRequest,
  MenuItemResponse,
  OrderInvoiceJson,
  OrderResponse,
  OrderStatus,
  PaymentResponse,
  PaymentStatusResponse,
  SupportRequestResponse,
  TableResponse,
  UpdateSupportStatusBody,
  UpdateTableStatusRequest,
} from "../types";

export const authAPI = {
  login: (payload: LoginRequest) => axiosInstance.post<ApiResponse<AuthPayload>>("/auth/login", payload),
  /** Server-side token invalidation; permitAll on backend allows call without breaking if unauthenticated */
  logout: () => axiosInstance.post<ApiResponse<unknown>>("/auth/logout"),
};

export const tableAPI = {
  listTables: () => axiosInstance.get<ApiResponse<TableResponse[]>>("/tables"),
  getTable: (tableCode: string) => axiosInstance.get<ApiResponse<TableResponse>>(`/tables/${tableCode}`),
  updateStatus: (tableCode: string, payload: UpdateTableStatusRequest) =>
    axiosInstance.put<ApiResponse<TableResponse>>(`/tables/${tableCode}/status`, payload),
};

export const menuAPI = {
  listCategories: () =>
    axiosInstance.get<ApiResponse<CategoryResponse[]>>("/menu/categories"),
  listByCategory: (categoryId: number) =>
    axiosInstance.get<ApiResponse<MenuItemResponse[]>>("/menu/items", { params: { categoryId } }),
  getMenuItem: (menuItemId: number) =>
    axiosInstance.get<ApiResponse<MenuItemResponse>>(`/menu/items/${menuItemId}`),
};

export const orderAPI = {
  listOrders: (status?: OrderStatus) =>
    axiosInstance.get<ApiResponse<OrderResponse[]>>("/orders", {
      params: status ? { status } : undefined,
    }),
  getOrder: (orderId: number) => axiosInstance.get<ApiResponse<OrderResponse>>(`/orders/${orderId}`),
  getInvoiceJson: (orderId: number) =>
    axiosInstance.get<ApiResponse<OrderInvoiceJson>>(`/orders/${orderId}/invoice`),
  confirmOrder: (orderId: number) => axiosInstance.put<ApiResponse<OrderResponse>>(`/orders/${orderId}/confirm`),
  cancelOrder: (orderId: number, payload: CancelOrderRequest) =>
    axiosInstance.put<ApiResponse<OrderResponse>>(`/orders/${orderId}/cancel`, payload),
  serveItem: (orderId: number, itemId: number) =>
    axiosInstance.put<ApiResponse<OrderResponse>>(`/orders/${orderId}/items/${itemId}/serve`),
  serveAll: (orderId: number) => axiosInstance.put<ApiResponse<OrderResponse>>(`/orders/${orderId}/serve-all`),
};

/** WAITER / MANAGER */
export const supportAPI = {
  create: (payload: CreateSupportRequest) =>
    axiosInstance.post<ApiResponse<SupportRequestResponse>>("/support", payload),
  listByTable: (tableCode: string) =>
    axiosInstance.get<ApiResponse<SupportRequestResponse[]>>(`/support/table/${encodeURIComponent(tableCode)}`),
  listAll: () => axiosInstance.get<ApiResponse<SupportRequestResponse[]>>("/support"),
  getOne: (id: number) => axiosInstance.get<ApiResponse<SupportRequestResponse>>(`/support/${id}`),
  assign: (id: number, body: AssignSupportRequestBody) =>
    axiosInstance.put<ApiResponse<SupportRequestResponse>>(`/support/${id}/assign`, body),
  updateStatus: (id: number, body: UpdateSupportStatusBody) =>
    axiosInstance.put<ApiResponse<SupportRequestResponse>>(`/support/${id}/status`, body),
};

export const paymentAPI = {
  createPayment: (payload: CreatePaymentRequest) => axiosInstance.post<ApiResponse<PaymentResponse>>("/payments", payload),
  getOrderPaymentStatus: (orderId: number) =>
    axiosInstance.get<ApiResponse<PaymentStatusResponse>>(`/payments/orders/${orderId}/status`),
};
