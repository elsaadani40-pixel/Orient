# First-user acceptance: run ORIENT locally

This checklist is for the first person trying ORIENT on their own machine. It validates a real local run, not just a green CI badge. Do not expose the development server to the public internet.

## 1. Start from a clean checkout

Requirements: Node.js 22 or newer and npm. From a terminal:

```sh
git clone https://github.com/elsaadani40-pixel/Orient.git
cd Orient
npm ci
npm test
npm run check:syntax
```

**Pass condition:** all three commands exit successfully. Save the Node/npm versions and any failing command if they do not.

## 2. Start the integrated local application

Choose a unique local bootstrap password of at least 14 characters. Do not reuse a real account password or commit this value.

Linux, macOS, or Termux:

```sh
export ORIENT_OWNER_BOOTSTRAP_PASSWORD='replace-with-a-unique-local-password'
npm start
```

Windows PowerShell:

```powershell
$env:ORIENT_OWNER_BOOTSTRAP_PASSWORD = 'replace-with-a-unique-local-password'
npm start
```

The documented default listener is `127.0.0.1:8080`. Open `http://127.0.0.1:8080/owner` in the same device/browser. Sign in as `Admin`, then complete the required first-run password rotation if prompted. Keep the terminal running.

## 3. Prove one harmless task end to end

1. Open `http://127.0.0.1:8080/workbench` in the same browser.
2. Confirm the page reflects the real server/API state. An empty task list is acceptable; invented task rows are not.
3. Submit a harmless read-only goal, such as: `لخّص قدراتك المتاحة حاليًا، واذكر بوضوح ما لا تستطيع تنفيذه.`
4. Inspect the returned task status and available events. Record whether the task completed, failed, or requires approval; do not infer success from the HTTP response alone.
5. Refresh the page and inspect the same task again. Confirm the task identity and recorded state remain consistent.
6. Sign out. Verify that `/workbench` and owner-only task/API access are denied until the owner signs in again.

Do not test with destructive instructions, real customer data, real messages, or external actions during first-run acceptance. Do not approve a write merely to make the checklist pass.

## 4. Record evidence instead of making assumptions

Complete this table for each environment actually tested. Write **Not tested** where appropriate.

| Environment | Version / device | Login + rotation | Read-only task | Refresh preserves state | Logout blocks owner access | Result / evidence |
|---|---|---|---|---|---|---|
| Desktop browser | | | | | | |
| Phone browser | | | | | | |
| Tablet browser | | | | | | |

Attach only redacted screenshots/logs. Never include passwords, session cookies, CSRF tokens, personal data, or secrets.

## 5. Scope and release limits

- A successful local run is not a production deployment or a security certification.
- Browser automation and CI do not substitute for manually testing the actual phone/tablet/browser combination.
- Do not expose this development listener to a LAN or public network without a separately reviewed HTTPS, session persistence, operational, and security configuration.
- Asynchronous production workers remain disabled until every acceptance criterion in [safety gate #189](https://github.com/elsaadani40-pixel/Orient/issues/189) is proven by implementation and tests.
- Record reproducible failures as issues with the exact commit SHA, environment versions, steps, expected result, and observed result.
