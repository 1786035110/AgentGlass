import type { ActionFacts, FileTargetFacts } from "../../src/core/domain.js";

export function actionFacts(
  action: Partial<ActionFacts> = {},
  target: Partial<FileTargetFacts> = {},
): ActionFacts {
  return {
    actionId: "action-1",
    kind: "read",
    targetLabel: "note.txt",
    mutatesState: "no",
    outsideWorkspace: "no",
    sensitive: "no",
    targets: [
      {
        targetId: "target-1",
        label: "note.txt",
        workspaceScope: "inside",
        state: "existing_file",
        linked: "no",
        supportedPath: "yes",
        evidenceCodes: [],
        ...target,
      },
    ],
    impactFacts: { effect: "read", createsParentDirectories: "no" },
    evidenceCodes: ["TOOL_IDENTITY_VERIFIED", "TOOL_SCHEMA_VERIFIED"],
    fingerprint: {
      algorithm: "sha256",
      canonicalizationVersion: 1,
      value: "a".repeat(64),
    },
    ...action,
  };
}
