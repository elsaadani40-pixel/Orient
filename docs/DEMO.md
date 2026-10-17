# ORIENT alpha demo

This is a short, reproducible walkthrough of a real low-risk runtime request. It is deliberately not presented as a recording or as proof of a high-risk approval path.

## 1. Start the local runtime

From the repository root, configure a unique owner bootstrap password and start the app:

```bash
export ORIENT_OWNER_BOOTSTRAP_PASSWORD='replace-with-a-unique-secret-of-14-chars-or-more'
npm start
```

Keep the listener on its default loopback address. Do not use real customer secrets or personal data in the demo.

## 2. Submit a task to the agent endpoint

In a second terminal:

```bash
curl -sS -X POST http://127.0.0.1:8080/agent \
  -H 'Content-Type: application/json' \
  -d '{"input":"احفظ أنني أختبر ORIENT"}'
```

## 3. Inspect and verify the outcome

Open http://127.0.0.1:8080/memory and inspect the result. Also inspect the response status; do not infer successful persistence from HTTP status alone.

## What this demonstrates

`user request → HTTP agent interface → configured runtime/planner/tools → inspect response → verify persisted result`

The exact planner and persistence behavior depends on local configuration. This walkthrough does **not** demonstrate a high-risk action, a human-approval prompt, an external integration, or a full end-to-end production acceptance test. Those require a separately verified scenario and should not be faked in a demo.

## Recording a GIF

Once the flow passes on the target machine, record the terminal and local interface using a screen recorder, then trim it to 20–40 seconds. Keep credentials and personal data out of the recording. Do not publish a GIF as a successful runtime demonstration until the result has been checked manually.
