 # Sitecore Serialization Viewer

Sitecore Serialization Viewer is a Visual Studio Code extension that helps Sitecore developers visualize, inspect, validate, and edit Sitecore Content Serialization (SCS) configuration from inside the IDE.

It provides:

- A live Sitecore content tree (via Authoring GraphQL).
- Serialization status visualization (direct, indirect, untracked, not serialized).
- Integrated `explain` analysis.
- Module-level exploration across configured `json` files.
- In-editor module configuration editing for includes, rules, excluded fields, roles, and users.

## Features

### 1) Explorer View: Sitecore Content Tree

- Adds a custom view in Explorer: **Sitecore Serialization Viewer**.
- Loads children from Authoring GraphQL for the selected Sitecore database.
- Supports normal expand/collapse behavior and refresh.
- Displays `/sitecore` as the root node.

### 2) Serialization Status Visualization

Each tree node is colored by status:

- **Direct (yellow)**: path directly matches a serialization include/rule.
- **Indirect (orange)**: path is serialized through parent/include scope.
- **Untracked (gray)**: unresolved or not yet fully evaluated.
- **Not serialized (dim/disabled gray)**: path not part of effective serialization.

During background reconciliation, unresolved nodes show a pending icon while status finalization runs.

### 3) Fast, Non-Blocking Status Reconciliation

- Tree expansion returns quickly from GraphQL results.
- Additional reconciliation runs in the background using `dotnet sitecore ser explain` for uncertain statuses.
- Statuses update in-place as results arrive, avoiding UI stalls on large trees.

### 4) Path and GUID Search

Command: **Search Sitecore Path**

- Accepts either:
	- A Sitecore path (for example, `/sitecore/content/home`)
	- A Sitecore item GUID (for example, `{FBFE3DAE-E317-4DCE-97D2-94C806896642}`)
- Reveals the item in the tree and opens details.

### 5) Database Selector (Status Bar)

- Status bar control: **Sitecore DB: master/core**.
- Switches GraphQL query database at runtime.
- Refreshes tree state for the selected database.

### 6) Module Filter Selector (Status Bar)

- Status bar control: **Module: All modules / specific module**.
- Module list is discovered from configured Sitecore module JSON files.
- In module-filter mode, tree content is built from module YAML under `items/**/*.{yml,yaml}` and filtered to the selected module scope.

### 7) Explain Panel (Per Item)

Command: **Show Details** (also opens when clicking tree nodes)

For each item, the panel shows:

- Item path.
- Effective serialized/not-serialized status.
- Module match and module description.
- Human-readable explain reasons parsed from CLI output.
- YAML physical file (when available).
- Include/rule metadata inferred from explain output and serialization config.

Actions in the panel:

- Open YAML file.
- Open module JSON file.
- Edit module JSON.
- Jump to include/rule in module JSON.
- Open module items listing.

### 8) Modules Listing Panel

Command: **Show all modules**

- Shows all active modules resolved from `sitecore.json` module globs.
- Displays module namespace, description, references, and resolved JSON path.
- Includes actions to open JSON, edit module, and view module items.

### 9) Module Items Listing Panel

From Explain or Modules panel, **View Items** opens a module items breakdown:

- Groups results by:
	- Master database items
	- Core database items
	- Roles
	- Users
- For each row, shows path/value, status (direct/indirect), include/rule source, and YAML path.
- Supports:
	- Open YAML
	- Copy path/value
	- Copy item ID (when available)

### 10) In-Editor Module JSON Editor

From Explain/Modules panel, **Edit** opens a rich module editor with save support.

Editable areas:

- Module namespace and description
- References
- Includes
- Include rules
- Excluded fields
- Role predicates
- User predicates

Editor capabilities:

- Add/remove includes and rules.
- Add/remove excluded fields, role predicates, user predicates.
- Expand/collapse all includes.
- Drag-and-drop reorder includes.
- Jump navigation to Module / Includes / Excluded Fields / Roles / Users sections.
- Reveal a specific include or rule when opened from Explain actions.

Save behavior:

- Preserves unrelated JSON fields.
- Writes normalized JSON back to the module file.
- Validates required fields before save.

### 11) Context Actions

- **Copy Sitecore Path** from tree item context menu.
- One-click tree refresh.

### 12) Performance Diagnostics (Optional)

When `debug` is enabled (via VS Code setting `sitecoreSerializationViewer.debug` or `DEBUG=true` in `.env.local`):

- Enables performance output channel: **Sitecore Serialization Performance**.
- Logs timing for GraphQL, tree expansion, module item indexing, and reconcile operations.

## Requirements

The extension assumes a Sitecore development workspace with serialization assets.

### Required

- VS Code `^1.110.0`.
- .NET SDK and Sitecore CLI (`dotnet sitecore`).
- A valid Sitecore solution/workspace containing serialization configuration and YAML items.

### Runtime dependencies for full functionality

- **Authoring GraphQL endpoint**: configure via `sitecoreSerializationViewer.authoringGraphqlUrl` (full URL) or `SITECORE_EDGE_HOSTNAME` (hostname). See the [Configuration](#configuration) table.
- **Authentication token** in `.sitecore/user.json` (typically after `dotnet sitecore cloud login`).
  The token is read from `endpoints.<name>.accessToken` where `<name>` defaults to `xmCloud`; override with the `endpoint` setting or `ENDPOINT` env var.
- `dotnet sitecore ser explain` available on PATH for explain/reconciliation features.

### Recommended workspace files

- One or more `sitecore.json` files with `modules` globs.
- Resolved module JSON files (`*.module.json`, `*.json`, etc.) containing `items.includes`.
- Serialized YAML trees under each module root in `items/`.

## Configuration

All options can be set either as a **VS Code setting** (via `settings.json` or the Settings UI) or as a **`.env.local` variable** in the workspace root. VS Code settings take precedence over `.env.local` variables when both are present.

| VS Code Setting | `.env.local` Variable | Default | Description |
|---|---|---|---|
| `sitecoreSerializationViewer.authoringGraphqlUrl` | `SITECORE_EDGE_HOSTNAME` | — | Authoring GraphQL endpoint. The VS Code setting accepts a full URL; the env var accepts a hostname or full URL (the API path is appended automatically). The VS Code setting takes precedence. |
| `sitecoreSerializationViewer.edgeContextId` | `SITECORE_EDGE_CONTEXT_ID` | — | Sitecore Edge context ID sent as the `SC-Edge-Context-Id` request header. |
| `sitecoreSerializationViewer.endpoint` | `ENDPOINT` | `xmCloud` | Endpoint key inside `.sitecore/user.json → endpoints` from which the `accessToken` is read (for example, `dev` if your CLI login stored the token under a `dev` key). |
| `sitecoreSerializationViewer.defaultLanguage` | `LANGUAGE` | `en` | Default Sitecore language for GraphQL requests. |
| `sitecoreSerializationViewer.defaultDatabase` | `DATABASE` | `master` | Default Sitecore database for tree queries. |
| `sitecoreSerializationViewer.debug` | `DEBUG` | `false` | Set to `true` to enable the performance diagnostics output channel: **Sitecore Serialization Performance**. |

## Known Issues

- Multi-root workspaces: current resolution logic uses the first workspace folder for most file and CLI operations.
- If `dotnet sitecore ser explain` is unavailable or slow, some status reconciliation may be delayed or remain unresolved.
- Module discovery depends on `sitecore.json` module globs and modules containing valid `items.includes`; misconfigured modules are skipped.
- GraphQL errors (missing endpoint, invalid token, insufficient permissions, unavailable authoring host) prevent live tree loading.

## Release Notes

Users appreciate release notes as you update your extension.

### 0.0.1

Initial public version of Sitecore Serialization Viewer with:

- Explorer tree integration and serialization status indicators.
- Path/GUID search and reveal.
- Database and module filtering.
- Explain panel with YAML/module navigation.
- Modules listing and module items breakdown.
- In-editor module JSON editing experience.
- Optional performance tracing output.

---

## Following extension guidelines

Ensure that you've read through the extension guidelines and follow the best practices for creating your extension.

- [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author this README using Visual Studio Code. Useful editor shortcuts:

- Split the editor (`Ctrl+\` on Windows/Linux, `Cmd+\` on macOS).
- Toggle Markdown preview (`Shift+Ctrl+V` on Windows/Linux, `Shift+Cmd+V` on macOS).
- Press `Ctrl+Space` to open Markdown snippet suggestions.

## For more information

- [Visual Studio Code Markdown Support](https://code.visualstudio.com/docs/languages/markdown)
- [Markdown Syntax Reference](https://www.markdownguide.org/basic-syntax/)
