/**
 * @file Agent Skill 学习闭环的核心类型定义。
 * 定义 Skill 管理工具的动作、请求、权限来源、生命周期状态和统计记录。
 * 所有六种 skill_manage 动作必须通过 {@link SkillManageAction} 穷尽区分，
 * 禁止用可选字段组合猜测动作。
 */

// ── 来源与范围 ──

/**
 * Skill 来源：用户级或项目级。
 * 同名时项目 Skill 覆盖用户 Skill。
 */
export type SkillSource = 'user' | 'project';

/**
 * Skill 写入操作的调用者来源。
 * 区分前台用户操作与后台自动维护，用于所有权检查和写入标记。
 */
export type SkillWriteOrigin = 'foreground' | 'background_review' | 'background_curator';

/** 后台 Skill Review 使用的受信 callerId 前缀。 */
export const SKILL_REVIEW_CALLER_ID_PREFIX = 'background-skill-review';

/** 后台 Skill Curator 使用的受信 callerId 前缀。 */
export const SKILL_CURATOR_CALLER_ID_PREFIX = 'background-skill-curator';

/** 用户批准 pending 重放时使用的受信 callerId 前缀。 */
export const SKILL_PENDING_APPROVAL_CALLER_PREFIX = 'skill-pending-approve';

// ── 生命周期 ──

/**
 * Skill 的生命周期状态。
 * - `active`：正常可加载、可匹配和使用。
 * - `stale`：超过 staleAfterDays 未活动，仍可加载但标为待归档。
 * - `archived`：已移入 `.archive/` 目录，不参与活跃索引。
 */
export type SkillLifecycleState = 'active' | 'stale' | 'archived';

// ── 动作与请求 ──

/**
 * skill_manage 工具支持的六种独立动作。
 * 每次工具调用只执行其中一种，不得组合。
 */
export type SkillManageAction =
  | 'create'
  | 'patch'
  | 'edit'
  | 'delete'
  | 'write_file'
  | 'remove_file';

/**
 * skill_manage 工具的完整请求参数。
 * 根据 action 不同，部分字段为可选。
 */
export interface SkillManageRequest {
  /** 目标 Skill 名称（文件系统安全小写 slug）。 */
  name: string;
  /** 要执行的动作。 */
  action: SkillManageAction;
  /** create/edit 时的新内容（完整 SKILL.md）。 */
  content?: string;
  /** create 时可选分类（用于检索分组，仅作元数据不改变运行时行为）。 */
  category?: string;
  /** patch 时的旧字符串（默认要求文件内唯一匹配）。 */
  oldString?: string;
  /** patch/edit 时的替换新字符串。 */
  newString?: string;
  /** patch 时是否允许替换所有匹配（默认 false）。 */
  replaceAll?: boolean;
  /** write_file/remove_file 时的支持文件相对路径（限于 `references/`、`templates/`、`scripts/`、`assets/`）。 */
  filePath?: string;
  /** write_file 时写入支持文件的内容。 */
  fileContent?: string;
  /** delete 时后台 origin 声明的吸收目标 umbrella 名称。 */
  absorbedInto?: string;
}

// ── 稳定错误代码 ──

/** 后台修改前未通过 load_skill 读取准确目标。 */
export const SKILL_ERR_READ_BEFORE_WRITE_REQUIRED = 'read_before_write_required';
/** 读取后目标内容已变化，需要重新读取后重试。 */
export const SKILL_ERR_STALE_SKILL_READ = 'stale_skill_read';
/** 目标状态与读取时不一致（如新建目标已经出现）。 */
export const SKILL_ERR_SKILL_TARGET_CHANGED = 'skill_target_changed';

/** Skill 写入边界可供调用方稳定判断的冲突错误代码。 */
export type SkillMutationErrorCode =
  | typeof SKILL_ERR_READ_BEFORE_WRITE_REQUIRED
  | typeof SKILL_ERR_STALE_SKILL_READ
  | typeof SKILL_ERR_SKILL_TARGET_CHANGED;

/**
 * 单次 Skill 管理操作的结果。
 * 区分成功、失败和暂存三种状态。
 */
export type SkillManageResult =
  | {
      status: 'success';
      action: SkillManageAction;
      name: string;
      /** 变更摘要。 */
      summary: string;
      /** 后台 create 时标记 agent-created。 */
      agentCreated?: boolean;
    }
  | {
      status: 'error';
      action: SkillManageAction;
      name: string;
      /** 错误描述。 */
      error: string;
      /** 稳定错误代码；冲突类错误必须携带，便于调用方重试决策。 */
      errorCode?: SkillMutationErrorCode;
    }
  | {
      status: 'staged';
      action: SkillManageAction;
      name: string;
      /** pending 记录唯一标识。 */
      pendingId: string;
      /** 变更摘要。 */
      summary: string;
    };

/**
 * pending 暂存时保存的单动作预览。
 * baseFingerprint 用于批准前检测目标是否发生变化。
 */
export interface SkillManagePreview {
  /** 用户可见的目标标签。 */
  readonly target: string;
  /** 暂存时目标内容；目录删除等动作可为空。 */
  readonly beforeContent: string | null;
  /** 应用后的目标内容；删除动作为空。 */
  readonly afterContent: string | null;
  /** 暂存时目标或完整包的稳定摘要。 */
  readonly baseFingerprint: string;
  /** 简短动作摘要。 */
  readonly summary: string;
}

/** Skill 管理预览结果。 */
export type SkillManagePreviewResult =
  | { readonly status: 'ready'; readonly preview: SkillManagePreview }
  | {
      readonly status: 'error';
      readonly error: string;
      /** 读取凭证或目标版本冲突时携带的稳定错误代码。 */
      readonly errorCode?: SkillMutationErrorCode;
    };

/**
 * 用户批准 pending 时交给 SkillLibrary 的受信重放条件。
 * id 只标识批准来源，baseFingerprint 才是锁内执行前必须重新验证的版本条件。
 */
export interface SkillPendingReplayGuard {
  /** 已通过参数绑定校验的 pending UUID。 */
  readonly id: string;
  /** pending 暂存时保存的目标内容或包摘要。 */
  readonly baseFingerprint: string;
}

// ── 元数据 ──

/**
 * Skill 包的完整元数据。
 * 包含解析路径、来源以及使用和所有权信息。
 */
export interface SkillPackageMetadata {
  /** 技能名称（文件系统安全小写 slug）。 */
  name: string;
  /** Skill 来源。 */
  source: SkillSource;
  /** SKILL.md 的物理路径。 */
  filePath: string;
  /** 技能根目录。 */
  skillDir: string;
  /** YAML frontmatter 中的描述。 */
  description: string;
  /** create 时指定的类别（可选）。 */
  category?: string;
}

// ── 使用统计与所有权 ──

/**
 * Skill 的使用统计记录，持久化在 `.usage.json` 中。
 * 只记录 curator-managed Skill 的遥测数据。前台创建的 Skill 初始为 unmanaged，
 * 直到用户通过 `/curator adopt` 显式移交后才纳入 Curator 管理。
 *
 * 不得根据计数或文件内容猜测作者身份。
 * `createdBy` 是"允许后台管理"的策略标记，不是历史作者事实。
 */
export interface SkillUsageRecord {
  /** 创建者类型：'agent' 或 null（unmanaged/前台创建）。 */
  createdBy: 'agent' | null;
  /** 累计使用次数（Skill 正文被注入任务）。 */
  useCount: number;
  /** 累计查看次数（load_skill 成功读取）。 */
  viewCount: number;
  /** 累计修改次数（patch/edit/write_file/remove_file）。 */
  patchCount: number;
  /** 首次创建时间（ISO 8601）。 */
  createdAt: string;
  /** 最近使用时间（ISO 8601）。 */
  lastUsedAt: string | null;
  /** 最近查看时间（ISO 8601）。 */
  lastViewedAt: string | null;
  /** 最近修改时间（ISO 8601）。 */
  lastPatchedAt: string | null;
  /** 当前生命周期状态。 */
  state: SkillLifecycleState;
  /** 是否被用户固定（跳过迁移和归档）。 */
  pinned: boolean;
  /** 归档时间（ISO 8601），未归档时为 null。 */
  archivedAt: string | null;
  /** 归档时的吸收目标 umbrella，仅后台 delete 设置。 */
  absorbedInto: string | null;
}
