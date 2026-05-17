import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { menuAPI, orderAPI, tableAPI } from "../../src/api/endpoints";
import { ORDER_LABEL, TABLE_COLOR, TABLE_LABEL, formatMoney, nextTableStatus } from "../../src/constants/posUi";
import { useWaiterStore } from "../../src/store/waiterStore";
import { useWaiterSocket } from "../../src/hooks/useWaiterSocket";
import { OrderResponse, TableResponse } from "../../src/types";
import { confirmAction, notify } from "../../src/lib/confirm";

const POS_NEUTRAL = {
  shell: "#F4F6F8",
  surface: "#FFFFFF",
  surfaceSoft: "#F8FAFC",
  border: "#D7E0E8",
  text: "#0F172A",
  textMuted: "#64748B",
  active: "#1F5FBF",
  activeSoft: "#EAF1FB",
};

const ITEM_STATUS_COLOR: Record<string, string> = {
  PENDING:   "#94A3B8",
  PREPARING: "#3B82F6",
  DONE:      "#10B981",
  SERVED:    "#059669",
  CANCELLED: "#EF4444",
};

const ITEM_STATUS_LABEL: Record<string, string> = {
  PENDING:   "Chờ",
  PREPARING: "Đang nấu",
  DONE:      "Xong",
  SERVED:    "Đã phục vụ",
  CANCELLED: "Đã hủy",
};

const CANCELLABLE_STATUSES = new Set(["PENDING", "PREPARING"]);

export default function TableDetailScreen() {
  const router = useRouter();
  const { tableCode } = useLocalSearchParams<{ tableCode: string }>();
  const { accessToken, staff, loading, setLoading, setError } = useWaiterStore();

  const [table, setTable] = useState<TableResponse | null>(null);
  const [orders, setOrders] = useState<OrderResponse[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmingOrderId, setConfirmingOrderId] = useState<number | null>(null);
  const [cancellingItemId, setCancellingItemId] = useState<number | null>(null);
  const [menuItemNames, setMenuItemNames] = useState<Map<number, string>>(new Map());

  const canUpdateTable = staff?.role === "WAITER" || staff?.role === "MANAGER";

  // Load menu item names once for display
  useEffect(() => {
    if (!accessToken) return;
    void (async () => {
      try {
        const catRes = await menuAPI.listCategories();
        const names = new Map<number, string>();
        await Promise.all(
          catRes.data.data.map(async (cat) => {
            try {
              const itemsRes = await menuAPI.listByCategory(cat.id);
              itemsRes.data.data.forEach((item) => names.set(item.id, item.name));
            } catch { /* ignore per-category errors */ }
          })
        );
        setMenuItemNames(names);
      } catch { /* silently ignore */ }
    })();
  }, [accessToken]);

  const loadData = useCallback(async (silent = false) => {
    if (!accessToken || !tableCode) return;

    try {
      if (!silent) setLoading(true);
      if (!silent) setError(null);

      const [tableRes, ordersRes] = await Promise.all([
        tableAPI.getTable(tableCode),
        orderAPI.listOrders(),
      ]);

      const tableData = tableRes.data.data;
      setTable(tableData);
      setOrders(ordersRes.data.data.filter((order) => order.tableId === tableData.id));
    } catch (err: any) {
      setError(err?.response?.data?.message || "Không thể tải chi tiết bàn");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [accessToken, setError, setLoading, tableCode]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!accessToken) return;
    const timerId = setInterval(() => void loadData(true), 10000);
    return () => clearInterval(timerId);
  }, [accessToken, loadData]);

  // ─── Realtime sync: refetch chỉ order liên quan để UI cập nhật ngay ─────────
  // Không phụ thuộc polling 10s — bếp/khách thay đổi là badge & nút đổi ngay.
  const refreshSingleOrder = useCallback(async (orderId: number) => {
    try {
      const res = await orderAPI.getOrder(orderId);
      const fresh = res.data.data;
      setOrders((prev) => {
        const exists = prev.some((o) => o.id === fresh.id);
        return exists
          ? prev.map((o) => (o.id === fresh.id ? fresh : o))
          : table && fresh.tableId === table.id
            ? [fresh, ...prev]
            : prev;
      });
    } catch { /* non-critical — polling sẽ sync */ }
  }, [table]);

  useWaiterSocket({
    enabled: !!accessToken,
    // Bếp đánh dấu xong 1 món → cập nhật status item ngay (PREPARING → DONE)
    onItemDone: (payload) => {
      if (table && payload.tableId === table.id) {
        void refreshSingleOrder(payload.orderId);
      }
    },
    // Toàn bộ item DONE → order chuyển READY, hiện nút "Phục vụ"
    onOrderReady: (payload) => {
      if (table && payload.tableId === table.id) {
        void refreshSingleOrder(payload.orderId);
      }
    },
    // Khách đặt thêm (revision mới) → reload order list để hiện món mới + nút "Gửi xuống bếp"
    onNewOrder: (payload) => {
      if (table && payload.tableId === table.id) {
        void loadData(true);
      }
    },
    // Cashier thanh toán xong → order PAID, bàn CLEANING — refresh toàn bộ
    onPaymentSuccess: (payload) => {
      if (table && payload.tableId === table.id) {
        void loadData(true);
      }
    },
  });

  const stats = useMemo(() => {
    const active = orders.filter((o) => o.status !== "PAID" && o.status !== "CANCELLED").length;
    const totalAmount = orders.reduce((sum, o) => sum + o.totalAmount, 0);
    return { active, totalAmount };
  }, [orders]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
  }

  async function handleConfirmOrder(orderId: number) {
    const ok = await confirmAction({
      title: "Xác nhận thêm món",
      message: "Gửi các món vừa thêm xuống bếp?",
      confirmLabel: "Xác nhận",
      cancelLabel: "Hủy",
    });
    if (!ok) return;

    setConfirmingOrderId(orderId);
    try {
      await orderAPI.confirmOrder(orderId);
      await loadData(true);
      notify("Thành công", "Đã gửi món mới xuống bếp.");
    } catch (err: any) {
      notify("Lỗi", err?.response?.data?.message || "Xác nhận thất bại");
    } finally {
      setConfirmingOrderId(null);
    }
  }

  async function handleCancelItem(orderId: number, itemId: number, itemName: string) {
    console.log("[cancelItem] pressed", { orderId, itemId, itemName });

    const ok = await confirmAction({
      title: "Hủy món",
      message: `Xác nhận hủy "${itemName}"?\nMón sẽ bị hủy khỏi đơn và bếp sẽ không nấu nữa.`,
      confirmLabel: "Hủy món",
      cancelLabel: "Đóng",
      destructive: true,
    });
    if (!ok) {
      console.log("[cancelItem] user dismissed confirm");
      return;
    }

    setCancellingItemId(itemId);
    try {
      console.log("[cancelItem] calling API", { orderId, itemId });
      const res = await orderAPI.cancelItem(orderId, itemId);
      console.log("[cancelItem] API ok", res.status, res.data?.message);
      await loadData(true);
    } catch (err: any) {
      const status = err?.response?.status;
      const serverMsg = err?.response?.data?.message;
      // Surface the actual backend rejection — without this, "Không thể hủy món"
      // hides why (kitchen already started, order paid, role missing, etc.)
      console.warn(
        "[cancelItem] failed",
        { orderId, itemId, status, serverMsg, raw: err?.response?.data, err: err?.message }
      );
      notify(
        "Không hủy được món",
        serverMsg
          ? `${serverMsg}`
          : status === 401 || status === 403
          ? "Phiên đăng nhập đã hết hạn hoặc bạn không có quyền."
          : "Không thể hủy món. Kiểm tra kết nối mạng và thử lại."
      );
    } finally {
      setCancellingItemId(null);
    }
  }

  async function handleUpdateTableStatus() {
    if (!table) return;
    const nextStatus = nextTableStatus(table.status);
    try {
      setLoading(true);
      const response = await tableAPI.updateStatus(table.tableCode, { status: nextStatus });
      setTable(response.data.data);
      notify("Cập nhật bàn", `Đã chuyển sang trạng thái ${TABLE_LABEL[nextStatus]}.`);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Cập nhật trạng thái bàn thất bại");
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <Pressable style={({ pressed }) => [styles.backButton, pressed && styles.pressed]} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>← Quay lại</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Chi tiết bàn {tableCode}</Text>
      </View>

      {loading && !table ? <ActivityIndicator style={styles.loader} color="#B0891F" /> : null}

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#B0891F" />}
      >
        {table ? (
          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>{table.tableCode}</Text>
              <View style={[styles.badge, { backgroundColor: TABLE_COLOR[table.status] }]}>
                <Text style={styles.badgeText}>{TABLE_LABEL[table.status]}</Text>
              </View>
            </View>
            <Text style={styles.cardSub}>Tầng {table.floor} · Bàn số {table.tableNo}</Text>
            <Text style={styles.cardSub}>Sức chứa: {table.capacity} khách</Text>

            {canUpdateTable ? (
              <Pressable style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]} onPress={handleUpdateTableStatus}>
                <Text style={styles.actionButtonText}>Chuyển sang {TABLE_LABEL[nextTableStatus(table.status)]}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <Text style={styles.emptyText}>Không tìm thấy thông tin bàn.</Text>
        )}

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{orders.length}</Text>
            <Text style={styles.statLabel}>Tổng đơn</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{stats.active}</Text>
            <Text style={styles.statLabel}>Đang xử lý</Text>
          </View>
          <View style={styles.statCardWide}>
            <Text style={styles.statValue}>{formatMoney(stats.totalAmount)}</Text>
            <Text style={styles.statLabel}>Doanh số tại bàn</Text>
          </View>
        </View>

        <View style={styles.listWrap}>
          <Text style={styles.sectionTitle}>Lịch sử đơn tại bàn</Text>

          {orders.map((order) => {
            const canReconfirm = order.status === "CONFIRMED" || order.status === "PREPARING";
            const isConfirming = confirmingOrderId === order.id;

            // Billable items (combo parent + single), split into active and cancelled
            const billableItems = (order.items ?? []).filter((i) => i.billable);
            const activeItems = billableItems.filter((i) => i.status !== "CANCELLED");
            const cancelledItems = billableItems.filter((i) => i.status === "CANCELLED");

            return (
              <View key={order.id} style={styles.card}>
                {/* Order header */}
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>Order #{order.id}</Text>
                  <Text style={styles.amount}>{formatMoney(order.totalAmount)}</Text>
                </View>
                <Text style={styles.cardSub}>Trạng thái: {ORDER_LABEL[order.status]}</Text>
                <Text style={styles.cardSub}>Tạo lúc: {new Date(order.createdAt).toLocaleString("vi-VN")}</Text>

                {/* Active item list */}
                {activeItems.length > 0 && (
                  <View style={styles.itemList}>
                    {activeItems.map((item) => {
                      const name = menuItemNames.get(item.menuItemId) ?? `Món #${item.menuItemId}`;
                      // Order must be in a revision-eligible state and the item must still be PENDING.
                      // PAID/CANCELLED orders are rejected by the backend regardless of item status.
                      const orderRevisionAllowed =
                        order.status !== "PAID" && order.status !== "CANCELLED";
                      const canCancel =
                        CANCELLABLE_STATUSES.has(item.status) &&
                        canUpdateTable &&
                        orderRevisionAllowed &&
                        item.billable !== false;
                      const isCancelling = cancellingItemId === item.id;
                      return (
                        <View key={item.id} style={styles.itemRow}>
                          <View style={styles.itemInfo}>
                            <Text style={styles.itemName} numberOfLines={2}>{item.quantity}× {name}</Text>
                            {item.note ? <Text style={styles.itemNote}>{item.note}</Text> : null}
                          </View>
                          <View style={[styles.itemStatusBadge, { backgroundColor: ITEM_STATUS_COLOR[item.status] ?? "#94A3B8" }]}>
                            <Text style={styles.itemStatusText}>{ITEM_STATUS_LABEL[item.status] ?? item.status}</Text>
                          </View>
                          {canCancel && (
                            <Pressable
                              style={({ pressed }) => [
                                styles.cancelItemBtn,
                                pressed && styles.pressed,
                                isCancelling && styles.cancelItemBtnDisabled,
                              ]}
                              onPress={() => void handleCancelItem(order.id, item.id, name)}
                              disabled={isCancelling}
                            >
                              <Text style={styles.cancelItemBtnText}>{isCancelling ? "…" : "Hủy"}</Text>
                            </Pressable>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}

                {/* Cancelled items — collapsed summary */}
                {cancelledItems.length > 0 && (
                  <Text style={styles.cancelledSummary}>
                    {cancelledItems.length} món đã hủy
                  </Text>
                )}

                {/* Confirm button */}
                {canReconfirm && canUpdateTable && (
                  <Pressable
                    style={({ pressed }) => [
                      styles.confirmButton,
                      pressed && styles.pressed,
                      isConfirming && styles.confirmButtonDisabled,
                    ]}
                    onPress={() => void handleConfirmOrder(order.id)}
                    disabled={isConfirming}
                  >
                    <Text style={styles.confirmButtonText}>
                      {isConfirming ? "Đang gửi..." : "Gửi thêm món xuống bếp"}
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}

          {!loading && orders.length === 0 ? <Text style={styles.emptyText}>Bàn này chưa có đơn nào.</Text> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: POS_NEUTRAL.shell },
  headerRow: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: POS_NEUTRAL.border,
    backgroundColor: POS_NEUTRAL.surface,
    gap: 8,
  },
  backButton: {
    alignSelf: "flex-start",
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: POS_NEUTRAL.border,
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: POS_NEUTRAL.surfaceSoft,
    justifyContent: "center",
  },
  backButtonText: { color: POS_NEUTRAL.text, fontWeight: "700" },
  headerTitle: { color: POS_NEUTRAL.text, fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  loader: { marginTop: 20 },
  scrollContent: { padding: 12, gap: 10, paddingBottom: 24 },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: POS_NEUTRAL.border,
    backgroundColor: POS_NEUTRAL.surface,
    padding: 10,
    gap: 6,
  },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTitle: { color: POS_NEUTRAL.text, fontSize: 16, fontWeight: "800" },
  cardSub: { color: POS_NEUTRAL.textMuted, fontSize: 12 },
  badge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { color: "#FFFFFF", fontSize: 10, fontWeight: "800" },
  actionButton: {
    marginTop: 8,
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: POS_NEUTRAL.active,
    paddingVertical: 10,
    alignItems: "center",
  },
  actionButtonText: { color: "#FFFFFF", fontWeight: "700" },
  statsRow: { flexDirection: "row", gap: 8 },
  statCard: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: POS_NEUTRAL.border,
    backgroundColor: POS_NEUTRAL.surface,
    padding: 10,
    alignItems: "center",
  },
  statCardWide: {
    flex: 2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: POS_NEUTRAL.border,
    backgroundColor: POS_NEUTRAL.surface,
    padding: 10,
    alignItems: "center",
  },
  statValue: { color: POS_NEUTRAL.text, fontSize: 20, fontWeight: "800" },
  statLabel: { color: POS_NEUTRAL.textMuted, fontSize: 12 },
  listWrap: { gap: 8 },
  sectionTitle: { color: POS_NEUTRAL.text, fontSize: 16, fontWeight: "800" },
  amount: { color: POS_NEUTRAL.text, fontWeight: "800" },
  emptyText: { color: POS_NEUTRAL.textMuted, textAlign: "center", marginTop: 8 },
  pressed: { opacity: 0.86 },
  // Item list inside order card
  itemList: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: POS_NEUTRAL.border,
    gap: 4,
    paddingTop: 6,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 3,
  },
  itemInfo: { flex: 1, gap: 1 },
  itemName: { color: POS_NEUTRAL.text, fontSize: 13, fontWeight: "600" },
  itemNote: { color: POS_NEUTRAL.textMuted, fontSize: 11, fontStyle: "italic" },
  itemStatusBadge: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  itemStatusText: { color: "#FFFFFF", fontSize: 10, fontWeight: "700" },
  cancelItemBtn: {
    minWidth: 40,
    minHeight: 32,
    borderRadius: 8,
    backgroundColor: "#EF4444",
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelItemBtnDisabled: { opacity: 0.45 },
  cancelItemBtnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 12 },
  cancelledSummary: {
    color: "#EF4444",
    fontSize: 11,
    fontStyle: "italic",
    marginTop: 2,
  },
  // Confirm revision button
  confirmButton: {
    marginTop: 6,
    minHeight: 40,
    borderRadius: 10,
    backgroundColor: "#D97706",
    paddingVertical: 8,
    alignItems: "center",
  },
  confirmButtonDisabled: { opacity: 0.55 },
  confirmButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 13 },
});
