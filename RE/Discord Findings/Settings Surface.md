# Settings Surface

> Type: Reference — Status: observed — Updated: 2026-10-21

## Purpose
Reference description of Discord's **settings surfaces** — the user-settings window and the server (guild) settings surface — with emphasis on navigation architecture, control vocabulary, search, the unsaved-change model, and the route scheme that makes a settings page addressable. Visual style is out of scope. A structure-to-structure comparison with CrowdOS's 13-tab Workspace Settings modal is in the final H2.

Target build analysed: Discord 1.0.9264, Electron 42.11.15 (`ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461`).

**Reachability note, stated up front:** Discord's desktop shell routes **only `/channels/…`** in the main window. Navigating to `https://discord.com/channels/@me/settings` renders the DM home ("Friends"), and `https://discord.com/settings/account` and `https://discord.com/guilds/345096814443233301/settings` both redirect back to the last channel (`ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461`, `ev_3e8a617d71c30123acd91bdd67d5bffa67f95b46a7a234302d5d56011803e6ee`, `ev_8e4577c4c784609722717f3cc11defd43bc608752720c04af6ad8327b262e2f2`). The settings surfaces open in a separate window, reachable only by activating the UI — which the read-only constraint for this task forbids. Everything below is therefore read from the shipped bundle, which is the authoritative static source and contains the **complete** settings registry.

## How it works

Discord's user settings are a **registry-driven, three-level navigation**:

```
sidebar item  →  panel  →  category  →  setting / card
```

Every level has a **stable string id** declared in one enum, so a settings page can be addressed by URL, referenced by telemetry, and diffed between builds. The registry in `web.31d1cd3e6e440749.js` (one contiguous enum, ~30 KB, offsets `8455150`–`8486400`, 535 ids in total) declares:

| Level | Count | Example ids |
| --- | --- | --- |
| Section (route slug) | **42** | `account`, `account-standing`, `account/account-standing`, `profile-customization`, `content-and-social`, `data-and-privacy`, `privacy-and-safety`, `family-center`, `sessions`, `authorized-apps`, `connections`, `clips`, `premium`, `guild-boosting`, `subscriptions`, `inventory`, `billing`, `appearance`, `accessibility`, `voice`, `poggermode`, `text`, `notifications`, `emails`, `keybinds`, `system`, `language`, `streamer-mode`, `advanced`, `activity-privacy`, `registered-games`, `overlay`, `experiments`, `developer-options`, `user`, `stream` |
| Sidebar item | **25** | `profile_sidebar_item`, `account_sidebar_item`, `messaging_permissions_sidebar_item`, `data_and_privacy_sidebar_item`, `notifications_sidebar_item`, `clips_sidebar_item`, `nitro_sidebar_item`, `premium_guild_subscriptions_sidebar_item`, `subscriptions_sidebar_item`, `gift_sidebar_item`, `billing_sidebar_item`, `appearance_sidebar_item`, `accessibility_sidebar_item`, `voice_and_video_sidebar_item`, `poggermode_sidebar_item`, `system_sidebar_item`, `language_and_time_sidebar_item`, `connected_apps_sidebar_item`, `activity_privacy_sidebar_item`, `registered_games_sidebar_item`, `overlay_sidebar_item`, `experiments_sidebar_item`, `developer_options_sidebar_item`, `developer_sidebar_item`, `logout_sidebar_item` |
| Panel | **31** | `profile_panel`, `account_panel`, `account_mfa_nested_panel`, `account_sessions_nested_panel`, `sessions_panel`, `account_standing_nested_panel`, `account_standing_panel`, `account_family_center_nested_panel`, `family_center_panel`, `messaging_permissions_panel`, `data_and_privacy_panel`, `notifications_panel`, `clips_panel`, `nitro_panel`, `premium_guild_subscriptions_panel`, `subscriptions_panel`, `gift_panel`, `billing_panel`, `appearance_panel`, `accessibility_panel`, `voice_and_video_panel`, `poggermode_panel`, `system_panel`, `language_and_time_panel`, `connected_apps_panel`, `activity_privacy_panel`, `registered_games_panel`, `overlay_panel`, `experiments_panel`, `developer_options_panel`, `developer_panel` |
| Category | **85** | `profile_category`, `account_info_category`, `account_password_security_category`, `security_keys_category`, `authenticator_app_category`, `sms_auth_category`, `backup_codes_category`, `sessions_sessions_category`, `account_standing_category`, `family_center_category`, `account_removal_category`, `content_category`, `spam_filters_category`, `permissions_category`, `friend_requests_category`, `restricted_users_category`, `connected_games_category`, `profile_privacy_category`, `data_usage_category`, `sponsored_content_category`, `voice_security_category`, `notifications_overview_category`, `notifications_sounds_category`, `notifications_badges_category`, `notifications_email_category`, `notifications_advanced_category`, `clips_general_category`, `clips_capture_settings_category`, `clips_storage_category`, `clips_developer_category`, `nitro_category`, `premium_guild_subscriptions_category`, `subscriptions_category`, `redeem_gift_category`, `my_gifts_category`, `purchased_gifts_category`, `gifting_badge_category`, `gift_blocked_payments_category`, `billing_payment_methods_category`, `billing_transaction_history_category`, `appearance_theme_category`, `appearance_in_app_icon_category`, `appearance_messages_category`, `appearance_chat_box_category`, `appearance_search_category`, `streamer_mode_category`, `appearance_advanced_category`, `text_readability_category`, `visual_density_category`, `color_and_contrast_category`, `motion`, `audio_and_screen_reader_category`, `voice_category`, `voice_input_profile_category`, `camera_category`, `streaming_category`, `voice_and_video_diagnostics_category`, `sounds_category`, `soundboard_category`, `guild_rooms_category`, `poggermode_category`, `system_general_category`, `system_custom_keybinds_category`, `system_default_keybinds_category`, `system_helper_category`, `system_game_mode_category`, `system_advanced_category`, `language_and_time_category`, `connections_category`, `authorized_apps_category`, `activity_sharing_category`, `activity_sharing_per_guild_category`, `activity_sharing_game_joining_category`, `registered_games_current_game_category`, `registered_games_added_games_category`, `overlay_enable_category`, `overlay_general_category`, `overlay_voice_widget_category`, `overlay_widgets_category`, `overlay_notifications_category`, `experiments_category`, `developer_category` |
| Grouping | 6 | `user_section`, `billing_section`, `app_section`, `games_and_apps_section`, `developer_section`, `utility_section` |
| Setting / card | 102 `_setting` ids, plus 5 `_accordion`, 6 `_list` and 1 `_card` | `profile_setting`, `account_info_username_setting`, `account_change_password_setting`, `backup_codes_setting`, `sessions_current_session_setting`, `sessions_logout_all_sessions_setting`, `account_disable_setting`, `account_delete_setting`, `dm_spam_setting`, `permissions_dms_setting`, `friend_requests_everyone_setting`, `profile_privacy_setting`, `data_usage_statistics_setting`, `hardware_acceleration`, `appearance_ui_density`, `appearance_zoom`, `high_contrast_mode`, `reduced_motion`, `toast_duration`, `voice_input_volume_setting`, `voice_microphone_test_setting`, `voice_push_to_talk_setting`, `camera_background_setting`, `os_open_on_startup`, `os_minimize_to_tray`, `custom_keybinds_setting`, `default_keybinds_setting`, `language_select_setting`, `time_format_setting`, `authorized_apps_list_setting`, `overlay_widgets_reset`, `developer_mode`, `application_test_mode`, … |

The registry is the whole surface: **a new setting is a new id plus a component**, and nothing else in the app needs to change.

### Verified behaviour
- `[Observed-from-bundle]` The user-settings surface is a **registry, not hand-built pages**: one contiguous enum declares 535 ids across sidebar items, panels, categories, groupings, settings, accordions, lists and cards (`web.31d1cd3e6e440749.js` @ `8455150`–`8486400`).
- `[Observed-from-bundle]` Nav state is in the URL: `/settings/<section>/<subsection?>`, with the section slug lowercased and space/underscore-normalised to `-` (`web.31d1cd3e6e440749.js` @ `7484409`, `8501364` region).
- `[Observed-from-bundle]` The section is **validated against the id enum**, not accepted as a free string, and a failed parse is reported as `user_settings_url_parsing_failed` with the offending path (`web.31d1cd3e6e440749.js` @ `8501364` region).
- `[Observed-from-bundle]` Settings are **saved explicitly**, never auto-saved: the action is `"Save Changes"` and the confirmation is `"Settings successfully updated."` (`8b9a4b4a55eaa34c.js` @ `1154821` region).
- `[Observed-from-bundle]` Leaving a surface with unsaved edits raises a guarded destructive dialog: `"Discard unsaved changes?"` with `"Keep Editing"` and `"Discard"` (`8b9a4b4a55eaa34c.js` @ `296526`–`296621`).
- `[Observed-from-bundle]` The unsaved guard is **scoped per editor** where the surface has sub-editors (an AutoMod rule gets its own message naming the rule) (`8b9a4b4a55eaa34c.js` @ `483006`).
- `[Observed-from-bundle]` Settings search is a first-class feature with a four-event telemetry chain — press, query entered, result pressed, closed — which implies an index over the registry rather than a DOM scan (`web.31d1cd3e6e440749.js` @ `445384` region).
- `[Observed-from-bundle]` Every category can link to the sibling settings it affects, via `*_related_settings` and `*_navigator` ids (registry).
- `[Observed-from-bundle]` Panels nest by id, not by flag: `account_mfa_nested_panel`, `account_sessions_nested_panel`, `account_standing_nested_panel`, `account_family_center_nested_panel` (registry).
- `[Observed-from-bundle]` Server settings is **two-level** and Discord renders its own breadcrumb for help text: `Server Settings > Community > Overview`, `Server Settings > Community > Onboarding`, `Server Settings > Automod.`, `Server Settings > Content Moderation.`, `Server Settings > Integrations`, `Server Settings > Roles` (`8b9a4b4a55eaa34c.js` @ `94207`, `216747`, `287516`, `287683`, `481921`, `499541`).
- `[Observed-from-bundle]` Control kinds are declared by id suffix — `_setting`, `_fieldset`, `_category`, `_card`, `_list`, `_accordion`, `_slider`, `_selector`, `_navigator`, `_prefix`, `_warning`/`_infobox` (registry).
- `[Observed-from-bundle]` Keybinds are editable in Settings and a panel that owns the key disables capture while it is visible (`8b9a4b4a55eaa34c.js` @ `29318` / `29345`).
- `[Observed]` The settings surface was **not rendered in this session**: `/channels/@me/settings` loaded the DM home (title `"Friends"`, `accessibility.nodes[99]` = `StaticText "Friends"`) and no settings chunk was fetched (`ev_8e4577c4c784609722717f3cc11defd43bc608752720c04af6ad8327b262e2f2`).
- `[Inferred]` The settings window is a separate browser context: `/settings/*` is deliberately excluded from `isAppRoute`, and the desktop shell redirects it to the last channel (`web.31d1cd3e6e440749.js` → `isAppRoute:e=>{…t.startsWith("/channels/")||…}`; `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` after the `/guilds/<id>/settings` attempt).
- `[Inferred]` Control *type* (switch vs select vs radio) is not derivable from the id suffix; the registry encodes identity, not widget type.

## Structural inventory

### Route scheme
| Aspect | Value | Evidence |
| --- | --- | --- |
| User settings route | `SETTINGS:(e,t)=>`/settings/${e}${null!=t?`/${t}`:""}`` | `web.31d1cd3e6e440749.js` @ `7484409` |
| Route template | `a.BV.SETTINGS(":section",":subsection?")` | @ `7499200` region |
| Parse | `function d(e){let t=e.split("/");return l.BVt.SETTINGS(t[0],t[1])}` | @ `8501364` region |
| Slug normalisation | `function c(e){return null==e?"":e.toLowerCase().replace(o,"-")}` with `o=/[_\s]|%20/g` | same region |
| Section validation | `function u(e){return Object.values(s.od).includes(e)}` | same region |
| Analytics | `"user_settings_url_parsed"` (`user_settings_url_path`, `user_settings_url_origin`), `"user_settings_url_parsing_failed"` | @ `8501364` region |
| Server settings route | `GUILD_SETTINGS:(e,t,n)=>{let i=`/guilds/${e}/settings${null!=t?`/${t}`:""}`;return null==n?i:`${i}/${n}`}` | @ `7487303` |
| Server settings template | `a.BV.GUILD_SETTINGS(i.p.guildId(),":section?",":subsection?")` | @ `7499200` region |
| Server settings picker | `PICK_GUILD_SETTINGS:(e,t,n)=>{…`/guilds/settings${…}?feature=${n}`}` | @ `7487303` |

### Search
| Aspect | Value | Evidence |
| --- | --- | --- |
| Telemetry | `"user_settings_search_press"`, `"user_settings_search_query_entered"`, `"user_settings_search_result_press"`, `"user_settings_search_closed"` | `web.31d1cd3e6e440749.js` @ `445384` region |
| Scope | the search is a **settings** search (it queries the registry), distinct from the chat command palette | same file; the command-palette copy is `"Search, members, media, pins, threads, and more"` in `8b9a4b4a55eaa34c.js` @ `180526` |

### Control vocabulary (derived from the registry id suffixes)
| Suffix | Control kind | Examples |
| --- | --- | --- |
| `_setting` | single toggle / value | `hardware_acceleration`, `os_minimize_to_tray`, `developer_mode` |
| `_fieldset` | grouped set of fields | `appearance_theme_fieldset`, `friend_requests_fieldset`, `voice_input_sensitivity_field_set`, `expression_picker_field_set` |
| `_category` | a titled block inside a panel | `appearance_theme_category`, `voice_category` |
| `_card` | a rich content card | `clips_general_card` |
| `_list` | a list widget | `security_keys_list`, `notification_sounds_list`, `streamer_mode_options_list`, `voice_and_video_sounds_list`, `overlay_widgets_list`, `overlay_notifications_list` |
| `_accordion` | collapsible block | `notifications_advanced_accordion`, `chat_bar_advanced_accordion`, `input_profile_voice_advanced_accordion`, `streaming_advanced_accordion`, `voice_and_video_diagnostics_accordion` |
| `_slider` | slider | `voice_global_attenuation_slider` |
| `_selector` | picker | `permissions_guild_selector` |
| `_navigator` | cross-link to another settings area | `appearance_theme_accessiblity_navigator`, `activity_privacy_to_profile_privacy_navigator`, `data_usage_activity_privacy_navigator` |
| `_prefix` | repeated-item id prefix | `sounds_list_item_`, `email_list_item_` |
| `_warning` / `_infobox` | inline messaging | `clips_hardware_classification_warning`, `clips_quality_infobox` |

The registry also records **read/write direction** through a `related settings` id on most categories (e.g. `appearance_theme_related_settings`, `notifications_sounds_related_settings`, `activity_privacy_related_settings`, `connected_games_related_settings`), which is how Discord links a setting to the sibling areas it affects.

### Server settings sections
Reachable section ids in the bundle: `GUILD_ROLES`, `GUILD_EMOJI`, `GUILD_STICKERS`, `GUILD_MODERATION`, `GUILD_INTEGRATIONS`, `GUILD_AUDIT_LOG`, `GUILD_WIDGET`, `GUILD_BANS`, `GUILD_PERMISSIONS`, plus `GUILD_EMOJIS` (`/guilds/:id/emojis`), `GUILD_AUDIT_LOG` (`/guilds/:id/audit-logs`), `GUILD_FEATURE`, `GUILD_MEMBER_VERIFICATION`, `GUILD_BOOSTING_MARKETING`.

User-facing section labels observed: `"Overview"`, `"Roles"`, `"Emoji"`, `"Stickers"`, `"Moderation"`, `"Integrations"`, `"Audit Log"`, `"Widget"`, `"Server Template"`, `"Bans"`, `"Permissions"`, `"Members"`, `"Invite"`, `"Sounds"`, `"Server Overview"`, `"Server Settings"`, `"Server Options"`, `"Server Order"`.

Server settings is **two-level** — a top section can have its own subsections, evidenced by the breadcrumb strings Discord renders in help text:

| Breadcrumb | Evidence |
| --- | --- |
| `Server Settings > Community > Overview` | `8b9a4b4a55eaa34c.js` @ `287516` |
| `Server Settings > Community > Onboarding` | @ `287683` |
| `Server Settings > Automod.` | @ `94207` |
| `Server Settings > Content Moderation.` | @ `481921` |
| `Server Settings > Integrations` | @ `216747` |
| `Server Settings > Roles` | @ `499541` |
| `This will be visible in Server Settings > Audit Log.` | @ `295122` |

Server-specific surfaces also carry their own menus: `GUILD_SETTINGS_EMOJI_EDIT_BUTTON="guild settings edit emoji"`, `GUILD_SETTINGS_SOUNDBOARD="guild settings soundboard"`, `GUILD_SETTINGS_USER_MENU="guild settings user menu"` (`web.31d1cd3e6e440749.js` @ `2851353` region). The new safety-centric Members page has its own copy: `"Meet the new safety-centric Members page!"`, `"View a list of new members and see who's been marked with safety signals such as unusual DM activity."`, `"There are no actionable members"` (`8b9a4b4a55eaa34c.js` @ `774586` region).

### Unsaved-change handling
| Aspect | Value | Evidence |
| --- | --- | --- |
| Guard title | `"Discard unsaved changes?"` | `8b9a4b4a55eaa34c.js` @ `296526` |
| Guard body | `"You have unsaved changes, are you sure you want to discard them?"` | @ `296611` |
| Guard actions | `"Keep Editing"` / `"Discard"` | @ `296535` region |
| Scoped guard | `"You have unsaved changes to the \"<ruleName>\" AutoMod rule. Are you sure you want to stop editing without saving?"` with panel title `"Unsaved Changes"` | @ `483006` / `@483144` |
| Generic warning | `"Careful — you have unsaved changes!"` | @ `1192326` |
| Banner | `"You have unsaved changes"` with `"Dismiss"` | @ `524497` |
| Save action | `"Save Changes"` | @ `1154821` region (`"K344S7"`) |
| Save success | `"Settings successfully updated."`, `"Server settings have been updated."` | @ `1154821`, @ `1189708` region |

The model is therefore: **edits are local until an explicit save**; navigating away, closing, or switching editor raises a confirm dialog that offers "Keep Editing" (default) and "Discard". Discord does not auto-save settings.

### Keyboard / keybind surfaces
| Aspect | Value | Evidence |
| --- | --- | --- |
| Custom keybinds | `"Add a Keybind"`, `system_custom_keybinds_category`, `custom_keybinds_setting` | `8b9a4b4a55eaa34c.js` @ `29318` / `29345`; `web.31d1cd3e6e440749.js` registry |
| Default keybinds | `system_default_keybinds_category`, `default_keybinds_setting` | same |
| Capture conflict | `"Keybinds are disabled while this panel is visible."` | `8b9a4b4a55eaa34c.js` |
| Overlay keybind | `overlay_keybind_setting` | registry |
| Clip keybinds | `clips_keybind`, `clips_screenshot_keybind` | registry |

## Implementation details
| Concern | Discord implementation | Evidence |
| --- | --- | --- |
| Nav state lives in the URL | `/settings/<section>/<subsection>`; the section slug is lowercased and space/underscore-normalised to `-` | `function c(e){return null==e?"":e.toLowerCase().replace(o,"-")}` |
| Section validity is checked against the enum, not a free string | `Object.values(s.od).includes(e)` | `function u(e){return Object.values(s.od).includes(e)}` |
| Unknown sections are rejected and reported | `"user_settings_url_parsing_failed"` with `user_settings_url_origin` / `user_settings_url_path` | `web.31d1cd3e6e440749.js` @ `8501364` region |
| Nested panels are first-class ids, not flags | `account_mfa_nested_panel`, `account_sessions_nested_panel`, `account_standing_nested_panel`, `account_family_center_nested_panel` | registry |
| Every category links to its "related settings" | `*_related_settings` ids across ~20 categories | registry |
| Save is explicit per surface | `"Save Changes"` + `"Settings successfully updated."` | `8b9a4b4a55eaa34c.js` |
| Discard is a guarded destructive action | `"Discard unsaved changes?"` / `"Keep Editing"` / `"Discard"` | same |
| Settings mutations are audited server-side too | `"Error saving user experiment overrides, unsaved data will be lost"`, `"Error saving guild experiment overrides, unsaved data will be lost"` | `web.31d1cd3e6e440749.js` @ `4603774` |
| Experimental overrides are a first-class settings surface | `experiments_sidebar_item`, `experiments_panel`, `experiments_category`, `experiments_setting`, `developer_options_*` | registry |
| Developer mode gates developer panels | `developer_mode` setting; `developer_sidebar_item`, `developer_panel` | registry |
| Platform-conditional settings exist | `os_open_on_startup`, `os_start_minimized`, `os_minimize_to_tray`, `os_system_service`, `capture_performance_trace`, `language_and_time_category` with `windows` / `linux` slugs | registry |

## Interaction model
| Action | Target | Result | Evidence |
| --- | --- | --- | --- |
| Navigate to a settings section | URL | router matches `SETTINGS(:section,:subsection?)`, slug normalised, section validated | `web.31d1cd3e6e440749.js` @ `8501364` region |
| Invalid section in URL | URL | `user_settings_url_parsing_failed` fires with the offending path | same |
| Search settings | settings search field | `user_settings_search_press` → `user_settings_search_query_entered` → `user_settings_search_result_press`; `user_settings_search_closed` on dismiss | @ `445384` region |
| Change a setting | switch / slider / selector | local draft state; the surface becomes "unsaved" | `"You have unsaved changes"` |
| Save | `"Save Changes"` | persists; `"Settings successfully updated."`; unsaved state clears | `8b9a4b4a55eaa34c.js` @ `1154821` region |
| Leave with unsaved changes | navigate / close | `"Discard unsaved changes?"` → `"Keep Editing"` or `"Discard"` | @ `296526` region |
| Stop editing a sub-editor with unsaved changes | back | `"You have unsaved changes to the \"<ruleName>\" AutoMod rule. Are you sure you want to stop editing without saving?"` | @ `483006` |
| Switch panel within a section | sidebar | panel id changes; nested panels (`*_nested_panel`) are reachable | registry |
| Enter a nested area | link / navigator | `*_navigator` ids cross-link to a sibling settings area | registry |
| Record a keybind | `"Add a Keybind"` | keybind capture; `"Keybinds are disabled while this panel is visible."` when the panel itself owns the key | `8b9a4b4a55eaa34c.js` |

## Performance notes
| Aspect | Approach | Evidence |
| --- | --- | --- |
| The nav is data, not code | 25 sidebar items / 31 panels / 85 categories are an enum + a registry, so adding a setting does not grow the router | registry region `8455150`–`8486300` |
| Settings are lazily mounted per panel | panel ids are resolved at open time; the registry carries no component references | registry shape |
| Cross-linking is id-based | `*_related_settings` / `*_navigator` ids let one surface reference another without a component import | registry |
| Search queries the registry, not the DOM | telemetry distinguishes "search pressed" / "query entered" / "result pressed" / "closed", i.e. an index, not a DOM scan | @ `445384` region |
| Save is one round-trip per surface | a single `"Save Changes"` commit plus one `"Settings successfully updated."` | `8b9a4b4a55eaa34c.js` |
| Settings live in a separate window | the settings window is a distinct browser context, so a heavy settings tree does not compete with the chat render path | route `SETTINGS(:section,:subsection?)` is not a `/channels/` app route; `isAppRoute` excludes it |

## Evidence
| ID / pointer | What it shows |
| --- | --- |
| `web.31d1cd3e6e440749.js` @ `8455150`–`8486400` | The complete settings registry: 42 section slugs, 25 sidebar items, 31 panels, 85 categories, 6 groupings, 102 setting ids, 5 accordions, 6 lists, 1 card (535 ids total) |
| `web.31d1cd3e6e440749.js` @ `8501364` region | `parseSettingsUrl`, slug normaliser, section validator, `user_settings_url_parsed` / `_parsing_failed` |
| `web.31d1cd3e6e440749.js` @ `7484409` / `7487303` / `7499200` region | `SETTINGS:(e,t)=>…`, `GUILD_SETTINGS:(e,t,n)=>…`, `PICK_GUILD_SETTINGS:(e,t,n)=>…`, `a.BV.SETTINGS(":section",":subsection?")` |
| `web.31d1cd3e6e440749.js` @ `445384` region | The four settings-search telemetry events |
| `web.31d1cd3e6e440749.js` @ `4603774` region | "unsaved data will be lost" save-failure handling for user/guild experiment overrides |
| `web.31d1cd3e6e440749.js` @ `2851353` region | Server-settings-specific menus and sheets (`guild settings edit emoji`, `guild settings soundboard`, `guild settings user menu`) |
| `8b9a4b4a55eaa34c.js` @ `296526`–`296621` | Unsaved-change guard: title, body, `"Keep Editing"`, `"Discard"` |
| `8b9a4b4a55eaa34c.js` @ `483006` / `@483144` / `@1192326` / `@524497` | Scoped unsaved-change guard, `"Unsaved Changes"` panel, `"Careful — you have unsaved changes!"`, `"You have unsaved changes"` banner |
| `8b9a4b4a55eaa34c.js` @ `1154821` / `@1189708` region | `"Save Changes"`, `"Settings successfully updated."`, `"Server settings have been updated."` |
| `8b9a4b4a55eaa34c.js` @ `94207`, `@216747`, `@287516`, `@287683`, `@481921`, `@499541`, `@295122` | Server-settings breadcrumb structure (Community → Overview/Onboarding, Automod, Content Moderation, Integrations, Roles, Audit Log) |
| `8b9a4b4a55eaa34c.js` @ `774586` region | Safety-centric Members page copy |
| `8b9a4b4a55eaa34c.js` @ `29318` / `29345` | `"Add a Keybind"`, `"Keybinds are disabled while this panel is visible."` |
| `ev_1830a653d82566a3598d5178bd89d5f5bf80fd49ad906db5a0be652702d22461` | Live target identity; URL after the `/guilds/<id>/settings` navigation had redirected back to the channel |
| `ev_3e8a617d71c30123acd91bdd67d5bffa67f95b46a7a234302d5d56011803e6ee` | Target listing at `https://discord.com/channels/@me/settings` — URL accepted, title still the DM home |
| `ev_8e4577c4c784609722717f3cc11defd43bc608752720c04af6ad8327b262e2f2` | Full passive inspection of the settings URL page — DM home, **no settings panel mounted, no settings chunk fetched** |
| `packages/client/components/workspace/modals/WorkspaceSettingsModal.tsx:26-35` | CrowdOS's 13-tab modal and its 10-id permission vocabulary (used in the mapping below) |

## Gaps
- **The settings surface was never rendered live.** Both candidate URLs redirect in the desktop shell and the settings window was never opened (read-only constraint). Every statement about layout, control rendering and visual state is bundle-derived; the *registry* is exhaustive and authoritative, the *rendering* was not observed.
- **Control *types* were inferred from id suffixes** (`_fieldset`, `_slider`, `_accordion`, …), not from rendered ARIA roles. A `*_setting` id could be a switch, a select or a radio group; this was not verified.
- **The list+detail layout was not observed.** Discord's settings window is known to be a sidebar + detail pane, but the sidebar is a single-level list of the 25 sidebar items and the detail pane stacks the panel's categories — the exact composition was not seen.
- **Search ranking, search scope (settings-only vs settings + commands) and the result rendering were not observed.** Only the telemetry event names were read.
- **Server-settings section ids were read from scattered constants**, not from a single section registry like the user-settings one. The complete ordered server-settings navigation list is therefore **not** established; the labels and breadcrumbs above are the confirmed subset.
- **The server-settings "Roles" section structure** (role card layout, the permission matrix inside it, the `*_category` layout for the server role page) is described in `Roles and Authority.md`; its *rendering* was not observed.
- **REA tool error (verbatim)** for the navigation attempt: `"Analysis could not complete. Run `rea doctor` and review the reported details; repeating the unchanged request is not expected to succeed."` — provider `rea-playwright-browser-scenario`, detail `"Scenario navigation failed before the initial state was captured."` The navigation itself completed (console events show the page loaded and the app connected to the gateway), so the failure was in the capture step only.
- Whether Discord's settings surface is keyboard-navigable end to end (roving focus, section jump, `/` to focus search) was not verified; only the keybind-recording surface was evidenced.

## User Decision:

## Comparison hooks
CrowdOS's Workspace Settings is a **single-level, 13-tab modal** (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`), where Discord's user settings is a **three-level registry** (25 sidebar items → 31 panels → 85 categories → 102 controls) and its server settings is a **two-level** surface. CrowdOS's tabs are: `overview` (Workspace), `agents` (Agents Board), `roles` (Permissions & Roles), `tools` (Security Tools Whitelist), `model_cards` (Model Modules), `skills_manager` (Skills Manager), `channels` (Category & Channels), `mounts` (Mounts), `storage` (Storage), `diagnostics` (Diagnostics), `audit` (Audit), `safety` (Safety Policies), `screen_lock` (Screen Lock) (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`).

CrowdOS `file:line` citations below are relative to `packages/client/`. An **absence** claim is evidenced by the complete 13-tab registry (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`) — the exhaustive set of Workspace Settings surfaces — or by the tab strip that renders them flat, with no grouping and no search field (`components/workspace/modals/WorkspaceSettingsModal.tsx:1005-1012`).

| Discord surface | CrowdOS surface | Gap |
| --- | --- | --- |
| Account (username, email, phone, password, MFA, backup codes, sessions) | — | **No equivalent.** Credential/session management has no CrowdOS surface (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Profile customization (display name, avatar, banner, pronouns) | — (operator profile modal, outside Workspace Settings) | Profile editing lives outside Workspace Settings (`components/workspace/modals/OperatorProfileModal.tsx:22-60`); no workspace-scoped profile surface (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Privacy & Safety (blocked users, ignored users, friend requests, DM policy) | Safety Policies (`components/workspace/modals/WorkspaceSettingsModal.tsx:2798`) | The tab is policy-shaped, not people-shaped — it configures permission policies and budget bounds (`components/workspace/modals/WorkspaceSettingsModal.tsx:2801-2802`). No blocked/ignored-user list, no friend-request policy, no DM-spam filter (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Data & Privacy (data usage, sponsored content, voice security) | — | **No equivalent.** No data-usage disclosure surface, no sponsored-content control (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Content and Social / Connected Games / Registered Games | — | **No equivalent.** (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`) |
| Notifications (overview, sounds, badges, email, advanced) | — | **No equivalent.** CrowdOS has no notification settings surface at all (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Appearance (theme, messages, chat box, search, density, zoom) | — (app-level theme only) | The theme preference is one global `localStorage` key (`src/config/theme.ts:8`, `src/config/theme.ts:39-46`), not workspace-scoped; there is no workspace-scoped appearance surface (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Accessibility (text readability, motion, audio, screen reader) | — (app-level) | Same gap: CrowdOS exposes no per-workspace accessibility settings (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Voice & Video (input/output, camera, streaming, diagnostics) | — | **No equivalent.** No voice or media settings surface (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| System (general, keybinds, game mode, language & time) | — | **No equivalent.** No keybind surface, no language/time surface (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Connected Apps / Authorized Apps | Security Tools Whitelist (`components/workspace/modals/WorkspaceSettingsModal.tsx:1859`) | Different axis: Discord authorises third-party apps; CrowdOS whitelists tool capabilities. No per-app authorisation surface (`components/workspace/modals/WorkspaceSettingsModal.tsx:1859`, `components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Clips | — | **No equivalent.** (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`) |
| Nitro / Premium / Subscriptions / Billing / Inventory / Gift | — | **Out of CrowdOS scope** (no commercial surface — `components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Activity Privacy / Overlay / Experiments / Developer Options | Diagnostics (`components/workspace/modals/WorkspaceSettingsModal.tsx:3115`, `components/workspace/settings/DiagnosticsTab.tsx:51-56`) | Partial: Diagnostics is observability, not experiment overrides. CrowdOS has no runtime-experiment override surface (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Server Settings → Roles (role cards, hoist, mentionable, colour, permissions matrix, channel overrides) | Permissions & Roles (`components/workspace/modals/WorkspaceSettingsModal.tsx:1718`) | Discord's role model has position/hoist/mentionable/gradient and ~41 flags with per-channel overrides; CrowdOS's role is `{id, name, color, permissions}` (`types/crowdOs.ts:325-330`), client-store-only (`stores/crowdOsStore.ts:523`, `stores/initialData.ts:14`), with a 10-id vocabulary (`components/workspace/modals/WorkspaceSettingsModal.tsx:25-36`) and **no channel-override surface** (`types/crowdOs.ts:325-330`). |
| Server Settings → Automod / Content Moderation | Safety Policies (`components/workspace/modals/WorkspaceSettingsModal.tsx:2798`) | Discord's automod is rule-based with per-rule unsaved-change handling; CrowdOS's safety tab is declarative policy (`components/workspace/modals/WorkspaceSettingsModal.tsx:2801-2802`). No per-rule editor (`components/workspace/modals/WorkspaceSettingsModal.tsx:2798`). |
| Server Settings → Community (Overview, Onboarding) | — | **No equivalent.** No onboarding, rules-channel or community-setup surface (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Server Settings → Integrations | — (Modules / Tools) | CrowdOS has model modules (`components/workspace/modals/WorkspaceSettingsModal.tsx:1901`) and tool modules (`components/workspace/modals/WorkspaceSettingsModal.tsx:1859`), not server integrations. No integration-authorisation surface (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Server Settings → Audit Log | Audit (`components/workspace/modals/WorkspaceSettingsModal.tsx:3119`, `components/workspace/settings/AuditTab.tsx:50-58`) | The Audit tab exists, but its rows are built from global store slices with no workspace filter (`components/workspace/settings/AuditTab.tsx:74-158`) and carry key/value fragments rather than sentence templates (`components/workspace/settings/AuditTab.tsx:84-89`). |
| Server Settings → Members (safety-centric) | Agents Board (`components/workspace/modals/WorkspaceSettingsModal.tsx:1152`) | Different subject (human members vs agents). CrowdOS has no per-agent risk flags — the agent record carries no risk field (`types/crowdOs.ts:6-27`). |
| Server Settings → Emoji / Stickers / Overview / Boosts / Invite / Bans / Widget / Sounds / Apps | — | **No equivalent** for most (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`); the Agents Board covers the roster half of "Members" only (`components/workspace/modals/WorkspaceSettingsModal.tsx:1152`). |
| Settings search (press / query / result / closed telemetry) | — | **No equivalent.** The tab strip is a flat list of the 13 tabs with no search field (`components/workspace/modals/WorkspaceSettingsModal.tsx:1005-1012`); search is the documented remedy once tabs exceed a screenful. |
| Unsaved-change guard (Keep Editing / Discard) | — (per-tab local state) | CrowdOS's settings are applied per action — "Save Configuration" (`components/workspace/modals/WorkspaceSettingsModal.tsx:1619`), "Save Skill" (`components/workspace/modals/WorkspaceSettingsModal.tsx:2422`), "Save Tool" (`components/workspace/modals/WorkspaceSettingsModal.tsx:2689`), "Save Cap" (`components/workspace/modals/WorkspaceSettingsModal.tsx:2900`), "Save Provider Budget" (`components/workspace/modals/WorkspaceSettingsModal.tsx:3008`), "Connect & Save" (`components/workspace/modals/WorkspaceSettingsModal.tsx:155`) — with no cross-tab unsaved state. Acceptable at 13 tabs; not acceptable as tabs grow. |
| Stable id per control (registry) | Tab `id` only (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`) | CrowdOS has ids at tab level only; no per-section or per-control ids, so a specific setting cannot be linked or audited by id (`components/workspace/modals/WorkspaceSettingsModal.tsx:959-973`). |
| Three-level nav (sidebar → panel → category) | One-level tab list (`components/workspace/modals/WorkspaceSettingsModal.tsx:1005-1012`) | At 13 tabs CrowdOS is below the threshold that needs grouping; the registry-with-sections pattern is what to adopt if it grows. |

## Target Contract
> Status: Target. Discord is a reference source only; CrowdOS's locked design contract (§1–§34) takes precedence, in particular §3 (one gate per domain) and §6 (docs sync).

* CrowdOS MUST keep a **stable id per settings surface** (tab, section, control) so a control can be addressed, audited and diffed without a component reference. Discord's id-only registry is the transferable pattern; the specific ids are not.
* CrowdOS's Workspace Settings MUST be reachable by a URL/route, and the route MUST be validated against the known id set — an unknown id MUST be rejected with a recorded failure, exactly as Discord's `user_settings_url_parsing_failed` does.
* CrowdOS MUST keep a **single owner** for each settings domain. A control that reads or writes another domain's state (storage tier, database URL, tool allowlist, audit log) MUST go through that domain's gate, never directly. Discord's per-surface panels are a useful *layout* precedent, not a licence to cross-read.
* Settings mutations in CrowdOS MUST be **explicitly saved** with a visible unsaved state and a guarded discard — CrowdOS must never silently auto-save a setting, because the Domain Spec's authority contract depends on the permission blob being a deliberate write.
* CrowdOS MUST add a **settings search** once the tab count grows past one screen, and MUST give it a telemetry triple (press / query entered / result pressed / closed) so it can be measured without screenshots.
* CrowdOS MUST keep the settings surface **scoped to the active workspace**. Discord's user settings are account-scoped and its server settings are guild-scoped; CrowdOS's settings are workspace-scoped (§1) and MUST NOT read or write another workspace's settings.
* CrowdOS MUST NOT copy Discord's 41-flag permission vocabulary into a single settings tab. The 10-id vocabulary in `WorkspaceSettingsModal.tsx:26-35` is the current contract, and authority remains tier-owned (§5.3) regardless of what that list says.
* CrowdOS's 13-tab modal MUST NOT grow past a screenful without either grouping tabs into sections or adding search; a flat 13-item list with no search is a known-usability ceiling, and the registry-with-sections pattern is the documented remedy.
* Any new CrowdOS settings surface MUST be added to the Domain Spec of the owning domain in the same task (§6), and MUST NOT be implemented in the client store only if it changes server-authoritative state.
