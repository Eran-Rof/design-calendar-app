import React, { useState, useEffect } from "react";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";
import { BRANDS as DEFAULT_BRANDS, CATEGORIES as DEFAULT_CATEGORIES, GENDERS as DEFAULT_GENDERS, CHANNEL_TYPES, DEFAULT_CUSTOMERS } from "../utils/constants";
import { getBrand, addDays } from "../utils/dates";
import { getChannelForCustomer } from "../utils/helpers";
import { Modal } from "./Modal";
import DateInput from "./DateInput";
import { useAppStore } from "../store";
import { selectCollMap } from "../store/selectors";

// ─── EDIT COLLECTION MODAL ───────────────────────────────────────────────────
function EditCollectionModal({
  onLogActivity,
  onClose,
}: {
  onLogActivity?: (entries: any[]) => void;
  onClose: () => void;
}) {
  const store = useAppStore();
  const collKey = store.editCollKey;
  const collMap = selectCollMap(store);
  const { collections, tasks, seasons, customers: customerList, orderTypes, currentUser, brands: brandsProp, genders: gendersProp, categoryLib: categoriesProp } = store;
  const setTasks = store.setTasks;
  const setCollections = store.setCollections;
  const brandList = (brandsProp && brandsProp.length > 0) ? brandsProp : DEFAULT_BRANDS;
  const genderList = (gendersProp && gendersProp.length > 0) ? gendersProp : DEFAULT_GENDERS;
  const categoryList = (categoriesProp && categoriesProp.length > 0)
    ? categoriesProp.map((c: any) => typeof c === "string" ? c : c.name || c.category || c)
    : DEFAULT_CATEGORIES;
  if (!collKey) return null;
  const coll = collMap[collKey];
  if (!coll) return null;
  const meta = collections[collKey] || {};
  const ddpTaskDate = coll.tasks?.find((t) => t.phase === "DDP")?.due || "";
  const [f, setF] = useState({
    collectionName: coll.collection || "",
    brand: coll.brand || "ring-of-fire",
    season: coll.season || "Fall",
    year: meta.year || new Date().getFullYear(),
    gender: meta.gender || "Men's",
    category: coll.category || "Denim",
    customer: meta.customer || "",
    orderType: meta.orderType || "",
    channelType: meta.channelType || "",
    customerShipDate: meta.customerShipDate || "",
    cancelDate: meta.cancelDate || "",
    ddpDate: meta.ddpDate || ddpTaskDate,
    sampleDueDate: meta.sampleDueDate || "",
  });
  const set = (k, v) =>
    setF((x) => {
      const next = { ...x, [k]: v };
      if (k === "ddpDate" && v) {
        next.customerShipDate = addDays(v, 24);
        next.cancelDate = addDays(addDays(v, 24), 6);
      }
      return next;
    });
  useEffect(() => {
    if (f.customer) {
      const ch = getChannelForCustomer(f.customer);
      if (ch && !f.channelType) set("channelType", ch);
    }
  }, [f.customer]);
  function save() {
    const collTasks = tasks.filter(
      (t) => `${t.brand}||${t.collection}` === collKey
    );
    const ddpTask = collTasks.find((t) => t.phase === "DDP");
    const oldDDP = ddpTask?.due || "";
    const newDDP = f.ddpDate;
    let updatedTasks = tasks.map((t) =>
      `${t.brand}||${t.collection}` === collKey
        ? {
            ...t,
            brand: f.brand,
            season: f.season,
            category: f.category,
            collection: f.collectionName,
            customer: f.customer,
            orderType: f.orderType,
            channelType: f.channelType,
          }
        : t
    );
    if (newDDP && oldDDP && newDDP !== oldDDP) {
      const shift = Math.round(
        (+new Date(newDDP) - +new Date(oldDDP)) / 86400000
      );
      updatedTasks = updatedTasks.map((t) => {
        if (`${t.brand}||${t.collection}` !== collKey) return t;
        const shiftedDue = addDays(t.due, shift);
        return {
          ...t,
          due: shiftedDue,
          ddpDate: t.phase === "DDP" ? newDDP : t.ddpDate,
        };
      });
    }
    setTasks(updatedTasks);
    setCollections((c) => ({
      ...c,
      [collKey]: {
        ...(c[collKey] || {}),
        customer: f.customer,
        orderType: f.orderType,
        channelType: f.channelType,
        customerShipDate: f.customerShipDate,
        cancelDate: f.cancelDate,
        ddpDate: newDDP,
        gender: f.gender,
        year: f.year,
        sampleDueDate: f.sampleDueDate,
      },
    }));
    // Log any changes to the activity log
    if (onLogActivity) {
      const now = new Date().toISOString();
      const by = currentUser?.name || "Unknown";
      const logBrand = f.brand;
      const logColl = f.collectionName;
      const entries: any[] = [];
      const t = Date.now();
      if (f.collectionName !== (coll.collection || "")) entries.push({ id: `${t}-ren`, field: "collection renamed", from: coll.collection, to: f.collectionName, changedBy: by, at: now, taskCollection: logColl, taskBrand: logBrand });
      if (newDDP && newDDP !== (meta.ddpDate || ddpTaskDate)) entries.push({ id: `${t}-ddp`, field: "DDP date", from: meta.ddpDate || ddpTaskDate, to: newDDP, changedBy: by, at: now, taskCollection: logColl, taskBrand: logBrand });
      if (f.customer !== (meta.customer || "")) entries.push({ id: `${t}-cus`, field: "customer", from: meta.customer || "—", to: f.customer || "—", changedBy: by, at: now, taskCollection: logColl, taskBrand: logBrand });
      if (f.orderType !== (meta.orderType || "")) entries.push({ id: `${t}-ot`, field: "order type", from: meta.orderType || "—", to: f.orderType || "—", changedBy: by, at: now, taskCollection: logColl, taskBrand: logBrand });
      if (f.season !== (coll.season || "")) entries.push({ id: `${t}-sea`, field: "season", from: coll.season, to: f.season, changedBy: by, at: now, taskCollection: logColl, taskBrand: logBrand });
      if (entries.length > 0) onLogActivity(entries);
    }
    onClose();
  }
  return (
    <Modal
      title={`Edit Collection — ${coll.collection}`}
      onClose={onClose}
      wide
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div>
          <label style={S.lbl}>Collection Name</label>
          <input
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.collectionName}
            onChange={(e) => set("collectionName", e.target.value)}
          />
        </div>
        <div>
          <label style={S.lbl}>Brand</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.brand}
            onChange={(e) => set("brand", e.target.value)}
          >
            {brandList.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.isPrivateLabel ? " (PL)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div>
          <label style={S.lbl}>Season</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.season}
            onChange={(e) => set("season", e.target.value)}
          >
            {seasons.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Year</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.year}
            onChange={(e) => set("year", parseInt(e.target.value))}
          >
            {[2024, 2025, 2026, 2027, 2028].map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Gender</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.gender}
            onChange={(e) => set("gender", e.target.value)}
          >
            {genderList.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Category</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.category}
            onChange={(e) => set("category", e.target.value)}
          >
            {categoryList.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 14,
        }}
      >
        <div>
          <label style={S.lbl}>Customer</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.customer}
            onChange={(e) => set("customer", e.target.value)}
          >
            <option value="">-- Select --</option>
            {(customerList || DEFAULT_CUSTOMERS).map((c) => {
              const name = typeof c === "string" ? c : c.name;
              return <option key={name} value={name}>{name}</option>;
            })}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Order Type</label>
          <select
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.orderType}
            onChange={(e) => set("orderType", e.target.value)}
          >
            <option value="">--</option>
            {orderTypes.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
      </div>
      <label style={S.lbl}>Channel Type</label>
      <select
        style={S.inp}
        value={f.channelType}
        onChange={(e) => set("channelType", e.target.value)}
      >
        <option value="">--</option>
        {CHANNEL_TYPES.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14 }}
      >
        <div>
          <label style={S.lbl}>DDP Date</label>
          <DateInput
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.ddpDate}
            onChange={(v) => set("ddpDate", v)}
          />
        </div>
        <div>
          <label style={S.lbl}>Sample Due Date</label>
          <DateInput
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.sampleDueDate}
            onChange={(v) => set("sampleDueDate", v)}
          />
        </div>
        <div>
          <label style={S.lbl}>Customer Ship Date</label>
          <DateInput
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.customerShipDate}
            onChange={(v) => set("customerShipDate", v)}
          />
        </div>
        <div>
          <label style={S.lbl}>Cancel Date</label>
          <DateInput
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.cancelDate}
            onChange={(v) => set("cancelDate", v)}
          />
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 12,
          justifyContent: "flex-end",
          marginTop: 20,
        }}
      >
        <button
          onClick={onClose}
          style={{
            padding: "10px 20px",
            borderRadius: 8,
            border: `1px solid ${TH.border}`,
            background: "none",
            color: TH.textMuted,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Cancel
        </button>
        <button onClick={save} style={S.btn}>
          Save Collection
        </button>
      </div>
    </Modal>
  );
}


export default EditCollectionModal;
