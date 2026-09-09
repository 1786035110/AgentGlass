import path from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { registerPiAdapter } from "../src/adapter/pi/adapter.js";

// 唯一 Pi 入口只注入 Pi 私有存储根并装配 Adapter；Core 不依赖 Pi 默认路径。
export default function agentglass(pi: ExtensionAPI): void {
  registerPiAdapter(
    pi,
    undefined,
    path.join(getAgentDir(), ".agentglass", "snapshots"),
  );
}
