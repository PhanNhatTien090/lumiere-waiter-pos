import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
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

  const role = staff?.role;
  const roleStatuses = useMemo(() => (role ? ORDER_STATUS_BY_ROLE[role] : ["CREATED"]) as OrderStatus[], [role]);

  // ─── WebSocket: realtime notifications ────────────────────────────────────────
  useWaiterSocket({
    enabled: !!accessToken,

    // /topic/waiter/ready — ALL items in an order are DONE → full alert
    onOrderReady: (payload) => {
      Alert.alert(
        "🍽 Món đã sẵn sàng",
        `Order #${payload.orderId} — Bàn #${payload.tableId} đã sẵn sàng phục vụ!`,
        [{ text: "OK" }]
      );
      void fetchOrders("READY", true);
    },

    // /topic/waiter/new-order — customer placed a new order via QR
    onNewOrder: (newOrder) => {
      upsertOrder(newOrder);
      Alert.alert(
        "📦 Đơn mới",
        `Bàn #${newOrder.tableId} vừa đặt đơn #${newOrder.id} (${newOrder.items.length} món).`,
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
        const results = await Promise.all(activeCats.map((cat) => menuAPI.listByCategory(cat.id)));
        setMenuItems(results.flatMap((r) => r.data.data));
      } else {
        const res = await menuAPI.listByCategory(Number(menuCatFilter));
        setMenuItems(res.data.data);
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
      setOrders(response.data.data);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Không thể tải danh sách đơn");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [accessToken, setError, setLoading, setOrders]);

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
      o.items.some((i) => i.status === "READY")   // any item ready to serve
    ).length,
    [orders]
  );
  const openSupportCount = useMemo(() => supportRequests.filter((r) => r.status === "CREATED").length, [supportRequests]);

  // Categories come directly from /menu/categories (sorted by displayOrder on fetch).
  // Items are pre-filtered by the API, so visibleMenuItems = menuItems.
  const visibleMenuItems = menuItems;

  const filteredTables = useMemo(() => tables.filter((t) => {
    const matchStatus = tableFilter === "all" || t.status === tableFilter;
    const matchSearch = !tableSearch.trim() || t.tableCode.toLowerCase().includes(tableSearch.toLowerCase());
    return matchStatus && matchSearch;
  }), [tables, tableFilter, tableSearch]);

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
      upsertOrder(response.data.data);
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

      Alert.alert("Thanh toán", `Trạng thái: ${response.data.data.status}`);
      const next = await orderAPI.getOrder(order.id);
      upsertOrder(next.data.data);
      await fetchOrders(orderStatus, true);
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
      const res = await supportAPI.assign(req.id, { staffId: staff.id });
      setSupportRequests((prev) => prev.map((r) => (r.id === req.id ? res.data.data : r)));
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
      const res = await supportAPI.updateStatus(req.id, { status });
      setSupportRequests((prev) => prev.map((r) => (r.id === req.id ? res.data.data : r)));
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
      <View style={styles.columnFlex}>
        <View style={styles.posPageHeader}>
          <View style={styles.flex1}>
            <Text style={styles.posTitle}>LUMIÈRE POS</Text>
            <Text style={styles.posSubtitle}>{staff.name} · {staff.role}</Text>
          </View>
          <Pressable style={({ pressed }) => [styles.headerLogoutBtn, pressed && styles.buttonPressed]} onPress={handleLogout}>
            <Text style={styles.headerLogoutText}>Đăng xuất</Text>
          </Pressable>
        </View>

        {activeTab === "support" ? <Text style={styles.pollingText}>Tự làm mới mỗi 12 giây · Theo thời gian tạo giảm dần</Text> : null}

        {(activeTab === "orders" || activeTab === "payments") && (
          <View style={styles.statusWrap}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.statusScroller}>
              {roleStatuses.map((status) => (
                <Pressable
                  key={status}
                  style={({ pressed }) => [styles.statusChip, orderStatus === status && styles.statusChipActive, pressed && styles.buttonPressed]}
                  onPress={() => setOrderStatus(status)}
                >
                  <Text style={[styles.statusChipText, orderStatus === status && styles.statusChipTextActive]}>{ORDER_LABEL[status]}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {activeTab === "orders" ? <Text style={styles.pollingText}>Tự động cập nhật mỗi 8 giây</Text> : null}
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
                        <Text style={styles.tblCardMeta}>Tầng {table.floor}  ·  {table.capacity} chỗ</Text>

                        {/* Row 3: buttons */}
                        <View style={styles.tblCardBtns}>
                          <Pressable
                            style={({ pressed }) => [styles.tblBtnSecondary, pressed && styles.tblBtnPressed]}
                            onPress={() => router.push({ pathname: "/tables/[tableCode]", params: { tableCode: table.tableCode } })}
                          >
                            <Text style={styles.tblBtnSecondaryText}>Chi tiết</Text>
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
                  <View key={req.id} style={[styles.supportTicket, { backgroundColor: ticketBg, borderColor: statusColor + "44" }]}>
                    {/* Left accent bar */}
                    <View style={[styles.supportTicketAccent, { backgroundColor: statusColor }]} />

                    <View style={styles.supportTicketBody}>
                      {/* Header: title + status badge */}
                      <View style={styles.supportTicketHeader}>
                        <Text style={styles.supportTicketTitle}>
                          🔔 Bàn {req.tableCode}  ·  #{req.id}
                        </Text>
                        <View style={[styles.supportStatusBadge, { backgroundColor: statusColor }]}>
                          <Text style={styles.supportStatusBadgeText}>{SUPPORT_LABEL[req.status]}</Text>
                        </View>
                      </View>

                      {/* Message */}
                      {req.message ? (
                        <Text style={styles.supportTicketMsg}>"{req.message}"</Text>
                      ) : null}

                      {/* Meta: time + assignee */}
                      <View style={styles.rowBetween}>
                        <Text style={styles.supportTicketMeta}>🕐 {timeAgo(req.createdAt)}</Text>
                        <Text style={styles.supportTicketMeta}>
                          {req.staffId ? `👤 NV #${req.staffId}${isMine ? " (bạn)" : ""}` : "👤 Chưa giao"}
                        </Text>
                      </View>

                      {/* Actions */}
                      <View style={styles.actionRow}>
                        {(req.status === "CREATED" || (req.status === "ASSIGNED" && req.staffId == null)) && (
                          <Pressable
                            style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]}
                            onPress={() => void handleSupportAssignToMe(req)}
                          >
                            <Text style={styles.smallButtonText}>Gán cho tôi</Text>
                          </Pressable>
                        )}
                        {req.status === "ASSIGNED" && isMine ? (
                          <Pressable
                            style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]}
                            onPress={() => void handleSupportUpdateStatus(req, "IN_PROGRESS")}
                          >
                            <Text style={styles.smallButtonText}>Bắt đầu xử lý</Text>
                          </Pressable>
                        ) : null}
                        {req.status === "IN_PROGRESS" && isMine ? (
                          <Pressable
                            style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]}
                            onPress={() => void handleSupportUpdateStatus(req, "RESOLVED")}
                          >
                            <Text style={styles.smallButtonText}>Đã giải quyết</Text>
                          </Pressable>
                        ) : null}
                        {req.status === "RESOLVED" && (role === "WAITER" || role === "MANAGER") ? (
                          <Pressable
                            style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]}
                            onPress={() => void handleSupportUpdateStatus(req, "CLOSED")}
                          >
                            <Text style={styles.smallButtonText}>Đóng yêu cầu</Text>
                          </Pressable>
                        ) : null}
                      </View>
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
                    {isAvailable && (
                      <Pressable style={({ pressed }) => [styles.mCardAddBtn, pressed && { opacity: 0.8, transform: [{ scale: 0.92 }] }]}>
                        <Text style={styles.mCardAddBtnText}>+</Text>
                      </Pressable>
                    )}
                  </View>
                  {/* Body */}
                  <View style={styles.mCardBody}>
                    <Text style={styles.mCardName} numberOfLines={2}>{item.name}</Text>
                    {item.description ? <Text style={styles.mCardDesc} numberOfLines={1}>{item.description}</Text> : null}
                    <Text style={styles.mCardPrice}>{formatMoneyOrContact(item.price)}</Text>
                    {item.cookTime ? (
                      <Text style={styles.mCardCookTime}>⏱ ~{Math.round(item.cookTime / 60)} phút</Text>
                    ) : null}
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
                const readyItemCount = order.items.filter((i) => i.status === "READY").length;
                const canServeAll = (role === "WAITER" || role === "MANAGER") && order.status === "READY";
                return (
                <View key={order.id} style={styles.card}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.cardTitle}>Order #{order.id}</Text>
                    <Text style={styles.price}>{formatMoneyOrContact(order.totalAmount)}</Text>
                  </View>
                  <View style={styles.rowBetween}>
                    <Text style={styles.cardSub}>Trạng thái: {ORDER_LABEL[order.status]}</Text>
                    {readyItemCount > 0 && (
                      <View style={styles.readyBadge}>
                        <Text style={styles.readyBadgeText}>🍽 {readyItemCount} món sẵn sàng</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.cardSub}>Số món: {order.items.length}</Text>

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
                        const isReady    = item.status === "READY";
                        const isServed   = item.status === "SERVED";
                        const canServe   = (role === "WAITER" || role === "MANAGER") && isReady;
                        return (
                          <View
                            key={item.id}
                            style={[styles.rowBetween, styles.detailRow, isReady && styles.detailRowReady]}
                          >
                            <View style={{ flex: 1, marginRight: 8 }}>
                              <Text style={[styles.detailText, isServed && styles.detailTextMuted]}>
                                Món #{item.menuItemId}  ×{item.quantity}
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
                onPress={() => setActiveTab(tab.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
              >
                <View style={styles.bottomTabCol}>
                  <Ionicons name={iconName} size={22} color={iconColor} />
                  <View style={styles.bottomTabLabelRow}>
                    <Text style={[styles.bottomTabLabel, isActive && styles.bottomTabLabelActive]}>{tab.label}</Text>
                    {tab.key === "orders" && pendingOrderCount > 0 ? (
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

  tblGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tblCard: {
    width: "48%",
    borderRadius: 14,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
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
    paddingVertical: 8,
    alignItems: "center",
  },
  tblBtnSecondaryText: { fontSize: 12, fontWeight: "600", color: "#374151" },
  tblBtnPrimary: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  tblBtnPrimaryText: { fontSize: 12, fontWeight: "700", color: "#FFFFFF" },
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

  mGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  mCard: {
    width: "48%",
    borderRadius: 14,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.09,
    shadowRadius: 8,
    elevation: 3,
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
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E8E0D0",
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
    flexDirection: "row",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  supportTicketAccent: { width: 4 },
  supportTicketBody: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
  supportTicketHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  supportTicketTitle: { fontSize: 14, fontWeight: "700", color: "#1F2937", flex: 1 },
  supportStatusBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  supportStatusBadgeText: { fontSize: 10, fontWeight: "700", color: "#FFFFFF" },
  supportTicketMsg: { fontSize: 13, color: "#4B5563", fontStyle: "italic" },
  supportTicketMeta: { fontSize: 12, color: "#9CA3AF" },

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
});
