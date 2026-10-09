/**
 * agent-porter — 把其他 harness 的 agents / commands / skills 注册为
 * omp 斜杠命令。
 *
 * 布局约定（demo 与本仓库实测）：智能体在 `<harness>/agents/<name>.md`，
 * 指令在 `<harness>/commands/[ns/]<name>.md`，技能在
 * `<harness>/skills/<name>/SKILL.md`（harness = .codebuddy / .qoder /
 * .claude / .agents / .github / ... 任意 dot-dir）。
 *
 * omp/18.8.6 实测结论：
 *   - task-agent 发现只认 `.omp/agents`（项目）、`~/.omp/agent/agents`
 *     （用户）、扩展包 agents/、Claude 插件 agents/ 与内置；
 *     指令/技能发现只认 `.omp`、`.claude`、`.agent[s]`、`.codex`、
 *     `.opencode`（技能另有 `.github`）。`.codebuddy/`、`.qoder/` 等
 *     其余 harness 的三类产物均不被发现。
 *   - 扩展 API 没有注册 task agent / skill 的方法。
 * 因此本扩展把外来 harness 的三类产物注册为斜杠命令，触发时：
 *   - agent（默认 dispatch）：
 *     · 定义在原生根（.omp/agents 或 ~/.omp/agent/agents）→ 用 task
 *       工具按名字派发真实子代理（tools/model 限定原生生效）
 *     · 其他来源 → 把定义全文嵌入任务描述派发通用 task 子代理
 *       （保留独立 context 与并行派发；tools/model 无法按定义限定）
 *   - agent `--inline`：定义全文注入当前会话（model 别名经
 *     before_provider_request 对下一发请求一次性生效）
 *   - command：展开正文（$ARGUMENTS / $@ / $1..$9 替换，无占位符时
 *     追加参数）后注入
 *   - skill：注入 SKILL.md 正文 + [Skill directory: <skillDir>]
 *     （与原生 /skill:<name> 的用户调用模板一致）
 *
 * 多源组合去重：按扫描顺序（项目级在前、用户级在后；同级别内
 * .agents/.omp 优先，其余字典序），同名定义先到先得；被覆盖的
 * 文件与命令名冲突都记入会话启动报告。原件零改动。
 *
 * 配置（可选，与本文件同目录 config.json）：
 * {
 *   "mode": "dispatch" | "inline",
 *   "sources": ["{cwd}/my-agents", "~/my-agents"],   // 追加 agent 扫描目录
 *   "prefixRules": [["^d2c-(?:block|page)-(\\w+)$", "d2c:$1"]],
 *   "modelAliases": { "space-bunny": "openrouter/inclusionai/ling-3.1-flash:high" }
 * }
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface AgentDef {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  body: string;
  file: string;
  source: string;
  /** 定义是否位于 omp 原生 task-agent 根（可按名字真实派发） */
  native: boolean;
}

/** 一条待注册的斜杠命令（agent / command / skill 统一归一成它） */
interface CommandSpec {
  command: string;
  description: string;
  kind: "agent" | "command" | "skill";
  file: string;
  run: (args: string, ctx: unknown) => void;
}

interface PorterConfig {
  mode?: "dispatch" | "inline";
  sources?: string[];
  prefixRules?: [string, string][];
  modelAliases?: Record<string, string>;
}

interface ModelResolution {
  selector?: string;
  note: string;
}

/** 命令 handler 拿到的 ctx：只取本扩展用到的字段，全部可选 */
interface PorterContext {
  agent?: { kind?: string };
  hasUI?: boolean;
  ui?: { notify(text: string, level: string): void };
  models?: { resolve(spec: string): unknown };
}

interface ProviderRequestEvent {
  payload?: Record<string, unknown>;
}

const DEFAULT_PREFIX_RULES: [string, string][] = [
  ["^d2c-(?:block|page)-(\\w+)$", "d2c:$1"],
];
const DEFAULT_MODEL_ALIASES: Record<string, string> = {
  "space-bunny": "openrouter/inclusionai/ling-3.1-flash:high",
};

/** omp 原生覆盖的 harness 根（指令与技能不再重复移植） */
const NATIVE_COMMAND_SKILL_ROOTS = [
  ".omp",
  ".claude",
  ".agents",
  ".agent",
  ".codex",
  ".opencode",
];
/** 技能另有 .github 原生覆盖 */
const NATIVE_SKILL_ROOTS = [...NATIVE_COMMAND_SKILL_ROOTS, ".github"];

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function loadConfig(dir: string): PorterConfig {
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as PorterConfig;
  } catch {
    return {};
  }
}

/**
 * 项目级 harness 根（绝对路径）：cwd 下所有含指定子目录的 dot-dir。
 * ".agents"（跨 harness 标准）与 ".omp"（omp 原生）优先，其余字典序。
 */
function projectHarnessRoots(cwd: string, subdir: string): string[] {
  const priority = [".agents", ".omp"];
  const rest: string[] = [];
  try {
    for (const entry of readdirSync(cwd).sort()) {
      if (!entry.startsWith(".") || priority.includes(entry)) continue;
      if (isDirectory(join(cwd, entry, subdir))) rest.push(entry);
    }
  } catch {
    return [];
  }
  return [...priority, ...rest]
    .filter((dir) => isDirectory(join(cwd, dir, subdir)))
    .map((dir) => join(cwd, dir));
}

/**
 * 用户级 harness 根（绝对路径）：~/.omp/agent（agents 特殊路径，
 * 注意是单数 agent）与 ~ 下任意含指定子目录的 dot-dir。
 */
function userHarnessRoots(home: string, subdir: string): string[] {
  const roots: string[] = [];
  if (subdir === "agents" && isDirectory(join(home, ".omp", "agent", "agents"))) {
    roots.push(join(home, ".omp", "agent"));
  }
  const priority = [".agents"];
  const rest: string[] = [];
  try {
    for (const entry of readdirSync(home).sort()) {
      if (!entry.startsWith(".") || entry === "omp" || priority.includes(entry)) {
        continue;
      }
      if (isDirectory(join(home, entry, subdir))) rest.push(entry);
    }
  } catch {
    return roots;
  }
  return [
    ...roots,
    ...[...priority, ...rest].filter((dir) =>
      isDirectory(join(home, dir, subdir)),
    ),
  ].map((dir) => join(home, dir));
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/.exec(text);
  const fm: Record<string, string> = {};
  if (!m) return { fm, body: text };
  let lastKey: string | undefined;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // YAML 列表续行：- "read" → 追加到上一个键（以 CSV 形式存储）
    if (line.startsWith("- ") && lastKey !== undefined) {
      const item = line.slice(2).trim().replace(/^["']|["']$/g, "");
      if (item) fm[lastKey] = fm[lastKey] ? `${fm[lastKey]},${item}` : item;
      continue;
    }
    const ci = line.indexOf(":");
    if (ci <= 0) continue;
    const key = line.slice(0, ci).trim().toLowerCase();
    let val = line.slice(ci + 1).trim();
    if (
      val.length > 1 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    if (fm[key] === undefined) fm[key] = val;
    lastKey = key;
  }
  return { fm, body: m[2] };
}

function parseAgentFile(file: string, source: string, native: boolean): AgentDef | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { fm, body } = parseFrontmatter(text);
  const name = (fm.name ?? "").trim();
  const description = (fm.description ?? "").trim();
  if (!name || !description) return null;
  const lower = name.toLowerCase();
  if (lower === "main" || lower === "sub") return null;
  const tools = (fm.tools ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const model = fm.model?.trim() || undefined;
  return { name, description, tools, model, body: body.trim(), file, source, native };
}

function collectAgents(
  sources: { dir: string; native: boolean }[],
): { agents: AgentDef[]; shadowed: { name: string; file: string; winner: string }[] } {
  const byName = new Map<string, AgentDef>();
  const shadowed: { name: string; file: string; winner: string }[] = [];
  for (const { dir, native } of sources) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
      const file = join(dir, entry);
      // statSync 跟随软链——omp 自身扫描器不跟随，这里直接读文件不受其限制
      if (!isFile(file)) continue;
      const def = parseAgentFile(file, dir, native);
      if (!def) continue;
      const winner = byName.get(def.name);
      if (winner) {
        shadowed.push({ name: def.name, file, winner: winner.file });
        continue;
      }
      byName.set(def.name, def);
    }
  }
  return { agents: [...byName.values()], shadowed };
}

function commandName(name: string, rules: [string, string][]): string {
  for (const [pattern, replacement] of rules) {
    const re = new RegExp(pattern);
    if (re.test(name)) return name.replace(re, replacement);
  }
  return name;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}

function parseFlags(args: string): { mode?: "dispatch" | "inline"; rest: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let mode: "dispatch" | "inline" | undefined;
  const rest: string[] = [];
  for (const token of tokens) {
    if (token === "--inline") mode = "inline";
    else if (token === "--dispatch") mode = "dispatch";
    else rest.push(token);
  }
  return { mode, rest: rest.join(" ") };
}

/** 指令模板的 $ARGUMENTS / $@ / $1..$9 替换（镜像原生文件指令展开） */
function expandCommandTemplate(body: string, args: string): string {
  const usedPlaceholder = /\$(?:\d+|ARGUMENTS|@)/.test(body);
  const positional = args.split(/\s+/).filter(Boolean);
  let out = body
    .replaceAll("$ARGUMENTS", args)
    .replaceAll("$@", args);
  for (let i = 0; i < positional.length && i < 9; i++) {
    out = out.replaceAll(`$${i + 1}`, positional[i]);
  }
  if (!usedPlaceholder && args) {
    out = `${out}\n${args}`;
  }
  return out;
}

function isPorterContext(value: unknown): value is PorterContext {
  // 字段访问全部走可选链，这里只确认是对象即可安全窄化
  return typeof value === "object" && value !== null;
}

function isProviderRequestEvent(event: unknown): event is ProviderRequestEvent {
  if (typeof event !== "object" || event === null) return false;
  return "payload" in event;
}

/** 解析 agent 的 model 字段（原生可用 / 别名映射 / 无法解析） */
function resolveModel(
  agent: AgentDef,
  ctx: PorterContext | undefined,
  modelAliases: Record<string, string>,
): ModelResolution | undefined {
  if (!agent.model) return undefined;
  const resolves = (spec: string): boolean => {
    try {
      return !!ctx?.models?.resolve?.(spec);
    } catch {
      return false;
    }
  };
  if (resolves(agent.model)) {
    return { selector: agent.model, note: `模型 ${agent.model}（原样可用）` };
  }
  const alias = modelAliases[agent.model];
  if (alias && resolves(alias)) {
    return { selector: alias, note: `模型 ${agent.model} → 映射 ${alias}` };
  }
  return { note: `模型 ${agent.model} 无法解析，已丢弃（跟主模型）` };
}

function buildAgentPrompt(
  agent: AgentDef,
  rest: string,
  mode: "dispatch" | "inline",
  model: ModelResolution | undefined,
): string {
  const lines: string[] = [];
  if (mode === "dispatch" && agent.native) {
    // 原生 task agent：按名字真实派发，frontmatter 的 tools/model 限定生效
    lines.push(`【任务代理派发】${agent.name}（omp 原生 task agent）`);
    lines.push(`来源：${agent.file}`);
    lines.push(
      `请使用 task 工具，以 agent: "${agent.name}" 派发子代理执行下方任务，不要在当前会话直接执行。`,
    );
    lines.push("该 agent 的 tools 与 model 限定由 omp 原生生效。");
  } else if (mode === "dispatch") {
    lines.push(`【任务代理派发】${agent.name}`);
    lines.push(`来源：${agent.file}`);
    lines.push(
      "请使用 task 工具派发一个子代理执行下方「agent 定义」的全部指令，不要在当前会话直接执行。",
    );
    lines.push("把「agent 定义」全文与「用户指令」作为子代理的任务描述。");
  } else {
    lines.push(`【任务代理】${agent.name} —— ${agent.description}`);
    lines.push(`来源：${agent.file}`);
    lines.push("请在当前会话内严格执行下方「agent 定义」的全部指令。");
  }
  if (agent.tools.length > 0) {
    lines.push(
      `声明工具：${agent.tools.join(", ")}（${
        mode === "dispatch"
          ? agent.native
            ? "派发时由 omp 原生生效"
            : "omp 无法按派发限权；子代理使用默认工具集"
          : "omp 无法按消息限权；当前会话工具集不变"
      }）`,
    );
  }
  if (model) {
    lines.push(
      `${model.note}${
        mode === "dispatch"
          ? agent.native
            ? "（派发时由 omp 原生生效）"
            : "（task 工具不支持按派发指定模型，子代理使用默认子代理模型）"
          : model.selector
            ? "（仅对本次注入的回复生效）"
            : ""
      }`,
    );
  }
  if (!(mode === "dispatch" && agent.native)) {
    lines.push("");
    lines.push(`<agent 定义 name="${agent.name}">`);
    lines.push(agent.body);
    lines.push("</agent 定义>");
  }
  lines.push("");
  lines.push(`用户指令：${rest || "（无）"}`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let cfg: PorterConfig = {};
  let prefixRules: [string, string][] = DEFAULT_PREFIX_RULES;
  let modelAliases: Record<string, string> = { ...DEFAULT_MODEL_ALIASES };
  let specs: CommandSpec[] = [];
  let shadowedAgents: { name: string; file: string; winner: string }[] = [];
  let shadowedCommands: { command: string; file: string; winner: string }[] = [];
  let oneShotModel: string | undefined;

  pi.setLabel("Agent Porter");

  try {
    if (cfg.prefixRules && cfg.prefixRules.length > 0) prefixRules = cfg.prefixRules;
    if (cfg.modelAliases) modelAliases = { ...DEFAULT_MODEL_ALIASES, ...cfg.modelAliases };
    const cwd = process.cwd();
    const home = homedir();
    const nativeProjectAgents = join(cwd, ".omp", "agents");
    const nativeUserAgents = join(home, ".omp", "agent", "agents");

    // ---------- agents：所有 harness 的 agents/（.omp 原生派发，其余通用派发）
    const agentSources = [
      ...projectHarnessRoots(cwd, "agents").map((root) => {
        const dir = join(root, "agents");
        return { dir, native: dir === nativeProjectAgents };
      }),
      ...userHarnessRoots(home, "agents").map((root) => {
        const dir =
          root === join(home, ".omp", "agent") ? nativeUserAgents : join(root, "agents");
        return { dir, native: dir === nativeUserAgents };
      }),
      ...(cfg.sources ?? []).map((p) => ({
        dir: p.replace(/\{cwd\}/g, cwd).replace(/^~(?=$|\/)/, home),
        native: false,
      })),
    ];
    const collected = collectAgents(agentSources);
    shadowedAgents = collected.shadowed;
    for (const agent of collected.agents) {
      const command = commandName(agent.name, prefixRules);
      specs.push({
        command,
        description: `代理：${truncate(agent.description, 80)}`,
        kind: "agent",
        run: (args, ctx) => {
          const { mode: flagMode, rest } = parseFlags(args ?? "");
          const mode = flagMode ?? cfg.mode ?? "dispatch";
          const porterCtx = isPorterContext(ctx) ? ctx : undefined;
          const model = resolveModel(agent, porterCtx, modelAliases);
          if (mode === "inline" && model?.selector) {
            oneShotModel = model.selector;
          }
          const prompt = buildAgentPrompt(agent, rest, mode, model);
          // 不带 attribution：agent 归因的消息在 print 模式下不起 turn（实测）
          pi.sendUserMessage(prompt);
        },
      });
    }

    // ---------- commands：外来 harness 的 commands/（原生根已由 omp 发现）
    const isNativeRoot = (root: string, home2: string): boolean => {
      const base =
        root === join(home2, ".omp", "agent")
          ? ".omp"
          : root.split("/").pop() ?? "";
      return NATIVE_COMMAND_SKILL_ROOTS.includes(base);
    };
    const commandRoots = [
      ...projectHarnessRoots(cwd, "commands"),
      ...userHarnessRoots(home, "commands"),
    ].filter((root) => !isNativeRoot(root, home));
    for (const root of commandRoots) {
      const commandsDir = join(root, "commands");
      let entries: string[] = [];
      try {
        entries = readdirSync(commandsDir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (entry.startsWith(".")) continue;
        const node = join(commandsDir, entry);
        // 子目录形式 <ns>/<name>.md → 命令 <ns>:<name>（claude 约定）
        if (isDirectory(node)) {
          let subEntries: string[] = [];
          try {
            subEntries = readdirSync(node);
          } catch {
            continue;
          }
          for (const sub of subEntries.sort()) {
            if (!sub.endsWith(".md") || sub.startsWith(".")) continue;
            addFileCommand(pi, specs, join(node, sub), `${entry}:${sub.slice(0, -3)}`);
          }
          continue;
        }
        if (!entry.endsWith(".md")) continue;
        addFileCommand(pi, specs, node, commandName(entry.slice(0, -3), prefixRules));
      }
    }

    // ---------- skills：外来 harness 的 skills/<name>/SKILL.md
    const isNativeSkillRoot = (root: string, home2: string): boolean => {
      const base =
        root === join(home2, ".omp", "agent")
          ? ".omp"
          : root.split("/").pop() ?? "";
      return NATIVE_SKILL_ROOTS.includes(base);
    };
    const skillRoots = [
      ...projectHarnessRoots(cwd, "skills"),
      ...userHarnessRoots(home, "skills"),
    ].filter((root) => !isNativeSkillRoot(root, home));
    for (const root of skillRoots) {
      const skillsDir = join(root, "skills");
      let entries: string[] = [];
      try {
        entries = readdirSync(skillsDir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (entry.startsWith(".")) continue;
        const skillFile = join(skillsDir, entry, "SKILL.md");
        if (!isFile(skillFile)) continue;
        addSkillCommand(pi, specs, skillFile, entry);
      }
    }
  } catch (err) {
    console.error(`[agent-porter] 扫描失败: ${String(err)}`);
  }

  // 模型别名：仅对 inline 模式的下一发请求生效（task 工具不支持按派发指定模型）
  pi.on("before_provider_request", async (event: unknown, ctx: unknown) => {
    if (!oneShotModel || !isProviderRequestEvent(event) || !event.payload) return;
    const porterCtx = isPorterContext(ctx) ? ctx : undefined;
    if (porterCtx?.agent?.kind !== "main") return;
    const model = oneShotModel;
    oneShotModel = undefined;
    return { ...event.payload, model };
  });

  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    const shadowedCount = shadowedAgents.length + shadowedCommands.length;
    const lines = [
      `agent-porter：注册 ${specs.length} 个命令（${specs.map((s) => `/${s.command}`).join(", ") || "无"}）`,
    ];
    if (shadowedCount > 0) {
      const entries: string[] = [];
      for (const s of shadowedAgents) {
        entries.push(`  去重: ${s.name} ← ${s.winner}（覆盖 ${s.file}）`);
      }
      for (const s of shadowedCommands) {
        entries.push(`  去重: /${s.command} ← ${s.winner}（覆盖 ${s.file}）`);
      }
      lines.push(...entries.slice(0, 15));
      if (entries.length > 15) {
        lines.push(`  … 另有 ${entries.length - 15} 条去重（多源同名，先到先得）`);
      }
    }
    const report = lines.join("\n");
    const porterCtx = isPorterContext(ctx) ? ctx : undefined;
    if (porterCtx?.hasUI && porterCtx.ui) {
      porterCtx.ui.notify(report, "info");
    } else {
      console.error(`[agent-porter] ${report}`);
    }
  });

  // 统一注册（共享 taken 集合，命令名冲突先到先得）
  const taken = new Set<string>();
  for (const spec of specs) {
    if (taken.has(spec.command)) {
      const winner = specs.find((s) => s.command === spec.command);
      shadowedCommands.push({
        command: spec.command,
        file: spec.file,
        winner: winner ? winner.file : spec.command,
      });
      continue;
    }
    taken.add(spec.command);
    pi.registerCommand(spec.command, {
      description: spec.description,
      handler: async (args: string, ctx: unknown) => {
        try {
          spec.run(args, ctx);
        } catch (err) {
          console.error(`[agent-porter] 命令 /${spec.command} 执行失败: ${String(err)}`);
        }
      },
    });
  }
}

/** 注册一条文件指令命令（外来 harness 的 commands/） */
function addFileCommand(
  pi: ExtensionAPI,
  specs: CommandSpec[],
  file: string,
  command: string,
): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const { fm, body } = parseFrontmatter(text);
  const description = (fm.description ?? "").trim();
  specs.push({
    command,
    description: truncate(description, 80),
    kind: "command",
    file,
    run: (args) => {
      const expanded = expandCommandTemplate(body.trim(), args);
      sendInjected(pi, expanded);
    },
  });
}

/** 注册一条技能命令（外来 harness 的 skills/<name>/SKILL.md） */
function addSkillCommand(
  pi: ExtensionAPI,
  specs: CommandSpec[],
  file: string,
  skillName: string,
): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const { fm, body } = parseFrontmatter(text);
  const description = (fm.description ?? fm.name ?? skillName).trim();
  const skillDir = join(file, "..");
  specs.push({
    command: skillName,
    description: `技能：${truncate(description, 80)}`,
    kind: "skill",
    file,
    run: (args) => {
      // 与原生 /skill:<name> 用户调用模板一致：正文 + skill 目录 + 用户参数
      const parts = [`【技能调用】${skillName}`, body.trim(), ""];
      parts.push(`[Skill directory: ${skillDir}]`);
      if (args) parts.push(`User: ${args}`);
      sendInjected(pi, parts.join("\n"));
    },
  });
}

function sendInjected(pi: ExtensionAPI, prompt: string): void {
  // 不带 attribution：agent 归因的消息在 print 模式下不起 turn（实测）
  pi.sendUserMessage(prompt);
}
