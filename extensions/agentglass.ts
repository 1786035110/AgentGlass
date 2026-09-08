import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiAdapter } from "../src/adapter/pi/adapter.js";

// 唯一 Pi 入口只负责装配 Adapter；分类、风险和审批仍由后续明确任务实现。
export default function agentglass(pi: ExtensionAPI): void {
  registerPiAdapter(pi);
}
