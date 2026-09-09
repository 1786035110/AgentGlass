import path from "node:path";

export type ShellClassificationDecision =
  | "candidate_fast_path"
  | "ask"
  | "block";

export type ShellCommandFamily =
  | "shell_builtin"
  | "filesystem_read"
  | "text_search"
  | "git_read"
  | "git_state_change"
  | "install"
  | "network"
  | "process"
  | "destructive"
  | "unsupported"
  | "unknown";

export interface ShellRuntimeEvidence {
  // 这些值必须对应当前调用的真实非交互 shell 与已解析命令；classifier 不会自行猜测
  // PATH、alias 或 function。上游拿不到任一证据时必须传 unknown，fast path 将失败关闭。
  shell: "bash" | "powershell" | "other" | "unknown";
  nonInteractive: "yes" | "no" | "unknown";
  environment: "verified" | "unknown";
  pathLookup: "verified" | "unknown";
  alias: "absent" | "present" | "unknown";
  function: "absent" | "present" | "unknown";
  commandResolution:
    | {
        status: "verified";
        name: string;
        kind: "builtin" | "executable";
        resolvedPath: string | null;
        // 不能只证明 PATH 命中：还须证明该具体实现和当前环境保持受支持的只读语义。
        supportedSemantics: "verified" | "unknown";
      }
    | { status: "unknown" };
}

export interface ShellClassification {
  // 这是 A-006 的分类处置，不是 RiskDecision，也不产生执行授权。
  decision: ShellClassificationDecision;
  family: ShellCommandFamily;
  mutatesState: "yes" | "no" | "unknown";
  reasonCodes: readonly string[];
  evidenceCodes: readonly string[];
  shellAssumption:
    | "bash_non_interactive_simple_command_v1"
    | "bash_syntax_only_v1"
    | "none";
}

type Operator = "|" | "||" | "&&" | ";" | "&" | "newline" | "redirect";
type Lexeme =
  | { kind: "word"; value: string }
  | { kind: "operator"; value: Operator };

const MAX_COMMAND_BYTES = 64 * 1024;
const destructiveCommands = new Set([
  "rm",
  "rmdir",
  "shred",
  "truncate",
  "unlink",
]);
const stateChangingCommands = new Set([
  "chmod",
  "chown",
  "cp",
  "install",
  "ln",
  "mkdir",
  "mv",
  "tee",
  "touch",
]);
const networkCommands = new Set([
  "curl",
  "ftp",
  "nc",
  "netcat",
  "rsync",
  "scp",
  "ssh",
  "telnet",
  "wget",
]);
const processCommands = new Set([
  "kill",
  "killall",
  "pkill",
  "service",
  "systemctl",
]);
const evalLikeCommands = new Set([
  ".",
  "!",
  "bash",
  "builtin",
  "command",
  "env",
  "eval",
  "exec",
  "sh",
  "source",
  "sudo",
  "time",
  "xargs",
]);

const simpleOptions = new Map<string, ReadonlySet<string>>([
  ["pwd", new Set(["-L", "-P", "--logical", "--physical"])],
  [
    "ls",
    new Set([
      "-1",
      "-A",
      "-F",
      "-S",
      "-a",
      "-d",
      "-h",
      "-l",
      "-n",
      "-r",
      "-t",
      "--all",
      "--almost-all",
      "--classify",
      "--directory",
      "--human-readable",
      "--inode",
      "--numeric-uid-gid",
      "--reverse",
      "--size",
    ]),
  ],
  [
    "cat",
    new Set([
      "-A",
      "-E",
      "-T",
      "-b",
      "-e",
      "-n",
      "-s",
      "-t",
      "-u",
      "-v",
      "--number",
      "--number-nonblank",
      "--show-all",
      "--show-ends",
      "--show-tabs",
      "--squeeze-blank",
    ]),
  ],
  [
    "wc",
    new Set([
      "-L",
      "-c",
      "-l",
      "-m",
      "-w",
      "--bytes",
      "--chars",
      "--lines",
      "--max-line-length",
      "--words",
    ]),
  ],
]);

function result(
  decision: ShellClassificationDecision,
  family: ShellCommandFamily,
  mutatesState: ShellClassification["mutatesState"],
  reasonCodes: readonly string[],
  evidenceCodes: readonly string[],
  shellAssumption: ShellClassification["shellAssumption"] = "none",
): ShellClassification {
  return Object.freeze({
    decision,
    family,
    mutatesState,
    reasonCodes: Object.freeze([...new Set(reasonCodes)]),
    evidenceCodes: Object.freeze([...new Set(evidenceCodes)]),
    shellAssumption,
  });
}

function preflight(...evidenceCodes: string[]): ShellClassification {
  return result(
    "block",
    "unknown",
    "unknown",
    ["PREFLIGHT_FAILED"],
    evidenceCodes,
  );
}

// 这里只识别“一个静态 Bash 命令”所需的最小词法边界：引号和反斜杠用于恢复参数位置，
// 控制符、重定向和展开只被标记为不支持，绝不尝试解释其执行语义。未闭合引号等非法输入
// 使后续安全分析没有可信参数位置，因此按 PREFLIGHT_FAILED 失败关闭。
function lex(
  command: string,
):
  | { status: "ok"; lexemes: Lexeme[]; features: string[] }
  | { status: "invalid"; evidence: string } {
  if (
    command.length === 0 ||
    Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES
  ) {
    return { status: "invalid", evidence: "SHELL_INPUT_INVALID" };
  }

  const lexemes: Lexeme[] = [];
  const features: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "single" | "double" | undefined;

  const pushWord = (): void => {
    if (!wordStarted) return;
    lexemes.push({ kind: "word", value: word });
    word = "";
    wordStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    const code = character.codePointAt(0) ?? 0;
    if (
      (code < 0x20 && character !== "\t" && character !== "\n") ||
      code === 0x7f
    ) {
      return { status: "invalid", evidence: "SHELL_CONTROL_CHARACTER" };
    }

    if (quote === "single") {
      if (character === "'") quote = undefined;
      else word += character;
      wordStarted = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        index += 1;
        if (index >= command.length)
          return { status: "invalid", evidence: "SHELL_ESCAPE_INCOMPLETE" };
        const escaped = command[index] ?? "";
        // Bash 双引号内只有这五类字符会被反斜杠转义；其他反斜杠必须保留，
        // 否则可能把实际的未知命令名错误还原成受支持命令。
        if (escaped === "\n") continue;
        word += ["$", "`", '"', "\\"].includes(escaped)
          ? escaped
          : `\\${escaped}`;
      } else {
        if (character === "$" || character === "`")
          features.push("SHELL_SUBSTITUTION");
        word += character;
      }
      wordStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      wordStarted = true;
      continue;
    }
    if (character === "\\") {
      index += 1;
      if (index >= command.length)
        return { status: "invalid", evidence: "SHELL_ESCAPE_INCOMPLETE" };
      const escaped = command[index] ?? "";
      // 非引号中的反斜杠换行是 Bash 行连接，不属于参数内容。
      if (escaped === "\n") continue;
      word += escaped;
      wordStarted = true;
      continue;
    }
    if (character === " " || character === "\t") {
      pushWord();
      continue;
    }
    if (character === "\n") {
      pushWord();
      lexemes.push({ kind: "operator", value: "newline" });
      features.push("COMPOUND_COMMAND_UNSUPPORTED");
      continue;
    }
    if (character === "$" || character === "`") {
      features.push("SHELL_SUBSTITUTION");
      word += character;
      wordStarted = true;
      continue;
    }
    if (character === "*" || character === "?" || character === "[") {
      features.push("DYNAMIC_EXPANSION_UNSUPPORTED");
      word += character;
      wordStarted = true;
      continue;
    }
    if (
      character === "{" ||
      character === "}" ||
      character === "(" ||
      character === ")"
    ) {
      features.push("DYNAMIC_CONSTRUCTION_UNSUPPORTED");
      word += character;
      wordStarted = true;
      continue;
    }
    if (character === "#" && !wordStarted) {
      features.push("SHELL_COMMENT_UNSUPPORTED");
      word += command.slice(index);
      wordStarted = true;
      break;
    }
    if ("|&;<>".includes(character)) {
      pushWord();
      let value = character;
      const next = command[index + 1];
      if (next === character || (character === ">" && next === "|")) {
        value += next;
        index += 1;
      }
      const operator: Operator =
        character === "|"
          ? value === "||"
            ? "||"
            : "|"
          : character === "&"
            ? value === "&&"
              ? "&&"
              : "&"
            : character === ";"
              ? ";"
              : "redirect";
      lexemes.push({ kind: "operator", value: operator });
      features.push(
        operator === "|"
          ? "PIPELINE_UNSUPPORTED"
          : operator === "redirect"
            ? "REDIRECTION_UNSUPPORTED"
            : "COMPOUND_COMMAND_UNSUPPORTED",
      );
      continue;
    }
    if (character === "~" && !wordStarted)
      features.push("DYNAMIC_EXPANSION_UNSUPPORTED");
    word += character;
    wordStarted = true;
  }

  if (quote) return { status: "invalid", evidence: "SHELL_QUOTE_UNCLOSED" };
  pushWord();
  if (!lexemes.some((lexeme) => lexeme.kind === "word"))
    return { status: "invalid", evidence: "SHELL_INPUT_INVALID" };
  return { status: "ok", lexemes, features: [...new Set(features)] };
}

function isControl(operator: Operator): boolean {
  return operator !== "redirect";
}

function hasLeadingAssignment(lexemes: readonly Lexeme[]): boolean {
  let commandExpected = true;
  for (const lexeme of lexemes) {
    if (lexeme.kind === "operator") {
      if (isControl(lexeme.value)) commandExpected = true;
      continue;
    }
    if (!commandExpected) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(lexeme.value)) return true;
    commandExpected = false;
  }
  return false;
}

// 复合语法本身不会进入 fast path；这里仍按分隔符恢复每段的命令/参数位置，只为识别
// “rm 是命令”和“echo rm”之间的安全差异。重定向目标会被跳过，避免把文件名误当命令。
function commandSegments(lexemes: readonly Lexeme[]): string[][] {
  const groups: Lexeme[][] = [[]];
  for (const lexeme of lexemes) {
    if (lexeme.kind === "operator" && isControl(lexeme.value)) groups.push([]);
    else groups.at(-1)?.push(lexeme);
  }

  return groups
    .map((group) => {
      const words: string[] = [];
      for (let index = 0; index < group.length; index += 1) {
        const item = group[index];
        if (item?.kind === "operator") {
          if (item.value === "redirect") index += 1;
          continue;
        }
        if (
          /^\d+$/.test(item?.value ?? "") &&
          group[index + 1]?.kind === "operator" &&
          group[index + 1]?.value === "redirect"
        ) {
          continue;
        }
        if (
          words.length === 0 &&
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(item?.value ?? "")
        )
          continue;
        words.push(item?.value ?? "");
      }
      return words;
    })
    .filter((words) => words.length > 0);
}

function nameOf(token: string): string {
  return path.posix.basename(token).toLowerCase();
}

function hasShortFlag(args: readonly string[], flag: string): boolean {
  const terminator = args.indexOf("--");
  const options = terminator < 0 ? args : args.slice(0, terminator);
  return options.some(
    (argument) =>
      argument === `-${flag}` ||
      (/^-[^-]+$/.test(argument) && argument.slice(1).includes(flag)),
  );
}

function hasLongFlag(args: readonly string[], flag: string): boolean {
  const terminator = args.indexOf("--");
  return (terminator < 0 ? args : args.slice(0, terminator)).includes(flag);
}

function gitCommand(args: readonly string[]): {
  subcommand: string | undefined;
  rest: readonly string[];
} {
  const optionsWithValue = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--namespace",
    "--work-tree",
  ]);
  let index = 0;
  while (index < args.length && args[index]?.startsWith("-")) {
    const option = args[index] ?? "";
    index += optionsWithValue.has(option) ? 2 : 1;
  }
  return {
    subcommand: args[index]?.toLowerCase(),
    rest: args.slice(index + 1),
  };
}

function destructiveEvidence(
  words: readonly string[],
  wrapperDepth = 0,
): string | undefined {
  const command = nameOf(words[0] ?? "");
  const args = words.slice(1);
  if (destructiveCommands.has(command))
    return `COMMAND_${command.toUpperCase()}`;
  if (command === "dd" && args.some((argument) => /^of=/.test(argument)))
    return "DD_OUTPUT_TARGET";
  if (command === "find" && args.includes("-delete"))
    return "FIND_DELETE_ACTION";
  const findExec = args.findIndex((argument) =>
    ["-exec", "-execdir", "-ok", "-okdir"].includes(argument),
  );
  if (
    command === "find" &&
    findExec >= 0 &&
    destructiveCommands.has(nameOf(args[findExec + 1] ?? ""))
  )
    return "FIND_EXEC_DESTRUCTIVE";
  if (
    command === "sed" &&
    args.some(
      (argument) =>
        argument === "--in-place" ||
        argument.startsWith("--in-place=") ||
        /^-i/.test(argument),
    )
  )
    return "SED_IN_PLACE";
  if (
    command === "perl" &&
    args.some((argument) => argument === "-pi" || /^-i/.test(argument))
  )
    return "PERL_IN_PLACE";
  if (
    wrapperDepth < 8 &&
    ["builtin", "command", "env", "sudo", "time", "xargs"].includes(command)
  ) {
    const nested = args.findIndex(
      (argument) =>
        !argument.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument),
    );
    if (nested >= 0)
      return destructiveEvidence(args.slice(nested), wrapperDepth + 1);
  }
  if (command !== "git") return undefined;

  const { subcommand, rest } = gitCommand(args);
  if (
    subcommand === "clean" &&
    (hasShortFlag(rest, "f") || hasLongFlag(rest, "--force"))
  )
    return "GIT_CLEAN_FORCE";
  if (subcommand === "reset" && hasLongFlag(rest, "--hard"))
    return "GIT_RESET_HARD";
  if (subcommand === "restore") return "GIT_RESTORE_WORKTREE";
  if (subcommand === "rm") return "GIT_RM";
  if (
    subcommand === "checkout" &&
    (rest.includes("--") || hasShortFlag(rest, "f"))
  )
    return "GIT_CHECKOUT_OVERWRITE";
  if (
    subcommand === "branch" &&
    (hasShortFlag(rest, "d") ||
      hasShortFlag(rest, "D") ||
      hasLongFlag(rest, "--delete"))
  )
    return "GIT_BRANCH_DELETE";
  if (
    subcommand === "tag" &&
    (hasShortFlag(rest, "d") || hasLongFlag(rest, "--delete"))
  )
    return "GIT_TAG_DELETE";
  if (subcommand === "stash" && ["drop", "clear"].includes(rest[0] ?? ""))
    return "GIT_STASH_DELETE";
  return undefined;
}

function askForCommand(
  words: readonly string[],
): ShellClassification | undefined {
  const command = nameOf(words[0] ?? "");
  const args = words.slice(1);
  if (evalLikeCommands.has(command))
    return result(
      "ask",
      "unsupported",
      "unknown",
      ["EVAL_LIKE_BEHAVIOR"],
      [`COMMAND_${command.toUpperCase()}`],
      "bash_syntax_only_v1",
    );
  if (networkCommands.has(command))
    return result(
      "ask",
      "network",
      "unknown",
      ["NETWORK_COMMAND"],
      [`COMMAND_${command.toUpperCase()}`],
      "bash_syntax_only_v1",
    );
  if (processCommands.has(command))
    return result(
      "ask",
      "process",
      "yes",
      ["PROCESS_STATE_CHANGE"],
      [`COMMAND_${command.toUpperCase()}`],
      "bash_syntax_only_v1",
    );
  if (stateChangingCommands.has(command))
    return result(
      "ask",
      "unsupported",
      "yes",
      ["SHELL_STATE_CHANGE"],
      [`COMMAND_${command.toUpperCase()}`],
      "bash_syntax_only_v1",
    );

  const directSubcommand = args[0]?.toLowerCase();
  if (
    (["apt", "apt-get", "brew", "cargo", "dnf", "pip", "pip3", "yum"].includes(
      command,
    ) &&
      directSubcommand === "install") ||
    (command === "npm" &&
      ["add", "ci", "i", "install"].includes(directSubcommand ?? "")) ||
    (command === "pnpm" &&
      ["add", "i", "install"].includes(directSubcommand ?? "")) ||
    (command === "yarn" &&
      ["add", "install"].includes(directSubcommand ?? "")) ||
    command === "npx"
  ) {
    return result(
      "ask",
      "install",
      "yes",
      ["INSTALL_COMMAND"],
      [`COMMAND_${command.toUpperCase()}`],
      "bash_syntax_only_v1",
    );
  }
  const git = command === "git" ? gitCommand(args) : undefined;
  const subcommand = git?.subcommand;
  if (command === "git" && subcommand === "config") {
    const readModes = new Set([
      "--get",
      "--get-all",
      "--get-regexp",
      "--get-urlmatch",
    ]);
    const mutation = !git?.rest.some((argument) => readModes.has(argument));
    return result(
      "ask",
      "git_state_change",
      mutation ? "yes" : "unknown",
      [mutation ? "GIT_CONFIG_MUTATION" : "GIT_CONFIG_UNSUPPORTED"],
      ["GIT_SUBCOMMAND_CONFIG"],
      "bash_syntax_only_v1",
    );
  }
  if (
    command === "git" &&
    ["clone", "fetch", "ls-remote", "pull", "push"].includes(subcommand ?? "")
  )
    return result(
      "ask",
      "network",
      "unknown",
      ["NETWORK_COMMAND"],
      [`GIT_SUBCOMMAND_${subcommand?.toUpperCase().replaceAll("-", "_")}`],
      "bash_syntax_only_v1",
    );
  if (
    command === "git" &&
    [
      "add",
      "am",
      "checkout",
      "commit",
      "merge",
      "mv",
      "rebase",
      "reset",
      "revert",
      "rm",
      "switch",
      "tag",
    ].includes(subcommand ?? "")
  )
    return result(
      "ask",
      "git_state_change",
      "yes",
      ["GIT_STATE_CHANGE"],
      [`GIT_SUBCOMMAND_${subcommand?.toUpperCase()}`],
      "bash_syntax_only_v1",
    );
  if (
    command === "git" &&
    subcommand &&
    !["branch", "diff", "log", "rev-parse", "show", "status"].includes(
      subcommand,
    )
  )
    return result(
      "ask",
      "git_state_change",
      "unknown",
      ["GIT_COMMAND_UNSUPPORTED"],
      ["GIT_SUBCOMMAND_UNSUPPORTED"],
      "bash_syntax_only_v1",
    );
  return undefined;
}

function simpleOptionsSupported(
  command: string,
  args: readonly string[],
): boolean {
  const allowed = simpleOptions.get(command);
  if (!allowed) return false;
  let afterTerminator = false;
  for (const argument of args) {
    if (argument === "--") {
      afterTerminator = true;
      continue;
    }
    if (!afterTerminator && argument.startsWith("-") && argument !== "-") {
      if (
        !allowed.has(argument) &&
        !(
          /^-[^-]{2,}$/.test(argument) &&
          [...argument.slice(1)].every((flag) => allowed.has(`-${flag}`))
        )
      )
        return false;
    } else if (command === "pwd") return false;
  }
  return true;
}

function headOrTailSupported(
  command: string,
  args: readonly string[],
): boolean {
  let afterTerminator = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--") {
      afterTerminator = true;
      continue;
    }
    if (afterTerminator || !argument.startsWith("-") || argument === "-") {
      continue;
    }
    if (
      ["-q", "-v", "-z", "--quiet", "--verbose", "--zero-terminated"].includes(
        argument,
      )
    )
      continue;
    if (/^-[nc]\d+$/.test(argument) || /^--(?:bytes|lines)=\d+$/.test(argument))
      continue;
    if (
      ["-n", "-c", "--lines", "--bytes"].includes(argument) &&
      /^\d+$/.test(args[index + 1] ?? "")
    ) {
      index += 1;
      continue;
    }
    return false;
  }
  return (
    command === "head" ||
    !args.some((argument) =>
      ["-f", "-F", "--follow", "--retry", "--pid"].includes(argument),
    )
  );
}

function grepSupported(args: readonly string[]): boolean {
  const flags = new Set([
    "-E",
    "-F",
    "-G",
    "-H",
    "-h",
    "-i",
    "-n",
    "-s",
    "-v",
    "-w",
    "-x",
    "--extended-regexp",
    "--fixed-strings",
    "--ignore-case",
    "--line-number",
    "--no-filename",
    "--quiet",
    "--silent",
    "--with-filename",
    "--word-regexp",
    "--invert-match",
    "--line-regexp",
  ]);
  let patterns = 0;
  let operands = 0;
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && flags.has(argument)) continue;
    if (options && ["-e", "--regexp"].includes(argument)) {
      if (args[index + 1] === undefined) return false;
      patterns += 1;
      index += 1;
      continue;
    }
    if (options && argument.startsWith("-")) return false;
    if (patterns === 0) patterns += 1;
    else operands += 1;
  }
  return patterns > 0 && operands >= 0;
}

function gitReadSupported(args: readonly string[]): boolean {
  const subcommand = args[0]?.toLowerCase();
  const rest = args.slice(1);
  if (!subcommand) return false;
  const flags: Record<string, ReadonlySet<string>> = {
    status: new Set([
      "-b",
      "-s",
      "--branch",
      "--porcelain",
      "--porcelain=v1",
      "--porcelain=v2",
      "--short",
      "--show-stash",
      "--untracked-files=all",
      "--untracked-files=no",
      "--untracked-files=normal",
    ]),
    diff: new Set([
      "--cached",
      "--check",
      "--name-only",
      "--name-status",
      "--shortstat",
      "--staged",
      "--stat",
    ]),
    log: new Set([
      "--decorate",
      "--name-only",
      "--oneline",
      "--shortstat",
      "--stat",
    ]),
    show: new Set([
      "--name-only",
      "--name-status",
      "--oneline",
      "--shortstat",
      "--stat",
    ]),
    "rev-parse": new Set([
      "--is-bare-repository",
      "--is-inside-work-tree",
      "--show-cdup",
      "--show-prefix",
      "--show-toplevel",
      "--verify",
    ]),
    branch: new Set(["--list", "--show-current"]),
  };
  const allowed = flags[subcommand];
  if (!allowed) return false;
  if (subcommand === "branch" && rest.length > 0 && !allowed.has(rest[0] ?? ""))
    return false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? "";
    if (argument === "--") continue;
    if (
      subcommand === "log" &&
      argument === "-n" &&
      /^\d+$/.test(rest[index + 1] ?? "")
    ) {
      index += 1;
      continue;
    }
    if (
      subcommand === "log" &&
      (/^-n\d+$/.test(argument) || /^--max-count=\d+$/.test(argument))
    )
      continue;
    if (argument.startsWith("-") && !allowed.has(argument)) return false;
  }
  return true;
}

function readOnlyFamily(command: string): ShellCommandFamily | undefined {
  if (command === "pwd") return "shell_builtin";
  if (["cat", "head", "ls", "tail", "wc"].includes(command))
    return "filesystem_read";
  if (command === "grep") return "text_search";
  if (command === "git") return "git_read";
  return undefined;
}

function readOnlySyntaxSupported(words: readonly string[]): boolean {
  const command = nameOf(words[0] ?? "");
  const args = words.slice(1);
  if (simpleOptions.has(command)) return simpleOptionsSupported(command, args);
  if (command === "head" || command === "tail")
    return headOrTailSupported(command, args);
  if (command === "grep") return grepSupported(args);
  if (command === "git") return gitReadSupported(args);
  return false;
}

function runtimeSupportsFastPath(
  commandToken: string,
  evidence: ShellRuntimeEvidence,
): string | undefined {
  const command = nameOf(commandToken);
  if (commandToken.includes("/")) return "EXPLICIT_COMMAND_PATH_UNSUPPORTED";
  if (evidence.nonInteractive === "no") return "INTERACTIVE_SHELL_UNSUPPORTED";
  if (evidence.nonInteractive === "unknown") return "SHELL_MODE_UNCERTAIN";
  if (evidence.environment !== "verified") return "ENVIRONMENT_UNCERTAIN";
  if (evidence.pathLookup !== "verified") return "PATH_UNCERTAIN";
  if (evidence.alias === "present") return "ALIAS_SHADOWING_PRESENT";
  if (evidence.alias === "unknown") return "ALIAS_UNCERTAIN";
  if (evidence.function === "present") return "FUNCTION_SHADOWING_PRESENT";
  if (evidence.function === "unknown") return "FUNCTION_UNCERTAIN";
  if (evidence.commandResolution.status !== "verified")
    return "COMMAND_RESOLUTION_UNCERTAIN";
  if (evidence.commandResolution.name !== command)
    return "COMMAND_RESOLUTION_MISMATCH";
  if (evidence.commandResolution.supportedSemantics !== "verified")
    return "COMMAND_SEMANTICS_UNCERTAIN";
  if (command === "pwd" && evidence.commandResolution.kind !== "builtin")
    return "COMMAND_RESOLUTION_MISMATCH";
  if (command !== "pwd") {
    const resolved = evidence.commandResolution.resolvedPath;
    if (
      evidence.commandResolution.kind !== "executable" ||
      !resolved ||
      !path.posix.isAbsolute(resolved)
    )
      return "COMMAND_RESOLUTION_UNCERTAIN";
  }
  return undefined;
}

function runtimeEvidence(value: unknown): ShellRuntimeEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  const data = (key: string): unknown => {
    const descriptor = fields[key];
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const shell = data("shell");
  const nonInteractive = data("nonInteractive");
  const environment = data("environment");
  const pathLookup = data("pathLookup");
  const alias = data("alias");
  const shellFunction = data("function");
  const resolution = data("commandResolution");
  if (
    !["bash", "powershell", "other", "unknown"].includes(String(shell)) ||
    !["yes", "no", "unknown"].includes(String(nonInteractive)) ||
    !["verified", "unknown"].includes(String(environment)) ||
    !["verified", "unknown"].includes(String(pathLookup)) ||
    !["absent", "present", "unknown"].includes(String(alias)) ||
    !["absent", "present", "unknown"].includes(String(shellFunction)) ||
    !resolution ||
    typeof resolution !== "object" ||
    Array.isArray(resolution)
  )
    return undefined;

  const resolutionFields = Object.getOwnPropertyDescriptors(resolution);
  const resolutionData = (key: string): unknown => {
    const descriptor = resolutionFields[key];
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const status = resolutionData("status");
  if (status !== "unknown" && status !== "verified") return undefined;
  if (
    status === "verified" &&
    (typeof resolutionData("name") !== "string" ||
      !["builtin", "executable"].includes(String(resolutionData("kind"))) ||
      !["verified", "unknown"].includes(
        String(resolutionData("supportedSemantics")),
      ) ||
      (resolutionData("resolvedPath") !== null &&
        typeof resolutionData("resolvedPath") !== "string"))
  )
    return undefined;
  return {
    shell: shell as ShellRuntimeEvidence["shell"],
    nonInteractive: nonInteractive as ShellRuntimeEvidence["nonInteractive"],
    environment: environment as ShellRuntimeEvidence["environment"],
    pathLookup: pathLookup as ShellRuntimeEvidence["pathLookup"],
    alias: alias as ShellRuntimeEvidence["alias"],
    function: shellFunction as ShellRuntimeEvidence["function"],
    commandResolution:
      status === "unknown"
        ? { status: "unknown" }
        : {
            status: "verified",
            name: resolutionData("name") as string,
            kind: resolutionData("kind") as "builtin" | "executable",
            resolvedPath: resolutionData("resolvedPath") as string | null,
            supportedSemantics: resolutionData("supportedSemantics") as
              | "verified"
              | "unknown",
          },
  };
}

// A-006 只返回确定性 shell 事实，不连接 Pi、不执行命令，也不产生 A-007 的最终 RiskAssessment。
// candidate_fast_path 仅表示“在明确 Bash/环境/解析证据下，语法属于窄只读集合”；路径、敏感性、
// 审批与实际放行仍必须由后续任务完成。任何缺失的关键运行证据都失败关闭。
export function classifyShellCommand(
  command: unknown,
  untrustedRuntime: unknown,
): ShellClassification {
  let runtime: ShellRuntimeEvidence | undefined;
  try {
    runtime = runtimeEvidence(untrustedRuntime);
  } catch {
    return preflight("SHELL_RUNTIME_INVALID");
  }
  if (!runtime) return preflight("SHELL_RUNTIME_INVALID");
  if (typeof command !== "string") return preflight("SHELL_INPUT_INVALID");
  if (runtime.shell === "unknown") return preflight("SHELL_RUNTIME_UNKNOWN");
  if (runtime.shell !== "bash")
    return result(
      "ask",
      "unsupported",
      "unknown",
      [
        runtime.shell === "powershell"
          ? "POWERSHELL_UNSUPPORTED"
          : "SHELL_UNSUPPORTED",
      ],
      ["FAST_PATH_NOT_APPLICABLE"],
    );

  const parsed = lex(command);
  if (parsed.status === "invalid") return preflight(parsed.evidence);
  const segments = commandSegments(parsed.lexemes);
  if (hasLeadingAssignment(parsed.lexemes))
    parsed.features.push("ENVIRONMENT_ASSIGNMENT_UNSUPPORTED");

  for (const words of segments) {
    const evidence = destructiveEvidence(words);
    if (evidence)
      return result(
        "block",
        "destructive",
        "yes",
        ["DESTRUCTIVE_FILE_OPERATION"],
        [evidence, "DANGEROUS_ARGUMENT_POSITION"],
        "bash_syntax_only_v1",
      );
  }

  if (parsed.features.length > 0) {
    return result(
      "ask",
      "unsupported",
      "unknown",
      ["UNSUPPORTED_SHELL_SYNTAX"],
      parsed.features,
      "bash_syntax_only_v1",
    );
  }

  const words = segments[0] ?? [];
  const special = askForCommand(words);
  if (special) return special;
  const commandName = nameOf(words[0] ?? "");
  const family = readOnlyFamily(commandName);
  if (!family)
    return result(
      "ask",
      "unsupported",
      "unknown",
      ["UNSUPPORTED_COMMAND"],
      ["COMMAND_FAMILY_UNSUPPORTED"],
      "bash_syntax_only_v1",
    );
  if (!readOnlySyntaxSupported(words))
    return result(
      "ask",
      family,
      "unknown",
      ["UNSUPPORTED_OPTION"],
      ["READ_ONLY_COMMAND_RECOGNIZED"],
      "bash_syntax_only_v1",
    );

  const failedEvidence = runtimeSupportsFastPath(words[0] ?? "", runtime);
  if (failedEvidence) return preflight(failedEvidence);
  return result(
    "candidate_fast_path",
    family,
    "no",
    ["KNOWN_READ_ONLY"],
    [
      "BASH_RUNTIME_VERIFIED",
      "NON_INTERACTIVE_SHELL_VERIFIED",
      "ENVIRONMENT_VERIFIED",
      "PATH_LOOKUP_VERIFIED",
      "COMMAND_RESOLUTION_VERIFIED",
      "COMMAND_SEMANTICS_VERIFIED",
      "ALIAS_ABSENT",
      "FUNCTION_ABSENT",
      "STATIC_SIMPLE_COMMAND",
    ],
    "bash_non_interactive_simple_command_v1",
  );
}
