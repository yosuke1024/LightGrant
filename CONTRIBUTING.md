# Contributing to LightGrant

Thank you for your interest in contributing to LightGrant! To keep development smooth, secure, and robust, please follow the guidelines outlined below.

---

## 1. Code Quality & Standards

- **TypeScript**: Ensure TypeScript compiles cleanly. Use strict compiler options (configured in `tsconfig.json`).
- **Formatting**: Always format your code with Prettier before submitting a PR:
  ```bash
  npm run format
  ```
- **Linting**: We enforce strict linting rules via ESLint. Ensure there are zero errors:
  ```bash
  npm run lint
  ```

---

## 2. Test Requirements

We require high test coverage to prevent regressions in critical security loops (revocation, token checks, etc.).
- **Write Tests**: Every new feature or bug fix must be accompanied by comprehensive tests in the `tests/` directory.
- **Coverage**: Maintain a code coverage of at least 70% overall.
- **Run Tests**: Verify your changes before pushing:
  ```bash
  npm run test
  ```

---

## 3. Security First

- **Credential Management**: Never commit hardcoded secrets, test credentials, or private keys to the repository.
- **Security Patches**: If you find a security bug, please follow the process in [SECURITY.md](./SECURITY.md) to report it privately.
