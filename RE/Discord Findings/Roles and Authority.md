# Roles and Authority

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Reference description of Discord's **authority model end to end** — owner, administrator, role hierarchy, permission bits, per-channel overrides — and of every place the UI surfaces it. Ends with a conservative *Transfer to CrowdOS* subsection that borrows Discord's presentation patterns while leaving CrowdOS's locked L0–L3 tier model untouched. Visual style is out of scope.

Target build analysed: Discord 1.0.9264, Electron 42.11.15 (`ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461`).

## How it works

Discord's authority is a **three-layer stack**, resolved at render time and never stored as a per-member permission blob:

| Layer | Owner | Storage | Resolution |
| --- | --- | --- | --- |
| 1. Guild-level roles | Guild | `roles` map, ordered by `position` | member's roles are unioned with the guild's `@everyone` role; `ADMINISTRATOR` short-circuits the rest |
| 2. Channel overwrites | Channel | `permission_overwrites` per channel | per-role / per-member allow-deny pairs applied on top of the guild result |
| 3. Owner | Guild | `owner_id` on the guild | owner has every permission, regardless of roles |

The bundle shows the resolution chain explicitly:

* Guild role deserialisation — `web.31d1cd3e6e440749.js` → `permissions:i.iu(t.permissions),mentionable:t.mentionable,position:t.position,color:t.color,colorString:0!==t.color?(0,r.Hl)(t.color):null,colors:t.colors??null,hoist:t.hoist,managed:t.managed??!1,tags:t.tags??{},icon:t.icon,unicode_emoji:t.unicode_emoji`.
* Effective permission — `web.31d1cd3e6e440749.js` → `function Y(e){let{permission:t,user:n,context:i,overwrites:r,roles:s,excludeGuildPermissions:l}=e;return a.zy(G({user:n,context:i,overwrites:r,roles:s,checkElevated:…}))}`. Two explicit flags shape the result: `excludeGuildPermissions` (compute channel-only) and `checkElevated`.
* Elevated check — `web.31d1cd3e6e440749.js` → `function V(e,t,n,i){return!!(null!=t&&(0,A.bM)(e,t))||null!=n&&(null==i||(0,S.zA)(n,i))}` — i.e. *is the subject's role higher than mine*.
* Owner's highest role — `web.31d1cd3e6e440749.js` → `function H(e,t){let n=p.Ay.getMember(e.id,t);if(null!=n)return T.A.getSortedRoles(e.id).find(e=>n.roles.includes(e.id))}`.
* **Owner is suppressed when an administrator role is hoisted** — `web.31d1cd3e6e440749.js` → `function B(e){return r().some(T.A.getUnsafeMutableRoles(e.id),e=>e.hoist&&(0,h._m)(e,C.xBc.ADMINISTRATOR))?void 0:e.ownerId??void 0}`. A hoisted admin role makes Discord render admins *instead of* a distinct owner.
* The hoist role of a member — `web.31d1cd3e6e440749.js` → `function j(e,t){return null==t.hoistRoleId?null:T.A.getRole(e.id,t.hoistRoleId)}`.

### Permission bit vocabulary
All permission flags live behind one module namespace (`xB`, re-exported as `xBc` from module `652215`). Observed flag names in the bundle:

`CREATE_INSTANT_INVITE`, `KICK_MEMBERS`, `BAN_MEMBERS`, `ADMINISTRATOR`, `MANAGE_CHANNELS`, `MANAGE_GUILD`, `ADD_REACTIONS`, `VIEW_AUDIT_LOG`, `PRIORITY_SPEAKER`, `STREAM`, `VIEW_CHANNEL`, `SEND_MESSAGES`, `SEND_TTS_MESSAGES`, `MANAGE_MESSAGES`, `EMBED_LINKS`, `ATTACH_FILES`, `READ_MESSAGE_HISTORY`, `MENTION_EVERYONE`, `USE_EXTERNAL_EMOJIS`, `VIEW_GUILD_INSIGHTS`, `CONNECT`, `SPEAK`, `MUTE_MEMBERS`, `DEAFEN_MEMBERS`, `MOVE_MEMBERS`, `USE_VAD`, `CHANGE_NICKNAME`, `MANAGE_NICKNAMES`, `MANAGE_ROLES`, `MANAGE_WEBHOOKS`, `MANAGE_GUILD_EXPRESSIONS`, `USE_APPLICATION_COMMANDS`, `REQUEST_TO_SPEAK`, `MANAGE_EVENTS`, `MANAGE_THREADS`, `CREATE_PUBLIC_THREADS`, `CREATE_PRIVATE_THREADS`, `USE_EXTERNAL_STICKERS`, `SEND_MESSAGES_IN_THREADS`, `USE_EMBEDDED_ACTIVITIES`, `MODERATE_MEMBERS`, `PIN_MESSAGES`.

Three **named bundles** are derived from the flat flags — `web.31d1cd3e6e440749.js` → module `547683`:
`yZ` = `kg(VIEW_CHANNEL, SEND_MESSAGES, EMBED_LINKS, ATTACH_FILES, READ_MESSAGE_HISTORY, ADD_REACTIONS, USE_EXTERNAL_EMOJIS)`; `Qr`/`G2` = `kg(MANAGE_CHANNELS, MANAGE_ROLES, …yZ)`.

### Verified behaviour
- `[Observed-from-bundle]` Discord's authority is **not stored per member**: effective permissions are recomputed from the member's roles, the guild's `@everyone` role, and the channel's overwrites, with two explicit switches `excludeGuildPermissions` and `checkElevated` (`web.31d1cd3e6e440749.js` → `function Y(e){let{permission:t,user:n,context:i,overwrites:r,roles:s,excludeGuildPermissions:l}=e;…}`).
- `[Observed-from-bundle]` `ADMINISTRATOR` bypasses channel overwrites — Discord says so verbatim: `"Members with this permission have every permission and also bypass channel specific permissions. This is a dangerous permission to grant."` (`8b9a4b4a55eaa34c.js`).
- `[Observed-from-bundle]` Role order is a server-assigned `position`; the member's highest role is the first of `getSortedRoles(guildId)` that the member holds (`web.31d1cd3e6e440749.js` → `T.A.getSortedRoles(e.id).find(e=>n.roles.includes(e.id))`).
- `[Observed-from-bundle]` "Higher role than you" is a **position comparison**, not a permission scan: `(0,S.zA)(n,i)` (`web.31d1cd3e6e440749.js` → `function V(e,t,n,i){…}`).
- `[Observed-from-bundle]` The **owner** is a guild field, not a role, and is granted every permission regardless of roles: `"This person is the server owner and always has all permissions regardless of roles."` (`8b9a4b4a55eaa34c.js`).
- `[Observed-from-bundle]` The owner marker is *suppressed* when a hoisted role holds `ADMINISTRATOR`, so admins render in the owner's place (`web.31d1cd3e6e440749.js` → `function B(e){…e.hoist&&(0,h._m)(e,C.xBc.ADMINISTRATOR)?void 0:e.ownerId??void 0}`).
- `[Observed-from-bundle]` Hoist is a **separate bit** from colour and from position; a role can be hoisted without a colour, and coloured without being hoisted (`web.31d1cd3e6e440749.js` → `t.hoist&&…` vs `t.color>0&&…`).
- `[Observed-from-bundle]` The role patch payload has explicit field names, so a partial role edit is a typed operation: `permissions`, `color`, `colors`, `hoist`, `mentionable`, `nick`, `deaf`, `mute`, `code`, `channel_id`, `role_ids`, plus `$add` / `$remove` op-codes (`web.31d1cd3e6e440749.js` → `ej.HOIST="hoist"` etc.).
- `[Observed-from-bundle]` The channel-permission matrix is a flat map keyed by the permission flag value, with three fields per entry — `title`, `description` (channel-type dependent) and `flag` (`web.31d1cd3e6e440749.js` → `[E.xBc.VIEW_CHANNEL.toString()]:{title:…,description:…,flag:E.xBc.VIEW_CHANNEL}`).
- `[Observed-from-bundle]` The matrix is grouped into 14 named permission groups and is **searchable** with an explicit empty state (`8b9a4b4a55eaa34c.js` → `"General Permissions"`, `"Text Channel Permissions"`, `"Search permissions"`, `"No permissions found"`).
- `[Observed-from-bundle]` Channel overrides have a Basic ↔ Advanced view toggle and a distinct 8-value subject taxonomy (`EMPTY_STATE`, `ADMINISTRATOR`, `ROLE`, `OWNER`, `MEMBER`, `USER`, `GUILD`, `APP_CHANNEL_APP`) tabbed `ROLES` / `MEMBERS` / `USERS` / `GUILDS` (`8b9a4b4a55eaa34c.js` → `"Mw/UDN":["Basic View"]`, `"0a6awf":["Advanced View"]`; `web.31d1cd3e6e440749.js`).
- `[Observed-from-bundle]` Refusals and guards name the reason: `"Cannot be removed due to Administrator access."`, `"Server owner cannot be removed."`, `"Role already has server-level permissions."`, `"Only users or roles with Manage Roles permission can be added."` (`8b9a4b4a55eaa34c.js`).
- `[Observed-from-bundle]` Every authority mutation has a dedicated audit-log sentence template, including colour, gradient, hoist, mentionable, position and grant/deny counts (`8b9a4b4a55eaa34c.js` → `"Set the color to "`, `"Hoisted"`, `"Mentionable"`, `"Granted N permissions"`, `"Denied N permissions"`, `"moved N roles"`).
- `[Observed]` A live locked private voice channel carries the restriction in its accessible name (`accessibility.nodes[609]` → `", Private Channel (locked)"`).
- `[Observed-from-bundle]` Role colour is a **user preference with an accessibility escape hatch**, not a fixed truth (`8b9a4b4a55eaa34c.js` → `"Show role colors in names"`, `"Don't show role colors"`).
- `[Inferred]` A refused action is always a disabled control with a reason rather than a hidden control: the bundle contains both the "cannot action" tooltips and a "Cannot remove permissions" family, and no evidence of a hidden-by-permission path was found — but the rendered state was not observed.

## Structural inventory

### Where authority is surfaced in the UI
| Surface | What it shows | Evidence |
| --- | --- | --- |
| Member row name colour | highest role with `color > 0` | `web.31d1cd3e6e440749.js` → `t.color>0&&…&&(n=t)` |
| Member list group headers | one group per **hoisted** role | `web.31d1cd3e6e440749.js` → `n?.hoistRoleId??"online"` |
| Owner marker | crown decorator + tooltip | `8b9a4b4a55eaa34c.js` → `"This person is the server owner and always has all permissions regardless of roles."` |
| Disabled member action | tooltip explaining the refusal | `8b9a4b4a55eaa34c.js` → `"Cannot action this member"`, `"This person has a higher role than you, so you cannot manage them."`, `"This person's highest role is the same as yours, so you cannot manage them."` |
| Channel entry (locked) | `, Private Channel (locked)` | `inspect-main.json` → `accessibility.nodes[609]` |
| Channel entry (no access) | `"Your role does not have permission to access this channel."` | `8b9a4b4a55eaa34c.js` |
| Guild roles page | per-role card: name, colour, hoist, mentionable, icon, permissions | `8b9a4b4a55eaa34c.js` → `"Not hoisted"`, `"Hoisted"`, `"Not mentionable"`, `"Mentionable"`, `"Set the icon"` |
| Channel permissions modal | Basic View / Advanced View toggle | `8b9a4b4a55eaa34c.js` → `"Mw/UDN":["Basic View"]`, `"0a6awf":["Advanced View"]`, `"dYRsrm":["Advanced permissions"]` |
| Audit log | every authority mutation, as a sentence | `8b9a4b4a55eaa34c.js` → `"Hoisted"`, `"Mentionable"`, `"Set the color to "`, `"Granted N permissions"`, `"Denied N permissions"`, `"moved N roles"` |

### Role card contents (guild roles page)
| Field | Read/write | Label evidence |
| --- | --- | --- |
| Name | read/write | `"Changed the name from <oldValue> to <newValue>"`, `"With the name <newValue>"` |
| Colour | read/write | `"Set the color to <newValue>"`, `"With no color"` |
| Gradient | read/write | `"Set the gradient to [<newColors>]"`, `"With no gradient"` |
| Icon | read/write | `"Set the icon"` |
| Hoist | read/write | `"Not hoisted"` / `"Hoisted"` |
| Mentionable | read/write | `"Not mentionable"` / `"Mentionable"` |
| Description | read/write | `"Changed the description from <oldValue> to <newValue>"`, `"[empty]"` |
| Permissions | read/write, counted | `"Granted N permission(s)"`, `"Denied N permission(s)"` |
| Position | reorder | `"moved N role(s)"` |
| Lifecycle | create/delete | `"created the role"`, `"deleted the role"` |

The role **patch payload field names** are the API contract: `web.31d1cd3e6e440749.js` → `ej.PERMISSIONS="permissions"`, `ej.COLORS="colors"`, `ej.COLOR="color"`, `ej.HOIST="hoist"`, `ej.MENTIONABLE="mentionable"`, `ej.NICK="nick"`, `ej.DEAF="deaf"`, `ej.MUTE="mute"`, `ej.CODE="code"`, `ej.CHANNEL_ID="channel_id"`, `ej.ROLE_IDS="role_ids"`, `ej.ROLES_ADD="$add"`, `ej.ROLES_REMOVE="$remove"`.

### Role chip — exact DOM contract
`web.31d1cd3e6e440749.js` → the name body component is invoked with `{roleName, colorString, colorStrings, name, className: et.UU, displayNameStylesFont, animateRoleGradient}` and is rendered inside `<span class="et.Xh">`; when the subject has lost permission the span additionally carries `et.oj` and the name is wrapped in a tooltip component. The member row container is `et.Dc` with `et.WK` added when `status === OFFLINE && !selected`, and the row inner is `et.Hz`. So a role chip is: *a span whose text colour is the highest coloured role's colour, carrying the role name for gradient rendering* — there is no separate pill element, the colour is applied to the name itself.

### Permission matrix organisation
The channel-permission matrix is a **flat, ordered map keyed by the permission flag value**: `web.31d1cd3e6e440749.js` →

```
[E.xBc.VIEW_CHANNEL.toString()]:{title:…,description:…,flag:E.xBc.VIEW_CHANNEL},
[E.xBc.MANAGE_CHANNELS.toString()]:{…}, [E.xBc.MANAGE_ROLES.toString()]:{…},
[E.xBc.MANAGE_WEBHOOKS.toString()]:{…}, [E.xBc.CREATE_INSTANT_INVITE.toString()]:{…},
[E.xBc.SEND_MESSAGES.toString()]:{…}, [E.xBc.EMBED_LINKS.toString()]:{…},
[E.xBc.ATTACH_FILES.toString()]:{…}, [E.xBc.ADD_REACTIONS.toString()]:{…},
[E.xBc.USE_EXTERNAL_EMOJIS.toString()]:{…}, [E.xBc.USE_EXTERNAL_STICKERS.toString()]:{…},
[E.xBc.MENTION_EVERYONE.toString()]:{…}, [E.xBc.MANAGE_MESSAGES.toString()]:{…},
[E.xBc.PIN_MESSAGES.toString()]:{…}, …
```

Each entry carries **three** fields: `title` (the switch label), `description` (an explanation that varies by channel type — `GUILD_CATEGORY`, `GUILD_VOICE`, `GUILD_STAGE_VOICE`, `GUILD_FORUM`, `GUILD_MEDIA`, `GUILD_ANNOUNCEMENT`), and `flag` (the bit). The advanced-permissions subject taxonomy is an 8-value enum: `web.31d1cd3e6e440749.js` → `EMPTY_STATE:0, ADMINISTRATOR:1, ROLE:2, OWNER:3, MEMBER:4, USER:5, GUILD:6, APP_CHANNEL_APP:7`; the advanced view is tabbed `ROLES:0, MEMBERS:1, USERS:2, GUILDS:3`.

### Permission groups (guild roles page)
The guild-role permission matrix is organised into named groups, each with its own heading:

| Group label | Evidence |
| --- | --- |
| `General Permissions` | `8b9a4b4a55eaa34c.js` → `"General Permissions"` |
| `Membership Permissions` | `"Membership Permissions"` |
| `Advanced Permissions` | `"Advanced Permissions"` |
| `General Server Permissions` | `"General Server Permissions"` |
| `General Category Permissions` | `"General Category Permissions"` |
| `General Channel Permissions` | `"General Channel Permissions"` |
| `Text Channel Permissions` | `"Text Channel Permissions"` |
| `Voice Channel Permissions` | `"Voice Channel Permissions"` |
| `Voice Channel Chat Permissions` | `"Voice Channel Chat Permissions"` |
| `Stage Channel Permissions` | `"Stage Channel Permissions"` |
| `Forum Channel Permissions` | `"Forum Channel Permissions"` |
| `Media Channel Permissions` | `"Media Channel Permissions"` |
| `Events Permissions` | `"Events Permissions"` |
| `Apps Permissions` | `"Apps Permissions"` |

The matrix also has a **permission search**: `8b9a4b4a55eaa34c.js` → `"OLJAk3":["Search permissions"]`, `"I+eHql"` (cardinal: `"No permissions found"` / `"1 permission found"` / `"N permissions found"`).

### Per-channel overrides
| Aspect | Behaviour | Evidence |
| --- | --- | --- |
| View toggle | Basic View (single synced set) ↔ Advanced View (per-role/member overrides) | `8b9a4b4a55eaa34c.js` → `"Mw/UDN":["Basic View"]`, `"0a6awf":["Advanced View"]` |
| Override rows | role and member rows, paginated | `"Add Role or Member"`, `"Role/Member"`, `"Item <pageNumber> of <totalPages> (current)"` |
| Fully-overridden state | `"Every role has overridden permissions in this channel."` | `8b9a4b4a55eaa34c.js` |
| Empty state | `"No Roles"` | `"No Roles"` |
| Add affordance | `"Add members or roles"`, `"Add Override"` | `"dMJ3Y6"`, `"1ZZtts"` |
| Removal guard | `"Cannot be removed due to Administrator access."`, `"Server owner cannot be removed."`, `"Cannot remove permissions"` | `"eTmN5a"`, `"icuNBM"`, `"Hw3XWx"` |
| @everyone warning | `"Heads up, @everyone does not have permission to view or connect to channels in this server. All channels will be default hidden to members. Use the Advanced View to give specific roles or members access to this channel."` | `"ZAk4Q9"` |
| Server-level conflict | `"Role already has server-level permissions."` | `"Jtpshs"` |
| Pick a member/role | `"Channels & Roles"` picker with a search field `"Not a valid user or role."` / `"Not a valid role."` | `"Channels & Roles"`, `"Not a valid user or role."`, `"Not a valid role."` |
| Private channel access edit | `"You will need the Manage Roles permission to edit access to this private channel."` | `"You will need the Manage Roles permission to edit access to this private channel."` |
| Add-to-private-channel guard | `"Only users or roles with Manage Roles permission can be added."` | `"Only users or roles with Manage Roles permission can be added."` |
| Import | `"Import Channel Permissions"`, `"Import Channel Permissions from "`, `"There are no roles with channel permissions to import."`, `"Duplicate the benefits or channel permissions from an existing tier or role."` | `"545418"`, `"545458"`, `"537175"`, `"536854"` |

### Permission names as the user sees them
`8b9a4b4a55eaa34c.js` → `"View Channels"`, `"Send messages and media"`, `"Manage Roles"`, `"Create Invite"`, `"Add Reactions"`, `"Administrator"`, `"Ban Members"`, `"Deafen Members"`, `"Read Messages"`.

Administrator's own description is the clearest statement of Discord's authority semantics: `"Members with this permission have every permission and also bypass channel specific permissions. This is a dangerous permission to grant."`

### Role-colour accessibility
Role colour is a user-facing display preference with its own accessibility controls in **User Settings → Accessibility**:
`8b9a4b4a55eaa34c.js` → `"Show role colors in names"`, `"Don't show role colors"`, `"Choose a display for role colors."`, `"Role Colors"`, `"Make roles with unique colors easier to read in Accessibility Settings."`, `"Choose how you would like role colors to be displayed."`, `"Show role colors in names"`.

## Implementation details
| Concern | Discord implementation | Evidence |
| --- | --- | --- |
| Role ordering | `getSortedRoles(guildId)` returns roles in hierarchy order (descending `position`); `position` is a server-assigned integer | `web.31d1cd3e6e440749.js` → `T.A.getSortedRoles(e.id)`, `position:t.position` |
| Highest role of a member | first role in `getSortedRoles` whose id is in the member's `roles` | `function H(e,t){…T.A.getSortedRoles(e.id).find(e=>n.roles.includes(e.id))}` |
| Colour selection | highest role with `color > 0`; gradient roles contribute `colors`/`colorStrings` | `t.color>0&&…`, `colorString:0!==t.color?(0,r.Hl)(t.color):null` |
| Hoist selection | highest role with `hoist` | `t.hoist&&…` |
| Owner rendering | owner id suppressed when any **hoisted** role carries `ADMINISTRATOR` | `function B(e){return r().some(…,e=>e.hoist&&(0,h._m)(e,C.xBc.ADMINISTRATOR))?void 0:e.ownerId??void 0}` |
| Elevated comparison | `(0,S.zA)(n,i)` compares two roles by position; used both for "can I manage this member" and "am I elevated" | `function V(e,t,n,i){…(0,S.zA)(n,i)}` |
| Permission evaluation flags | `excludeGuildPermissions` (channel-only computation) and `checkElevated` (treat an elevated actor as full-permission) | `function Y(e){let{permission:t,user:n,context:i,overwrites:r,roles:s,excludeGuildPermissions:l}=e;…}` |
| Guard bundles | `kg(...)` composes flag sets; `a.bM(e,t)` is the "has permission" test | `web.31d1cd3e6e440749.js` → `i.kg(...a)`, `(0,A.bM)(e,t)` |
| Role deletion guard | the member's role list is rewritten on `GUILD_ROLE_DELETE` | `r===i&&"GUILD_ROLE_DELETE"===e.type?a.roles.filter(t=>t!==e.roleId):a.roles` |
| Audit entry vocabulary | every authority mutation has a dedicated sentence template | `8b9a4b4a55eaa34c.js` → `"Hoisted"`, `"Mentionable"`, `"Set the color to "`, `"Granted N permissions"`, `"Denied N permissions"`, `"moved N roles"`, `"created the role"`, `"deleted the role"` |
| Permission-matrix search | the matrix is filterable, with an empty-state string | `"Search permissions"`, `"No permissions found"` |

### Transfer to CrowdOS
CrowdOS's authority is **not** Discord's. CrowdOS has an L0–L3 agent authority tier enforced by the router, plus a *cosmetic, client-store-only* role list. The following are safe to borrow; the following are not.

**CrowdOS facts this section relies on**
| Fact | Evidence |
| --- | --- |
| Role type is `{id, name, color, permissions}` — no `position`, no `hoist`, no hierarchy field | `packages/client/types/crowdOs.ts` (`interface Role`) |
| Roles are a client-store array seeded from `initialRoles`; `addRole` / `updateRole` / `reorderRoles` mutate the store; **no server-side role table or gate exists** | `packages/client/stores/crowdOsStore.ts` (`roles: Role[]`, `reorderRoles`, `addRole`, `updateRole`; `initialRoles` imported at `:782`, seeded at `:1903`) |
| The four seeded roles are named after the tiers: `L0 Omniscient Monitor`, `L1 Executive Administrator`, `L2 Operation Coordinator`, `L3 Autonomic Worker`, each with a `permissions` array | `packages/client/stores/initialData.ts:14-18` |
| The Workspace Settings modal exposes a **separate** permission vocabulary of 10 ids: `administrator`, `view_channels`, `manage_channels`, `manage_roles`, `manage_agents`, `manage_skills`, `manage_tools`, `send_messages`, `read_history`, `mention_roles` | `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:26-35` |
| `manage_roles` is already described hierarchy-aware: "Allows members to create or edit roles lower than their highest role." | same file, `:29` |
| Authority level is a distinct type `AuthorityLevel = 0 \| 1 \| 2 \| 3`, and authority is enforced by the router, not by roles | `re-docs/Backend Docs/Domain Spec/Agents.md` (`AuthorityLevel`); AGENTS.md §5.3 |
| CrowdOS already has an Audit tab | `packages/client/components/workspace/settings/AuditTab.tsx` |

**Safe to borrow**
1. **The hoisted-group ordering pattern** — a roster that is partitioned into deterministic, named groups and ordered by a stated key. In CrowdOS the key MUST be the **tier** (plus presence), not a role id. A "group by L2 / L3" roster is a legitimate presentation of an existing authority model; a "group by Admin role" roster is not, because it would let a role imply authority.
2. **Explain-the-refusal** — Discord renders an outranked/tied target as a *disabled control with a stated reason* (`"This person has a higher role than you…"`, `"Cannot action this member"`). CrowdOS should use the same pattern for tier refusals: "you cannot act on an L0 agent", "that agent is above your tier". Hiding the control is the worse pattern.
3. **Role colour as a cosmetic chip with a per-user accessibility toggle** — CrowdOS can keep `Role.color` (already in the type) as a *display* aid for the client-side role list, and can adopt Discord's accessibility escape hatch ("Show role colors in names" / "Don't show role colors"). Colour MUST remain non-authoritative: it may never be the only carrier of a permission or tier.
4. **The permission-matrix shape** — group taxonomy + per-permission title + description + a searchable list with an empty state. CrowdOS's 10-id vocabulary can be rendered with the same *presentation* structure (grouped, searchable, each entry with a title and a one-line explanation) without inheriting Discord's 41-bit blob.
5. **Audit-entry sentence templates** — CrowdOS's Audit tab can adopt Discord's pattern of one readable template per mutation kind ("hoisted", "colour changed", "N permissions granted/denied", "moved N roles"). The set of *what is audited* is CrowdOS's call, but the readability pattern transfers directly.
6. **Explicit "role already has server-level permissions" style conflict detection** — before applying a channel-scoped override, CrowdOS should detect and report that the tier/permission already grants it globally, exactly as Discord does with `"Role already has server-level permissions."`
7. **The Basic ↔ Advanced view toggle** for a permission surface — a simple synced view plus an explicit per-subject override view is a good pattern for CrowdOS's channel-level agent routing, provided the advanced view's subjects are CrowdOS-native (tier, agent) and never roles.

**Must NOT borrow**
1. **Role-as-authority.** CrowdOS §5.3 forbids it outright: "Authority comes from level, never from name or label." A role named `L1 Executive Administrator` MUST NOT grant L1 capabilities; the seeded CrowdOS roles already sit dangerously close to this line and are cosmetic by contract.
2. **`ADMINISTRATOR` as an all-permissions bypass.** Discord's admin "bypass[es] channel specific permissions". CrowdOS's tier rules must not be bypassable by any role, permission bit or admin flag — including a future `administrator` id in the current 10-id vocabulary, which today is a display-only label.
3. **Owner-implies-everything.** CrowdOS has no guild owner concept; do not introduce one as a shortcut for "can do anything".
4. **A 40+ bit permission blob.** CrowdOS's tier model is a four-value lattice, not a bitmask. A flat permission set invites the exact "permission blobs with no enforcement" drift that the Agents domain spec already flags.
5. **Discord's member-list grouping by role id.** CrowdOS's roster must group by tier/presence (§5.3), or the group header becomes an authority hint by accident.
6. **The owner-suppression trick** (`ownerId` hidden when a hoisted admin role exists). It is a display shortcut that makes the authority model ambiguous; CrowdOS should never hide who holds the top tier.
7. **Client-store-only roles as an authority source.** CrowdOS's roles are already client-only; they MUST stay that way for display, and any future server-side role table must be explicitly declared as non-authoritative.

**Open question for the user** (not answered here): whether the current CrowdOS `administrator` permission id in `WorkspaceSettingsModal.tsx:26` should be renamed to avoid reading as an authority grant, given §5.3.

## Interaction model
| Action | Target | Result | Evidence |
| --- | --- | --- | --- |
| Inspect a member's authority | member row | crown decorator for owner; role-coloured name | `web.31d1cd3e6e440749.js` → `decorators` props `isOwner`, `ownerTooltipText` |
| Try to act on an outranked member | member row action | disabled + `"This person has a higher role than you, so you cannot manage them."` | `8b9a4b4a55eaa34c.js` |
| Try to act on a tied member | member row action | disabled + `"This person's highest role is the same as yours, so you cannot manage them."` | same |
| Try to act on a member you cannot touch | member row action | disabled + `"Cannot action this member"` | `"Se4c7+"` |
| Toggle a permission | permission matrix switch | flag flips; audit entry records Granted/Denied count | `web.31d1cd3e6e440749.js` → `[E.xBc.X.toString()]:{…}`; `8b9a4b4a55eaa34c.js` → `"Granted N permissions"` |
| Toggle hoist | role card | `"Hoisted"` / `"Not hoisted"` audit entry; member list regroup | `"gWfe24"`, `"+tb8kN"` |
| Toggle mentionable | role card | `"Mentionable"` / `"Not mentionable"` | `"LL8VFF"`, `"Z7xzmC"` |
| Reorder roles | role list drag | `"moved N roles"` audit entry; hierarchy changes | `"jZeaoW"` |
| Switch Basic ↔ Advanced view | channel permissions | `Advanced View` / `Basic View`; override rows appear | `"0a6awf"`, `"Mw/UDN"` |
| Add a subject to a private channel | channel permissions picker | `"Add members or roles"`; blocked without `MANAGE_ROLES` | `"dMJ3Y6"`, `"Only users or roles with Manage Roles permission can be added."` |
| Search the permission matrix | matrix search field | `"N permission(s) found"` / `"No permissions found"` | `"OLJAk3"`, `"I+eHql"` |
| Open a locked channel | channel list entry | `, Private Channel (locked)` on the entry | `accessibility.nodes[609]` |
| Change role-colour display | User Settings → Accessibility | `"Show role colors in names"` / `"Don't show role colors"` | `8b9a4b4a55eaa34c.js` |

## Performance notes
| Aspect | Approach | Evidence |
| --- | --- | --- |
| Permission evaluation is pure/derived | no per-member permission blob is stored; `can()` is recomputed from roles + overwrites with memoised store hooks | `web.31d1cd3e6e440749.js` → `(0,A.bM)(e,t)`, `A.$3({permission:…,user:…,context:…})` |
| Elevated checks are cheap | a role-position comparison, not a permission scan | `(0,S.zA)(n,i)` |
| Role list is a plain map + sorted accessor | `getSortedRoles` / `getUnsafeMutableRoles` | `T.A.getSortedRoles(e.id)`, `T.A.getUnsafeMutableRoles(e.id)` |
| Group header resolution is a single role lookup | `j(e,t){return null==t.hoistRoleId?null:T.A.getRole(e.id,t.hoistRoleId)}` | `web.31d1cd3e6e440749.js` |
| Role mutation patches only changed fields | `$add` / `$remove` op-codes for role lists | `ej.ROLES_ADD="$add"`, `ej.ROLES_REMOVE="$remove"` |
| Audit templates are pre-built | every mutation kind has a compiled sentence template, so the audit log is render-only | `8b9a4b4a55eaa34c.js` → `"<name>":["…"]` catalogue |

## Evidence
| ID / pointer | What it shows |
| --- | --- |
| `web.31d1cd3e6e440749.js` → `ej.HOIST="hoist"`, `ej.MENTIONABLE="mentionable"`, `ej.COLOR="color"`, `ej.COLORS="colors"`, `ej.PERMISSIONS="permissions"`, `ej.ROLES_ADD="$add"` | Role patch payload field names |
| `web.31d1cd3e6e440749.js` → role deserialiser (`mentionable`, `position`, `color`, `hoist`, `managed`, `tags`, `icon`, `unicode_emoji`) | The persisted role shape |
| `web.31d1cd3e6e440749.js` → `function Y(e,t){…t.color>0&&…;t.hoist&&…;return{colorString…,colorRoleId…,iconRoleId…,hoistRoleId…,highestRoleId…}}` | Colour / hoist / icon / highest-role selection |
| `web.31d1cd3e6e440749.js` → `function B(e){return r().some(…,e=>e.hoist&&(0,h._m)(e,C.xBc.ADMINISTRATOR))?void 0:e.ownerId??void 0}` | Owner suppression under a hoisted admin role |
| `web.31d1cd3e6e440749.js` → `function Y(e){let{permission,user,context,overwrites,roles,excludeGuildPermissions}=e;…}`, `function V(e,t,n,i){…(0,S.zA)(n,i)}` | Permission resolution and elevated comparison |
| `web.31d1cd3e6e440749.js` → module `547683` (`kg(...a)` bundles), `[E.xBc.X.toString()]:{title,description,flag}` | Permission bundles and the matrix entry shape |
| `web.31d1cd3e6e440749.js` → `EMPTY_STATE:0, ADMINISTRATOR:1, ROLE:2, OWNER:3, MEMBER:4, USER:5, GUILD:6, APP_CHANNEL_APP:7`; `ROLES:0, MEMBERS:1, USERS:2, GUILDS:3` | Advanced-permissions subject taxonomy and tabs |
| `8b9a4b4a55eaa34c.js` → `"General Permissions"`, `"Membership Permissions"`, `"Advanced Permissions"`, `"Text Channel Permissions"`, `"Voice Channel Permissions"`, `"Forum Channel Permissions"`, `"Search permissions"` | Permission group taxonomy and matrix search |
| `8b9a4b4a55eaa34c.js` → `"Members with this permission have every permission and also bypass channel specific permissions. This is a dangerous permission to grant."` | Administrator semantics, verbatim |
| `8b9a4b4a55eaa34c.js` → `"Hoisted"`, `"Mentionable"`, `"Set the color to "`, `"Granted N permissions"`, `"Denied N permissions"`, `"moved N roles"`, `"created the role"`, `"deleted the role"` | Role audit-entry vocabulary |
| `8b9a4b4a55eaa34c.js` → `"ZAk4Q9"`, `"eTmN5a"`, `"icuNBM"`, `"Jtpshs"`, `"Only users or roles with Manage Roles permission can be added."` | Channel-override guards and warnings |
| `inspect-main.json` → `accessibility.nodes[609]` | A locked private voice channel in the live channel list |
| `packages/client/stores/initialData.ts:14-18` | CrowdOS seeded role list (tier-named, cosmetic) |
| `packages/client/types/crowdOs.ts` | CrowdOS `Role` type — four fields, no hierarchy |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:26-35` | CrowdOS's 10-id permission vocabulary |
| `re-docs/Backend Docs/Domain Spec/Agents.md` | CrowdOS `AuthorityLevel` and the router-enforced tier contract |

## Gaps
- **Permission bit values were not extracted.** The flags live in module `652215` → namespace `xB` (re-exported `xBc`); the definition is behind a re-export (`tB.xB`) and no literal assignment (e.g. `MODERATE_MEMBERS=`) was found in the six captured chunks. Flag *names* and *semantics* are evidenced; numeric values are not.
- **The live role-management UI was never opened.** Guild settings are not URL-routable in the desktop shell (see `Settings Surface.md`), so the role card was read from the bundle only; no live role card, hoist toggle or permission switch was observed.
- **The `@everyone` role's permission set for the observed server was not read** (no live guild settings / role list).
- **Whether Discord hides or disables an action when the actor lacks the permission** was only partly observable. The bundle contains both a `"Cannot action this member"` tooltip (disabled-with-reason) and a `"Cannot remove permissions"` / `"Cannot be removed due to Administrator access."` family. A blanket rule "always disabled with a reason" is therefore **inferred**, not observed.
- **The owner-suppression rule** was read from code (`function B(e)`); no live session had both an owner and a hoisted admin role, so the rendered result was not confirmed.
- **Role colour gradient rendering** (`colors`/`colorStrings`) was read from the model only; the rendered gradient was not observed.
- **The exact ordering of hoisted-role groups relative to the synthetic `"online"` group** is inferred from the group-key expression and the role hierarchy order; it was not confirmed against a rendered member list.
- **CrowdOS's existing `administrator` permission id** (`WorkspaceSettingsModal.tsx:26`) is display-only today. Whether it is intended as cosmetic or aspirational is not stated in the repo — flagged, not changed.

## User Decision:

## Target Contract
> Status: Target. Discord's role/permission model is a reference only. CrowdOS's locked design contract takes precedence, in particular §5.3 (authority comes from level, never from name or label), §5.4 (L3 workers are stateless), and the Agents domain spec's "permission blobs with no enforcement must be labeled advisory or wired to enforcement".

* CrowdOS MUST keep authority derived from the **agent tier** only. A role name, a role colour, a badge, or a `Role` row MUST NOT grant, imply or gate any capability.
* CrowdOS MUST keep its existing role list **cosmetic and client-side** unless a server-side role domain is explicitly scaffolded with a gate; even then, roles MUST be declared non-authoritative in the Domain Spec.
* Any role that CrowdOS displays next to an agent MUST be accompanied by the agent's tier, so a colour or a title can never be mistaken for authority. CrowdOS's `L0/L1/L2/L3`-named roles MUST NOT be the sole indicator.
* CrowdOS MUST NOT introduce an `administrator`-style all-permissions bypass over tier rules, nor an "owner implies everything" shortcut, nor a 40-bit permission blob, unless a Domain Spec states how each interacts with §5.3.
* If CrowdOS implements channel-scoped agent routing or overrides, it MUST surface conflicts explicitly ("already granted globally") in the style of Discord's `"Role already has server-level permissions."`, and MUST audit every such mutation in a readable sentence template.
* Any authority refusal in the CrowdOS UI MUST be a disabled control with a stated reason (tier-based), never a silently hidden control, and never a generic failure string.
* CrowdOS's permission surfaces MUST be searchable with an explicit empty state, and each entry MUST carry a title plus a one-line explanation, matching the matrix presentation pattern without adopting Discord's grouping.
* CrowdOS's Audit surface SHOULD cover every role/permission/authority mutation with a human-readable sentence; the vocabulary is CrowdOS's, the pattern is Discord's.
* Where CrowdOS has no equivalent (guild owner, @everyone, hoisted role groups), the absence MUST be deliberate and stated, not silently inherited by copying a Discord screen.
