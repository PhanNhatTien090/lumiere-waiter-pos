import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { orderAPI, tableAPI } from "../../src/api/endpoints";
import { ORDER_LABEL, TABLE_COLOR, TABLE_LABEL, formatMoney, nextTableStatus } from "../../src/constants/posUi";
import { useWaiterStore } from "../../src/store/waiterStore";
import { OrderResponse, TableResponse } from "../../src/types";

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

export default function TableDetailScreen() {
  const router = useRouter();
  const { tableCode } = useLocalSearchParams<{ tableCode: string }>();
  const { accessToken, staff, loading, setLoading, setError } = useWaiterStore();

  const [table, setTable] = useState<TableResponse | null>(null);
  const [orders, setOrders] = useState<OrderResponse[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const canUpdateTable = staff?.role === "WAITER" || staff?.role === "MANAGER";

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

    const timerId = setInterval(() => {
      void loadData(true);
    }, 10000);

    return () => clearInterval(timerId);
  }, [accessToken, loadData]);

  const stats = useMemo(() => {
    const active = orders.filter((order) => order.status !== "PAID" && order.status !== "CANCELLED").length;
    const totalAmount = orders.reduce((sum, order) => sum + order.totalAmount, 0);
    return { active, totalAmount };
  }, [orders]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
  }

  async function handleUpdateTableStatus() {
    if (!table) return;

    const nextStatus = nextTableStatus(table.status);

    try {
      setLoading(true);
      const response = await tableAPI.updateStatus(table.tableCode, { status: nextStatus });
      setTable(response.data.data);
      Alert.alert("Cập nhật bàn", `Đã chuyển sang trạng thái ${TABLE_LABEL[nextStatus]}.`);
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
            <Text style={styles.statLabel}>Đơn đang xử lý</Text>
          </View>
          <View style={styles.statCardWide}>
            <Text style={styles.statValue}>{formatMoney(stats.totalAmount)}</Text>
            <Text style={styles.statLabel}>Doanh số tại bàn</Text>
          </View>
        </View>

        <View style={styles.listWrap}>
          <Text style={styles.sectionTitle}>Lịch sử đơn tại bàn</Text>
          {orders.map((order) => (
            <View key={order.id} style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>Order #{order.id}</Text>
                <Text style={styles.amount}>{formatMoney(order.totalAmount)}</Text>
              </View>
              <Text style={styles.cardSub}>Trạng thái: {ORDER_LABEL[order.status]}</Text>
              <Text style={styles.cardSub}>Số món: {order.items.length}</Text>
              <Text style={styles.cardSub}>Tạo lúc: {new Date(order.createdAt).toLocaleString("vi-VN")}</Text>
            </View>
          ))}

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
  statsRow: { flexDirection: 'row', gap: 8 },
  statCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: POS_NEUTRAL.border,
    backgroundColor: POS_NEUTRAL.surface,
    padding: 10,
    alignItems: "center",
  },
  statCardWide: {
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
});
