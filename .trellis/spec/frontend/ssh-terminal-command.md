# SSH Terminal Command Boundary

> Terminal context-menu SSH connections execute by writing an `ssh ...` command
> into the active PTY. Treat saved connection fields as untrusted input and keep
> command construction centralized.

## Scenario: Save and Execute an SSH Connection

### 1. Scope / Trigger

This contract applies whenever code:

- saves or edits `config.sshConnections` from `SshModal`;
- turns an `SshConnection` into terminal input; or
- changes SSH target validation, port parsing, or identity-file arguments.

The boundary exists because `user@host` is written into an interactive shell.
Without a shared allowlist, persisted configuration can become shell syntax.

### 2. Signatures

```ts
export type SshCommandValidation =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing-user' | 'missing-host' | 'invalid-user' | 'invalid-host' | 'invalid-port';
    };

export function validateSshConnectionTarget(
  conn: Pick<SshConnection, 'user' | 'host' | 'port'>,
): SshCommandValidation;

export function buildSshCommand(
  conn: SshConnection,
  identityPath?: string,
): string;
```

`TerminalInstance` and all other consumers import `buildSshCommand` from
`src/utils/sshCommand.ts`. Components must not define local command builders.

### 3. Contracts

#### Save path

```text
SshModal string fields
  -> trim user/host
  -> parse port with: value.trim() ? Number(value) : NaN
  -> validateSshConnectionTarget
  -> display validation reason and disable Save when invalid
  -> persist the parsed port only when validation succeeds
```

- Port 22 is the initial value for a new form, not an error fallback.
- Never use `parseInt` for the form port. Partial strings must not be accepted.
- Validate before writing a connection to `config.sshConnections`.

#### Terminal path

```text
SshConnection (including legacy or externally edited config)
  -> buildSshCommand
  -> validate again
  -> write the returned command to the PTY
```

Command output has these forms:

```text
ssh user@host
ssh -p 2222 user@host
ssh -i "C:/path/to/key" -o IdentitiesOnly=yes user@host
```

- `user` and `host` are trimmed before output.
- `user` is restricted to letters, digits, `.`, `_`, and `-`.
- `host` is restricted to letters, digits, `.`, `_`, `:`, `[`, `]`, and `-`.
- Identity paths are trimmed, wrapped in double quotes, have `"` escaped, and
  have Windows backslashes normalized to `/`.
- Do not add `BatchMode=yes`: terminal sessions may rely on password autofill or
  interactive password entry, and BatchMode disables password authentication.

### 4. Validation & Error Matrix

Validation is ordered; the first matching failure is returned.

| Condition | Validation result | `buildSshCommand` behavior |
| --- | --- | --- |
| `user.trim()` is empty | `{ ok: false, reason: 'missing-user' }` | throws `Error('missing-user')` |
| `host.trim()` is empty | `{ ok: false, reason: 'missing-host' }` | throws `Error('missing-host')` |
| user contains a non-allowlisted character | `{ ok: false, reason: 'invalid-user' }` | throws `Error('invalid-user')` |
| host contains a non-allowlisted character | `{ ok: false, reason: 'invalid-host' }` | throws `Error('invalid-host')` |
| port is `NaN`, non-integer, `< 1`, or `> 65535` | `{ ok: false, reason: 'invalid-port' }` | throws `Error('invalid-port')` |
| all target fields are valid | `{ ok: true }` | returns the command string |

Invalid historical configuration must fail at the terminal boundary before
password autofill is armed or any SSH command is written.

### 5. Good / Base / Bad Cases

- **Base**: `{ user: 'deploy', host: 'example.com', port: 22 }` becomes
  `ssh deploy@example.com`.
- **Good**: port `2222` becomes `ssh -p 2222 deploy@example.com`; a Windows key
  path becomes a quoted forward-slash path with `IdentitiesOnly=yes`.
- **Good**: surrounding spaces in user and host are removed before validation
  and output.
- **Bad**: `deploy;rm`, `example.com && whoami`, `NaN`, `0`, `22.5`, and `65536`
  are rejected with stable reason codes.
- **Bad**: clearing the port field maps to `NaN`; it must not save as port 22.

### 6. Tests Required

Update `tests/sshCommand.test.cjs` whenever this contract changes. Assertions
must cover:

- default and non-default port command output;
- user/host trimming;
- Windows identity-path normalization, quoting, and `IdentitiesOnly=yes`;
- missing and shell-like user/host values;
- `NaN`, zero, negative, fractional, and out-of-range ports;
- `buildSshCommand` throwing the matching reason instead of falling back.

Keep `src/utils/sshCommand.ts` in `tsconfig.test.json` so the CommonJS test
receives `.tmp-tests/utils/sshCommand.js` from the normal pretest compile. Run
the focused contract with:

```powershell
npm test -- "tests/sshCommand.test.cjs"
```

### 7. Wrong vs Correct

#### Wrong

```ts
const parsedPort = parseInt(port, 10);
const savedPort = parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 22;
const command = `ssh ${conn.user}@${conn.host}`;
```

This accepts partial input such as `22abc`, silently rewrites invalid data to 22,
and bypasses the terminal command boundary.

#### Correct

```ts
const parsedPort = port.trim() ? Number(port) : NaN;
const validation = validateSshConnectionTarget({ user, host, port: parsedPort });
if (!validation.ok) return;

onSave({ ...connection, user: user.trim(), host: host.trim(), port: parsedPort });

// At execution time, validate again and construct only through the utility.
const command = buildSshCommand(connection, identityPath);
```
