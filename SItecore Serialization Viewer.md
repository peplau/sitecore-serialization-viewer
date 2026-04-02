I want to leverage Sitecore CLI serialization extensions to build a VSCode Extension, in special the commands: dotnet sitecore ser info and dotnet sitecore ser explain -p "/sitecore/content/some/path" To build a tool that helps Developers (locally) to visualize the Sitecore Content Tree and quickly see if items are serialized, where and how. --- Example of Info output: PS D:\Git\Vizient\dxp-sitecoreai> dotnet sitecore ser info Maximum subtree-relative item path allowed: 100 nextjs-starter Subtrees: DefaultRenderingHost: /sitecore/system/Settings/Services/Rendering Hosts/Default Scope: SingleItem FieldsFilter Excludes: 0 Roles: 0 Users: 0 Project.click-click-launch Subtrees: ccl.templates: /sitecore/templates/Project/click-click-launch ccl.templates.branches: /sitecore/templates/Branches/Project/click-click-launch ccl.modules: /sitecore/system/settings/Project/click-click-launch ccl.renderings: /sitecore/Layout/Renderings/Project/click-click-launch ccl.placeholderSettings: /sitecore/Layout/Placeholder Settings/Project/click-click-launch ccl.powershell: /sitecore/system/Modules/PowerShell/Script Library/Click Click Launch ccl.media.fd: /sitecore/media library/Feature/Alaris ccl.media.ms: /sitecore/media library/Feature/Solterra ccl.media.bp: /sitecore/media library/Feature/SYNC FieldsFilter Excludes: 0 Roles: 0 Users: 0 Vizient.Common Common Component items for the Vizient website Subtrees: System.Settings.Vizient.Common: /sitecore/system/Settings/Feature/vizient/Components/Common Templates.Feature.Vizient.Common: /sitecore/templates/Feature/vizient/Components/Common Templates.Branches.Vizient.Common: /sitecore/templates/Branches/Feature/vizient/Components/Common Layout.Renderings.Vizient.Common: /sitecore/layout/Renderings/Feature/vizient/Components/Common Layout.Placeholders.Vizient.Common: /sitecore/layout/Placeholder Settings/Feature/vizient/Components/Common FieldsFilter Excludes: 0 Roles: 0 Users: 0 Vizient.Heroes Heroes Component items for the Vizient website Subtrees: System.Settings.Vizient.Heroes: /sitecore/system/Settings/Feature/vizient/Components/Heroes Templates.Feature.Vizient.Heroes: /sitecore/templates/Feature/vizient/Components/Heroes Templates.Branches.Vizient.Heroes: /sitecore/templates/Branches/Feature/vizient/Components/Heroes Layout.Renderings.Vizient.Heroes: /sitecore/layout/Renderings/Feature/vizient/Components/Heroes Layout.Placeholders.Vizient.Heroes: /sitecore/layout/Placeholder Settings/Feature/vizient/Components/Heroes FieldsFilter Excludes: 0 Roles: 0 Users: 0 vizient.media-full-width Items related to the Media Full Width component Subtrees: Templates.Components.MediaFullWidth: /sitecore/templates/Feature/vizient/Components/Media Full Width Renderings.Components.MediaFullWidth: /sitecore/layout/Renderings/Feature/Vizient/Components/Media Full Width FieldsFilter Excludes: 0 Roles: 0 Users: 0 _Vizient.Main Foundational items for the Vizient website Subtrees: System.Settings.Project.Vizient: /sitecore/system/Settings/Project/vizient System.Settings.Feature.Vizient: /sitecore/system/Settings/Feature/vizient Scope: ItemAndChildren Templates.Project.Vizient: /sitecore/templates/Project/vizient Scope: SingleItem Templates.Project.Vizient.Base: /sitecore/templates/Project/vizient/Base Templates.Feature.Vizient: /sitecore/templates/Feature/vizient Scope: ItemAndChildren Templates.Branches.Project.Vizient: /sitecore/templates/Branches/Project/vizient Scope: SingleItem Templates.Branches.Feature.Vizient: /sitecore/templates/Branches/Feature/vizient Scope: ItemAndChildren Media.Project.Vizient: /sitecore/Media Library/Project/vizient Rules: 3 Layout.Renderings.Project.Vizient: /sitecore/layout/Renderings/Project/vizient Scope: SingleItem Layout.Renderings.Feature.Vizient: /sitecore/layout/Renderings/Feature/vizient Scope: ItemAndChildren Layout.Placeholders.Project.Vizient: /sitecore/layout/Placeholder Settings/Project/vizient Scope: SingleItem Layout.Placeholders.Feature.Vizient: /sitecore/layout/Placeholder Settings/Feature/vizient Scope: ItemAndChildren Content.Tenant.Vizient: /sitecore/content/vizient Scope: SingleItem Push operations: CreateAndUpdate Content.Site.Vizient: /sitecore/content/vizient/vizient-website Rules: 13 FieldsFilter Excludes: 0 Roles: 0 Users: 0 ---- Example of explain: PS D:\Git\Vizient\dxp-sitecoreai> dotnet sitecore ser explain -p "/sitecore/content/vizient/vizient-website/Presentation/Available Renderings" [_Vizient.Main] [/sitecore/content/vizient/vizient-website] Rule /Presentation/Available Renderings with scope ItemAndDescendants included item [_Vizient.Main] [/sitecore/content/vizient/vizient-website] Rule /Presentation/Available Renderings set allowed push operations CreateUpdateAndDelete [_Vizient.Main] [/sitecore/content/vizient/vizient-website] Path /sitecore/content/vizient/vizient-website/Presentation/Available Renderings of master database is included! Physical path: D:\Git\Vizient\dxp-sitecoreai\serialization\_vizient.main\items\Content.Site.Vizient\vizient-website\Presentation\Available Renderings.yml 
----- 
The tool must be visual, allowing us to leverage the session open when the dev executes a login from the CLI: dotnet sitecore cloud login --allow-write true After that the info and explain commands would be used to visually show the content tree with visual signs showing the status of the item in the serialization: 1) Items not serialized would show in gray (as if it is disabled) 2) Items that are exact matches with Includes would show as Yellow - eg: "includes": [ { "name": "System.Settings.Project.Vizient", "path": "/sitecore/system/Settings/Project/vizient", "scope": "itemAndDescendants", "allowedPushOperations": "CreateUpdateAndDelete", "database": "master" }, 3) Items that are indirectly serialized due to a parent direct item are shown in orange

---

Why VS Code fits really well

Your users are developers already working in:

the local repo
the terminal
the serialization folder
PowerShell / CLI
Sitecore solution files

A VS Code extension lets you live exactly where they already are, with almost no adoption friction.

Why it may be better than Tauri as v1

A VS Code extension gives you, out of the box:

access to the current workspace
an integrated tree view in the sidebar
easy execution of local commands/processes
clickable links to open files
context menus on tree items
output/log panels
command palette integration
reuse of the developer’s terminal/session patterns

So instead of inventing a new shell, you can make this feel like a natural Sitecore developer tool.

My recommendation now
Best v1 stack

VS Code Extension + TypeScript + Node.js

And optionally:

a small .NET helper CLI/library only if parsing or Sitecore integration gets too complex in TS

But I would start with TypeScript only first.

Why TypeScript-only is a strong start

A VS Code extension already runs on Node, so it can:

run dotnet sitecore ser info
run dotnet sitecore ser explain -p "..."
run PowerShell if needed
inspect the workspace files
watch the serialization folder
render a tree in the Explorer sidebar
open the YAML file directly in the editor

That means you may not need a separate backend process at all for the MVP.

What the extension could look like
1. Sidebar tree view

A custom explorer like:

Sitecore Content Tree
yellow nodes = directly included
orange nodes = included via parent/rule
gray nodes = not serialized

You could also add icons or badges like:

D = direct
I = indirect
N = not serialized
2. Details panel / webview

When a node is clicked, show:

full Sitecore path
serialization status
matched module/include
scope
push operations
physical YAML path
raw explain output
3. Commands

Examples:

Sitecore: Refresh Serialization Map
Sitecore: Explain Current Item Path
Sitecore: Open Serialized YAML
Sitecore: Reveal In Serialization Folder
Sitecore: Login to Sitecore Cloud
Sitecore: Inspect Selected Sitecore Path
4. Context menu

Right-click a node:

Explain
Open YAML
Copy Sitecore path
Refresh children
The main technical question
Can a VS Code extension leverage the CLI login/session?

Usually, yes — indirectly, and that is the right way to do it.

The extension should not try to implement Sitecore auth itself first.

Instead, it should:

call the Sitecore CLI in the user’s environment
rely on the current local project/workspace
use the CLI as the contract for authenticated operations

That is much safer than trying to reverse-engineer session files.

Best architecture for the extension
Extension host

TypeScript

Responsibilities:

register commands
create tree providers
run CLI commands
parse outputs
cache results
open files
show status badges / tooltips
Optional webview

Use a VS Code Webview only for the rich details panel.

Do not make the whole app a webview if the built-in TreeView API is enough.

Optional helper layer

If needed later:

small .NET helper tool for parsing/normalization
or even PowerShell scripts for Windows-heavy teams

But keep the extension as the main product.

Suggested implementation design
Core services in the extension
CliRunner

Wrap:

dotnet sitecore ser info
dotnet sitecore ser explain -p "..."
optional login/status commands
InfoParser

Parse ser info into:

modules
include paths
scopes
rules count
push operations
database
ExplainParser

Parse ser explain into:

included or not
matched root/include
matched rule
scope result
physical path
SerializationResolver

Given a Sitecore path, determine:

gray / yellow / orange
why
confidence
whether explain is needed
TreeProvider

Provides nodes to the VS Code TreeView.

WorkspaceResolver

Find:

repo root
serialization folders
module structure
config files if relevant

-----

Big design choice: where does the tree come from?
— Live Sitecore tree

-----

For a live Sitecore tree inside VS Code, the best design is:

Use two backends, not one

Backend 1: Live tree provider

fetches the actual item hierarchy from Sitecore
lazy-loads children as folders are expanded
powers the real content tree

Backend 2: Serialization provider

runs dotnet sitecore ser info
runs dotnet sitecore ser explain -p "..."
determines gray / yellow / orange
resolves physical YAML file paths

That split matters because Sitecore serialization tells you whether an item is covered by serialization rules, but not the full live hierarchy. Sitecore’s own guidance points to using the Sitecore Item API when you need to automate or inspect content structure, while SCS is the mechanism that persists developer-owned items and is configured by sitecore.json and *.module.json.

So yes: build the extension, but make the tree come from Sitecore Item API

That is the right move if you want a true explorer.

The extension architecture I would recommend is:

VS Code extension host

TypeScript only, at least at first.

It should own:

TreeView registration
commands
cache
CLI execution
Sitecore API calls
opening YAML files
Live tree service

This talks to Sitecore and returns:

item id
item name
full path
template id/name if available
whether it has children
child count if available

Use lazy loading only. Do not fetch the whole tree.

Serialization service

This builds a rule map from ser info, then confirms selected nodes with ser explain. Sitecore serialization configuration is rule-based, with includes, scopes like SingleItem, ItemAndChildren, ItemAndDescendants, and Ignored, so your resolver should mirror those semantics rather than relying on filesystem guesses alone.

The flow should be this

When the extension starts:

detect workspace root
load sitecore.json
run dotnet sitecore ser info
parse all includes/rules into memory
connect to Sitecore
load only the first tree level you care about

When the user expands a node:

call Sitecore Item API for that node’s children
classify each child against the cached serialization rule set
render immediately
if a node is ambiguous, defer ser explain until selection/hover/details

When the user selects a node:

run dotnet sitecore ser explain -p "..."
show exact matched include/rule
show allowed push operations
show physical YAML path if serialized
Your color model still works

Keep it exactly as:

Gray: not serialized
Yellow: direct include / exact configured root
Orange: inherited from parent include or include rule

I would add one more internal status, even if you do not display it at first:

Unknown/Pending: node loaded from Sitecore but not yet confirmed by explain

That prevents the UI from blocking while you ask the CLI for more detail.

The most important performance rule

Do not run ser explain for every visible node.

That will feel slow very fast.

Instead:

use ser info + parsed module rules for 90% of classification
use ser explain only for:
selected node
hovered node
conflicting rule cases
diagnostics mode

----

My recommendation for authentication

You already want to leverage:
dotnet sitecore cloud login --allow-write true

That is the right mindset. Make the extension treat the CLI as the auth boundary, not reimplement auth itself. Accelerate also positions the CLI as the tool used to connect to XM Cloud and manage serialization/deploy scenarios.

----

The MVP that is still realistic

If you want live tree now, this is the smallest serious version:

Sidebar

A real tree with lazy-loaded Sitecore nodes.

Details pane

For selected item:

Sitecore path
item id
serialization status
matched module/include/rule
allowed push ops
YAML path
Commands
Refresh current node
Explain selected item
Open serialized YAML
Copy Sitecore path
Reconnect to Sitecore
Cache

Keep an in-memory cache for:

tree children by parent path
parsed ser info
ser explain by full item path

----

Yes, do Option C now — but architect it as a VS Code extension with a live Sitecore tree provider plus a separate serialization resolver. That is the cleanest path to a real developer-grade tool.

My strongest advice: build the live tree from Sitecore, not from serialization files, and treat serialization as an overlay. That is the right mental model.

----

Recommendation

Use Preview GraphQL for the live tree in the VS Code extension, and keep the CLI for the serialization overlay.

Do not use the Delivery API on Experience Edge as your primary tree source for this tool. The Delivery API is published-content-only, while the Preview API reads from the CM backend and includes both published and unpublished content. That makes Preview much closer to what developers need when they are inspecting serialization, draft items, and current tree structure.

Why Preview GraphQL is the sweet spot

Preview GraphQL:

reads from the CM backend,
returns published and unpublished content,
is explicitly described as ideal for local development and non-production scenarios,
and uses the same general query/response shape as Delivery, which keeps your code portable.

That maps very well to your use case:

developer-local,
live tree,
current state of content,
serialization overlay from CLI.

Architecture I would use now
Tree source

Preview GraphQL

Use it to:

load root nodes
lazy-load children
search by path/id
fetch item metadata for the selected node
Serialization source

Sitecore CLI

dotnet sitecore ser info
dotnet sitecore ser explain -p "..."

Use this only for:

direct vs indirect vs not serialized
matched include/rule
physical YAML path
push operations

That gives you the right split:

GraphQL = hierarchy
CLI = serialization truth

----

Practical guidance

I would implement the live tree with:

Preview GraphQL by default
lazy loading only
aggressive in-memory caching

And I would avoid building the tree around siteInfo.routes; Sitecore introduced a limit of 100 total includedPaths + excludedPaths on Preview siteInfo.routes, so it is not a great foundation for a general tree explorer.

Best starting stack

For this project, I would start with a desktop extension, not a web extension, because you need to run local processes like dotnet sitecore ... and read the local workspace. VS Code supports Node-based extension APIs for that.

So the practical stack is:

TypeScript
VS Code Extension API
Node 20+
fetch or a GraphQL client for SitecoreAI
child_process or execa for CLI execution

File structure I recommend

Start slightly more structured than the Yeoman default, because your extension has three concerns: tree, serialization, and Sitecore API.

sitecoreai-serialization-explorer/
  .vscode/
    launch.json
    tasks.json
  src/
    extension.ts
    commands/
      refreshTree.ts
      explainItem.ts
      openYaml.ts
      reconnect.ts
    tree/
      contentTreeProvider.ts
      treeItemFactory.ts
      models.ts
    sitecore/
      previewGraphqlClient.ts
      authoringGraphqlClient.ts
      auth.ts
      queries.ts
    serialization/
      cliRunner.ts
      infoParser.ts
      explainParser.ts
      statusResolver.ts
      models.ts
    workspace/
      repoResolver.ts
      fileLocator.ts
      configReader.ts
    ui/
      detailsPanel.ts
    util/
      logging.ts
      cache.ts
      paths.ts
  media/
    icon.png
  package.json
  tsconfig.json
  README.md
  CHANGELOG.md
  .gitignore


What each part does

src/extension.ts
Registers commands, the tree view, and activation hooks.

src/tree/
Owns the live Sitecore tree shown in the sidebar.

src/sitecore/previewGraphqlClient.ts
Calls Preview GraphQL for lazy-loading children and fetching item metadata. Preview is the read API designed for draft + published content.

src/sitecore/authoringGraphqlClient.ts
Leave this mostly unused at first, but keep the slot ready for future authoring actions. Sitecore documents this API as the read/write GraphQL endpoint for managing content

src/serialization/cliRunner.ts
Runs:

dotnet sitecore ser info
dotnet sitecore ser explain -p "/sitecore/..."

src/serialization/statusResolver.ts
Combines cached ser info data with selected-node ser explain results to decide:

gray
yellow
orange

src/workspace/
Finds the repo root, sitecore.json, serialization folders, and YAML files.

src/ui/detailsPanel.ts
Shows the selected item details, matched include/rule, and YAML path.

The first project scaffold I would make

After generating the extension, keep the first milestone very small:

sidebar tree with mock nodes
command to run dotnet sitecore ser info
command to query one item from Preview GraphQL
details panel for selected item
color status on a few nodes

That proves all three hard parts early:

VS Code extension plumbing
GraphQL access
CLI integration
The first commands to add in package.json

I would start with these commands:

SitecoreAI: Connect
SitecoreAI: Refresh Content Tree
SitecoreAI: Explain Selected Item
SitecoreAI: Open Serialized YAML
SitecoreAI: Copy Sitecore Path

My recommendation for your exact project

Use this as your v1 architecture:

Preview GraphQL: live tree
CLI serialization commands: status overlay
VS Code TreeView: main UI
Webview/details panel: selected item diagnostics
TypeScript only: first version

That is the cleanest starting point for SitecoreAI today.