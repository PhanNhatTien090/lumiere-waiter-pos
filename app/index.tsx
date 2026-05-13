import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { authAPI, menuAPI, orderAPI, paymentAPI, supportAPI, tableAPI } from "../src/api/endpoints";
import {
  ORDER_ITEM_LABEL,
  ORDER_LABEL,
  ORDER_STATUS_BY_ROLE,
  TABLE_COLOR,
  TABLE_LABEL,
  formatMoney,
  formatMoneyOrContact,
  nextTableStatus,
} from "../src/constants/posUi";
import { useWaiterStore } from "../src/store/waiterStore";
import { useWaiterSocket } from "../src/hooks/useWaiterSocket";
import { useAudioNotification } from "../src/hooks/useAudioNotification";
import {
  CategoryResponse,
  MenuItemResponse,
  OrderResponse,
  OrderStatus,
  PaymentMethod,
  PaymentProvider,
  StaffRole,
  SupportRequestResponse,
  SupportRequestStatus,
  TableResponse,
  TableStatus,
} from "../src/types";

type AppTab = "tables" | "orders" | "menu" | "payments" | "support";

const SUPPORT_LABEL: Record<SupportRequestStatus, string> = {
  CREATED: "Mới",
  ASSIGNED: "Đã giao",
  IN_PROGRESS: "Đang xử lý",
  RESOLVED: "Đã giải quyết",
  CLOSED: "Đã đóng",
};

const TABLE_LABEL_SHORT: Record<TableStatus, string> = {
  AVAILABLE: "Trống",
  OCCUPIED: "Đang dùng",
  RESERVED: "Đặt trước",
  CLEANING: "Dọn dẹp",
};

const SUPPORT_STATUS_COLOR: Record<SupportRequestStatus, string> = {
  CREATED: "#DC2626",
  ASSIGNED: "#2563EB",
  IN_PROGRESS: "#D97706",
  RESOLVED: "#16A34A",
  CLOSED: "#6B7280",
};

const SUPPORT_STATUS_BG: Record<SupportRequestStatus, string> = {
  CREATED: "#FFF8F0",
  ASSIGNED: "#EFF6FF",
  IN_PROGRESS: "#FFFBEB",
  RESOLVED: "#F0FDF4",
  CLOSED: "#F9FAFB",
};

const TAB_ICON: Record<AppTab, { default: string; active: string }> = {
  tables:   { default: "grid-outline",         active: "grid" },
  orders:   { default: "receipt-outline",       active: "receipt" },
  menu:     { default: "restaurant-outline",    active: "restaurant" },
  payments: { default: "card-outline",          active: "card" },
  support:  { default: "notifications-outline", active: "notifications" },
};

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "Vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return new Date(iso).toLocaleDateString("vi-VN");
}

export default function WaiterMobileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    accessToken,
    staff,
    tables,
    categories,
    menuItems,
    orders,
    selectedOrder,
    loading,
    error,
    hydrated,
    setLoading,
    setError,
    hydrateAuth,
    setAuth,
    logout,
    setTables,
    setCategories,
    setMenuItems,
    setOrders,
    upsertOrder,
    setSelectedOrder,
  } = useWaiterStore();

  // ─── Audio notification (Web Audio API, matching KDS pattern) ─────────────
  const { unlock, playNewOrder, playPaymentSuccess, playAlert, playOrderReady } = useAudioNotification();
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Ref keeps the latest categories value accessible inside fetchMenu
  // without adding `categories` to useCallback deps (avoids double-fetch on load).
  const categoriesRef = useRef<CategoryResponse[]>([]);
  categoriesRef.current = categories;

  const [activeTab, setActiveTab] = useState<AppTab>("tables");
  const [orderStatus, setOrderStatus] = useState<OrderStatus>("CREATED");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [refreshing, setRefreshing] = useState(false);
  const [pollingTick, setPollingTick] = useState(0);
  const [supportRequests, setSupportRequests] = useState<SupportRequestResponse[]>([]);
  const [tableFilter, setTableFilter] = useState<"all" | TableStatus>("all");
  const [tableSearch, setTableSearch] = useState("");
  const [menuCatFilter, setMenuCatFilter] = useState("all");
  const [menuItemNames, setMenuItemNames] = useState<Record<number, string>>({});

  // Create-order modal
  const [createOrderTable, setCreateOrderTable] = useState<TableResponse | null>(null);
  const [createCart, setCreateCart] = useState<Record<number, number>>({});
  const [createNote, setCreateNote] = useState("");
  const [createOrderCatFilter, setCreateOrderCatFilter] = useState<"all" | number>("all");
  const [submittingOrder, setSubmittingOrder] = useState(false);

  // Per-status order count for each status chip
  const [orderCountByStatus, setOrderCountByStatus] = useState<Record<string, number>>({});
  // Count of new CREATED orders not yet seen by the waiter (drives audio + badge)
  const [unseenCreatedCount, setUnseenCreatedCount] = useState(0);
  // Track the set of order IDs seen in the current polling window to detect NEW arrivals
  const knownOrderIdsRef = useRef<Set<number>>(new Set());
  // Stable ref to fetchCounts so WebSocket callbacks can call it without stale closure
  const fetchCountsRef = useRef<() => Promise<void>>(async () => {});

  const role = staff?.role;
  const roleStatuses = useMemo(() => (role ? ORDER_STATUS_BY_ROLE[role] : ["CREATED"]) as OrderStatus[], [role]);

  // ─── WebSocket: realtime notifications ────────────────────────────────────────
  useWaiterSocket({
    enabled: !!accessToken,

    // /topic/waiter/ready — ALL items in an order are DONE → full alert
    onOrderReady: (payload) => {
      if (soundEnabled) playOrderReady();
      Alert.alert(
        "🍽 Món đã sẵn sàng",
        `Order #${payload.orderId} — Bàn #${payload.tableId} đã sẵn sàng phục vụ!`,
        [{ text: "OK" }]
      );
      void fetchOrders("READY", true);
    },

    // /topic/waiter/new-order — customer placed a new order via QR
    onNewOrder: (newOrder) => {
      if (soundEnabled) playNewOrder();
      upsertOrder(newOrder);
      // Track as unseen and bump the CREATED counter immediately
      knownOrderIdsRef.current.add(newOrder.id);
      setUnseenCreatedCount((prev) => prev + 1);
      setOrderCountByStatus((prev) => ({
        ...prev,
        CREATED: (prev["CREATED"] ?? 0) + 1,
      }));
      void fetchCountsRef.current();
      Alert.alert(
        "📦 Đơn mới từ QR",
        `Bàn #${newOrder.tableId} vừa đặt đơn #${newOrder.id}\n` +
        `📋 ${newOrder.items.length} món · ${formatMoney(newOrder.totalAmount ?? 0)}`,
        [{ text: "OK" }]
      );
    },

    // /topic/waiter/item-done — kitchen marked one task DONE → silently refresh
    // the specific order so item statuses update without waiting for order-ready
    onItemDone: (payload) => {
      void orderAPI.getOrder(payload.orderId)
        .then((res) => upsertOrder(res.data.data))
        .catch(() => { /* non-critical — next poll will sync */ });
    },

    // /topic/waiter/support-request — customer created a new support request
    onNewSupportRequest: (req) => {
      if (soundEnabled) playAlert();
      setSupportRequests((prev) =>
        prev.some((r) => r.id === req.id)
          ? prev.map((r) => (r.id === req.id ? req : r))
          : [req, ...prev]
      );
      Alert.alert(
        "🔔 Yêu cầu hỗ trợ mới",
        `Bàn ${req.tableCode}: "${req.message ?? "Cần hỗ trợ"}"`,
        [{ text: "OK" }]
      );
    },

    // /topic/waiter/payment-success — payment completed → sound + refresh tables
    onPaymentSuccess: (payload) => {
      if (soundEnabled) playPaymentSuccess();
      Alert.alert(
        "✅ Thanh toán thành công",
        `Order #${payload.orderId} — Bàn #${payload.tableId}\n` +
        `💰 ${formatMoney(payload.amount ?? 0)}\n` +
        `🧹 Bàn chuyển sang trạng thái: Đang dọn`,
        [{ text: "OK" }]
      );
      // Refresh tables to show CLEANING status
      void fetchTables(true);
      // Refresh orders to show PAID status
      void fetchOrders(orderStatus, true);
    },
  });

  useEffect(() => {
    void hydrateAuth();
  }, [hydrateAuth]);

  useEffect(() => {
    if (role && !roleStatuses.includes(orderStatus)) {
      setOrderStatus(roleStatuses[0]);
    }
  }, [orderStatus, role, roleStatuses]);

  const fetchTables = useCallback(async (silent = false) => {
    if (!accessToken) return;

    try {
      if (!silent) setLoading(true);
      if (!silent) setError(null);
      const response = await tableAPI.listTables();
      setTables(response.data.data);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || "Không thể tải danh sách bàn");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [accessToken, setError, setLoading, setTables]);

  const fetchMenu = useCallback(async (silent = false) => {
    if (!accessToken || !(role === "WAITER" || role === "MANAGER")) return;
    try {
      if (!silent) setLoading(true);
      if (!silent) setError(null);

      // Load categories once (ref avoids stale closure without depending on state)
      let activeCats = categoriesRef.current;
      if (activeCats.length === 0) {
        const catRes = await menuAPI.listCategories();
        const sorted = [...catRes.data.data].sort((a, b) => a.displayOrder - b.displayOrder);
        setCategories(sorted);
        categoriesRef.current = sorted;
        activeCats = sorted;
      }

      if (activeCats.length === 0) {
        setMenuItems([]);
        return;
      }

      if (menuCatFilter === "all") {
        const results = await Promise.all(
          activeCats.map((cat) =>
            menuAPI.listByCategory(cat.id).then((r) =>
              r.data.data.map((item) => ({ ...item, categoryId: item.categoryId ?? cat.id }))
            )
          )
        );
        setMenuItems(results.flat());
      } else {
        const filterId = Number(menuCatFilter);
        const res = await menuAPI.listByCategory(filterId);
        setMenuItems(res.data.data.map((item) => ({ ...item, categoryId: item.categoryId ?? filterId })));
      }
    } catch (err: any) {
      setError(err?.response?.data?.message || "Không thể tải thực đơn");
    } finally {
      if (!silent) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, role, menuCatFilter, setCategories, setMenuItems, setLoading, setError]);

  const fetchOrders = useCallback(async (status: OrderStatus, silent = false) => {
    if (!accessToken) return;

    try {
      if (!silent) setLoading(true);
      if (!silent) setError(null);
      const response = await orderAPI.listOrders(status);
      const fresh = response.data.data as OrderResponse[];

      // ── Smart new-order detection (runs on every 8s poll) ─────────────────
      // Only detect new CREATED orders to avoid false positives from other statuses
      if (status === "CREATED" && knownOrderIdsRef.current.size > 0) {
        const newOnes = fresh.filter((o) => !knownOrderIdsRef.current.has(o.id));
        if (newOnes.length > 0) {
          if (soundEnabled) playNewOrder();
          setUnseenCreatedCount((prev) => prev + newOnes.length);
        }
      }
      // Rebuild the known-IDs set for the CREATED status each poll
      if (status === "CREATED") {
        knownOrderIdsRef.current = new Set(fresh.map((o) => o.id));
      }

      setOrders(fresh);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Không thể tải danh sách đơn");
    } finally {
      if (!silent) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, setError, setLoading, setOrders, soundEnabled, playNewOrder]);

  const fetchSupport = useCallback(
    async (silent = false) => {
      if (!accessToken || !(role === "WAITER" || role === "MANAGER")) return;
      try {
        if (!silent) setLoading(true);
        if (!silent) setError(null);
        const res = await supportAPI.listAll();
        const rows = res.data?.data;
        setSupportRequests(Array.isArray(rows) ? rows : []);
      } catch (err: any) {
        setError(err?.response?.data?.message || "Không tải được yêu cầu hỗ trợ");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [accessToken, role, setError, setLoading]
  );

  const refreshByTab = useCallback(
    async (tab: AppTab, status: OrderStatus, silent = false) => {
      if (tab === "tables") {
        await fetchTables(silent);
        return;
      }

      if (tab === "menu") {
        await fetchMenu(silent);
        return;
      }

      if (tab === "support") {
        await fetchSupport(silent);
        return;
      }

      await fetchOrders(status, silent);
    },
    [fetchMenu, fetchOrders, fetchSupport, fetchTables]
  );

  useEffect(() => {
    if (!accessToken || !role) {
      return;
    }

    void refreshByTab(activeTab, orderStatus);
  }, [accessToken, activeTab, orderStatus, refreshByTab, role]);

  useEffect(() => {
    if (!accessToken || !role || activeTab !== "orders") {
      return;
    }

    const timerId = setInterval(() => {
      setPollingTick((value) => value + 1);
      void fetchOrders(orderStatus, true);
    }, 8000);

    return () => {
      clearInterval(timerId);
    };
  }, [accessToken, activeTab, fetchOrders, orderStatus, role]);

  // ─── Background CREATED-orders poll (all tabs) ────────────────────────────
  // Runs even when the user is on the Tables / Support / Menu tab so audio
  // fires the moment a new QR order arrives, regardless of active tab.
  useEffect(() => {
    if (!accessToken || !role) return;
    if (!(role === "WAITER" || role === "MANAGER")) return;
    // Already handled by the main orders poll above when on the orders tab
    if (activeTab === "orders" && orderStatus === "CREATED") return;

    const timerId = setInterval(async () => {
      try {
        const res = await orderAPI.listOrders("CREATED");
        const fresh = (res.data.data ?? []) as OrderResponse[];
        if (knownOrderIdsRef.current.size > 0) {
          const newOnes = fresh.filter((o) => !knownOrderIdsRef.current.has(o.id));
          if (newOnes.length > 0) {
            if (soundEnabled) playNewOrder();
            setUnseenCreatedCount((prev) => prev + newOnes.length);
            setOrderCountByStatus((prev) => ({
              ...prev,
              CREATED: fresh.length,
            }));
          }
        }
        knownOrderIdsRef.current = new Set(fresh.map((o) => o.id));
      } catch {
        /* non-critical */
      }
    }, 10_000);

    return () => clearInterval(timerId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, activeTab, orderStatus, role, soundEnabled, playNewOrder]);

  useEffect(() => {
    if (!accessToken || !role || activeTab !== "support") {
      return;
    }

    const timerId = setInterval(() => {
      void fetchSupport(true);
    }, 12_000);

    return () => {
      clearInterval(timerId);
    };
  }, [accessToken, activeTab, fetchSupport, role]);

  const tabs = useMemo(() => {
    if (!role) return [] as Array<{ key: AppTab; label: string }>;

    const nextTabs: Array<{ key: AppTab; label: string }> = [
      { key: "tables", label: "Bàn" },
      { key: "orders", label: "Đơn" },
    ];

    if (role === "WAITER" || role === "MANAGER") {
      nextTabs.push({ key: "menu", label: "Thực đơn" });
    }

    if (role === "CASHIER" || role === "MANAGER") {
      nextTabs.push({ key: "payments", label: "Thanh toán" });
    }

    if (role === "WAITER" || role === "MANAGER") {
      nextTabs.push({ key: "support", label: "Hỗ trợ" });
    }

    return nextTabs;
  }, [role]);

  const pendingOrderCount = useMemo(
    () => orders.filter((o) =>
      o.status === "CREATED" ||
      o.status === "CONFIRMED" ||
      o.items.some((i) => i.status === "DONE")   // any item done from kitchen, ready to serve
    ).length,
    [orders]
  );
  const openSupportCount = useMemo(() => supportRequests.filter((r) => r.status === "CREATED").length, [supportRequests]);

  // Fetch per-status order counts for badge display on status chips
  useEffect(() => {
    if (!accessToken || !role) return;

    const fetchCounts = async () => {
      const counts: Record<string, number> = {};
      try {
        const statusList = role ? ORDER_STATUS_BY_ROLE[role] : ["CREATED"];
        const results = await Promise.allSettled(
          statusList.map((s) => orderAPI.listOrders(s as any))
        );
        statusList.forEach((s, idx) => {
          const r = results[idx];
          counts[s] = r.status === "fulfilled" ? r.value.data.data.length : 0;
        });
      } catch {
        /* best-effort */
      }
      setOrderCountByStatus(counts);
    };

    // Expose via ref so WebSocket callbacks can trigger a refresh immediately
    fetchCountsRef.current = fetchCounts;

    void fetchCounts();
    const timerId = setInterval(() => void fetchCounts(), 15_000);
    return () => clearInterval(timerId);
  }, [accessToken, role]);

  // Categories come directly from /menu/categories (sorted by displayOrder on fetch).
  // Items are pre-filtered by the API, so visibleMenuItems = menuItems.
  const visibleMenuItems = menuItems;

  const filteredTables = useMemo(() => tables.filter((t) => {
    const matchStatus = tableFilter === "all" || t.status === tableFilter;
    const matchSearch = !tableSearch.trim() || t.tableCode.toLowerCase().includes(tableSearch.toLowerCase());
    return matchStatus && matchSearch;
  }), [tables, tableFilter, tableSearch]);

  const filteredCreateOrderItems = useMemo(
    () =>
      createOrderCatFilter === "all"
        ? menuItems
        : menuItems.filter((m) => m.categoryId === createOrderCatFilter),
    [menuItems, createOrderCatFilter]
  );

  const cartStats = useMemo(() => {
    let total = 0;
    let count = 0;
    Object.entries(createCart).forEach(([id, qty]) => {
      const item = menuItems.find((m) => m.id === Number(id));
      if (item) total += item.price * qty;
      count += qty;
    });
    return { total, count, types: Object.keys(createCart).length };
  }, [createCart, menuItems]);

  async function handleManualRefresh() {
    setRefreshing(true);
    await refreshByTab(activeTab, orderStatus, true);
    setRefreshing(false);
  }

  async function handleLogin() {
    try {
      setLoading(true);
      setError(null);
      const response = await authAPI.login({ username: username.trim(), password });
      await setAuth(response.data.data);
      setActiveTab("tables");
    } catch (err: any) {
      setError(err?.response?.data?.message || "Đăng nhập thất bại");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await authAPI.logout();
    } catch {
      /* still clear local session */
    }
    logout();
    setActiveTab("tables");
    setOrderStatus("CREATED");
    setUsername("");
    setPassword("");
  }

  async function handleOrderDetail(order: OrderResponse) {
    if (selectedOrder?.id === order.id) {
      setSelectedOrder(null);
      return;
    }

    try {
      setLoading(true);
      const response = await orderAPI.getOrder(order.id);
      const orderData = response.data.data;
      upsertOrder(orderData);
      setSelectedOrder(orderData);

      // Fetch names for items not already in store or local cache
      const idsToFetch = [...new Set(
        orderData.items
          .map((i) => i.menuItemId)
          .filter((id) => !menuItems.find((m) => m.id === id) && !menuItemNames[id])
      )];
      if (idsToFetch.length > 0) {
        const results = await Promise.allSettled(idsToFetch.map((id) => menuAPI.getMenuItem(id)));
        const newNames: Record<number, string> = {};
        idsToFetch.forEach((id, idx) => {
          const r = results[idx];
          if (r.status === "fulfilled") newNames[id] = r.value.data.data.name;
        });
        if (Object.keys(newNames).length > 0) {
          setMenuItemNames((prev) => ({ ...prev, ...newNames }));
        }
      }
    } catch (err: any) {
      setError(err?.response?.data?.message || "Không tải được chi tiết đơn");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(order: OrderResponse) {
    try {
      setLoading(true);
      const response = await orderAPI.confirmOrder(order.id);
      upsertOrder(response.data.data);
      await fetchOrders(orderStatus, true);
      Alert.alert("Thành công", "Đã xác nhận đơn hàng.");
    } catch (err: any) {
      setError(err?.response?.data?.message || "Xác nhận đơn thất bại");
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel(order: OrderResponse) {
    try {
      setLoading(true);
      const response = await orderAPI.cancelOrder(order.id, { reason: "Khách yêu cầu hủy" });
      upsertOrder(response.data.data);
      await fetchOrders(orderStatus, true);
      Alert.alert("Đã hủy", "Đơn hàng đã được hủy.");
    } catch (err: any) {
      setError(err?.response?.data?.message || "Hủy đơn thất bại");
    } finally {
      setLoading(false);
    }
  }

  async function handleServeAll(order: OrderResponse) {
    try {
      setLoading(true);
      const response = await orderAPI.serveAll(order.id);
      upsertOrder(response.data.data);
      await fetchOrders(orderStatus, true);
      Alert.alert("Thành công", "Đã phục vụ toàn bộ món.");
    } catch (err: any) {
      setError(err?.response?.data?.message || "Phục vụ thất bại");
    } finally {
      setLoading(false);
    }
  }

  async function handleServeItem(orderId: number, itemId: number) {
    try {
      setLoading(true);
      const response = await orderAPI.serveItem(orderId, itemId);
      upsertOrder(response.data.data);
      Alert.alert("Thành công", "Đã cập nhật món phục vụ.");
    } catch (err: any) {
      setError(err?.response?.data?.message || "Phục vụ món thất bại");
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateTable(table: TableResponse) {
    const nextStatus = nextTableStatus(table.status);

    try {
      setLoading(true);
      const response = await tableAPI.updateStatus(table.tableCode, { status: nextStatus });
      setTables(tables.map((item) => (item.id === table.id ? response.data.data : item)));
      Alert.alert("Cập nhật bàn", `Đã chuyển ${table.tableCode} sang trạng thái ${TABLE_LABEL[nextStatus]}.`);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Cập nhật bàn thất bại");
    } finally {
      setLoading(false);
    }
  }

  async function handleOpenCreateOrder(table: TableResponse) {
    setCreateOrderTable(table);
    setCreateCart({});
    setCreateNote("");
    setCreateOrderCatFilter("all");

    if (!accessToken || !(role === "WAITER" || role === "MANAGER")) return;

    // Force-load all menu items for the modal — fetchMenu honors menuCatFilter
    // which may exclude categories the user wants to add to the new order.
    try {
      let cats = categoriesRef.current;
      if (cats.length === 0) {
        const catRes = await menuAPI.listCategories();
        cats = [...catRes.data.data].sort((a, b) => a.displayOrder - b.displayOrder);
        setCategories(cats);
        categoriesRef.current = cats;
      }
      const results = await Promise.all(
        cats.map((cat) =>
          menuAPI.listByCategory(cat.id).then((r) =>
            r.data.data.map((item) => ({ ...item, categoryId: item.categoryId ?? cat.id }))
          )
        )
      );
      setMenuItems(results.flat());
    } catch (err: any) {
      setError(err?.response?.data?.message || "Không thể tải thực đơn");
    }
  }

  function handleCloseCreateOrder() {
    setCreateOrderTable(null);
    setCreateCart({});
    setCreateNote("");
  }

  function handleAddToCart(menuItemId: number) {
    setCreateCart((prev) => ({ ...prev, [menuItemId]: (prev[menuItemId] ?? 0) + 1 }));
  }

  function handleRemoveFromCart(menuItemId: number) {
    setCreateCart((prev) => {
      const current = prev[menuItemId] ?? 0;
      if (current <= 1) {
        const { [menuItemId]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [menuItemId]: current - 1 };
    });
  }

  async function handleSubmitCreateOrder() {
    if (!createOrderTable) return;
    const items = Object.entries(createCart)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => ({
        menuItemId: Number(id),
        quantity: qty,
        note: null,
        comboSelection: null,
      }));

    if (items.length === 0) {
      Alert.alert("Thiếu thông tin", "Vui lòng chọn ít nhất 1 món trước khi tạo đơn.");
      return;
    }

    try {
      setSubmittingOrder(true);
      setError(null);
      const created = await orderAPI.createOrder({
        tableCode: createOrderTable.tableCode,
        note: createNote.trim() || null,
        splitBillAllowed: false,
        items,
      });
      const orderId = created.data.data.id;
      upsertOrder(created.data.data);

      // Auto-confirm to skip the manual CREATED → CONFIRMED step
      try {
        const confirmed = await orderAPI.confirmOrder(orderId);
        upsertOrder(confirmed.data.data);
        Alert.alert("Đã tạo đơn", `Đơn #${orderId} cho bàn ${createOrderTable.tableCode} đã được gửi tới bếp.`);
      } catch {
        Alert.alert(
          "Đã tạo đơn",
          `Đơn #${orderId} đã được tạo nhưng chưa xác nhận. Vui lòng xác nhận thủ công ở tab Đơn.`
        );
      }

      handleCloseCreateOrder();
      void fetchTables(true);
      void fetchOrders(orderStatus, true);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Tạo đơn thất bại");
    } finally {
      setSubmittingOrder(false);
    }
  }

  async function handleCreatePayment(order: OrderResponse) {
    const provider: PaymentProvider = paymentMethod === "CASH" ? "CASH" : "VIETQR";

    try {
      setLoading(true);
      const response = await paymentAPI.createPayment({
        orderId: order.id,
        paymentMethod,
        provider,
        locale: null,
        clientIp: null,
        bankCode: null,
      });

      const payStatus = response.data.data.status;
      if (payStatus === "COMPLETED" || payStatus === "SUCCESS") {
        if (soundEnabled) playPaymentSuccess();
        Alert.alert(
          "✅ Thanh toán thành công",
          `Order #${order.id} — ${formatMoney(order.totalAmount ?? 0)}\n🧹 Bàn chuyển sang trạng thái: Đang dọn`
        );
      } else {
        Alert.alert("Thanh toán", `Trạng thái: ${payStatus}`);
      }

      const next = await orderAPI.getOrder(order.id);
      upsertOrder(next.data.data);
      await fetchOrders(orderStatus, true);
      // Refresh tables to reflect CLEANING status
      void fetchTables(true);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Tạo thanh toán thất bại");
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckPayment(order: OrderResponse) {
    try {
      setLoading(true);
      const response = await paymentAPI.getOrderPaymentStatus(order.id);
      Alert.alert("Trạng thái thanh toán", `${response.data.data.status}`);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Không xem được trạng thái thanh toán");
    } finally {
      setLoading(false);
    }
  }

  async function handleSupportAssignToMe(req: SupportRequestResponse) {
    if (!staff) return;
    try {
      setLoading(true);
      const res = await supportAPI.assign(req.id, staff.id);
      const updated = res.data?.data;
      if (updated) {
        setSupportRequests((prev) => prev.map((r) => (r.id === req.id ? updated : r)));
      } else {
        await fetchSupport(true);
      }
      Alert.alert("Đã giao", `Yêu cầu #${req.id} đã giao cho bạn.`);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Giao việc thất bại");
    } finally {
      setLoading(false);
    }
  }

  async function handleSupportUpdateStatus(req: SupportRequestResponse, status: SupportRequestStatus) {
    try {
      setLoading(true);
      const res = await supportAPI.updateStatus(req.id, status);
      const updated = res.data?.data;
      if (updated) {
        setSupportRequests((prev) => prev.map((r) => (r.id === req.id ? updated : r)));
      } else {
        await fetchSupport(true);
      }
      Alert.alert("Đã cập nhật", `Trạng thái: ${SUPPORT_LABEL[status]}`);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Cập nhật trạng thái thất bại");
    } finally {
      setLoading(false);
    }
  }

  if (!hydrated) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator size="large" color="#8B6914" />
      </SafeAreaView>
    );
  }

  if (!accessToken || !staff) {
    return (
      <SafeAreaView style={styles.loginShell} edges={["top", "bottom", "left", "right"]}>
        <StatusBar barStyle="light-content" backgroundColor="#1C1C1E" />
        <View style={styles.loginOuter}>
          <View style={styles.loginCard}>
            <View style={styles.loginLogoRow}>
              <View style={styles.loginLogoBadge}>
                <Text style={styles.loginLogoLetter}>L</Text>
              </View>
              <View>
                <Text style={styles.loginTitle}>Đăng nhập POS</Text>
                <Text style={styles.loginSubtitle}>LUMIÈRE · Nhân viên</Text>
              </View>
            </View>

            <TextInput
              value={username}
              onChangeText={setUsername}
              style={styles.input}
              placeholder="Tên đăng nhập"
              placeholderTextColor="#A89880"
              autoCapitalize="none"
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              style={styles.input}
              placeholder="Mật khẩu"
              placeholderTextColor="#A89880"
              secureTextEntry
              returnKeyType="go"
              onSubmitEditing={handleLogin}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]} onPress={handleLogin} disabled={loading}>
              <Text style={styles.primaryButtonText}>{loading ? "Đang đăng nhập..." : "Đăng nhập"}</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const bottomInset = Math.max(insets.bottom, 10);

  return (
    <SafeAreaView style={styles.shellCream} edges={["top", "left", "right"]}>
      <StatusBar barStyle="dark-content" backgroundColor="#FAF8F0" />
      <View style={styles.columnFlex} onTouchStart={unlock}>
        <View style={styles.posPageHeader}>
          <View style={styles.flex1}>
            <Text style={styles.posTitle}>LUMIÈRE POS</Text>
            <Text style={styles.posSubtitle}>{staff.name} · {staff.role}</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.soundToggleBtn, pressed && styles.buttonPressed]}
            onPress={() => { unlock(); setSoundEnabled((prev) => !prev); }}
          >
            <Ionicons name={soundEnabled ? "volume-high" : "volume-mute"} size={18} color={soundEnabled ? "#C9A227" : "#9CA3AF"} />
          </Pressable>
          <Pressable style={({ pressed }) => [styles.headerLogoutBtn, pressed && styles.buttonPressed]} onPress={handleLogout}>
            <Text style={styles.headerLogoutText}>Đăng xuất</Text>
          </Pressable>
        </View>

        {(activeTab === "orders" || activeTab === "payments") && (
          <View style={styles.statusWrap}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.statusScroller}>
              {roleStatuses.map((status) => {
                const count = orderCountByStatus[status] ?? 0;
                const isCreated = status === "CREATED";
                const hasUnseen = isCreated && unseenCreatedCount > 0;
                return (
                <Pressable
                  key={status}
                  style={({ pressed }) => [styles.statusChip, orderStatus === status && styles.statusChipActive, pressed && styles.buttonPressed]}
                  onPress={() => {
                    setOrderStatus(status);
                    // Clear unseen badge when waiter explicitly opens CREATED tab
                    if (isCreated) setUnseenCreatedCount(0);
                  }}
                >
                  <Text style={[styles.statusChipText, orderStatus === status && styles.statusChipTextActive]}>{ORDER_LABEL[status]}</Text>
                  {hasUnseen ? (
                    // Pulsing "Mới" indicator — highest priority
                    <View style={[styles.statusChipBadge, styles.statusChipBadgeNew]}>
                      <Text style={styles.statusChipBadgeText}>+{unseenCreatedCount > 99 ? "99+" : unseenCreatedCount} mới</Text>
                    </View>
                  ) : count > 0 ? (
                    <View style={[styles.statusChipBadge, orderStatus === status && styles.statusChipBadgeActive]}>
                      <Text style={[styles.statusChipBadgeText, orderStatus === status && styles.statusChipBadgeTextActive]}>{count > 99 ? "99+" : count}</Text>
                    </View>
                  ) : null}
                </Pressable>
              );})}
            </ScrollView>
          </View>
        )}

        {activeTab === "menu" && categories.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.mCatBar} contentContainerStyle={styles.mCatRow}>
            <Pressable style={[styles.mCatPill, menuCatFilter === "all" && styles.mCatPillActive]} onPress={() => setMenuCatFilter("all")}>
              <Text style={[styles.mCatPillText, menuCatFilter === "all" && styles.mCatPillTextActive]}>Tất cả</Text>
            </Pressable>
            {categories.map((cat) => (
              <Pressable key={cat.id} style={[styles.mCatPill, menuCatFilter === String(cat.id) && styles.mCatPillActive]} onPress={() => setMenuCatFilter(String(cat.id))}>
                <Text style={[styles.mCatPillText, menuCatFilter === String(cat.id) && styles.mCatPillTextActive]}>{cat.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText} numberOfLines={2}>{error}</Text>
            <Pressable onPress={() => setError(null)} hitSlop={8}>
              <Text style={styles.errorBannerDismiss}>×</Text>
            </Pressable>
          </View>
        ) : null}
        {loading ? <ActivityIndicator style={styles.loader} color="#C9A227" /> : null}

        <ScrollView
          style={styles.scrollFlex}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: 76 + bottomInset }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleManualRefresh} tintColor="#C9A227" />}
        >
          {activeTab === "tables" && (
            <View>
              {/* Summary row - TOP */}
              {filteredTables.length > 0 && (
                <View style={styles.tblSummaryRow}>
                  <View style={styles.tblSummaryCol}>
                    <Text style={styles.tblSummaryValue}>{filteredTables.filter(t => t.status === "OCCUPIED").length}</Text>
                    <Text style={styles.tblSummaryLabel}>Đang dùng</Text>
                  </View>
                  <View style={styles.tblSummaryCol}>
                    <Text style={styles.tblSummaryValue}>{filteredTables.filter(t => t.status === "AVAILABLE").length}</Text>
                    <Text style={styles.tblSummaryLabel}>Trống</Text>
                  </View>
                  <View style={styles.tblSummaryCol}>
                    <Text style={styles.tblSummaryValue}>{filteredTables.reduce((sum, t) => sum + t.capacity, 0)}</Text>
                    <Text style={styles.tblSummaryLabel}>Sức chứa</Text>
                  </View>
                </View>
              )}

              {/* Search */}
              <TextInput
                style={styles.tblSearch}
                placeholder="Tìm mã bàn..."
                placeholderTextColor="#9CA3AF"
                value={tableSearch}
                onChangeText={setTableSearch}
              />

              {/* Status filter pills */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tblFilterRow}>
                {(["all", "AVAILABLE", "OCCUPIED", "RESERVED", "CLEANING"] as const).map((f) => (
                  <Pressable
                    key={f}
                    style={[styles.tblPill, tableFilter === f && styles.tblPillActive]}
                    onPress={() => setTableFilter(f)}
                  >
                    {f !== "all" && (
                      <View style={[styles.tblPillDot, { backgroundColor: TABLE_COLOR[f] }]} />
                    )}
                    <Text style={[styles.tblPillText, tableFilter === f && styles.tblPillTextActive]}>
                      {f === "all" ? "Tất cả" : TABLE_LABEL_SHORT[f]}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>

              {/* Grid */}
              <View style={styles.tblGrid}>
                {filteredTables.map((table) => {
                  const color = TABLE_COLOR[table.status];
                  const nextStatus = nextTableStatus(table.status);
                  const sittingMinutes = table.status === "OCCUPIED" && table.updatedAt ? Math.floor((Date.now() - new Date(table.updatedAt).getTime()) / 60000) : 0;
                  const timeLabel = table.status === "OCCUPIED" && sittingMinutes > 0 ? `  ·  ${sittingMinutes} phút` : "";
                  return (
                    <View key={table.id} style={styles.tblCard}>
                      {/* Top color bar */}
                      <View style={[styles.tblCardBar, { backgroundColor: color }]} />

                      <View style={styles.tblCardBody}>
                        {/* Row 1: name + badge */}
                        <View style={styles.tblCardTop}>
                          <Text style={styles.tblCardName}>{table.tableCode}</Text>
                          <View style={[styles.tblStatusBadge, { backgroundColor: color + "1A", borderColor: color + "60" }]}>
                            <Text style={[styles.tblStatusText, { color }]}>{TABLE_LABEL_SHORT[table.status]}</Text>
                          </View>
                        </View>

                        {/* Row 2: meta */}
                        <Text style={styles.tblCardMeta}>Tầng {table.floor}  ·  {table.capacity} chỗ{timeLabel}</Text>

                        {/* Row 3: buttons */}
                        <View style={styles.tblCardBtns}>
                          <Pressable
                            style={({ pressed }) => [styles.tblBtnSecondary, pressed && styles.tblBtnPressed]}
                            onPress={() => void handleOpenCreateOrder(table)}
                          >
                            <Text style={styles.tblBtnSecondaryText}>Tạo đơn</Text>
                          </Pressable>
                          <Pressable
                            style={({ pressed }) => [styles.tblBtnPrimary, { backgroundColor: color }, pressed && styles.tblBtnPressed]}
                            onPress={() => handleUpdateTable(table)}
                          >
                            <Text style={styles.tblBtnPrimaryText}>{TABLE_LABEL_SHORT[nextStatus]}</Text>
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>

              {!loading && filteredTables.length === 0 && (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyStateIcon}>🪑</Text>
                  <Text style={styles.emptyStateTitle}>
                    {tableSearch || tableFilter !== "all" ? "Không tìm thấy bàn" : "Chưa có dữ liệu bàn"}
                  </Text>
                  {(tableSearch || tableFilter !== "all") ? (
                    <Text style={styles.emptyStateSubtitle}>Thử thay đổi bộ lọc hoặc từ khóa tìm kiếm</Text>
                  ) : null}
                </View>
              )}
            </View>
          )}

          {activeTab === "support" && (
            <View style={styles.list}>
              {supportRequests.map((req) => {
                const isMine = staff != null && req.staffId === staff.id;
                const statusColor = SUPPORT_STATUS_COLOR[req.status];
                const ticketBg = SUPPORT_STATUS_BG[req.status];

                return (
                  <View key={req.id} style={[styles.supportTicket, { backgroundColor: req.status === "CREATED" ? "#FEF2F2" : ticketBg }]}>
                    <View style={styles.supportTicketBody}>
                      {/* Header: table code + new badge */}
                      <View style={styles.supportTicketHeader}>
                        <Text style={[styles.supportTicketTitle, req.status === "CREATED" && { color: "#DC2626" }]}>
                          Bàn {req.tableCode}  #{req.id}
                        </Text>
                        {req.status === "CREATED" && <View style={styles.supportNewBadge}><Text style={styles.supportNewBadgeText}>Mới</Text></View>}
                      </View>

                      {/* Message */}
                      {req.message ? (
                        <Text style={styles.supportTicketMsg}>"{req.message}"</Text>
                      ) : null}

                      {/* Time + Status badge */}
                      <View style={styles.rowBetween}>
                        <Text style={styles.supportTicketMeta}>{timeAgo(req.createdAt)}</Text>
                        <View style={[styles.supportStatusBadge, { backgroundColor: statusColor }]}>
                          <Text style={styles.supportStatusBadgeText}>{SUPPORT_LABEL[req.status]}</Text>
                        </View>
                      </View>

                      {/* Single action button based on status */}
                      {req.status === "CREATED" ? (
                        <Pressable
                          style={({ pressed }) => [styles.supportAssignBtn, pressed && styles.buttonPressed]}
                          onPress={() => void handleSupportAssignToMe(req)}
                        >
                          <Text style={styles.supportAssignBtnText}>Gán cho tôi</Text>
                        </Pressable>
                      ) : req.status === "ASSIGNED" && isMine ? (
                        <Pressable
                          style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]}
                          onPress={() => void handleSupportUpdateStatus(req, "IN_PROGRESS")}
                        >
                          <Text style={styles.smallButtonText}>Bắt đầu</Text>
                        </Pressable>
                      ) : req.status === "IN_PROGRESS" && isMine ? (
                        <Pressable
                          style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]}
                          onPress={() => void handleSupportUpdateStatus(req, "RESOLVED")}
                        >
                          <Text style={styles.smallButtonText}>Xong</Text>
                        </Pressable>
                      ) : req.status === "RESOLVED" && (role === "WAITER" || role === "MANAGER") ? (
                        <Pressable
                          style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]}
                          onPress={() => void handleSupportUpdateStatus(req, "CLOSED")}
                        >
                          <Text style={styles.smallButtonText}>Đóng</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                );
              })}

              {!loading && supportRequests.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyStateIcon}>✅</Text>
                  <Text style={styles.emptyStateTitle}>Không có yêu cầu hỗ trợ</Text>
                  <Text style={styles.emptyStateSubtitle}>Tất cả yêu cầu đã được xử lý</Text>
                </View>
              ) : null}
            </View>
          )}

          {activeTab === "menu" && (
            <View style={styles.mGrid}>
              {visibleMenuItems.map((item: MenuItemResponse) => {
                const isAvailable = item.available !== false;
                return (
                <View key={item.id} style={styles.mCard}>
                  {/* Image */}
                  <View style={[styles.mCardImgWrap, { backgroundColor: "#2C3E50" }]}>
                    {item.imageUrl ? (
                      <Image source={{ uri: item.imageUrl }} style={styles.mCardImg} resizeMode="cover" />
                    ) : (
                      <View style={styles.mCardImgFallback}>
                        <Text style={styles.mCardImgEmoji}>🍽</Text>
                      </View>
                    )}
                    {!isAvailable && (
                      <View style={styles.mCardDimOverlay}>
                        <Text style={styles.mCardDimText}>Tạm hết</Text>
                      </View>
                    )}
                    {isAvailable && (
                      <Pressable style={({ pressed }) => [styles.mCardAddBtnNew, pressed && { opacity: 0.85, transform: [{ scale: 0.95 }] }]}>
                        <Text style={styles.mCardAddBtnText}>+</Text>
                      </Pressable>
                    )}
                    {item.cookTime && (
                      <Text style={styles.mCardCookTimeOverlay}>⏱ {item.cookTime}m</Text>
                    )}
                  </View>
                  {/* Body */}
                  <View style={styles.mCardBody}>
                    <Text style={styles.mCardName} numberOfLines={2}>{item.name}</Text>
                    {item.description ? <Text style={styles.mCardDesc} numberOfLines={1}>{item.description}</Text> : null}
                    <Text style={styles.mCardPriceYellow}>{formatMoneyOrContact(item.price)}</Text>
                  </View>
                </View>
              );})}
              {!loading && visibleMenuItems.length === 0 && (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyStateIcon}>🍽️</Text>
                  <Text style={styles.emptyStateTitle}>Không có món trong danh mục này</Text>
                </View>
              )}
            </View>
          )}

          {(activeTab === "orders" || activeTab === "payments") && (
            <View style={styles.list}>
              {orders.map((order) => {
                const doneItemCount = order.items.filter((i) => i.status === "DONE").length;
                const canServeAll = (role === "WAITER" || role === "MANAGER")
                  && (order.status === "PREPARING" || order.status === "READY")
                  && doneItemCount > 0;
                const table = tables.find(t => t.id === order.tableId);
                const orderStatusColor =
                  order.status === "CREATED" ? "#1F5FBF" :
                  order.status === "CONFIRMED" ? "#1E8C5A" :
                  order.status === "PREPARING" ? "#D97706" :
                  order.status === "READY" ? "#059669" :
                  order.status === "SERVED" ? "#6B7280" :
                  order.status === "PAID" ? "#0D9488" :
                  order.status === "CANCELLED" ? "#DC2626" : "#6B7280";
                return (
                <View key={order.id} style={styles.card}>
                  {/* Table name - PROMINENT */}
                  {table && <Text style={styles.cardTableNameLarge}>Bàn {table.tableCode}</Text>}
                  
                  <View style={styles.rowBetween}>
                    <Text style={styles.cardOrderId}>Order #{order.id}  ·  {order.items.length} món</Text>
                    <Text style={styles.priceSmall}>{formatMoneyOrContact(order.totalAmount)}</Text>
                  </View>
                  
                  <View style={styles.rowBetween}>
                    <View style={[styles.orderStatusBadge, { backgroundColor: orderStatusColor }]}>
                      <Text style={styles.orderStatusText}>{ORDER_LABEL[order.status]}</Text>
                    </View>
                    {doneItemCount > 0 && (
                      <View style={styles.readyBadge}>
                        <Text style={styles.readyBadgeText}>🍽 {doneItemCount} món sẵn sàng</Text>
                      </View>
                    )}
                  </View>

                  {/* Items preview */}
                  <View style={styles.orderItemsPreview}>
                    {order.items.slice(0, 3).map((item) => {
                      const isReady = item.status === "DONE";
                      const menuItem = menuItems.find((m) => m.id === item.menuItemId) || { name: `Món #${item.menuItemId}` };
                      return (
                        <View key={item.id} style={[styles.itemPreviewRow, isReady && styles.itemPreviewRowReady]}>
                          <Text style={styles.itemPreviewName} numberOfLines={1}>
                            {menuItem.name} ×{item.quantity}
                          </Text>
                          <Text style={[styles.itemPreviewStatus, isReady && styles.itemPreviewStatusReady]}>
                            {ORDER_ITEM_LABEL[item.status] ?? item.status}
                          </Text>
                        </View>
                      );
                    })}
                    {order.items.length > 3 && (
                      <Text style={styles.itemPreviewMore}>+{order.items.length - 3} món khác</Text>
                    )}
                  </View>

                  <View style={styles.actionRow}>
                    <Pressable style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]} onPress={() => void handleOrderDetail(order)}>
                      <Text style={styles.smallButtonText}>{selectedOrder?.id === order.id ? "Ẩn chi tiết" : "Chi tiết"}</Text>
                    </Pressable>

                    {(role === "WAITER" || role === "MANAGER") && order.status === "CREATED" ? (
                      <>
                        <Pressable style={({ pressed }) => [styles.confirmButton, pressed && styles.buttonPressed]} onPress={() => void handleConfirm(order)}>
                          <Text style={styles.confirmButtonText}>Xác nhận</Text>
                        </Pressable>
                        <Pressable style={({ pressed }) => [styles.dangerButton, pressed && styles.buttonPressed]} onPress={() => void handleCancel(order)}>
                          <Text style={styles.dangerButtonText}>Hủy</Text>
                        </Pressable>
                      </>
                    ) : null}

                    {canServeAll ? (
                      <Pressable style={({ pressed }) => [styles.confirmButton, pressed && styles.buttonPressed]} onPress={() => void handleServeAll(order)}>
                        <Text style={styles.confirmButtonText}>Phục vụ tất cả</Text>
                      </Pressable>
                    ) : null}

                    {(role === "CASHIER" || role === "MANAGER") && activeTab === "payments" && order.status === "SERVED" ? (
                      <>
                        <Pressable
                          style={({ pressed }) => [styles.smallButton, paymentMethod === "CASH" && styles.smallButtonActive, pressed && styles.buttonPressed]}
                          onPress={() => setPaymentMethod("CASH")}
                        >
                          <Text style={styles.smallButtonText}>Tiền mặt</Text>
                        </Pressable>
                        <Pressable
                          style={({ pressed }) => [styles.smallButton, paymentMethod === "QR_CODE" && styles.smallButtonActive, pressed && styles.buttonPressed]}
                          onPress={() => setPaymentMethod("QR_CODE")}
                        >
                          <Text style={styles.smallButtonText}>VietQR</Text>
                        </Pressable>
                        <Pressable style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]} onPress={() => void handleCreatePayment(order)}>
                          <Text style={styles.smallButtonText}>Thanh toán</Text>
                        </Pressable>
                        <Pressable style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]} onPress={() => void handleCheckPayment(order)}>
                          <Text style={styles.smallButtonText}>Kiểm tra</Text>
                        </Pressable>
                      </>
                    ) : null}
                  </View>

                  {selectedOrder?.id === order.id ? (
                    <View style={styles.detailBox}>
                      {selectedOrder.items.map((item) => {
                        const isReady    = item.status === "DONE";
                        const isServed   = item.status === "SERVED";
                        const canServe   = (role === "WAITER" || role === "MANAGER") && isReady
                          && (selectedOrder.status === "PREPARING" || selectedOrder.status === "READY" || selectedOrder.status === "SERVED");
                        return (
                          <View
                            key={item.id}
                            style={[styles.rowBetween, styles.detailRow, isReady && styles.detailRowReady]}
                          >
                            <View style={{ flex: 1, marginRight: 8 }}>
                              <Text style={[styles.detailText, isServed && styles.detailTextMuted]}>
                                {(menuItems.find((m) => m.id === item.menuItemId)?.name ?? menuItemNames[item.menuItemId] ?? `Món #${item.menuItemId}`) + ` ×${item.quantity}`}
                                {item.note ? `  · ${item.note}` : ""}
                              </Text>
                              <Text style={[
                                styles.detailStatusText,
                                isReady  && styles.detailStatusReady,
                                isServed && styles.detailStatusServed,
                              ]}>
                                {ORDER_ITEM_LABEL[item.status] ?? item.status}
                              </Text>
                            </View>
                            {canServe ? (
                              <Pressable
                                style={({ pressed }) => [styles.serveButton, pressed && styles.buttonPressed]}
                                onPress={() => void handleServeItem(order.id, item.id)}
                              >
                                <Text style={styles.serveButtonText}>Phục vụ</Text>
                              </Pressable>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
                );
              })}

              {!loading && orders.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyStateIcon}>📋</Text>
                  <Text style={styles.emptyStateTitle}>Không có đơn phù hợp</Text>
                  <Text style={styles.emptyStateSubtitle}>Chưa có đơn nào ở trạng thái này</Text>
                </View>
              ) : null}
            </View>
          )}
        </ScrollView>

        <View style={[styles.bottomNav, { paddingBottom: bottomInset }]}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            const iconColor = isActive ? "#C9A227" : "rgba(255,255,255,0.42)";
            const iconName = (isActive ? TAB_ICON[tab.key].active : TAB_ICON[tab.key].default) as React.ComponentProps<typeof Ionicons>["name"];
            return (
              <Pressable
                key={tab.key}
                style={({ pressed }) => [styles.bottomTabBtn, isActive && styles.bottomTabBtnActive, pressed && styles.buttonPressed]}
                onPress={() => {
                  setActiveTab(tab.key);
                  // Clear unseen badge when waiter taps the orders tab
                  if (tab.key === "orders") setUnseenCreatedCount(0);
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
              >
                <View style={styles.bottomTabCol}>
                  <Ionicons name={iconName} size={22} color={iconColor} />
                  <View style={styles.bottomTabLabelRow}>
                    <Text style={[styles.bottomTabLabel, isActive && styles.bottomTabLabelActive]}>{tab.label}</Text>
                    {tab.key === "orders" && unseenCreatedCount > 0 ? (
                      // Hot-orange badge for truly new orders the waiter hasn't seen yet
                      <View style={[styles.bottomTabBadge, { backgroundColor: "#F97316", borderColor: "#1C1C1E" }]}>
                        <Text style={styles.bottomTabBadgeText}>{unseenCreatedCount > 99 ? "99+" : unseenCreatedCount}</Text>
                      </View>
                    ) : tab.key === "orders" && pendingOrderCount > 0 ? (
                      <View style={styles.bottomTabBadge}>
                        <Text style={styles.bottomTabBadgeText}>{pendingOrderCount > 99 ? "99+" : pendingOrderCount}</Text>
                      </View>
                    ) : null}
                    {tab.key === "support" && openSupportCount > 0 ? (
                      <View style={[styles.bottomTabBadge, styles.tabBadgeAlertFill]}>
                        <Text style={styles.bottomTabBadgeText}>{openSupportCount > 99 ? "99+" : openSupportCount}</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* ─── Create Order Modal ──────────────────────────────────────── */}
      <Modal
        visible={!!createOrderTable}
        animationType="slide"
        transparent={false}
        onRequestClose={handleCloseCreateOrder}
      >
        <SafeAreaView style={styles.coShell} edges={["top", "left", "right", "bottom"]}>
          <View style={styles.coHeader}>
            <Pressable
              style={({ pressed }) => [styles.coCloseBtn, pressed && styles.buttonPressed]}
              onPress={handleCloseCreateOrder}
              disabled={submittingOrder}
            >
              <Text style={styles.coCloseBtnText}>← Hủy</Text>
            </Pressable>
            <View style={styles.flex1}>
              <Text style={styles.coTitle}>Tạo đơn mới</Text>
              <Text style={styles.coSubtitle}>Bàn {createOrderTable?.tableCode}</Text>
            </View>
          </View>

          {categories.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.mCatBar}
              contentContainerStyle={styles.mCatRow}
            >
              <Pressable
                style={[styles.mCatPill, createOrderCatFilter === "all" && styles.mCatPillActive]}
                onPress={() => setCreateOrderCatFilter("all")}
              >
                <Text style={[styles.mCatPillText, createOrderCatFilter === "all" && styles.mCatPillTextActive]}>Tất cả</Text>
              </Pressable>
              {categories.map((cat) => (
                <Pressable
                  key={cat.id}
                  style={[styles.mCatPill, createOrderCatFilter === cat.id && styles.mCatPillActive]}
                  onPress={() => setCreateOrderCatFilter(cat.id)}
                >
                  <Text style={[styles.mCatPillText, createOrderCatFilter === cat.id && styles.mCatPillTextActive]}>{cat.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          <ScrollView style={styles.flex1} contentContainerStyle={styles.coScrollContent}>
            {loading && menuItems.length === 0 ? (
              <ActivityIndicator style={styles.loader} color="#C9A227" />
            ) : null}

            <View style={styles.mGrid}>
              {filteredCreateOrderItems.map((item) => {
                const qty = createCart[item.id] ?? 0;
                const isAvailable = item.available !== false;
                return (
                  <View key={item.id} style={styles.mCard}>
                    <View style={styles.mCardImgWrap}>
                      {item.imageUrl ? (
                        <Image source={{ uri: item.imageUrl }} style={styles.mCardImg} resizeMode="cover" />
                      ) : (
                        <View style={styles.mCardImgFallback}>
                          <Text style={styles.mCardImgEmoji}>🍽</Text>
                        </View>
                      )}
                      {!isAvailable && (
                        <View style={styles.mCardDimOverlay}>
                          <Text style={styles.mCardDimText}>Tạm hết</Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.mCardBody}>
                      <Text style={styles.mCardName} numberOfLines={2}>{item.name}</Text>
                      <Text style={styles.mCardPrice}>{formatMoneyOrContact(item.price)}</Text>
                      {isAvailable ? (
                        qty > 0 ? (
                          <View style={styles.coQtyRow}>
                            <Pressable
                              onPress={() => handleRemoveFromCart(item.id)}
                              style={({ pressed }) => [styles.coQtyBtn, pressed && styles.buttonPressed]}
                            >
                              <Text style={styles.coQtyBtnText}>−</Text>
                            </Pressable>
                            <Text style={styles.coQtyValue}>{qty}</Text>
                            <Pressable
                              onPress={() => handleAddToCart(item.id)}
                              style={({ pressed }) => [styles.coQtyBtn, pressed && styles.buttonPressed]}
                            >
                              <Text style={styles.coQtyBtnText}>+</Text>
                            </Pressable>
                          </View>
                        ) : (
                          <Pressable
                            onPress={() => handleAddToCart(item.id)}
                            style={({ pressed }) => [styles.coAddBtn, pressed && styles.buttonPressed]}
                          >
                            <Text style={styles.coAddBtnText}>+ Thêm</Text>
                          </Pressable>
                        )
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>

            {!loading && filteredCreateOrderItems.length === 0 && (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateIcon}>🍽️</Text>
                <Text style={styles.emptyStateTitle}>Không có món trong danh mục này</Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.coNoteWrap}>
            <TextInput
              style={styles.coNoteInput}
              placeholder="Ghi chú đơn (ví dụ: ít cay, không hành...)"
              placeholderTextColor="#9CA3AF"
              value={createNote}
              onChangeText={setCreateNote}
              multiline
              maxLength={200}
            />
          </View>

          <View style={styles.coFooter}>
            <View style={styles.flex1}>
              <Text style={styles.coFooterMeta}>{cartStats.count} món · {cartStats.types} loại</Text>
              <Text style={styles.coFooterTotal}>{formatMoney(cartStats.total)}</Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.coSubmitBtn,
                (cartStats.count === 0 || submittingOrder) && styles.coSubmitBtnDisabled,
                pressed && styles.buttonPressed,
              ]}
              onPress={() => void handleSubmitCreateOrder()}
              disabled={cartStats.count === 0 || submittingOrder}
            >
              <Text style={styles.coSubmitBtnText}>
                {submittingOrder ? "Đang tạo..." : "Tạo đơn"}
              </Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#FAF8F0" },

  loginShell: { flex: 1, backgroundColor: "#1C1C1E" },
  loginOuter: { flex: 1, justifyContent: "center", paddingHorizontal: 20 },
  loginCard: {
    width: "100%",
    maxWidth: 360,
    alignSelf: "center",
    borderRadius: 20,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.5,
    shadowRadius: 50,
    elevation: 12,
    gap: 14,
  },
  loginLogoRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  loginLogoBadge: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: "#1C1C1E",
    borderWidth: 1.5,
    borderColor: "#3A3A3C",
    justifyContent: "center",
    alignItems: "center",
  },
  loginLogoLetter: { fontSize: 26, fontWeight: "700", color: "#C9A227" },
  loginTitle: { fontSize: 18, fontWeight: "700", color: "#1C1C1E" },
  loginSubtitle: { marginTop: 2, fontSize: 13, fontWeight: "400", color: "#8E8E93" },
  input: {
    borderWidth: 1.5,
    borderColor: "#E0D5C0",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 14 : 12,
    fontSize: 15,
    color: "#1A1208",
  },
  error: { color: "#EF4444", marginVertical: 4, fontSize: 13 },
  primaryButton: {
    backgroundColor: "#C9A227",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    shadowColor: "#C9A227",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  primaryButtonText: { color: "#1A1208", fontWeight: "700", fontSize: 15 },

  shellCream: { flex: 1, backgroundColor: "#FAF8F0" },
  columnFlex: { flex: 1, flexDirection: "column" },
  flex1: { flex: 1 },
  scrollFlex: { flex: 1 },
  posPageHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E0D5C0",
  },
  posTitle: { fontSize: 17, fontWeight: "700", color: "#1C1C1E" },
  posSubtitle: { marginTop: 3, fontSize: 13, fontWeight: "500", color: "#636366" },
  soundToggleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  headerLogoutBtn: {
    borderWidth: 1.5,
    borderColor: "#E0D5C0",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#FAFAFA",
  },
  headerLogoutText: { color: "#48484A", fontWeight: "600", fontSize: 13 },

  bottomNav: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: "#1C1C1E",
    borderTopWidth: 1,
    borderTopColor: "#3A3A3C",
    paddingTop: 6,
  },
  bottomTabBtn: {
    flex: 1,
    minHeight: 58,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  bottomTabBtnActive: { backgroundColor: "rgba(201,162,39,0.12)" },
  bottomTabCol: { alignItems: "center", justifyContent: "center", gap: 3 },
  bottomTabLabelRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  bottomTabLabel: { fontSize: 11, fontWeight: "600", color: "rgba(255,255,255,0.42)" },
  bottomTabLabelActive: { color: "#C9A227" },
  bottomTabBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: "#EF4444",
    borderWidth: 2,
    borderColor: "#1C1C1E",
    alignItems: "center",
    justifyContent: "center",
  },
  tabBadgeAlertFill: { backgroundColor: "#EF4444" },
  bottomTabBadgeText: { color: "#FFF", fontSize: 10, fontWeight: "800" },

  statusWrap: { marginBottom: 8, paddingHorizontal: 14, marginTop: 8 },
  statusScroller: { maxHeight: 44 },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E0D5C0",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
  },
  statusChipActive: { backgroundColor: "#1C1C1E", borderColor: "#1C1C1E" },
  statusChipText: { color: "#48484A", fontWeight: "600", fontSize: 13 },
  statusChipTextActive: { color: "#FFFFFF" },
  statusChipBadge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: "#EF4444",
    alignItems: "center",
    justifyContent: "center",
  },
  statusChipBadgeActive: {
    backgroundColor: "#C9A227",
  },
  /** Hot-orange badge shown when there are unseen NEW orders — high-attention color */
  statusChipBadgeNew: {
    backgroundColor: "#F97316",
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    // Shadow to make it pop on the chip
    shadowColor: "#F97316",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.55,
    shadowRadius: 3,
    elevation: 3,
  },
  statusChipBadgeText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "800",
  },
  statusChipBadgeTextActive: {
    color: "#1C1C1E",
  },
  pollingText: { marginHorizontal: 18, marginTop: 4, marginBottom: 2, color: "#636366", fontSize: 13 },
  loader: { marginBottom: 8 },
  scrollContent: { paddingHorizontal: 14, paddingTop: 10 },
  list: { gap: 10 },
  grid: { gap: 10 },
  secondaryOutlineButton: {
    borderRadius: 9,
    borderWidth: 2,
    borderColor: "#8B6914",
    backgroundColor: "#FFFBF0",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  secondaryOutlineButtonText: { color: "#6B5610", fontWeight: "700", fontSize: 12 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#E8E0D0",
    backgroundColor: "#FFFFFF",
    padding: 12,
    gap: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  cardPressed: { transform: [{ scale: 0.99 }] },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  cardTitle: { color: "#1F2937", fontSize: 16, fontWeight: "700" },
  cardSub: { color: "#6B7280", fontSize: 13 },
  badge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 5 },
  badgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  price: { color: "#C9A227", fontWeight: "800", fontSize: 16 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  smallButton: {
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#D1D9E6",
    backgroundColor: "#F8FAFD",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  smallButtonActive: { borderColor: "#C49A2B", backgroundColor: "#F5E6A3" },
  smallButtonText: { color: "#334155", fontWeight: "600", fontSize: 12 },
  dangerButton: {
    borderRadius: 9,
    backgroundColor: "#FEE2E2",
    borderWidth: 1,
    borderColor: "#FCA5A5",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  dangerButtonText: { color: "#B91C1C", fontWeight: "700", fontSize: 12 },
  detailBox: {
    borderTopWidth: 1,
    borderTopColor: "#E5EAF1",
    marginTop: 8,
    paddingTop: 8,
    gap: 8,
  },
  detailText: { color: "#4B5563", fontSize: 13, flex: 1 },
  tinyButton: {
    borderRadius: 8,
    backgroundColor: "#1D4ED8",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  tinyButtonText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  emptyText: { color: "#6B7280", textAlign: "center", marginTop: 16 },
  buttonPressed: { opacity: 0.88 },

  // ── Table screen ─────────────────────────────────────────────────────────────
  tblSearch: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
    fontSize: 14,
    color: "#111827",
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
    },
  tblFilterRow: { flexDirection: "row", gap: 6, paddingBottom: 12 },
  tblPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  tblPillActive: { backgroundColor: "#111827", borderColor: "#111827" },
  tblPillDot: { width: 7, height: 7, borderRadius: 4 },
  tblPillText: { fontSize: 12, fontWeight: "600", color: "#6B7280" },
  tblPillTextActive: { color: "#FFFFFF" },

  tblGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "space-between" },
  tblCard: {
    width: "48%",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  tblCardBar: { height: 4, width: "100%" },
  tblCardBody: { padding: 12, gap: 8 },
  tblCardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tblCardName: { fontSize: 16, fontWeight: "800", color: "#111827", letterSpacing: -0.3 },
  tblStatusBadge: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  tblStatusText: { fontSize: 10, fontWeight: "700" },
  tblCardMeta: { fontSize: 12, color: "#9CA3AF", fontWeight: "500" },
  tblCardBtns: { flexDirection: "row", gap: 6 },
  tblBtnSecondary: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#E5E7EB",
    backgroundColor: "#F9FAFB",
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: "center",
  },
  tblBtnSecondaryText: { fontSize: 11, fontWeight: "600", color: "#374151" },
  tblBtnPrimary: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: "center",
  },
  tblBtnPrimaryText: { fontSize: 11, fontWeight: "700", color: "#FFFFFF" },
  tblBtnPressed: { opacity: 0.82, transform: [{ scale: 0.97 }] },

  // ── Menu 2-column grid (keep tableGrid alias) ─────────────────────────────────
  tableGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },

  // ── Menu tab ──────────────────────────────────────────────────────────────────
  mCatBar: {
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    maxHeight: 48,
  },
  mCatRow: { flexDirection: "row", gap: 6, paddingHorizontal: 14, paddingVertical: 8 },
  mCatPill: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#F9FAFB",
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  mCatPillActive: { backgroundColor: "#C9A227", borderColor: "#C9A227" },
  mCatPillText: { fontSize: 12, fontWeight: "600", color: "#6B7280" },
  mCatPillTextActive: { color: "#FFFFFF" },

  mGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, justifyContent: "space-between" },
  mCard: {
    width: "48%",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  mCardImgWrap: { width: "100%", aspectRatio: 4 / 3, backgroundColor: "#F3F4F6" },
  mCardImg: { width: "100%", height: "100%" },
  mCardImgFallback: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#F9EFD9" },
  mCardImgEmoji: { fontSize: 32 },
  mCardDimOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.52)",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 0,
  },
  mCardDimText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  mCardAddBtn: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#C9A227",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#C9A227",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.45,
    shadowRadius: 4,
    elevation: 4,
  },
  mCardAddBtnText: { color: "#FFFFFF", fontSize: 18, fontWeight: "700", lineHeight: 22, marginTop: -1 },
  mCardBody: { padding: 10, gap: 3 },
  mCardName: { fontSize: 13, fontWeight: "700", color: "#111827", lineHeight: 18 },
  mCardDesc: { fontSize: 11, color: "#9CA3AF", lineHeight: 15 },
  mCardPrice: { fontSize: 14, fontWeight: "800", color: "#C9A227", marginTop: 2 },
  mCardCookTime: { fontSize: 10, color: "#6B7280", marginTop: 1 },

  // ── Support ticket cards ──────────────────────────────────────────────────────
  supportTicket: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#E8EDF3",
    backgroundColor: "#FFFFFF",
    borderLeftWidth: 3,
    borderLeftColor: "#D94040",
    overflow: "hidden",
    paddingVertical: 12,
    paddingHorizontal: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  supportTicketBody: { gap: 6 },
  supportTicketHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  supportTicketTitle: { fontSize: 14, fontWeight: "700", color: "#1F2937" },
  supportStatusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  supportStatusBadgeText: { fontSize: 10, fontWeight: "700", color: "#FFFFFF" },
  supportTicketMsg: { fontSize: 13, color: "#4B5563", fontStyle: "italic", marginTop: 2 },
  supportTicketMeta: { fontSize: 12, color: "#9CA3AF", fontWeight: "500" },

  // ── Confirm (green primary) button ────────────────────────────────────────────
  confirmButton: {
    borderRadius: 9,
    backgroundColor: "#16A34A",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  confirmButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 12 },

  // ── Dismissable error banner ──────────────────────────────────────────────────
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FEF2F2",
    borderLeftWidth: 3,
    borderLeftColor: "#EF4444",
    marginHorizontal: 14,
    marginVertical: 6,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  errorBannerText: { flex: 1, color: "#B91C1C", fontSize: 13, fontWeight: "500" },
  errorBannerDismiss: { color: "#EF4444", fontSize: 20, fontWeight: "700", lineHeight: 22 },

  // ── Rich empty states ─────────────────────────────────────────────────────────
  emptyState: {
    alignItems: "center",
    paddingVertical: 40,
    paddingHorizontal: 24,
    gap: 8,
  },
  emptyStateIcon: { fontSize: 44 },
  emptyStateTitle: { fontSize: 15, fontWeight: "600", color: "#374151", textAlign: "center" },
  emptyStateSubtitle: { fontSize: 13, color: "#9CA3AF", textAlign: "center" },

  // ── Order card: ready-items badge ─────────────────────────────────────────────
  readyBadge: {
    borderRadius: 8,
    backgroundColor: "#DCFCE7",
    borderWidth: 1,
    borderColor: "#86EFAC",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  readyBadgeText: { fontSize: 11, fontWeight: "700", color: "#15803D" },

  // ── Per-item serve button (compact, fits inside detail row) ───────────────────
  serveButton: {
    borderRadius: 8,
    backgroundColor: "#16A34A",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  serveButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 11 },

  // ── Create-order modal ────────────────────────────────────────────────────────
  coShell: { flex: 1, backgroundColor: "#FAF8F0" },
  coHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: 1,
    borderBottomColor: "#E0D5C0",
  },
  coCloseBtn: {
    borderWidth: 1.5,
    borderColor: "#E0D5C0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#FAFAFA",
  },
  coCloseBtnText: { color: "#48484A", fontWeight: "600", fontSize: 13 },
  coTitle: { fontSize: 17, fontWeight: "700", color: "#1C1C1E" },
  coSubtitle: { marginTop: 2, fontSize: 13, fontWeight: "500", color: "#636366" },
  coScrollContent: { padding: 14, paddingBottom: 20 },
  coQtyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
    backgroundColor: "#F5E6A3",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#C9A227",
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  coQtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: "#C9A227",
    alignItems: "center",
    justifyContent: "center",
  },
  coQtyBtnText: { color: "#1A1208", fontSize: 16, fontWeight: "800", lineHeight: 18 },
  coQtyValue: { color: "#1A1208", fontSize: 14, fontWeight: "800" },
  coAddBtn: {
    marginTop: 6,
    borderRadius: 10,
    backgroundColor: "#1C1C1E",
    paddingVertical: 8,
    alignItems: "center",
  },
  coAddBtnText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  coNoteWrap: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#E0D5C0",
  },
  coNoteInput: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    backgroundColor: "#F9FAFB",
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: "#111827",
    minHeight: 36,
    maxHeight: 80,
  },
  coFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#E0D5C0",
  },
  coFooterMeta: { fontSize: 12, color: "#636366", fontWeight: "500" },
  coFooterTotal: { fontSize: 18, fontWeight: "800", color: "#C9A227", marginTop: 2 },
  coSubmitBtn: {
    backgroundColor: "#16A34A",
    borderRadius: 12,
    paddingHorizontal: 22,
    paddingVertical: 12,
    minWidth: 120,
    alignItems: "center",
    shadowColor: "#16A34A",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  coSubmitBtnDisabled: { backgroundColor: "#9CA3AF", shadowOpacity: 0, elevation: 0 },
  coSubmitBtnText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },

  // ── Detail box rows ───────────────────────────────────────────────────────────
  detailRow: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 8,
  },
  detailRowReady: {
    backgroundColor: "#F0FDF4",
    borderWidth: 1,
    borderColor: "#BBF7D0",
  },
  detailStatusText: { fontSize: 11, fontWeight: "600", color: "#9CA3AF", marginTop: 2 },
  detailStatusReady: { color: "#16A34A" },
  detailStatusServed: { color: "#9CA3AF" },
  detailTextMuted: { color: "#D1D5DB" },

  // ── New table summary row ─────────────────────────────────────────────────────
  tblSummaryRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 16,
    marginHorizontal: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: "#F0F4F8",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#D7E0E8",
  },
  tblSummaryCol: { alignItems: "center", gap: 4 },
  tblSummaryValue: { fontSize: 18, fontWeight: "800", color: "#1F5FBF" },
  tblSummaryLabel: { fontSize: 11, color: "#64748B", fontWeight: "600" },

  // ── Order card improvements ───────────────────────────────────────────────────
  cardTableNameLarge: { fontSize: 16, fontWeight: "800", color: "#1F5FBF", marginBottom: 6 },
  cardOrderId: { fontSize: 12, color: "#64748B", fontWeight: "500" },
  priceSmall: { fontSize: 15, fontWeight: "700", color: "#B8922A" },
  orderStatusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  orderStatusText: { fontSize: 11, fontWeight: "700", color: "#FFFFFF" },
  
  // ── Order items preview ───────────────────────────────────────────────────
  orderItemsPreview: { 
    marginTop: 8, 
    paddingVertical: 6, 
    borderTopWidth: 1, 
    borderTopColor: "#E5EAF1",
    gap: 4,
  },
  itemPreviewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  itemPreviewRowReady: { backgroundColor: "#F0FDF4", paddingHorizontal: 6, borderRadius: 4 },
  itemPreviewName: { fontSize: 12, color: "#374151", fontWeight: "500" },
  itemPreviewStatus: { fontSize: 10, color: "#9CA3AF" },
  itemPreviewStatusReady: { color: "#16A34A", fontWeight: "600" },
  itemPreviewMore: { fontSize: 11, color: "#D1D5DB", fontStyle: "italic", paddingTop: 2 },

  // ── Menu card improvements ────────────────────────────────────────────────────
  mCardAddBtnNew: {
    position: "absolute",
    bottom: 10,
    right: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#D97706",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#D97706",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 5,
  },
  mCardCookTimeOverlay: {
    position: "absolute",
    bottom: 8,
    left: 8,
    backgroundColor: "rgba(0,0,0,0.65)",
    color: "#FFFFFF",
    fontSize: 9,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  mCardPriceYellow: { fontSize: 15, fontWeight: "800", color: "#D97706", marginTop: 4 },

  // ── Support card improvements ─────────────────────────────────────────────────
  supportNewBadge: {
    backgroundColor: "#DC2626",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  supportNewBadgeText: { fontSize: 9, fontWeight: "800", color: "#FFFFFF", letterSpacing: 0.3 },
  supportAssignBtn: {
    borderRadius: 8,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#D4C4A8",
    paddingHorizontal: 14,
    paddingVertical: 7,
    alignItems: "center",
    alignSelf: "flex-end",
    marginTop: 4,
  },
  supportAssignBtnText: { color: "#B8922A", fontWeight: "700", fontSize: 12 },
});
