# 10 - CI Guardrail + PR Template Spec

Mo ta cac guardrail CI can cai dat de chan regression va enforce boundary DDD. Team implement thuc te thanh `.github/workflows/document-workflow-guardrails.yml` va `.github/pull_request_template.md`.

## 1. Muc tieu

- Chan tai tao compatibility layer cu.
- Bat buoc PR tich checklist regression + guardrail.
- Bao dam lint + build xanh truoc khi merge.

## 2. Cac job CI

### 2.1 `deprecated-import-guard`

- Trigger: `pull_request` vao `main`, `REFACTOR`.
- Step:
  ```bash
  cd frontend/document-workflow-ui
  # Fail neu tim thay import path cu
  if git grep -nE "from ['\"]@?/?components/admin/AdminPrimitives" -- src; then
    echo "::error::Deprecated import AdminPrimitives detected"
    exit 1
  fi
  if git grep -nE "from ['\"]@?/?components/admin/AdminGuard" -- src; then
    echo "::error::Deprecated import AdminGuard detected"
    exit 1
  fi
  if git grep -nE "from ['\"]@?/?pages/admin/" -- src; then
    echo "::error::Deprecated import pages/admin/* detected"
    exit 1
  fi
  ```
- Backend variant (sau sprint 3):
  ```bash
  if git grep -nE "require\\(['\"].*models/DocumentModel['\"]\\)" -- modules/document-workflow \
      | grep -v "infrastructure/"; then
    echo "::error::DocumentModel must only be imported from infrastructure/"
    exit 1
  fi
  ```

### 2.2 `frontend-quality-gate`

- Step:
  ```bash
  cd frontend/document-workflow-ui
  npm ci
  npm run lint
  npm run build
  ```
- `package.json` phai co:
  ```json
  { "scripts": { "lint": "eslint \"src/**/*.{ts,tsx}\"" } }
  ```

### 2.3 `backend-test-gate`

- Step:
  ```bash
  npm ci
  npm test
  ```
- Test phai cover: domain unit, application use-case, contract HTTP.

### 2.4 `pr-checklist-gate`

- Action: `mheap/github-action-required-labels` hoac custom script parse `github.event.pull_request.body`.
- Require:
  - Tick `- [x] Da chay regression checklist cho use-case bi tac dong`
  - Tick `- [x] Khong them import tu path deprecated (xem readme/refactor/09-deprecations.md)`
- Script pseudocode:
  ```js
  const body = process.env.PR_BODY || "";
  const must = [
    "[x] Da chay regression checklist",
    "[x] Khong them import tu path deprecated",
  ];
  const missing = must.filter(s => !body.includes(s));
  if (missing.length) {
    console.error("Missing checks:", missing);
    process.exit(1);
  }
  ```

## 3. ESLint rule

File `frontend/document-workflow-ui/eslint.config.js`:

```js
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

const DEPRECATION_MSG =
  "Deprecated import. Use @/shared/ui/primitives or @/features/document-workflow/admin/... Deadline 2026-06-30.";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } } },
    plugins: { "@typescript-eslint": tsPlugin, "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@/components/admin/AdminPrimitives", message: DEPRECATION_MSG },
          { name: "@/components/admin/AdminGuard", message: DEPRECATION_MSG },
        ],
        patterns: [
          { group: ["**/components/admin/AdminPrimitives", "**/components/admin/AdminPrimitives.*"], message: DEPRECATION_MSG },
          { group: ["**/components/admin/AdminGuard", "**/components/admin/AdminGuard.*"], message: DEPRECATION_MSG },
          { group: ["**/pages/admin/**"], message: DEPRECATION_MSG },
        ],
      }],
    },
  },
];
```

## 4. PR template (`.github/pull_request_template.md`)

```md
## Tom tat thay doi

<!-- Mo ta ngan -->

## Use-case bi tac dong

- [ ] Workflow: create / assign / draft / review / feedback / finalize / submit / approve / publish / archive
- [ ] Admin: users / units / settings / audit / email rules
- [ ] Khong anh huong use-case

## Guardrail DDD

- [x] Khong them import tu path deprecated (xem readme/refactor/09-deprecations.md)
- [x] Khong them method moi vao `DocumentModel` (phai di qua repository sau sprint 3)
- [x] Khong goi `mailSend` truc tiep trong controller / use-case moi (phai qua event handler sau sprint 4)

## Regression

- [x] Da chay regression checklist cho use-case bi tac dong (link log)
- Link log: 

## Test

- [ ] Unit test them moi
- [ ] Contract test them moi neu them endpoint
- [ ] Manual e2e smoke da chay
```

> Cac dong `- [x]` la BAT BUOC; job `pr-checklist-gate` se fail neu developer khong tick.

## 5. Rollout

- Sprint 0: them PR template, chua enforce `pr-checklist-gate`.
- Sprint 10: enforce tat ca.
- Moi khi them guardrail moi: chay pilot 2 PR -> enforce.

## 6. Bao tri

- Xem lai rule moi 3 thang.
- Khi deadline deprecation den -> xoa thuc su va don rule tuong ung.
