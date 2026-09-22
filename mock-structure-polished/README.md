# Polished workspace storage mock (canon)

Proposed on-disk layout for the Electron app. The global index stays at the
workspaces root; every workspace folder is self-contained and browsable.

```text
workspaces/
  workspaces.json                  <- portal/hub index (lists every workspace)
  CrowdOS Nightly/
    workspace.json                 <- singular record for THIS folder only
    vfs/
      .crowdos/
        workspace.json             <- runtime object only (permissions, constraints, artifactDir, fsMounts)
        categories.json            <- ONLY place for categories
        channels.json              <- ONLY place for channels
        cache/ runtime/ snapshots/ <- empty working dirs (.gitkeep placeholders)
      agents/
        <agent-id>.json            <- one file per agent, single object, filename matches id
      artifacts/                   <- plain file storage, no index file
      src/
```

## Canon rules

- Global wins for listing and startup; the per-folder copy is rewritten from
  the global after load. Folder names are display names, ids never change.
- Per-folder workspace.json is a single object with rootPath "." (own folder),
  never a one-entry workspaces array.
- Inner vfs/.crowdos/workspace.json holds only the workspace object. Categories
  and channels are not embedded there.
- Mount modes: workspace uses default, children use inherit (follow parent,
  mounts empty) or override (use own mounts). Sources and targets are virtual.
- artifactDir is folder-relative ("vfs/artifacts"). Generation writes under
  <workspaceFolder>/vfs/artifacts/<runId>/<artifactId>.<ext> and stores that
  relative path in the DB artifact row.
- vfs/ is never a mount target for user repositories; mounts reference host
  paths that still pass the mount jail.

## Copy map into .Mock Structure

| Polished file | Destination in .Mock Structure |
|---|---|
| workspaces.json | reference only (global index stays as-is) |
| CrowdOS Nightly/workspace.json | CrowdOS Nightly/workspace.json (replaces array form) |
| CrowdOS Nightly/vfs/.crowdos/workspace.json | CrowdOS Nightly/vfs/.crowdos/workspace.json (drop embedded categories/channels) |
| CrowdOS Nightly/vfs/.crowdos/categories.json | CrowdOS Nightly/vfs/.crowdos/categories.json |
| CrowdOS Nightly/vfs/.crowdos/channels.json | CrowdOS Nightly/vfs/.crowdos/channels.json (ids now point at this workspace) |
| CrowdOS Nightly/vfs/agents/agent-default-assistant.json | CrowdOS Nightly/vfs/agents/agent-default-assistant.json (unwrapped from array) |

