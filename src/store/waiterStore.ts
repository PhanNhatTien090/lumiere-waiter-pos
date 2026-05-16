import { create } from "zustand";
import { AuthPayload, CategoryResponse, MenuItemResponse, OrderResponse, StaffInfo, TableResponse } from "../types";

interface WaiterStore {
  accessToken: string | null;
  staff: StaffInfo | null;
  tables: TableResponse[];
  categories: CategoryResponse[];
  menuItems: MenuItemResponse[];
  orders: OrderResponse[];
  selectedOrder: OrderResponse | null;
  loading: boolean;
  error: string | null;
  hydrated: boolean;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  hydrateAuth: () => Promise<void>;
  setAuth: (payload: AuthPayload) => void;
  logout: () => void;
  setTables: (tables: TableResponse[]) => void;
  setCategories: (categories: CategoryResponse[]) => void;
  setMenuItems: (menuItems: MenuItemResponse[]) => void;
  setOrders: (orders: OrderResponse[]) => void;
  upsertOrder: (order: OrderResponse) => void;
  setSelectedOrder: (order: OrderResponse | null) => void;
}

export const useWaiterStore = create<WaiterStore>((set) => ({
  accessToken: null,
  staff: null,
  tables: [],
  categories: [],
  menuItems: [],
  orders: [],
  selectedOrder: null,
  loading: false,
  error: null,
  hydrated: false,
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  hydrateAuth: async () => {
    // Do not persist auth across app restarts: every new launch starts logged out.
    set({
      accessToken: null,
      staff: null,
      hydrated: true,
    });
  },
  setAuth: (payload) => {
    set({
      accessToken: payload.accessToken,
      staff: payload.staff,
      error: null,
      hydrated: true,
    });
  },
  logout: () => {
    set({
      accessToken: null,
      staff: null,
      tables: [],
      categories: [],
      menuItems: [],
      orders: [],
      selectedOrder: null,
      error: null,
      hydrated: true,
    });
  },
  setTables: (tables) => set({ tables }),
  setCategories: (categories) => set({ categories }),
  setMenuItems: (menuItems) => set({ menuItems }),
  setOrders: (orders: OrderResponse[]) => set({ orders }),
  upsertOrder: (order) =>
    set((state) => ({
      orders: state.orders.some((existing) => existing.id === order.id)
        ? state.orders.map((existing) => (existing.id === order.id ? order : existing))
        : [order, ...state.orders],
      // Sync selectedOrder để detail view re-render ngay khi có event WS/poll
      selectedOrder:
        state.selectedOrder && state.selectedOrder.id === order.id
          ? order
          : state.selectedOrder,
    })),
  setSelectedOrder: (selectedOrder) => set({ selectedOrder }),
}));
