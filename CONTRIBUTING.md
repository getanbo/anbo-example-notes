# Contributing

Keep changes focused on a complete user-visible flow. Terraform resources are
not considered supported by this example until `scripts/smoke.mjs` proves their
behavior through the installed Anbo CLI.

Before opening a pull request:

```bash
npm ci
npm run check
```

Run behavioral acceptance with packed candidate tarballs by dispatching the
`Installed CLI Acceptance` workflow with exact CLI and MiniStack plugin refs.
Do not replace that workflow with direct Terraform, Docker, application, smoke,
or plugin commands.

Do not commit `.anbo/plugins.lock.json`, `.anbo/state`, Terraform state, clone
URLs, credentials, generated Lambda archives, or application data.
