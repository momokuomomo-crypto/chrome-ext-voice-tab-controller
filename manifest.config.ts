import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "音声タブコントローラー",
  description:
    "音が出ているタブの一覧・ミュート/解除・サイト単位の常時ミュートを管理します。",
  version: pkg.version,
  permissions: ["tabs", "storage"],
  action: {
    default_popup: "src/popup/index.html",
  },
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
});
