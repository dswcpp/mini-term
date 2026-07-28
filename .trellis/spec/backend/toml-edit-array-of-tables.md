# toml_edit 处理 array-of-tables (`[[...]]`)

> 编辑 TOML **数组表**（`[[projects]]` / `[[platforms]]` / `[[providers]]` 等）时，
> 与单一 nested table（`[features]` / `[mcp_servers.<name>]`）写法不同的标准模式。
> 沿用本规范可避免类型推断歧义、误用 `Item::Table` 代替
> `Item::ArrayOfTables`，以及序列化后丢失用户注释或字段顺序。

## Scope / Trigger

需要往 TOML 文件**追加、删除或列出**多个同名 section（`[[xxx]]`），且必须保留
用户已有注释和字段顺序时，使用本规范。

适用范围：

- 应用自身或第三方工具配置中的顶层 array-of-tables；
- 需要在不重排整份文档的前提下幂等追加、更新或删除条目的写盘逻辑。

不适用：单一 `[features]` / `[mcp_servers.<name>]` 这类 nested table；该场景直接使用
`doc["features"]["hooks"] = value(true)` 一类 nested table 写法。

## Signatures

```rust
use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};

// 1. 解析（失败时附带路径和原始错误）
let mut doc: DocumentMut = std::fs::read_to_string(&path)
    .map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?
    .parse::<DocumentMut>()
    .map_err(|e| format!("解析 TOML 失败: {}", e))?;

// 2. 获取 array-of-tables；不存在时创建空数组
let projects_item = doc
    .entry("projects")
    .or_insert(Item::ArrayOfTables(ArrayOfTables::new()));
let projects = projects_item
    .as_array_of_tables_mut()
    .ok_or("projects 不是 array of tables")?;

// 3. 构造新条目（包含嵌套子表）
let mut new_project = Table::new();
new_project["name"] = value("demo");

let mut metadata = Table::new();
metadata["root_dir"] = value("/path/to/project");
new_project["metadata"] = Item::Table(metadata);

projects.push(new_project);

// 4. 写回；未修改部分的注释和顺序由 toml_edit 保留
std::fs::write(&path, doc.to_string())?;
```

## Contracts

| 操作 | API | 关键约束 |
|---|---|---|
| 读已存在表数组 | `doc.get("projects").and_then(\|item\| item.as_array_of_tables())` | 返回 `Option<&ArrayOfTables>` |
| 按下标访问 | `projects.get(idx)` / `get_mut(idx)` | **没有 `Index<usize>`**；`projects[1]` 会编译失败 |
| 嵌套字段读 | `table["metadata"]["root_dir"].as_str()` | 取得 `Table` 后可按字符串 key 链式读取 |
| 嵌套字段写 | `table["metadata"] = Item::Table(new_subtable)` | 可替换整个子表；改单字段时先取得对应 table |
| 删除条目 | `projects.remove(idx)` | 删除后后续下标变化；批量条件删除优先使用 `retain` |

写盘前必须完成所有校验。任何解析、类型、重名或业务校验失败都不得覆盖原文件。
如需触发外部 reload / restart，只能在 `std::fs::write` 成功之后执行。

## Validation & Error Matrix

| 条件 | 错误处理 |
|---|---|
| 文件不存在或不可读 | 返回带路径的 IO error，不创建半成品文档 |
| TOML 解析失败 | 返回 `DocumentMut` syntax error，并保留定位信息 |
| 目标 key 存在但不是 array-of-tables | `as_array_of_tables_mut()` 返回 `None`，报明确类型错误 |
| 重名追加 | 写盘前用 `.iter().any(...)` 检测；返回用户可理解的错误且不写盘 |
| 类型推断歧义（E0282） | 对 closure 参数显式标注 `&Item`，或取得 `Table` 后再索引 |
| 写盘失败 | 返回原始 IO cause；不得继续触发 reload / restart |

## Good / Base / Bad Cases

- **Good**：读取 → 解析 → 校验类型与重名 → 修改 `DocumentMut` → 写回；如外部工具
  需要 reload / restart，仅在写盘成功后触发生效流程。
- **Base**：只追加但跳过重名检测；配置文件可能出现重复 entry，消费者行为不确定。
- **Bad**：用 `serde::Serialize` + `toml::to_string` 重建整份文档；该方式不保留
  comments / whitespace trivia，容易丢失用户注释和原有顺序。

## Tests Required

每个新增 array-of-tables 操作都必须新增与该实现同批交付的测试，至少覆盖：

1. **追加保留注释**：输入包含 `# user comment`，写回字符串仍包含该注释；
2. **追加保留已有 entry**：追加后原条目的字段和值不变；
3. **不存在时自动创建数组**：目标 key 缺失时生成合法 `[[projects]]`；
4. **错误类型不写盘**：目标 key 不是 array-of-tables 时返回错误，原文件内容不变；
5. **重名检测**：重复条目返回错误，且写盘函数未被调用；
6. **Round-trip**：写回后重新解析，比较解析后的字段值，而不是 TOML 引号风格。

不得仅凭手工验证或文档示例宣称测试已覆盖；测试断言必须随具体实现落地。

## Wrong vs Correct

### Wrong

```rust
// E0608：ArrayOfTables 没有 Index<usize>
let projects = doc["projects"].as_array_of_tables().unwrap();
let first_name = projects[0]["name"].as_str().unwrap();

// 错误：把字符串渲染格式写死到断言中
assert!(serialized.contains(r#"root_dir = "D:\\work\\demo""#));
```

### Correct

```rust
// 用 get(idx) 取得 Table，再按字符串 key 访问
let projects = doc["projects"].as_array_of_tables().unwrap();
let first = projects.get(0).unwrap();
let first_name = first["name"].as_str().unwrap();
let root_dir = first["metadata"]["root_dir"].as_str().unwrap();

// Round-trip 后比较语义值，不依赖 basic/literal string 的渲染差异
let reparsed: DocumentMut = serialized.parse().unwrap();
let actual = reparsed["projects"].as_array_of_tables().unwrap()
    .get(0).unwrap()["metadata"]["root_dir"]
    .as_str().unwrap();
assert_eq!(actual, r"D:\work\demo");
```

## Related

- `hook_registry.rs` / `ssh_mcp_registry.rs`：nested table（非数组）模式
- [`agent-config-injection.md`](./agent-config-injection.md)：nested table 幂等写入约定
