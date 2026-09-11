import { expect, test } from "vitest";
import {
  classifyShellCommand,
  type ShellClassificationDecision,
  type ShellCommandFamily,
  type ShellRuntimeEvidence,
} from "../../src/core/shell-classification.js";

interface Fixture {
  name: string;
  command: string;
  runtime: ShellRuntimeEvidence;
  decision: ShellClassificationDecision;
  reason: string;
  family?: ShellCommandFamily;
}

function bashRuntime(
  command: string,
  overrides: Partial<ShellRuntimeEvidence> = {},
): ShellRuntimeEvidence {
  return {
    shell: "bash",
    nonInteractive: "yes",
    environment: "verified",
    pathLookup: "verified",
    alias: "absent",
    function: "absent",
    commandResolution: {
      status: "verified",
      name: command,
      kind: command === "pwd" ? "builtin" : "executable",
      resolvedPath: command === "pwd" ? null : `/usr/bin/${command}`,
      supportedSemantics: "verified",
    },
    ...overrides,
  };
}

const positive: Fixture[] = [
  ["pwd", "pwd", "pwd"],
  ["pwd physical", "pwd -P", "pwd"],
  ["pwd logical", "pwd --logical", "pwd"],
  ["ls", "ls", "ls"],
  ["ls combined short options", "ls -la", "ls"],
  ["ls all operand", "ls -a .", "ls"],
  ["ls long option", "ls --all src", "ls"],
  ["ls human readable", "ls -h docs", "ls"],
  ["ls option terminator", "ls -- -odd", "ls"],
  ["ls escaped operand", "ls path\\ with\\ spaces", "ls"],
  ["cat", "cat README.md", "cat"],
  ["cat numbered", "cat -n README.md", "cat"],
  ["cat long numbered", "cat --number README.md", "cat"],
  ["cat option terminator", "cat -- -odd", "cat"],
  ["cat quoted operand", 'cat "file name.txt"', "cat"],
  ["head", "head note.txt", "head"],
  ["head count pair", "head -n 10 note.txt", "head"],
  ["head attached count", "head -n10 note.txt", "head"],
  ["head long count", "head --lines=5 note.txt", "head"],
  ["tail", "tail note.txt", "tail"],
  ["tail count", "tail -n20 note.txt", "tail"],
  ["tail bytes", "tail --bytes=4 note.txt", "tail"],
  ["wc", "wc note.txt", "wc"],
  ["wc combined counts", "wc -lw note.txt", "wc"],
  ["wc words", "wc --words note.txt", "wc"],
  ["wc bytes", "wc -c note.txt", "wc"],
  ["grep", "grep needle note.txt", "grep"],
  ["grep numbered", "grep -n needle note.txt", "grep"],
  ["grep fixed", "grep -F needle note.txt", "grep"],
  ["grep explicit pattern", "grep -e needle note.txt", "grep"],
  ["grep literal dollar", "grep '$HOME' note.txt", "grep"],
  ["git status", "git status", "git"],
  ["git short status", "git status --short", "git"],
  ["git porcelain", "git status --porcelain=v2", "git"],
  ["git diff", "git diff", "git"],
  ["git diff stat", "git diff --stat", "git"],
  ["git diff cached", "git diff --cached", "git"],
  ["git log", "git log --oneline", "git"],
  ["git show", "git show HEAD", "git"],
  ["git rev parse", "git rev-parse --show-toplevel", "git"],
].map(([name, command, executable]) => ({
  name: name ?? "",
  command: command ?? "",
  runtime: bashRuntime(executable ?? ""),
  decision: "candidate_fast_path",
  reason: "KNOWN_READ_ONLY",
}));

const asks: Fixture[] = [
  {
    name: "unsupported ls color",
    command: "ls --color=auto",
    runtime: bashRuntime("ls"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
    family: "filesystem_read",
  },
  {
    name: "unsupported ls option after operand",
    command: "ls src --color=auto",
    runtime: bashRuntime("ls"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
  },
  {
    name: "unsupported cat help",
    command: "cat --help",
    runtime: bashRuntime("cat"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
  },
  {
    name: "tail follow",
    command: "tail -f app.log",
    runtime: bashRuntime("tail"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
  },
  {
    name: "tail follow after operand",
    command: "tail app.log -f",
    runtime: bashRuntime("tail"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
  },
  {
    name: "grep recursive",
    command: "grep -R needle .",
    runtime: bashRuntime("grep"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
  },
  {
    name: "grep pattern file",
    command: "grep -f patterns.txt note.txt",
    runtime: bashRuntime("grep"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
  },
  {
    name: "git external diff",
    command: "git diff --ext-diff",
    runtime: bashRuntime("git"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
  },
  {
    name: "git branch create neighbor",
    command: "git branch feature",
    runtime: bashRuntime("git"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
  },
  {
    name: "git branch delete-looking pattern after terminator",
    command: "git branch --list -- -D",
    runtime: bashRuntime("git"),
    decision: "ask",
    reason: "UNSUPPORTED_OPTION",
  },
  {
    name: "absolute command path",
    command: "/usr/bin/cat note.txt",
    runtime: bashRuntime("cat"),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "pipeline",
    command: "cat note.txt | grep needle",
    runtime: bashRuntime("cat"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "or pipeline",
    command: "grep needle note.txt || echo missing",
    runtime: bashRuntime("grep"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "and compound",
    command: "pwd && ls",
    runtime: bashRuntime("pwd"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "semicolon compound",
    command: "pwd; ls",
    runtime: bashRuntime("pwd"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "background",
    command: "tail app.log &",
    runtime: bashRuntime("tail"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "output redirect",
    command: "grep needle note.txt > matches.txt",
    runtime: bashRuntime("grep"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "append redirect",
    command: "cat note.txt >> copy.txt",
    runtime: bashRuntime("cat"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "input redirect",
    command: "wc -l < note.txt",
    runtime: bashRuntime("wc"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "command substitution",
    command: "cat $(pwd)/note.txt",
    runtime: bashRuntime("cat"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "backtick substitution",
    command: "cat `pwd`/note.txt",
    runtime: bashRuntime("cat"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "variable expansion",
    command: "cat $FILE",
    runtime: bashRuntime("cat"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "glob expansion",
    command: "cat *.txt",
    runtime: bashRuntime("cat"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "brace construction",
    command: "cat file{1,2}.txt",
    runtime: bashRuntime("cat"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "environment assignment",
    command: "LC_ALL=C grep needle note.txt",
    runtime: bashRuntime("grep"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "eval",
    command: "eval 'cat note.txt'",
    runtime: bashRuntime("eval"),
    decision: "ask",
    reason: "EVAL_LIKE_BEHAVIOR",
  },
  {
    name: "source",
    command: "source script.sh",
    runtime: bashRuntime("source"),
    decision: "ask",
    reason: "EVAL_LIKE_BEHAVIOR",
  },
  {
    name: "bash c",
    command: "bash -c 'cat note.txt'",
    runtime: bashRuntime("bash"),
    decision: "ask",
    reason: "EVAL_LIKE_BEHAVIOR",
  },
  {
    name: "xargs",
    command: "xargs cat",
    runtime: bashRuntime("xargs"),
    decision: "ask",
    reason: "EVAL_LIKE_BEHAVIOR",
  },
  {
    name: "npm install",
    command: "npm install lodash",
    runtime: bashRuntime("npm"),
    decision: "ask",
    reason: "INSTALL_COMMAND",
    family: "install",
  },
  {
    name: "pip install",
    command: "pip install requests",
    runtime: bashRuntime("pip"),
    decision: "ask",
    reason: "INSTALL_COMMAND",
  },
  {
    name: "pip show is not install by substring",
    command: "pip show requests",
    runtime: bashRuntime("pip"),
    decision: "ask",
    reason: "UNSUPPORTED_COMMAND",
  },
  {
    name: "apt install",
    command: "apt-get install jq",
    runtime: bashRuntime("apt-get"),
    decision: "ask",
    reason: "INSTALL_COMMAND",
  },
  {
    name: "curl network",
    command: "curl https://example.invalid",
    runtime: bashRuntime("curl"),
    decision: "ask",
    reason: "NETWORK_COMMAND",
    family: "network",
  },
  {
    name: "wget network",
    command: "wget https://example.invalid",
    runtime: bashRuntime("wget"),
    decision: "ask",
    reason: "NETWORK_COMMAND",
  },
  {
    name: "ssh network",
    command: "ssh host",
    runtime: bashRuntime("ssh"),
    decision: "ask",
    reason: "NETWORK_COMMAND",
  },
  {
    name: "kill process",
    command: "kill 123",
    runtime: bashRuntime("kill"),
    decision: "ask",
    reason: "PROCESS_STATE_CHANGE",
    family: "process",
  },
  {
    name: "move file",
    command: "mv old new",
    runtime: bashRuntime("mv"),
    decision: "ask",
    reason: "SHELL_STATE_CHANGE",
  },
  {
    name: "git config write",
    command: "git config user.name Alice",
    runtime: bashRuntime("git"),
    decision: "ask",
    reason: "GIT_CONFIG_MUTATION",
    family: "git_state_change",
  },
  {
    name: "git config global write",
    command: "git config --global user.name Alice",
    runtime: bashRuntime("git"),
    decision: "ask",
    reason: "GIT_CONFIG_MUTATION",
  },
  {
    name: "git config write after global cwd option",
    command: "git -C repo config user.name Alice",
    runtime: bashRuntime("git"),
    decision: "ask",
    reason: "GIT_CONFIG_MUTATION",
  },
  {
    name: "git config read after global cwd option",
    command: "git -C repo config --get user.name",
    runtime: bashRuntime("git"),
    decision: "ask",
    reason: "GIT_CONFIG_UNSUPPORTED",
  },
  {
    name: "git config read unsupported",
    command: "git config --get user.name",
    runtime: bashRuntime("git"),
    decision: "ask",
    reason: "GIT_CONFIG_UNSUPPORTED",
  },
  {
    name: "git add",
    command: "git add note.txt",
    runtime: bashRuntime("git"),
    decision: "ask",
    reason: "GIT_STATE_CHANGE",
  },
  {
    name: "unknown neighbor containing rm",
    command: "firmware-tool inspect",
    runtime: bashRuntime("firmware-tool"),
    decision: "ask",
    reason: "UNSUPPORTED_COMMAND",
  },
  {
    name: "double-quoted backslash does not create cat command",
    command: '"c\\\\at" note.txt',
    runtime: bashRuntime("cat"),
    decision: "ask",
    reason: "UNSUPPORTED_COMMAND",
  },
  {
    name: "rm as argument is not rm command",
    command: "echo rm note.txt",
    runtime: bashRuntime("echo"),
    decision: "ask",
    reason: "UNSUPPORTED_COMMAND",
  },
  {
    name: "find exec argument neighbor",
    command: "find . -exec echo rm {} \\;",
    runtime: bashRuntime("find"),
    decision: "ask",
    reason: "UNSUPPORTED_SHELL_SYNTAX",
  },
  {
    name: "PowerShell get content",
    command: "Get-Content note.txt",
    runtime: { ...bashRuntime("Get-Content"), shell: "powershell" },
    decision: "ask",
    reason: "POWERSHELL_UNSUPPORTED",
  },
  {
    name: "PowerShell remove item not interpreted",
    command: "Remove-Item note.txt",
    runtime: { ...bashRuntime("Remove-Item"), shell: "powershell" },
    decision: "ask",
    reason: "POWERSHELL_UNSUPPORTED",
  },
];

const destructive: Fixture[] = [
  ["rm", "rm note.txt", "rm", "COMMAND_RM"],
  ["rm force recursive", "rm -rf build", "rm", "COMMAND_RM"],
  ["rmdir", "rmdir empty", "rmdir", "COMMAND_RMDIR"],
  ["unlink", "unlink note.txt", "unlink", "COMMAND_UNLINK"],
  ["shred", "shred note.txt", "shred", "COMMAND_SHRED"],
  ["truncate", "truncate -s 0 note.txt", "truncate", "COMMAND_TRUNCATE"],
  ["dd output", "dd if=/dev/zero of=image.bin", "dd", "DD_OUTPUT_TARGET"],
  ["find delete", "find . -delete", "find", "FIND_DELETE_ACTION"],
  ["find exec rm", "find . -exec rm {} \\;", "find", "FIND_EXEC_DESTRUCTIVE"],
  ["sed in place", "sed -i s/a/b/ note.txt", "sed", "SED_IN_PLACE"],
  ["perl in place", "perl -pi -e s/a/b/ note.txt", "perl", "PERL_IN_PLACE"],
  ["git clean", "git clean -fd", "git", "GIT_CLEAN_FORCE"],
  ["git reset hard", "git reset --hard HEAD", "git", "GIT_RESET_HARD"],
  [
    "git reset hard with cwd",
    "git -C repo reset --hard HEAD",
    "git",
    "GIT_RESET_HARD",
  ],
  [
    "git checkout path",
    "git checkout -- note.txt",
    "git",
    "GIT_CHECKOUT_OVERWRITE",
  ],
  ["git restore", "git restore note.txt", "git", "GIT_RESTORE_WORKTREE"],
  ["git rm", "git rm note.txt", "git", "GIT_RM"],
  ["git branch force delete", "git branch -D old", "git", "GIT_BRANCH_DELETE"],
  ["git tag delete", "git tag -d v1", "git", "GIT_TAG_DELETE"],
  ["git stash drop", "git stash drop", "git", "GIT_STASH_DELETE"],
  ["compound destructive", "echo ok; rm -rf build", "echo", "COMMAND_RM"],
  ["pipeline destructive", "printf x | rm note.txt", "printf", "COMMAND_RM"],
  ["wrapped destructive", "sudo rm note.txt", "sudo", "COMMAND_RM"],
  ["argument neighbor not substring", "rm-safe note.txt", "rm-safe", "none"],
].map(([name, command, executable, evidence]) => ({
  name: name ?? "",
  command: command ?? "",
  runtime: bashRuntime(executable ?? ""),
  decision: evidence === "none" ? "ask" : "block",
  reason:
    evidence === "none" ? "UNSUPPORTED_COMMAND" : "DESTRUCTIVE_FILE_OPERATION",
  family: evidence === "none" ? "unsupported" : "destructive",
}));

const preflight: Fixture[] = [
  {
    name: "unknown shell",
    command: "cat note.txt",
    runtime: { ...bashRuntime("cat"), shell: "unknown" },
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "interactive uncertainty",
    command: "cat note.txt",
    runtime: bashRuntime("cat", { nonInteractive: "unknown" }),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "environment uncertainty",
    command: "cat note.txt",
    runtime: bashRuntime("cat", { environment: "unknown" }),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "PATH uncertainty",
    command: "cat note.txt",
    runtime: bashRuntime("cat", { pathLookup: "unknown" }),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "alias uncertainty",
    command: "cat note.txt",
    runtime: bashRuntime("cat", { alias: "unknown" }),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "function uncertainty",
    command: "cat note.txt",
    runtime: bashRuntime("cat", { function: "unknown" }),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "known alias shadow",
    command: "cat note.txt",
    runtime: bashRuntime("cat", { alias: "present" }),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "unknown resolution",
    command: "cat note.txt",
    runtime: bashRuntime("cat", { commandResolution: { status: "unknown" } }),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "resolution mismatch",
    command: "cat note.txt",
    runtime: bashRuntime("cat", {
      commandResolution: {
        status: "verified",
        name: "other",
        kind: "executable",
        resolvedPath: "/usr/bin/other",
        supportedSemantics: "verified",
      },
    }),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "command semantics uncertainty",
    command: "cat note.txt",
    runtime: bashRuntime("cat", {
      commandResolution: {
        status: "verified",
        name: "cat",
        kind: "executable",
        resolvedPath: "/usr/bin/cat",
        supportedSemantics: "unknown",
      },
    }),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "unclosed quote",
    command: "cat 'note.txt",
    runtime: bashRuntime("cat"),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "incomplete escape",
    command: "cat note.txt\\",
    runtime: bashRuntime("cat"),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
  {
    name: "empty input",
    command: "",
    runtime: bashRuntime("cat"),
    decision: "block",
    reason: "PREFLIGHT_FAILED",
  },
];

test("A-006 conservative shell corpus", () => {
  const fixtures = [...positive, ...asks, ...destructive, ...preflight];
  const decisions: Record<string, number> = {};
  const mutations: Record<string, number> = {};
  const families = new Set<ShellCommandFamily>();
  let unknownOrAsk = 0;
  let destructiveEvidence = 0;

  for (const fixture of fixtures) {
    const classified = classifyShellCommand(fixture.command, fixture.runtime);
    expect(classified.decision, fixture.name).toBe(fixture.decision);
    expect(classified.reasonCodes, fixture.name).toContain(fixture.reason);
    if (fixture.family)
      expect(classified.family, fixture.name).toBe(fixture.family);
    if (classified.decision === "candidate_fast_path") {
      expect(classified.mutatesState, fixture.name).toBe("no");
      expect(classified.shellAssumption, fixture.name).toBe(
        "bash_non_interactive_simple_command_v1",
      );
      expect(classified.evidenceCodes, fixture.name).toEqual(
        expect.arrayContaining([
          "BASH_RUNTIME_VERIFIED",
          "ENVIRONMENT_VERIFIED",
          "COMMAND_RESOLUTION_VERIFIED",
          "COMMAND_SEMANTICS_VERIFIED",
          "ALIAS_ABSENT",
          "FUNCTION_ABSENT",
        ]),
      );
    }
    if (classified.decision === "ask" || classified.mutatesState === "unknown")
      unknownOrAsk += 1;
    if (classified.reasonCodes.includes("DESTRUCTIVE_FILE_OPERATION")) {
      destructiveEvidence += 1;
      expect(classified.evidenceCodes, fixture.name).toContain(
        "DANGEROUS_ARGUMENT_POSITION",
      );
    }
    decisions[classified.decision] = (decisions[classified.decision] ?? 0) + 1;
    mutations[classified.mutatesState] =
      (mutations[classified.mutatesState] ?? 0) + 1;
    families.add(classified.family);
  }

  expect(fixtures.length).toBeGreaterThanOrEqual(80);
  expect(decisions).toEqual({ candidate_fast_path: 40, ask: 50, block: 37 });
  expect(destructiveEvidence).toBe(23);
  expect([...families].sort()).toEqual([
    "destructive",
    "filesystem_read",
    "git_read",
    "git_state_change",
    "install",
    "network",
    "process",
    "shell_builtin",
    "text_search",
    "unknown",
    "unsupported",
  ]);
  console.info(
    `A-006 shell fixtures=${fixtures.length} decisions=${JSON.stringify(decisions)} mutations=${JSON.stringify(mutations)} unknown_or_ask=${unknownOrAsk} destructive=${destructiveEvidence}`,
  );
});
