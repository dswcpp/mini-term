# SSH Terminal Command Boundary

> Terminal context-menu SSH connections execute by writing an `ssh ...` command
> into the active PTY. Keep command construction centralized and validated.

## Contract

- Build terminal SSH commands only through `src/utils/sshCommand.ts`.
- Components should call `buildSshCommand`; they must not hand-concatenate
  `ssh`, `user@host`, `-p`, or `-i` fragments.
- Validate saved targets through `validateSshConnectionTarget` before writing
  them to `config.sshConnections`.
- `user` and `host` are intentionally restricted to OpenSSH target-safe
  characters. This prevents saved connection data from becoming shell syntax
  when written into an interactive terminal.
- Private-key paths are quoted by the utility and have Windows backslashes
  normalized to `/`, matching the existing OpenSSH-on-Windows behavior.
- Do not add `BatchMode=yes` to terminal SSH commands that may rely on password
  autofill; it disables password authentication.

## Tests

- Update `tests/sshCommand.test.cjs` when changing command construction.
- Keep `src/utils/sshCommand.ts` in `tsconfig.test.json` so `npm test` covers
  the pure command-building contract.
