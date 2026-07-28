# Tauri command nested struct 参数 invoke 约定

> Rust 端 `#[tauri::command] fn xxx(request: T)` 的参数是 struct 时，前端
> `invoke('xxx', payload)` 必须把 struct 放在同名的 top-level key 下；不能把
> struct 字段直接摊平。否则 Tauri 无法反序列化该 command 参数。
>
> **伪代码声明**：本文使用的 `ProjectImportRequest`、`import_project` 及所有字段均为
> 中性伪代码，只用于说明边界形状，不代表当前仓库存在对应命令、类型、文件或测试。
> 在实际实现落地前，不得把这些名称写成“参考实现”或“已有实现”。

## Scope / Trigger

新增或修改 Tauri command 时，只要任一参数是 struct（而非 primitive、`String`、
`Vec<primitive>` 或 `Option<primitive>`），就必须按本规范核对 Rust 参数名、serde
字段名和前端 invoke payload。

## Signatures（伪代码）

```rust
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportRequest {
    pub name: String,
    pub root_dir: String,
    pub tags: Vec<String>,
}

#[tauri::command]
pub fn import_project(
    request: ProjectImportRequest,
    dry_run: Option<bool>,
) -> Result<(), String> {
    // 伪代码：在这里执行校验与导入。
    Ok(())
}
```

```typescript
// 伪代码：名称和字段只展示跨边界形状。
interface ProjectImportRequest {
  name: string;
  rootDir: string;
  tags: string[];
}

const request: ProjectImportRequest = {
  name: 'demo',
  rootDir: '/path/to/project',
  tags: [],
};

await invoke<void>('import_project', {
  request,
  dryRun: false,
});
```

## Contracts

### Tauri invoke 参数映射

Tauri command 的每个 Rust 参数名对应 invoke payload 的一个 **top-level key**；参数
类型只决定该 key 的 value 形状：

| Rust 参数声明（伪代码） | 前端 invoke payload |
|---|---|
| `name: String` | `{ name: 'demo' }` |
| `dry_run: Option<bool>` | `{ dryRun: false }`，或省略该可选 key |
| `request: ProjectImportRequest` | **`{ request: { name, rootDir, tags } }`** |
| `request: T, dry_run: Option<bool>` | `{ request: { ... }, dryRun: false }` |

在默认 Tauri command 参数命名规则下，Rust 的 snake_case 参数名在 JavaScript payload
侧使用 camelCase（例如 `dry_run` → `dryRun`）。struct 自身仍必须单独处理字段命名。

### Rust struct 字段命名

跨边界 struct 必须显式声明 `#[serde(rename_all = "camelCase")]`，并让对应 TypeScript
interface 与 serde 产物逐字段一致：

- Rust `root_dir` ↔ TypeScript `rootDir`；
- Rust `Option<T>` ↔ TypeScript 可选字段 `field?: T`；
- Rust `Vec<T>` ↔ TypeScript `T[]`；
- 新增、删除或重命名字段时，两端必须在同一变更中更新。

不要依赖调用方猜测 snake_case 或 camelCase，也不要在 `invoke` 调用处临时声明一份
脱离共享类型的 inline shape。

## Validation & Error Matrix

| 错误现象 | 原因 | 修复 |
|---|---|---|
| `failed to deserialize parameter 'request'` | payload 缺少 `request` wrapping key，或其值不是 object | 传 `{ request: { ... } }` |
| `missing field 'rootDir'` | 前端漏字段，或误传为 `root_dir` | 对齐 serde camelCase 字段名 |
| `invalid type: null, expected struct` | 必填 struct 参数传了 `null` | 传完整 object；只有 Rust 参数为 `Option<T>` 时才允许缺省 |
| command 能调用但字段值错误 | Rust 与 TypeScript 类型独立漂移 | 使用共享 TS interface，并增加边界 fixture / invoke 测试 |
| 可选 top-level 参数被误判为必填 | 前端无条件传入错误占位值 | 对 `Option<T>` 省略 key 或传合法值，不伪造默认值 |

## Good / Base / Bad Cases

- **Good**：Rust struct 显式 camelCase serde；TypeScript interface 逐字段对齐；invoke
  payload 保留参数 wrapping key；边界测试同时覆盖成功和错误 payload。
- **Base**：少量 primitive 参数直接作为 top-level key 传递；参数增长后再重构为 struct，
  并同步修改调用方和测试。
- **Bad**：把 struct 字段摊平、混用 snake_case/camelCase，或复制一份 inline TS 类型后
  假设编译通过就等于运行时反序列化正确。

## Tests Required

真正新增带 struct 参数的 command 时，必须补齐以下验证；本文伪代码本身不表示这些
测试已经存在：

1. **成功 invoke**：使用完整 `{ request: {...} }` payload，断言 Rust 收到的每个字段值；
2. **错误 shape**：使用摊平 payload，断言调用失败且错误指向缺失的 struct 参数；
3. **camelCase fixture**：至少覆盖一个 Rust snake_case 字段，断言前端 camelCase 可反序列化；
4. **可选参数**：分别验证省略和提供 `Option<T>` top-level 参数；
5. **类型同步**：TypeScript interface 与 Rust struct 的新增、删除、可选性变化在 review 中逐项核对。

## Wrong vs Correct（伪代码）

### Wrong

```typescript
// 错：struct 字段被摊平，后端找不到 request 参数。
await invoke('import_project', {
  name: 'demo',
  rootDir: '/path/to/project',
  tags: [],
  dryRun: false,
});

// 错：struct 已声明 camelCase serde，调用方却发送 snake_case 字段。
await invoke('import_project', {
  request: {
    name: 'demo',
    root_dir: '/path/to/project',
    tags: [],
  },
});
```

### Correct

```typescript
// 伪代码共享类型。
interface ProjectImportRequest {
  name: string;
  rootDir: string;
  tags: string[];
}

const request: ProjectImportRequest = {
  name: 'demo',
  rootDir: '/path/to/project',
  tags: [],
};

// 参数名是 top-level key，struct 字段保持嵌套。
await invoke<void>('import_project', {
  request,
  dryRun: false,
});
```

## Related

- [../frontend/type-safety.md](../frontend/type-safety.md) ── 前端跨边界类型约定
- [../guides/cross-layer-thinking-guide.md](../guides/cross-layer-thinking-guide.md) ── Boundary 思考清单
