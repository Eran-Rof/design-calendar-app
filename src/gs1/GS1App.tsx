import React from "react";
import { TH } from "../utils/theme";
import { useGS1Store } from "./store/gs1Store";
import GS1NavBar from "./panels/NavBar";
import CompanySetupPanel from "./panels/CompanySetupPanel";
import UpcMasterPanel from "./panels/UpcMasterPanel";
import ScaleMasterPanel from "./panels/ScaleMasterPanel";
import PackGtinMasterPanel from "./panels/PackGtinMasterPanel";
import PackingListUploadPanel from "./panels/PackingListUploadPanel";
import LabelBatchPanel from "./panels/LabelBatchPanel";
import CartonPanel from "./panels/CartonPanel";
import ReceivingPanel from "./panels/ReceivingPanel";

export default function GS1App() {
  const activeTab = useGS1Store(s => s.activeTab);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: TH.surfaceHi, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <GS1NavBar />
      <div style={{ flex: 1, overflowY: "auto" }}>
        {activeTab === "company"  && <CompanySetupPanel />}
        {activeTab === "upc"      && <UpcMasterPanel />}
        {activeTab === "scale"    && <ScaleMasterPanel />}
        {activeTab === "gtins"    && <PackGtinMasterPanel />}
        {activeTab === "upload"   && <PackingListUploadPanel />}
        {activeTab === "labels"   && <LabelBatchPanel />}
        {activeTab === "cartons"  && <CartonPanel />}
        {activeTab === "receiving" && <ReceivingPanel />}
      </div>
    </div>
  );
}
